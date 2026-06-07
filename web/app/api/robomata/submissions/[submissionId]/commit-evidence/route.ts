import { NextRequest, NextResponse } from "next/server";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { isRobomataWorkflowMutationEnabled, isRobomataWorkflowServerEnabled } from "~~/lib/featureFlags";
import { requirePartnerAddress, requireSubmissionAccess } from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import {
  getRobomataSuiClient,
  getRobomataSuiGasBudget,
  getRobomataSuiNetwork,
  getRobomataSuiServerSigner,
  getRobomataSuiSponsorGasBudget,
  getRobomataSuiSponsorMinCoinBalance,
  getRobomataSuiSponsorSigner,
  getRobomataSuiTimeoutMs,
  isRobomataSuiCommitRuntimeConfigured,
  isRobomataSuiOperatorCommitRuntimeConfigured,
  isRobomataSuiSponsorshipRuntimeConfigured,
  parsePositiveInteger,
} from "~~/lib/robomata/server/suiCommitConfig";
import {
  type FacilitySubmission,
  resolveSubmissionFacilityObjectId,
  resolveSubmissionFacilityOperatorAddress,
} from "~~/lib/robomata/submissions";

const DEFAULT_COMMIT_STALE_MS = 10 * 60 * 1000;
const DEFAULT_EVENT_QUERY_LIMIT = 100;
const DEFAULT_EVENT_QUERY_MAX_PAGES = 10;

export const runtime = "nodejs";

function requireRobomataWorkflow() {
  if (isRobomataWorkflowServerEnabled()) return null;
  return NextResponse.json({ error: "Robomata workflow is not enabled." }, { status: 404 });
}

function requireRobomataMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata submission writes are not enabled." }, { status: 403 });
}

function commitStaleBeforeMs(): number {
  return Date.now() - parsePositiveInteger(process.env.ROBOMATA_SUI_COMMIT_STALE_MS, DEFAULT_COMMIT_STALE_MS);
}

function isStaleCommit(submission: FacilitySubmission): boolean {
  const startedAt = submission.evidenceCommit.commitStartedAt;
  if (!startedAt) return true;
  const parsed = Date.parse(startedAt);
  return Number.isNaN(parsed) || parsed < commitStaleBeforeMs();
}

function normalizeHex(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, "");
}

function digestMatches(value: unknown, expectedDigest: string): boolean {
  const expected = normalizeHex(expectedDigest);
  if (typeof value === "string") {
    if (normalizeHex(value) === expected) return true;

    try {
      return Buffer.from(value, "base64").toString("hex") === expected;
    } catch {
      return false;
    }
  }
  if (Array.isArray(value) && value.every(item => typeof item === "number")) {
    return Buffer.from(value).toString("hex") === expected;
  }
  if (value && typeof value === "object" && "bytes" in value) {
    return digestMatches((value as { bytes: unknown }).bytes, expectedDigest);
  }
  return false;
}

function eventTxDigest(event: Record<string, unknown>): string | undefined {
  const id = event.id;
  if (id && typeof id === "object") {
    const txDigest =
      (id as { txDigest?: unknown; tx_digest?: unknown }).txDigest ?? (id as { tx_digest?: unknown }).tx_digest;
    if (typeof txDigest === "string") return txDigest;
  }
  const digest = event.digest ?? event.txDigest;
  return typeof digest === "string" ? digest : undefined;
}

