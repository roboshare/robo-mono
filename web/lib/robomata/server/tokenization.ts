import "server-only";
import { encodeAbiParameters, keccak256, parseAbiParameters, parseUnits } from "viem";
import type {
  FacilitySubmission,
  SubmissionTokenizationAnchors,
  SubmissionTokenizationTerms,
} from "~~/lib/robomata/submissions";
import { getDeployedContract } from "~~/utils/contracts";

const LOCAL_IPFS_UPLOAD_URL = "http://127.0.0.1:5001/api/v0/add";
const PINATA_UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const PAYMENT_TOKEN_DECIMALS = 6;
const DEFAULT_REVENUE_SHARE_BPS = 5_000;
const DEFAULT_TARGET_YIELD_BPS = 1_000;
const DEFAULT_MATURITY_MONTHS = 36;
const DEFAULT_TOKEN_PRICE = 1;

type TokenizationTermsInput = Partial<{
  offeringLimitCents: unknown;
  tokenPrice: unknown;
  maturityMonths: unknown;
  revenueShareBps: unknown;
  targetYieldBps: unknown;
  immediateProceeds: unknown;
  protectionEnabled: unknown;
}>;

export type PreparedTokenization = {
  assetMetadata: Record<string, unknown>;
  revenueTokenMetadata: Record<string, unknown>;
  evmCall: {
    contractAddress?: string;
    contractName: "FacilityRegistry";
    functionName: "registerAssetAndCreateRevenueTokenPool";
    args: [string, string, string, string, string, string, string, boolean, boolean];
  };
};

function committedBorrowingBaseCents(submission: FacilitySubmission): number {
  return submission.computation?.borrowingBase.availableBorrowingBaseCents ?? 0;
}

export function hasOpenTokenizationBlockers(submission: FacilitySubmission): boolean {
  return submission.exceptions.some(exception => exception.actionStatus === "open");
}

export function canDraftTokenization(submission: FacilitySubmission): boolean {
  return submission.evidenceCommit.status === "committed" && !hasOpenTokenizationBlockers(submission);
}

export function buildTokenizationAnchors(submission: FacilitySubmission): SubmissionTokenizationAnchors {
  const rootDigest = submission.evidenceCommit.rootDigest;

  return {
    evidenceRoot: submission.evidenceCommit.evidenceRoot,
    rootDigest,
    suiTxDigest: submission.evidenceCommit.txDigest,
    facilityCommitment: rootDigest ? deriveFacilityCommitment(submission) : undefined,
  };
}

export function defaultTokenizationTerms(submission: FacilitySubmission): Required<SubmissionTokenizationTerms> {
  return {
    offeringLimitCents: committedBorrowingBaseCents(submission),
    tokenPrice: DEFAULT_TOKEN_PRICE,
    maturityMonths: DEFAULT_MATURITY_MONTHS,
    revenueShareBps: DEFAULT_REVENUE_SHARE_BPS,
    targetYieldBps: DEFAULT_TARGET_YIELD_BPS,
    immediateProceeds: false,
    protectionEnabled: false,
  };
}

function normalizeNumber(value: unknown, field: string, options: { integer?: boolean; min?: number; max?: number }) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }
  if (options.integer && !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer.`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(`${field} must be at least ${options.min}.`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${field} must be at most ${options.max}.`);
  }
  return value;
}

function normalizeBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}

