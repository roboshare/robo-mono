import { createHash } from "node:crypto";
import "server-only";
import {
  type Chain,
  type Hex,
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  fallback,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbiParameters,
  parseUnits,
} from "viem";
import type {
  FacilitySubmission,
  SubmissionTokenizationAnchors,
  SubmissionTokenizationTerms,
} from "~~/lib/robomata/submissions";
import scaffoldConfig, { type ScaffoldConfig } from "~~/scaffold.config";
import { getDeployedContract } from "~~/utils/contracts";
import { getAlchemyHttpUrl, getInfuraHttpUrl } from "~~/utils/scaffold-eth";

const LOCAL_IPFS_UPLOAD_URL = "http://127.0.0.1:5001/api/v0/add";
const PINATA_UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const PAYMENT_TOKEN_DECIMALS = 6;
const DEFAULT_REVENUE_SHARE_BPS = 5_000;
const DEFAULT_TARGET_YIELD_BPS = 1_000;
const DEFAULT_MATURITY_MONTHS = 36;
const DEFAULT_TOKEN_PRICE = 1;
const MOCK_IPFS_CID_PREFIX = "mock-tokenization-";
const RECEIPT_VALIDATION_ABI = [
  {
    type: "event",
    name: "AssetRegistered",
    inputs: [
      { name: "assetId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "assetValue", type: "uint256", indexed: false },
      { name: "status", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "FacilityRegistered",
    inputs: [
      { name: "facilityId", type: "uint256", indexed: true },
      { name: "partner", type: "address", indexed: true },
      { name: "facilityCommitment", type: "bytes32", indexed: true },
    ],
  },
  {
    type: "event",
    name: "FacilityMetadataUpdated",
    inputs: [
      { name: "facilityId", type: "uint256", indexed: true },
      { name: "facilityCommitment", type: "bytes32", indexed: true },
      { name: "assetMetadataURI", type: "string", indexed: false },
      { name: "revenueTokenMetadataURI", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RevenueTokenPoolCreated",
    inputs: [
      { name: "assetId", type: "uint256", indexed: true },
      { name: "revenueTokenId", type: "uint256", indexed: true },
      { name: "partner", type: "address", indexed: true },
      { name: "assetValue", type: "uint256", indexed: false },
      { name: "supply", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RevenueTokenInfoSet",
    inputs: [
      { name: "revenueTokenId", type: "uint256", indexed: true },
      { name: "price", type: "uint256", indexed: false },
      { name: "supply", type: "uint256", indexed: false },
      { name: "maxSupply", type: "uint256", indexed: false },
      { name: "maturityDate", type: "uint256", indexed: false },
      { name: "immediateProceeds", type: "bool", indexed: false },
      { name: "protectionEnabled", type: "bool", indexed: false },
    ],
  },
] as const;
const REVENUE_TOKEN_POLICY_ABI = [
  {
    type: "function",
    name: "getTokenPrice",
    stateMutability: "view",
    inputs: [{ name: "revenueTokenId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getTokenMaturityDate",
    stateMutability: "view",
    inputs: [{ name: "revenueTokenId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getRevenueShareBP",
    stateMutability: "view",
    inputs: [{ name: "revenueTokenId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getTargetYieldBP",
    stateMutability: "view",
    inputs: [{ name: "revenueTokenId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getRevenueTokenMaxSupply",
    stateMutability: "view",
    inputs: [{ name: "revenueTokenId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getRevenueTokenImmediateProceedsEnabled",
    stateMutability: "view",
    inputs: [{ name: "revenueTokenId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getRevenueTokenProtectionEnabled",
    stateMutability: "view",
    inputs: [{ name: "revenueTokenId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

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
    contractAddress: string;
    contractName: "FacilityRegistry";
    functionName: "registerAssetAndCreateRevenueTokenPool";
    args: [string, string, string, string, string, string, string, boolean, boolean];
  };
};

type CompletionValidationInput = {
  assetId: string;
  assetMetadataUri?: string;
  chainId: string | null;
  registryAddress: string;
  revenueTokenId?: string;
  revenueTokenMetadataUri?: string;
  submission: FacilitySubmission;
  txHash: string;
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

function normalizeAddress(address: string, field: string): `0x${string}` {
  if (!isAddress(address)) throw new Error(`${field} must be a valid EVM address.`);
  return getAddress(address) as `0x${string}`;
}

function getConfiguredChain(chainId: number | undefined): Chain | undefined {
  if (!chainId) return undefined;
  return scaffoldConfig.targetNetworks.find(targetNetwork => targetNetwork.id === chainId) as Chain | undefined;
}

function getTokenizationPublicClient(chainId: number | undefined) {
  const chain = getConfiguredChain(chainId);
  if (!chain) return undefined;

  const rpcFallbacks = [];
  const infuraHttpUrl = getInfuraHttpUrl(chain.id);
  const alchemyHttpUrl = getAlchemyHttpUrl(chain.id);
  const rpcOverrideUrl = (scaffoldConfig.rpcOverrides as ScaffoldConfig["rpcOverrides"])?.[chain.id];
  if (infuraHttpUrl) rpcFallbacks.push(http(infuraHttpUrl));
  if (alchemyHttpUrl) rpcFallbacks.push(http(alchemyHttpUrl));
  if (rpcOverrideUrl) rpcFallbacks.push(http(rpcOverrideUrl));
  rpcFallbacks.push(http());

  return createPublicClient({
    chain,
    transport: fallback(rpcFallbacks),
  });
}

function getConfiguredFacilityRegistryAddress(chainId: number | undefined): string {
  const deployedRegistryAddress = getDeployedContract(chainId, "FacilityRegistry")?.address;
  if (deployedRegistryAddress) return deployedRegistryAddress;

  const localMockRegistryAddress = process.env.ROBOMATA_TOKENIZATION_MOCK_REGISTRY_ADDRESS?.trim();
  if (process.env.NODE_ENV !== "production" && localMockRegistryAddress && isAddress(localMockRegistryAddress)) {
    return localMockRegistryAddress;
  }

  throw new Error("FacilityRegistry is not deployed for the selected EVM network.");
}

function getConfiguredContractAddress(chainId: number | undefined, contractName: string): `0x${string}` {
  const deployedAddress = getDeployedContract(chainId, contractName)?.address;
  if (!deployedAddress) throw new Error(`${contractName} is not deployed for the selected EVM network.`);
  return normalizeAddress(deployedAddress, contractName);
}

function canUseMockCompletionVerification() {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.ROBOMATA_TOKENIZATION_MOCK_COMPLETION_VERIFICATION_ENABLED === "true"
  );
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

export async function verifyTokenizationCompletion({
  assetId,
  assetMetadataUri,
  chainId,
  registryAddress,
  revenueTokenId,
  revenueTokenMetadataUri,
  submission,
  txHash,
}: CompletionValidationInput) {
  const parsedChainId = chainIdFromHeader(chainId);
  const expectedRegistryAddress = normalizeAddress(
    getConfiguredFacilityRegistryAddress(parsedChainId),
    "registryAddress",
  );
  const normalizedRegistryAddress = normalizeAddress(registryAddress, "registryAddress");
  const preparedRegistryAddress = submission.tokenization.evm.registryAddress
    ? normalizeAddress(submission.tokenization.evm.registryAddress, "prepared registryAddress")
    : expectedRegistryAddress;

  if (normalizedRegistryAddress !== expectedRegistryAddress || normalizedRegistryAddress !== preparedRegistryAddress) {
    throw new Error("registryAddress does not match the prepared FacilityRegistry for this chain.");
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw new Error("txHash must be a 32-byte hex string.");
  if (canUseMockCompletionVerification()) return;

  const publicClient = getTokenizationPublicClient(parsedChainId);
  if (!publicClient) throw new Error("Unable to verify tokenization transaction for the selected EVM network.");

  const receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hex });
  if (receipt.status !== "success") throw new Error("Tokenization transaction did not succeed on-chain.");

  const expectedAssetId = BigInt(assetId);
  if (!revenueTokenId) throw new Error("revenueTokenId is required for prepared offering completion.");
  const expectedRevenueTokenId = BigInt(revenueTokenId);
  const expectedPartnerAddress = normalizeAddress(submission.partnerAddress, "partnerAddress");
  const expectedCommitment = deriveFacilityCommitment(submission).toLowerCase();
  const expectedAssetMetadataUri = assetMetadataUri ?? submission.tokenization.evm.assetMetadataUri;
  const expectedRevenueTokenMetadataUri =
    revenueTokenMetadataUri ?? submission.tokenization.evm.revenueTokenMetadataUri;
  const preparedCallArgs = submission.tokenization.evm.preparedCallArgs;
  if (!preparedCallArgs) {
    throw new Error("Prepared tokenization call args are missing; prepare tokenization again.");
  }
  const [
    ,
    expectedAssetValue,
    expectedTokenPrice,
    expectedMaturityDate,
    expectedRevenueShareBps,
    expectedTargetYieldBps,
    expectedMaxSupply,
    expectedImmediateProceeds,
    expectedProtectionEnabled,
  ] = preparedCallArgs;
  const expectedAssetValueUnits = BigInt(expectedAssetValue);
  const expectedTokenPriceUnits = BigInt(expectedTokenPrice);
  const expectedMaturityTimestamp = BigInt(expectedMaturityDate);
  const expectedRevenueShare = BigInt(expectedRevenueShareBps);
  const expectedTargetYield = BigInt(expectedTargetYieldBps);
  const expectedSupply = BigInt(expectedMaxSupply);
  const expectedPoolAssetValue = expectedSupply * expectedTokenPriceUnits;
  const roboshareTokensAddress = getConfiguredContractAddress(parsedChainId, "RoboshareTokens");
  let sawAssetRegistered = false;
  let sawFacilityRegistered = false;
  let sawFacilityMetadata = false;
  let sawRevenueTokenPool = false;
  let sawRevenueTokenInfo = false;

  for (const log of receipt.logs) {
    let event: { eventName: string; args: Record<string, unknown> };
    try {
      event = decodeEventLog({
        abi: RECEIPT_VALIDATION_ABI,
        data: log.data,
        topics: log.topics,
      }) as { eventName: string; args: Record<string, unknown> };
    } catch {
      continue;
    }

    const logAddress = normalizeAddress(log.address, "log.address");
    if (
      ["AssetRegistered", "FacilityRegistered", "FacilityMetadataUpdated"].includes(event.eventName) &&
      logAddress !== normalizedRegistryAddress
    ) {
      continue;
    }

    if (event.eventName === "AssetRegistered") {
      sawAssetRegistered =
        event.args.assetId === expectedAssetId &&
        normalizeAddress(String(event.args.owner), "AssetRegistered.owner") === expectedPartnerAddress &&
        event.args.assetValue === expectedAssetValueUnits;
    }
    if (event.eventName === "FacilityRegistered") {
      sawFacilityRegistered =
        event.args.facilityId === expectedAssetId &&
        normalizeAddress(String(event.args.partner), "FacilityRegistered.partner") === expectedPartnerAddress &&
        String(event.args.facilityCommitment).toLowerCase() === expectedCommitment;
    }
    if (event.eventName === "FacilityMetadataUpdated") {
      sawFacilityMetadata =
        event.args.facilityId === expectedAssetId &&
        String(event.args.facilityCommitment).toLowerCase() === expectedCommitment &&
        event.args.assetMetadataURI === expectedAssetMetadataUri &&
        event.args.revenueTokenMetadataURI === expectedRevenueTokenMetadataUri;
    }
    if (event.eventName === "RevenueTokenPoolCreated") {
      sawRevenueTokenPool =
        event.args.assetId === expectedAssetId &&
        event.args.revenueTokenId === expectedRevenueTokenId &&
        normalizeAddress(String(event.args.partner), "RevenueTokenPoolCreated.partner") === expectedPartnerAddress &&
        event.args.assetValue === expectedPoolAssetValue &&
        event.args.supply === expectedSupply;
    }
    if (event.eventName === "RevenueTokenInfoSet" && logAddress === roboshareTokensAddress) {
      sawRevenueTokenInfo =
        event.args.revenueTokenId === expectedRevenueTokenId &&
        event.args.price === expectedTokenPriceUnits &&
        event.args.supply === expectedSupply &&
        event.args.maxSupply === expectedSupply &&
        event.args.maturityDate === expectedMaturityTimestamp &&
        event.args.immediateProceeds === expectedImmediateProceeds &&
        event.args.protectionEnabled === expectedProtectionEnabled;
    }
  }

  if (!sawAssetRegistered) throw new Error("Tokenization receipt is missing the expected AssetRegistered event.");
  if (!sawFacilityRegistered) throw new Error("Tokenization receipt is missing the expected FacilityRegistered event.");
  if (!sawFacilityMetadata) throw new Error("Tokenization receipt is missing the expected facility metadata event.");
  if (!sawRevenueTokenPool) throw new Error("Tokenization receipt is missing the expected revenue-token pool event.");
  if (!sawRevenueTokenInfo) {
    throw new Error("Tokenization receipt is missing the expected revenue-token policy event.");
  }

  const [tokenPrice, maturityDate, revenueShareBps, targetYieldBps, maxSupply, immediateProceeds, protectionEnabled] =
    await Promise.all([
      publicClient.readContract({
        address: roboshareTokensAddress,
        abi: REVENUE_TOKEN_POLICY_ABI,
        functionName: "getTokenPrice",
        args: [expectedRevenueTokenId],
      }),
      publicClient.readContract({
        address: roboshareTokensAddress,
        abi: REVENUE_TOKEN_POLICY_ABI,
        functionName: "getTokenMaturityDate",
        args: [expectedRevenueTokenId],
      }),
      publicClient.readContract({
        address: roboshareTokensAddress,
        abi: REVENUE_TOKEN_POLICY_ABI,
        functionName: "getRevenueShareBP",
        args: [expectedRevenueTokenId],
      }),
      publicClient.readContract({
        address: roboshareTokensAddress,
        abi: REVENUE_TOKEN_POLICY_ABI,
        functionName: "getTargetYieldBP",
        args: [expectedRevenueTokenId],
      }),
      publicClient.readContract({
        address: roboshareTokensAddress,
        abi: REVENUE_TOKEN_POLICY_ABI,
        functionName: "getRevenueTokenMaxSupply",
        args: [expectedRevenueTokenId],
      }),
      publicClient.readContract({
        address: roboshareTokensAddress,
        abi: REVENUE_TOKEN_POLICY_ABI,
        functionName: "getRevenueTokenImmediateProceedsEnabled",
        args: [expectedRevenueTokenId],
      }),
      publicClient.readContract({
        address: roboshareTokensAddress,
        abi: REVENUE_TOKEN_POLICY_ABI,
        functionName: "getRevenueTokenProtectionEnabled",
        args: [expectedRevenueTokenId],
      }),
    ]);

  if (
    tokenPrice !== expectedTokenPriceUnits ||
    maturityDate !== expectedMaturityTimestamp ||
    revenueShareBps !== expectedRevenueShare ||
    targetYieldBps !== expectedTargetYield ||
    maxSupply !== expectedSupply ||
    immediateProceeds !== expectedImmediateProceeds ||
    protectionEnabled !== expectedProtectionEnabled
  ) {
    throw new Error("Revenue token economics do not match the prepared tokenization call.");
  }
}

async function uploadJsonToIpfs(data: Record<string, unknown>, filename: string): Promise<string> {
  if (process.env.ROBOMATA_TOKENIZATION_MOCK_METADATA_ENABLED === "true" && process.env.NODE_ENV !== "production") {
    const digest = createHash("sha256").update(JSON.stringify({ filename, data })).digest("hex");
    return `ipfs://${MOCK_IPFS_CID_PREFIX}${digest.slice(0, 32)}`;
  }

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
  const registryAddress = getConfiguredFacilityRegistryAddress(chainIdFromHeader(input.chainId));

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

  return {
    assetMetadata,
    revenueTokenMetadata,
    assetMetadataUri,
    revenueTokenMetadataUri,
    evmCall: {
      contractAddress: registryAddress,
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