async function findCommittedEvidenceEvent(input: {
  facilityObjectId: string;
  label: string;
  rootDigest: string;
}): Promise<string | undefined> {
  const eventType = `${process.env.ROBOMATA_SUI_PACKAGE_ID}::facility::EvidenceCommitted`;
  const limit = parsePositiveInteger(process.env.ROBOMATA_SUI_EVENT_QUERY_LIMIT, DEFAULT_EVENT_QUERY_LIMIT);
  const maxPages = parsePositiveInteger(process.env.ROBOMATA_SUI_EVENT_QUERY_MAX_PAGES, DEFAULT_EVENT_QUERY_MAX_PAGES);
  const expectedFacility = input.facilityObjectId.toLowerCase();
  let cursor: { eventSeq: string; txDigest: string } | null | undefined;
  const client = getRobomataSuiClient();

  for (let page = 0; page < maxPages; page++) {
    const payload = await withTimeout(
      () =>
        client.queryEvents({
          query: { MoveEventType: eventType },
          cursor,
          limit,
          order: "descending",
        }),
      getRobomataSuiTimeoutMs(),
    );
    const events = payload.data as unknown as Record<string, unknown>[];

    const match = events.find(event => {
      const parsedJson = (event.parsedJson ?? event.parsed_json) as
        | { facility_id?: unknown; evidence_kind?: unknown; evidence_digest?: unknown }
        | undefined;
      return (
        parsedJson &&
        typeof parsedJson.facility_id === "string" &&
        parsedJson.facility_id.toLowerCase() === expectedFacility &&
        parsedJson.evidence_kind === input.label &&
        digestMatches(parsedJson.evidence_digest, input.rootDigest)
      );
    });

    if (match) return eventTxDigest(match);
    if (!payload.hasNextPage || !payload.nextCursor) return undefined;
    cursor = payload.nextCursor;
  }

  return undefined;
}

function matchesCommittedEvidenceEvent(input: {
  event: Record<string, unknown>;
  facilityObjectId: string;
  label: string;
  rootDigest: string;
}): boolean {
  const parsedJson = (input.event.parsedJson ?? input.event.parsed_json) as
    | { facility_id?: unknown; evidence_kind?: unknown; evidence_digest?: unknown }
    | undefined;
  return Boolean(
    parsedJson &&
      typeof parsedJson.facility_id === "string" &&
      parsedJson.facility_id.toLowerCase() === input.facilityObjectId.toLowerCase() &&
      parsedJson.evidence_kind === input.label &&
      digestMatches(parsedJson.evidence_digest, input.rootDigest),
  );
}

async function findCommittedEvidenceEventInTransaction(input: {
  txDigest: string;
  facilityObjectId: string;
  label: string;
  rootDigest: string;
}): Promise<string | undefined> {
  const client = getRobomataSuiClient();
  const expectedEventType = `${process.env.ROBOMATA_SUI_PACKAGE_ID}::facility::EvidenceCommitted`;
  const response = await withTimeout(
    signal =>
      client
        .getTransactionBlock({
          digest: input.txDigest,
          options: { showEvents: true, showEffects: true },
          signal,
        })
        .catch(() => undefined),
    getRobomataSuiTimeoutMs(),
  );
  if (!response) return undefined;
  const status = response.effects?.status;
  if (status?.status === "failure") {
    throw new Error(
      status.error
        ? `Sui transaction ${input.txDigest} failed: ${status.error}`
        : `Sui transaction ${input.txDigest} failed before emitting EvidenceCommitted.`,
    );
  }
  const events = (response.events ?? []) as unknown as Record<string, unknown>[];
  const match = events.find(event => {
    const eventType = event.type;
    return (
      typeof eventType === "string" &&
      eventType === expectedEventType &&
      matchesCommittedEvidenceEvent({ ...input, event })
    );
  });

  return match ? input.txDigest : undefined;
}

function isFailedSuiTransactionError(error: unknown): error is Error {
  return error instanceof Error && /^Sui transaction .+ failed/.test(error.message);
}

type SuiCommitResult = {
  errorMessage?: string;
  txDigest?: string;
  uncertain: boolean;
};

type CommitEvidenceRequest = {
  mode?:
    | "server"
    | "operator_prepare"
    | "operator_prepare_sponsored"
    | "operator_complete"
    | "operator_complete_sponsored"
    | "operator_release";
  operatorSignature?: string;
  sponsorSignature?: string;
  transactionBytes?: string;
  txDigest?: string;
  walletAddress?: string;
};

type OperatorCommitPayload = {
  chain: string;
  transactionJson: string;
  facilityObjectId: string;
  facilityOperatorAddress: string;
  label: string;
  rootDigest: string;
  packageId: string;
  sponsorship?: {
    gasBudget: number;
    gasObjectId: string;
    sponsorAddress: string;
    sponsorSignature: string;
    transactionBytes: string;
  };
};