export function mergeTokenizationTerms(
  submission: FacilitySubmission,
  input: TokenizationTermsInput,
): Required<SubmissionTokenizationTerms> {
  const current = {
    ...defaultTokenizationTerms(submission),
    ...submission.tokenization.terms,
  };
  const borrowingBaseCents = committedBorrowingBaseCents(submission);

  return {
    offeringLimitCents:
      input.offeringLimitCents === undefined
        ? Math.min(current.offeringLimitCents, borrowingBaseCents)
        : Math.min(
            normalizeNumber(input.offeringLimitCents, "offeringLimitCents", {
              integer: true,
              min: 1,
            }),
            borrowingBaseCents,
          ),
    tokenPrice:
      input.tokenPrice === undefined
        ? current.tokenPrice
        : normalizeNumber(input.tokenPrice, "tokenPrice", { min: 0.01 }),
    maturityMonths:
      input.maturityMonths === undefined
        ? current.maturityMonths
        : normalizeNumber(input.maturityMonths, "maturityMonths", { integer: true, min: 1, max: 120 }),
    revenueShareBps:
      input.revenueShareBps === undefined
        ? current.revenueShareBps
        : normalizeNumber(input.revenueShareBps, "revenueShareBps", { integer: true, min: 0, max: 10_000 }),
    targetYieldBps:
      input.targetYieldBps === undefined
        ? current.targetYieldBps
        : normalizeNumber(input.targetYieldBps, "targetYieldBps", { integer: true, min: 0, max: 10_000 }),
    immediateProceeds:
      input.immediateProceeds === undefined
        ? current.immediateProceeds
        : normalizeBoolean(input.immediateProceeds, "immediateProceeds"),
    protectionEnabled:
      input.protectionEnabled === undefined
        ? current.protectionEnabled
        : normalizeBoolean(input.protectionEnabled, "protectionEnabled"),
  };
}

export function assertCompleteTokenizationTerms(
  terms: SubmissionTokenizationTerms,
): asserts terms is Required<SubmissionTokenizationTerms> {
  const requiredFields = [
    "offeringLimitCents",
    "tokenPrice",
    "maturityMonths",
    "revenueShareBps",
    "targetYieldBps",
    "immediateProceeds",
    "protectionEnabled",
  ] as const;
  const missing = requiredFields.find(field => terms[field] === undefined);
  if (missing) throw new Error(`Tokenization ${missing} is required before preparing EVM call args.`);
}

function centsToUnits(cents: number): bigint {
  return parseUnits((cents / 100).toFixed(2), PAYMENT_TOKEN_DECIMALS);
}

function tokenPriceToUnits(tokenPrice: number): bigint {
  return parseUnits(tokenPrice.toString(), PAYMENT_TOKEN_DECIMALS);
}

function chainIdFromHeader(chainId: string | null): number | undefined {
  if (!chainId) return undefined;
  const parsed = Number.parseInt(chainId, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function assertBytes32(value: string | undefined, field: string): `0x${string}` {
  if (!value || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`${field} must be a bytes32 hex string.`);
  }
  return value as `0x${string}`;
}

export function deriveFacilityCommitment(submission: FacilitySubmission): `0x${string}` {
  const rootDigest = assertBytes32(submission.evidenceCommit.rootDigest, "rootDigest");

  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("string submissionId, address partnerAddress, bytes32 rootDigest, string asOfDate"),
      [submission.id, submission.partnerAddress as `0x${string}`, rootDigest, submission.asOfDate],
    ),
  );
}

