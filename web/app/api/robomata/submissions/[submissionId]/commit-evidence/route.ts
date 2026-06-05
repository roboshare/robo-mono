import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  isRobomataSuiCommitEnabled,
  isRobomataWorkflowMutationEnabled,
  isRobomataWorkflowServerEnabled,
} from "~~/lib/featureFlags";
import { requirePartnerAddress, requireSubmissionAccess } from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import {
  type FacilitySubmission,
  resolveSubmissionFacilityObjectId,
  resolveSubmissionFacilityOperatorAddress,
} from "~~/lib/robomata/submissions";

const execFileAsync = promisify(execFile);
const DEFAULT_COMMIT_STALE_MS = 10 * 60 * 1000;
const DEFAULT_EVENT_QUERY_LIMIT = 100;
const DEFAULT_EVENT_QUERY_MAX_PAGES = 10;
const DEFAULT_SUI_CLI_TIMEOUT_MS = 120_000;

export const runtime = "nodejs";

function isCommitConfigured(facilityObjectId: string | undefined, facilityOperatorAddress: string | undefined) {
  const signerAddress = process.env.ROBOMATA_SUI_SIGNER_ADDRESS?.trim().toLowerCase();

  return Boolean(
    process.env.ROBOMATA_SUI_PACKAGE_ID &&
      process.env.ROBOMATA_SUI_CLIENT_CONFIG &&
      facilityObjectId &&
      facilityOperatorAddress &&
      signerAddress === facilityOperatorAddress.toLowerCase() &&
      isRobomataSuiCommitEnabled(),
  );
}

function requireRobomataWorkflow() {
  if (isRobomataWorkflowServerEnabled()) return null;
  return NextResponse.json({ error: "Robomata workflow is not enabled." }, { status: 404 });
}

function requireRobomataMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata submission writes are not enabled." }, { status: 403 });
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

function serializeEventCursor(cursor: unknown): string | undefined {
  if (typeof cursor === "string" && cursor.length > 0) return cursor;
  if (cursor && typeof cursor === "object") return JSON.stringify(cursor);
}

async function findCommittedEvidenceEvent(input: {
  facilityObjectId: string;
  label: string;
  rootDigest: string;
}): Promise<string | undefined> {
  const eventType = `${process.env.ROBOMATA_SUI_PACKAGE_ID}::facility::EvidenceCommitted`;
  const limit = parsePositiveInteger(process.env.ROBOMATA_SUI_EVENT_QUERY_LIMIT, DEFAULT_EVENT_QUERY_LIMIT).toString();
  const maxPages = parsePositiveInteger(process.env.ROBOMATA_SUI_EVENT_QUERY_MAX_PAGES, DEFAULT_EVENT_QUERY_MAX_PAGES);
  const expectedFacility = input.facilityObjectId.toLowerCase();
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const args = [
      "client",
      "--client.config",
      process.env.ROBOMATA_SUI_CLIENT_CONFIG as string,
      "query-events",
      "--query",
      JSON.stringify({ MoveEventType: eventType }),
      "--limit",
      limit,
      "--descending-order",
      "--json",
    ];

    if (cursor) args.push("--cursor", cursor);

    const { stdout } = await execFileAsync("sui", args, {
      timeout: parsePositiveInteger(process.env.ROBOMATA_SUI_CLI_TIMEOUT_MS, DEFAULT_SUI_CLI_TIMEOUT_MS),
    });
    const payload = JSON.parse(stdout) as
      | { data?: Record<string, unknown>[]; nextCursor?: unknown; next_cursor?: unknown; hasNextPage?: unknown }
      | Record<string, unknown>[];
    const events = Array.isArray(payload) ? payload : (payload.data ?? []);

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
    if (Array.isArray(payload)) return undefined;

    const nextCursor = serializeEventCursor(payload.nextCursor ?? payload.next_cursor);
    const hasNextPage = payload.hasNextPage === true || Boolean(nextCursor);
    if (!hasNextPage || !nextCursor) return undefined;
    cursor = nextCursor;
  }

  return undefined;
}

function parseSuiTransactionResult(stdout: string): { txDigest?: string; errorMessage?: string; uncertain: boolean } {
  try {
    const payload = JSON.parse(stdout);
    const status = payload?.effects?.status?.status;
    const errorMessage = payload?.effects?.status?.error;
    const parsedTxDigest = payload?.digest ?? payload?.effects?.transactionDigest ?? undefined;
    const txDigest = typeof parsedTxDigest === "string" ? parsedTxDigest : undefined;

    if (status === "success") return { txDigest, uncertain: false };
    if (status === "failure") {
      return {
        txDigest,
        errorMessage: typeof errorMessage === "string" ? errorMessage : "Sui transaction failed.",
        uncertain: false,
      };
    }

    return {
      txDigest,
      errorMessage: "Sui transaction status was missing from CLI output.",
      uncertain: true,
    };
  } catch {
    return {
      errorMessage: "Sui transaction output was not valid JSON.",
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

  if (!isCommitConfigured(facilityObjectId, facilityOperatorAddress)) {
    return NextResponse.json(
      { error: "Sui commit environment is not configured for this app runtime." },
      { status: 400 },
    );
  }

  const rootDigest = submission.evidenceCommit.rootDigest;
  const label = `submission_${submission.id}`;

  if (submission.evidenceCommit.status === "committing") {
    if (!isStaleCommit(submission)) {
      return NextResponse.json(
        { error: "Evidence commit is already in progress for this submission." },
        { status: 409 },
      );
    }

    let txDigest: string | undefined;
    try {
      txDigest = await findCommittedEvidenceEvent({ facilityObjectId, label, rootDigest });
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? `Stale evidence commit requires Sui reconciliation, but event lookup failed: ${error.message}`
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
    submission = released;
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

  const gasBudget = process.env.ROBOMATA_SUI_GAS_BUDGET ?? "100000000";
  const args = [
    "client",
    "--client.config",
    process.env.ROBOMATA_SUI_CLIENT_CONFIG as string,
    "call",
    "--package",
    process.env.ROBOMATA_SUI_PACKAGE_ID as string,
    "--module",
    "facility",
    "--function",
    "commit_evidence",
    "--args",
    facilityObjectId,
    label,
    rootDigest,
    "--gas-budget",
    gasBudget,
    "--json",
  ];

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("sui", args, {
      timeout: parsePositiveInteger(process.env.ROBOMATA_SUI_CLI_TIMEOUT_MS, DEFAULT_SUI_CLI_TIMEOUT_MS),
    }));
  } catch (error) {
    return keepCommitInReconciliationState({
      submission: committingSubmission,
      error:
        error instanceof Error
          ? `Sui commit response was not confirmed and must be reconciled before retry: ${error.message}`
          : "Sui commit response was not confirmed and must be reconciled before retry.",
    });
  }

  const result = parseSuiTransactionResult(stdout);
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