async function parseCommitEvidenceRequest(request: NextRequest): Promise<CommitEvidenceRequest> {
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const input = parsed as Record<string, unknown>;
    const mode = input.mode;
    return {
      mode:
        mode === "operator_prepare" ||
        mode === "operator_prepare_sponsored" ||
        mode === "operator_complete" ||
        mode === "operator_complete_sponsored" ||
        mode === "operator_release" ||
        mode === "server"
          ? mode
          : undefined,
      operatorSignature: typeof input.operatorSignature === "string" ? input.operatorSignature.trim() : undefined,
      sponsorSignature: typeof input.sponsorSignature === "string" ? input.sponsorSignature.trim() : undefined,
      transactionBytes: typeof input.transactionBytes === "string" ? input.transactionBytes.trim() : undefined,
      txDigest: typeof input.txDigest === "string" ? input.txDigest.trim() : undefined,
      walletAddress: typeof input.walletAddress === "string" ? input.walletAddress.trim() : undefined,
    };
  } catch {
    return {};
  }
}

function hexToBytes(value: string): number[] {
  const hex = normalizeHex(value);
  if (hex.length % 2 !== 0) throw new Error("Expected an even-length hex digest.");
  return Array.from(Buffer.from(hex, "hex"));
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`Sui commit timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildSuiCommitTransaction(input: {
  facilityObjectId: string;
  label: string;
  rootDigest: string;
  senderAddress?: string;
}): Transaction {
  const tx = new Transaction();
  if (input.senderAddress) tx.setSender(input.senderAddress);
  tx.setGasBudget(getRobomataSuiGasBudget());
  tx.moveCall({
    target: `${process.env.ROBOMATA_SUI_PACKAGE_ID}::facility::commit_evidence`,
    arguments: [
      tx.object(input.facilityObjectId),
      tx.pure.string(input.label),
      tx.pure.vector("u8", hexToBytes(input.rootDigest)),
    ],
  });
  return tx;
}

async function prepareOperatorSuiCommit(input: {
  facilityObjectId: string;
  facilityOperatorAddress: string;
  label: string;
  rootDigest: string;
}): Promise<OperatorCommitPayload> {
  const tx = buildSuiCommitTransaction({ ...input, senderAddress: input.facilityOperatorAddress });
  const client = getRobomataSuiClient();
  const transactionJson = await withTimeout(() => tx.toJSON({ client }), getRobomataSuiTimeoutMs());

  return {
    chain: `sui:${getRobomataSuiNetwork()}`,
    transactionJson,
    facilityObjectId: input.facilityObjectId,
    facilityOperatorAddress: input.facilityOperatorAddress,
    label: input.label,
    rootDigest: input.rootDigest,
    packageId: process.env.ROBOMATA_SUI_PACKAGE_ID ?? "",
  };
}

async function selectSponsorGasPayment(input: { sponsorAddress: string; gasBudget: number }) {
  const client = getRobomataSuiClient();
  const minBalance = Math.max(input.gasBudget, getRobomataSuiSponsorMinCoinBalance());
  const coins = await withTimeout(
    signal =>
      client.getCoins({
        owner: input.sponsorAddress,
        limit: 50,
        signal,
      }),
    getRobomataSuiTimeoutMs(),
  );
  const gasCoin = coins.data.find(coin => BigInt(coin.balance) >= BigInt(minBalance));

  if (!gasCoin) {
    throw new Error(
      `No sponsor SUI gas coin with at least ${minBalance} MIST is available for ${input.sponsorAddress}.`,
    );
  }

  return {
    digest: gasCoin.digest,
    objectId: gasCoin.coinObjectId,
    version: gasCoin.version,
  };
}

async function prepareSponsoredOperatorSuiCommit(input: {
  facilityObjectId: string;
  facilityOperatorAddress: string;
  label: string;
  rootDigest: string;
}): Promise<OperatorCommitPayload> {
  const sponsor = getRobomataSuiSponsorSigner();
  if (!sponsor) throw new Error("ROBOMATA_SUI_SPONSOR_PRIVATE_KEY is missing, invalid, or address-mismatched.");

  const client = getRobomataSuiClient();
  const gasBudget = getRobomataSuiSponsorGasBudget();
  const tx = buildSuiCommitTransaction(input);
  const kindBytes = await withTimeout(() => tx.build({ client, onlyTransactionKind: true }), getRobomataSuiTimeoutMs());
  const sponsoredTx = Transaction.fromKind(kindBytes);
  const gasPayment = await selectSponsorGasPayment({ sponsorAddress: sponsor.address, gasBudget });

  sponsoredTx.setSender(input.facilityOperatorAddress);
  sponsoredTx.setGasOwner(sponsor.address);
  sponsoredTx.setGasBudget(gasBudget);
  sponsoredTx.setGasPayment([gasPayment]);

  const transactionBytes = await withTimeout(() => sponsoredTx.build({ client }), getRobomataSuiTimeoutMs());
  const { signature: sponsorSignature } = await sponsor.keypair.signTransaction(transactionBytes);

  return {
    chain: `sui:${getRobomataSuiNetwork()}`,
    transactionJson: await sponsoredTx.toJSON(),
    facilityObjectId: input.facilityObjectId,
    facilityOperatorAddress: input.facilityOperatorAddress,
    label: input.label,
    rootDigest: input.rootDigest,
    packageId: process.env.ROBOMATA_SUI_PACKAGE_ID ?? "",
    sponsorship: {
      gasBudget,
      gasObjectId: gasPayment.objectId,
      sponsorAddress: sponsor.address,
      sponsorSignature,
      transactionBytes: toBase64(transactionBytes),
    },
  };
}

async function executeSuiCommit(input: {
  facilityObjectId: string;
  label: string;
  rootDigest: string;
}): Promise<SuiCommitResult> {
  const signer = getRobomataSuiServerSigner();
  if (!signer) {
    return {
      errorMessage: "ROBOMATA_SUI_PRIVATE_KEY is missing or invalid for this app runtime.",
      uncertain: false,
    };
  }

  const tx = buildSuiCommitTransaction(input);

  try {
    const client = getRobomataSuiClient();
    const result = await withTimeout(
      signal =>
        client.core.signAndExecuteTransaction({
          signer: signer.keypair,
          transaction: tx,
          include: { effects: true },
          signal,
        }),
      getRobomataSuiTimeoutMs(),
    );

    if (result.Transaction) return { txDigest: result.Transaction.digest, uncertain: false };
    if (result.FailedTransaction) {
      return {
        txDigest: result.FailedTransaction.digest,
        errorMessage:
          result.FailedTransaction.status.error?.message ??
          String(result.FailedTransaction.status.error ?? "Sui transaction failed."),
        uncertain: false,
      };
    }

    return {
      errorMessage: "Sui transaction status was missing from SDK output.",
      uncertain: true,
    };
  } catch (error) {
    return {
      errorMessage:
        error instanceof Error
          ? `Sui commit response was not confirmed and must be reconciled before retry: ${error.message}`
          : "Sui commit response was not confirmed and must be reconciled before retry.",
      uncertain: true,
    };
  }
}

async function executeSponsoredOperatorSuiCommit(input: {
  operatorSignature: string;
  sponsorSignature: string;
  transactionBytes: string;
}): Promise<SuiCommitResult> {
  try {
    const client = getRobomataSuiClient();
    const result = await withTimeout(
      signal =>
        client.core.executeTransaction({
          transaction: fromBase64(input.transactionBytes),
          signatures: [input.operatorSignature, input.sponsorSignature],
          include: { effects: true },
          signal,
        }),
      getRobomataSuiTimeoutMs(),
    );

    if (result.Transaction) return { txDigest: result.Transaction.digest, uncertain: false };
    if (result.FailedTransaction) {
      return {
        txDigest: result.FailedTransaction.digest,
        errorMessage:
          result.FailedTransaction.status.error?.message ??
          String(result.FailedTransaction.status.error ?? "Sui sponsored transaction failed."),
        uncertain: false,
      };
    }

    return {
      errorMessage: "Sponsored Sui transaction status was missing from SDK output.",
      uncertain: true,
    };
  } catch (error) {
    return {
      errorMessage:
        error instanceof Error
          ? `Sponsored Sui commit response was not confirmed and must be reconciled before retry: ${error.message}`
          : "Sponsored Sui commit response was not confirmed and must be reconciled before retry.",
      uncertain: true,
    };
  }
}

async function keepCommitInReconciliationState(input: { submission: FacilitySubmission; error: string }) {
  return NextResponse.json(
    {
      submission: input.submission,
      error: input.error,
    },
    { status: 202 },
  );
}

async function markCommitFailed(input: {
  store: ReturnType<typeof getSubmissionStore>;
  submission: FacilitySubmission;
  rootDigest: string;
  error: string;
}) {
  const failed = await input.store.failEvidenceCommit(input.submission.id, input.rootDigest, input.error);
  return NextResponse.json(
    {
      submission: failed ?? input.submission,
      error: input.error,
    },
    { status: 500 },
  );
}

export async function POST(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
  const featureError = requireRobomataWorkflow();
  if (featureError) return featureError;
  const mutationError = requireRobomataMutation();
  if (mutationError) return mutationError;

  const { submissionId } = await context.params;
  const store = getSubmissionStore();
  let submission = await store.get(submissionId);

  if (!submission) {
    return NextResponse.json({ error: "Submission not found." }, { status: 404 });
  }

  const partnerAddress = await requirePartnerAddress(request);
  if (partnerAddress instanceof NextResponse) return partnerAddress;

  const accessError = requireSubmissionAccess(submission, partnerAddress);
  if (accessError) return accessError;

  const requestBody = await parseCommitEvidenceRequest(request);
  const commitMode = requestBody.mode ?? "server";

  if (submission.evidenceCommit.status === "committed") {
    return NextResponse.json({ submission });
  }

  if (!submission.evidenceCommit.evidenceRoot || !submission.evidenceCommit.rootDigest) {
    return NextResponse.json({ error: "Compute the submission before committing evidence." }, { status: 400 });
  }

  if (!submission.computation || submission.computation.borrowingBase.exceptionCount > 0) {
    return NextResponse.json(
      { error: "Resolve open borrowing-base and evidence exceptions before committing evidence." },
      { status: 400 },
    );
  }

  const facilityObjectId = resolveSubmissionFacilityObjectId(submission);
  const facilityOperatorAddress = resolveSubmissionFacilityOperatorAddress(submission);

  if (!facilityObjectId) {
    return NextResponse.json({ error: "Sui facility object is not configured for this submission." }, { status: 400 });
  }

  if (!facilityOperatorAddress) {
    return NextResponse.json(
      { error: "Sui facility operator is not configured for this submission." },
      { status: 400 },
    );
  }

  const serverCommitConfigured = isRobomataSuiCommitRuntimeConfigured({ facilityObjectId, facilityOperatorAddress });
  const operatorCommitConfigured = isRobomataSuiOperatorCommitRuntimeConfigured({
    facilityObjectId,
    facilityOperatorAddress,
  });
  const sponsoredOperatorCommitConfigured = isRobomataSuiSponsorshipRuntimeConfigured({
    facilityObjectId,
    facilityOperatorAddress,
  });

  if (commitMode === "server" && operatorCommitConfigured) {
    return NextResponse.json(
      { error: "Operator-owned Sui commit is enabled for this submission; server signing is disabled." },
      { status: 400 },
    );
  }

  if (commitMode === "server" && !serverCommitConfigured) {
    return NextResponse.json(
      { error: "Sui commit environment is not configured for this app runtime." },
      { status: 400 },
    );
  }

  if (
    [
      "operator_prepare",
      "operator_prepare_sponsored",
      "operator_complete",
      "operator_complete_sponsored",
      "operator_release",
    ].includes(commitMode) &&
    !operatorCommitConfigured
  ) {
    return NextResponse.json(
      { error: "Operator-owned Sui commit is not configured for this app runtime." },
      { status: 400 },
    );
  }

  if (
    ["operator_prepare_sponsored", "operator_complete_sponsored"].includes(commitMode) &&
    !sponsoredOperatorCommitConfigured
  ) {
    return NextResponse.json(
      { error: "Native Sui sponsorship is not configured for this app runtime." },
      { status: 400 },
    );
  }

  const rootDigest = submission.evidenceCommit.rootDigest;
  const label = `submission_${submission.id}`;
  let operatorWalletAddress: string | undefined;
  if (commitMode === "operator_complete" || commitMode === "operator_complete_sponsored") {
    operatorWalletAddress = requestBody.walletAddress?.toLowerCase();
    if ((requestBody.txDigest || requestBody.operatorSignature) && !operatorWalletAddress) {
      return NextResponse.json({ error: "Operator Sui wallet address is required." }, { status: 400 });
    }
    if (operatorWalletAddress && operatorWalletAddress !== facilityOperatorAddress.toLowerCase()) {
      return NextResponse.json(
        { error: "Operator Sui wallet does not match the configured facility operator." },
        { status: 400 },
      );
    }
  }

  if (
    submission.evidenceCommit.status === "committing" &&
    (!["operator_complete", "operator_complete_sponsored", "operator_release"].includes(commitMode) ||
      isStaleCommit(submission))
  ) {
    if (!isStaleCommit(submission)) {
      return NextResponse.json(
        { error: "Evidence commit is already in progress for this submission." },
        { status: 409 },
      );
    }

    let txDigest: string | undefined;
    try {
      txDigest = requestBody.txDigest
        ? await findCommittedEvidenceEventInTransaction({
            txDigest: requestBody.txDigest,
            facilityObjectId,
            label,
            rootDigest,
          })
        : undefined;
      txDigest ??= await findCommittedEvidenceEvent({ facilityObjectId, label, rootDigest });
    } catch (error) {
      if (isFailedSuiTransactionError(error)) {
        const released = await store.failEvidenceCommit(submission.id, rootDigest, error.message);
        return NextResponse.json({ submission: released ?? submission, error: error.message }, { status: 409 });
      }

      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? "Stale evidence commit requires Sui reconciliation, but event lookup failed: " + error.message
              : "Stale evidence commit requires Sui reconciliation, but event lookup failed.",
        },
        { status: 409 },
      );
    }

    if (txDigest) {
      const reconciled = await store.completeEvidenceCommit(submission.id, rootDigest, {
        txDigest,
        committedAt: new Date().toISOString(),
        facilityObjectId,
        facilityOperatorAddress,
        ...(commitMode === "operator_complete" || commitMode === "operator_complete_sponsored"
          ? {
              commitAuthority: "operator" as const,
              operatorWalletAddress: operatorWalletAddress ?? facilityOperatorAddress,
              ...(commitMode === "operator_complete_sponsored"
                ? {
                    sponsorshipMode: "native_sui" as const,
                    sponsorAddress: getRobomataSuiSponsorSigner()?.address,
                  }
                : {}),
            }
          : {}),
      });
      if (reconciled) return NextResponse.json({ submission: reconciled });

      return NextResponse.json(
        { error: "Sui evidence commit was found, but local commit state changed before it could be reconciled." },
        { status: 409 },
      );
    }

    const released = await store.failEvidenceCommit(
      submission.id,
      rootDigest,
      "Previous evidence commit attempt timed out before a matching Sui event was found.",
    );
    if (!released) {
      const latest = await store.get(submission.id);
      if (latest?.evidenceCommit.status === "committed") return NextResponse.json({ submission: latest });
      return NextResponse.json(
        { error: "Evidence commit state changed before the stale attempt could be released." },
        { status: 409 },
      );
    }
    if (commitMode === "operator_complete") {
      return NextResponse.json(
        {
          submission: released,
          error: "Previous operator evidence commit attempt timed out before a matching Sui event was found.",
        },
        { status: 409 },
      );
    }
    submission = released;
  }

  if (commitMode === "operator_release") {
    if (submission.evidenceCommit.status !== "committing") return NextResponse.json({ submission });
    const released = await store.failEvidenceCommit(
      submission.id,
      rootDigest,
      "Operator Sui wallet signing was cancelled before a transaction digest was returned.",
    );
    return NextResponse.json({ submission: released ?? submission });
  }

  if (commitMode === "operator_prepare" || commitMode === "operator_prepare_sponsored") {
    const committingSubmission = await store.beginEvidenceCommit(submission.id, rootDigest, new Date().toISOString());
    if (!committingSubmission) {
      const latest = await store.get(submission.id);
      if (latest?.evidenceCommit.status === "committed") return NextResponse.json({ submission: latest });
      return NextResponse.json(
        { error: "Evidence commit is already in progress or the evidence root has changed." },
        { status: 409 },
      );
    }

    try {
      const operatorCommit =
        sponsoredOperatorCommitConfigured || commitMode === "operator_prepare_sponsored"
          ? await prepareSponsoredOperatorSuiCommit({
              facilityObjectId,
              facilityOperatorAddress,
              label,
              rootDigest,
            })
          : await prepareOperatorSuiCommit({
              facilityObjectId,
              facilityOperatorAddress,
              label,
              rootDigest,
            });
      return NextResponse.json({ submission: committingSubmission, operatorCommit });
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? "Failed to prepare operator Sui transaction: " + error.message
          : "Failed to prepare operator Sui transaction.";
      const failed = await store.failEvidenceCommit(committingSubmission.id, rootDigest, errorMessage);
      return NextResponse.json(
        {
          submission: failed ?? committingSubmission,
          error: errorMessage,
        },
        { status: 500 },
      );
    }
  }

  if (commitMode === "operator_complete_sponsored") {
    const sponsor = getRobomataSuiSponsorSigner();
    if (!sponsor) {
      return NextResponse.json(
        { error: "ROBOMATA_SUI_SPONSOR_PRIVATE_KEY is missing, invalid, or address-mismatched." },
        { status: 400 },
      );
    }
    if (
      !requestBody.txDigest &&
      (!requestBody.operatorSignature || !requestBody.sponsorSignature || !requestBody.transactionBytes)
    ) {
      return NextResponse.json(
        {
          error:
            "Sponsored operator completion requires a transaction digest or transaction bytes plus operator and sponsor signatures.",
        },
        { status: 400 },
      );
    }

    const result = requestBody.txDigest
      ? ({ txDigest: requestBody.txDigest, uncertain: false } satisfies SuiCommitResult)
      : await executeSponsoredOperatorSuiCommit({
          operatorSignature: requestBody.operatorSignature ?? "",
          sponsorSignature: requestBody.sponsorSignature ?? "",
          transactionBytes: requestBody.transactionBytes ?? "",
        });

    if (result.errorMessage) {
      if (result.uncertain) {
        return keepCommitInReconciliationState({
          submission,
          error: `${result.errorMessage} Reconcile Sui events before retrying.`,
        });
      }

      return markCommitFailed({
        store,
        submission,
        rootDigest,
        error: result.errorMessage,
      });
    }

    let txDigest: string | undefined;
    try {
      txDigest = result.txDigest
        ? await findCommittedEvidenceEventInTransaction({
            txDigest: result.txDigest,
            facilityObjectId,
            label,
            rootDigest,
          })
        : undefined;
      txDigest ??= await findCommittedEvidenceEvent({ facilityObjectId, label, rootDigest });
    } catch (error) {
      if (isFailedSuiTransactionError(error)) {
        const released = await store.failEvidenceCommit(submission.id, rootDigest, error.message);
        return NextResponse.json({ submission: released ?? submission, error: error.message }, { status: 409 });
      }

      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? "Sponsored operator Sui commit requires event reconciliation, but event lookup failed: " + error.message
              : "Sponsored operator Sui commit requires event reconciliation, but event lookup failed.",
        },
        { status: 409 },
      );
    }

    if (!txDigest) {
      return NextResponse.json(
        {
          submission,
          txDigest: result.txDigest,
          error: result.txDigest
            ? `Sponsored Sui transaction ${result.txDigest} was submitted, but the matching EvidenceCommitted event is not indexed yet. Retry completion shortly.`
            : "The matching EvidenceCommitted event is not indexed yet. Retry completion shortly.",
        },
        { status: 202 },
      );
    }

    const saved = await store.completeEvidenceCommit(submission.id, rootDigest, {
      txDigest,
      committedAt: new Date().toISOString(),
      facilityObjectId,
      facilityOperatorAddress,
      commitAuthority: "operator",
      operatorWalletAddress: operatorWalletAddress ?? facilityOperatorAddress,
      sponsorshipMode: "native_sui",
      sponsorAddress: sponsor.address,
    });

    if (saved) return NextResponse.json({ submission: saved });
    const latest = await store.get(submission.id);
    if (latest?.evidenceCommit.status === "committed") return NextResponse.json({ submission: latest });
    return NextResponse.json(
      { error: "Sponsored operator Sui commit was found, but local commit state changed before it could be saved." },
      { status: 409 },
    );
  }

  if (commitMode === "operator_complete") {
    let txDigest: string | undefined;
    try {
      txDigest = requestBody.txDigest
        ? await findCommittedEvidenceEventInTransaction({
            txDigest: requestBody.txDigest,
            facilityObjectId,
            label,
            rootDigest,
          })
        : undefined;
      txDigest ??= await findCommittedEvidenceEvent({ facilityObjectId, label, rootDigest });
    } catch (error) {
      if (isFailedSuiTransactionError(error)) {
        const released = await store.failEvidenceCommit(submission.id, rootDigest, error.message);
        return NextResponse.json({ submission: released ?? submission, error: error.message }, { status: 409 });
      }

      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? "Operator Sui commit requires event reconciliation, but event lookup failed: " + error.message
              : "Operator Sui commit requires event reconciliation, but event lookup failed.",
        },
        { status: 409 },
      );
    }

    if (!txDigest) {
      return NextResponse.json(
        {
          submission,
          error: requestBody.txDigest
            ? `Sui transaction ${requestBody.txDigest} was submitted, but the matching EvidenceCommitted event is not indexed yet. Retry completion shortly.`
            : "The matching EvidenceCommitted event is not indexed yet. Retry completion shortly.",
        },
        { status: 202 },
      );
    }

    const saved = await store.completeEvidenceCommit(submission.id, rootDigest, {
      txDigest,
      committedAt: new Date().toISOString(),
      facilityObjectId,
      facilityOperatorAddress,
      commitAuthority: "operator",
      operatorWalletAddress: operatorWalletAddress ?? facilityOperatorAddress,
    });

    if (saved) return NextResponse.json({ submission: saved });
    const latest = await store.get(submission.id);
    if (latest?.evidenceCommit.status === "committed") return NextResponse.json({ submission: latest });
    return NextResponse.json(
      { error: "Operator Sui commit was found, but local commit state changed before it could be saved." },
      { status: 409 },
    );
  }

  const committingSubmission = await store.beginEvidenceCommit(submission.id, rootDigest, new Date().toISOString());
  if (!committingSubmission) {
    const latest = await store.get(submission.id);
    if (latest?.evidenceCommit.status === "committed") {
      return NextResponse.json({ submission: latest });
    }
    return NextResponse.json(
      { error: "Evidence commit is already in progress or the evidence root has changed." },
      { status: 409 },
    );
  }

  const result = await executeSuiCommit({ facilityObjectId, label, rootDigest });
  if (result.errorMessage) {
    if (result.uncertain) {
      return keepCommitInReconciliationState({
        submission: committingSubmission,
        error: `${result.errorMessage} Reconcile Sui events before retrying.`,
      });
    }

    return markCommitFailed({
      store,
      submission: committingSubmission,
      rootDigest,
      error: result.errorMessage,
    });
  }

  try {
    const saved = await store.completeEvidenceCommit(committingSubmission.id, rootDigest, {
      txDigest: result.txDigest,
      committedAt: new Date().toISOString(),
      facilityObjectId,
      facilityOperatorAddress,
      commitAuthority: "server",
    });
    if (saved) return NextResponse.json({ submission: saved });
  } catch {
    // The Sui side effect has already returned successfully. Leave the commit as in-progress
    // so a stale retry must reconcile the on-chain event before any new Sui call.
  }

  return NextResponse.json(
    { error: "Sui commit may have succeeded, but local persistence did not confirm it. Retry after reconciliation." },
    { status: 202 },
  );
}