async function uploadJsonToIpfs(data: Record<string, unknown>, filename: string): Promise<string> {
  const file = new File([JSON.stringify(data, null, 2)], filename, { type: "application/json" });
  const formData = new FormData();
  formData.append("file", file, filename);

  if (process.env.PINATA_JWT || process.env.NODE_ENV === "production") {
    if (!process.env.PINATA_JWT) throw new Error("Pinata is not configured for tokenization metadata upload.");
    const pinataFormData = new FormData();
    pinataFormData.append("network", "public");
    pinataFormData.append("file", file, filename);
    if (process.env.PINATA_GROUP_ID) pinataFormData.append("group_id", process.env.PINATA_GROUP_ID);

    const response = await fetch(PINATA_UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` },
      body: pinataFormData,
    });
    if (!response.ok) {
      throw new Error(`Pinata upload failed: ${response.status} ${response.statusText}`);
    }
    const result = (await response.json()) as { data?: { cid?: string }; Hash?: string };
    const cid = result.data?.cid ?? result.Hash;
    if (!cid) throw new Error("Pinata upload failed: missing CID in response.");
    return `ipfs://${cid}`;
  }

  const response = await fetch(process.env.IPFS_API_URL || LOCAL_IPFS_UPLOAD_URL, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    throw new Error(`Local IPFS upload failed: ${response.status} ${response.statusText}`);
  }
  const result = (await response.json()) as { data?: { cid?: string }; Hash?: string };
  const cid = result.data?.cid ?? result.Hash;
  if (!cid) throw new Error("Local IPFS upload failed: missing CID in response.");
  return `ipfs://${cid}`;
}

export async function prepareTokenization(input: {
  chainId: string | null;
  submission: FacilitySubmission;
}): Promise<PreparedTokenization & { assetMetadataUri: string; revenueTokenMetadataUri: string }> {
  const terms = input.submission.tokenization.terms;
  assertCompleteTokenizationTerms(terms);

  const anchors = input.submission.tokenization.anchors;
  const preparedAt = new Date().toISOString();
  const assetMetadata = {
    name: `Robomata facility ${input.submission.facilityName}`,
    description: "Tokenized borrowing-base facility prepared from a committed Robomata submission.",
    properties: {
      submissionId: input.submission.id,
      operatorName: input.submission.operatorName,
      facilityName: input.submission.facilityName,
      asOfDate: input.submission.asOfDate,
      availableBorrowingBaseCents: committedBorrowingBaseCents(input.submission),
      offeringLimitCents: terms.offeringLimitCents,
      evidenceRoot: anchors.evidenceRoot,
      rootDigest: anchors.rootDigest,
      suiTxDigest: anchors.suiTxDigest,
      facilityCommitment: anchors.facilityCommitment,
      preparedAt,
    },
  };
  const revenueTokenMetadata = {
    name: `Robomata claim units - ${input.submission.facilityName}`,
    description:
      "Claim units for a Robomata facility offering. Private receivable rows and evidence contents are excluded.",
    properties: {
      submissionId: input.submission.id,
      offeringLimitCents: terms.offeringLimitCents,
      tokenPrice: terms.tokenPrice,
      maturityMonths: terms.maturityMonths,
      revenueShareBps: terms.revenueShareBps,
      targetYieldBps: terms.targetYieldBps,
      immediateProceeds: terms.immediateProceeds,
      protectionEnabled: terms.protectionEnabled,
      rootDigest: anchors.rootDigest,
      preparedAt,
    },
  };

  const [assetMetadataUri, revenueTokenMetadataUri] = await Promise.all([
    uploadJsonToIpfs(assetMetadata, `${input.submission.id}-asset-metadata.json`),
    uploadJsonToIpfs(revenueTokenMetadata, `${input.submission.id}-revenue-token-metadata.json`),
  ]);
  const encodedRegistrationData = encodeAbiParameters(
    parseAbiParameters("bytes32 facilityCommitment, string assetMetadataURI, string revenueTokenMetadataURI"),
    [deriveFacilityCommitment(input.submission), assetMetadataUri, revenueTokenMetadataUri],
  );
  const assetValueUnits = centsToUnits(terms.offeringLimitCents);
  const tokenPriceUnits = tokenPriceToUnits(terms.tokenPrice);
  if (tokenPriceUnits <= 0n) throw new Error("tokenPrice must produce a positive payment-token amount.");
  const requestedSupply = assetValueUnits / tokenPriceUnits;
  if (requestedSupply <= 0n) throw new Error("offeringLimitCents must be at least one token at the configured price.");
  const maturityTimestamp = BigInt(Math.floor(Date.now() / 1000) + terms.maturityMonths * 30 * 24 * 60 * 60);
  const registry = getDeployedContract(chainIdFromHeader(input.chainId), "FacilityRegistry");

  return {
    assetMetadata,
    revenueTokenMetadata,
    assetMetadataUri,
    revenueTokenMetadataUri,
    evmCall: {
      contractAddress: registry?.address,
      contractName: "FacilityRegistry",
      functionName: "registerAssetAndCreateRevenueTokenPool",
      args: [
        encodedRegistrationData,
        assetValueUnits.toString(),
        tokenPriceUnits.toString(),
        maturityTimestamp.toString(),
        terms.revenueShareBps.toString(),
        terms.targetYieldBps.toString(),
        requestedSupply.toString(),
        terms.immediateProceeds,
        terms.protectionEnabled,
      ],
    },
  };
}
