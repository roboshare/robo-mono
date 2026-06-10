import { NextRequest, NextResponse } from "next/server";
import { Transaction } from "@mysten/sui/transactions";
import { isRobomataFacilityMonitoringEnabled, isRobomataWorkflowServerEnabled } from "~~/lib/featureFlags";
import { getFacilityMonitoringStore } from "~~/lib/robomata/server/facilityMonitoringStore";
import { requirePartnerAddress, requireSubmissionAccess } from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import {
  getRobomataSuiClient,
  getRobomataSuiGasBudget,
  getRobomataSuiServerSigner,
  getRobomataSuiTimeoutMs,
  isRobomataSuiCommitRuntimeConfigured,
} from "~~/lib/robomata/server/suiCommitConfig";
import {
  findCommittedEvidenceEvent,
  findCommittedEvidenceEventInTransaction,
  isFailedSuiTransactionError,
} from "~~/lib/robomata/server/suiEvidenceEvents";
import {
  resolveSubmissionFacilityObjectId,
  resolveSubmissionFacilityOperatorAddress,
} from "~~/lib/robomata/submissions";

export const runtime = "nodejs";

function requireRobomataMonitoring() {
  if (!isRobomataWorkflowServerEnabled()) {
    return NextResponse.json({ error: "Robomata workflow is not enabled." }, { status: 404 });
  }
  if (!isRobomataFacilityMonitoringEnabled()) {
    return NextResponse.json({ error: "Robomata facility monitoring is not enabled." }, { status: 404 });
  }

  return null;
}

async function readVerifyBody(request: NextRequest) {
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return {};
    return body as { mode?: unknown; rootCommitId?: unknown; txDigest?: unknown };
  } catch {
    return {};
  }
}

function normalizeHex(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, "");
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
      reject(new Error(`Sui monitoring root commit timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildSuiRootCommitTransaction(input: {
  facilityObjectId: string;
  label: string;
  rootDigest: string;
}): Transaction {
  const tx = new Transaction();
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

async function executeServerSuiRootCommit(input: { facilityObjectId: string; label: string; rootDigest: string }) {
  const signer = getRobomataSuiServerSigner();
  if (!signer) throw new Error("ROBOMATA_SUI_PRIVATE_KEY is missing or invalid for this app runtime.");

  const client = getRobomataSuiClient();
  const result = await withTimeout(
    signal =>
      client.core.signAndExecuteTransaction({
        signer: signer.keypair,
        transaction: buildSuiRootCommitTransaction(input),
        include: { effects: true },
        signal,
      }),
    getRobomataSuiTimeoutMs(),
  );

  if (result.Transaction) return result.Transaction.digest;
  if (result.FailedTransaction) {
    throw new Error(
      result.FailedTransaction.status.error?.message ??
        String(result.FailedTransaction.status.error ?? "Sui monitoring root transaction failed."),
    );
  }
  throw new Error("Sui transaction status was missing from SDK output.");
}

export async function GET(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
  const featureError = requireRobomataMonitoring();
  if (featureError) return featureError;

  const partnerAddress = await requirePartnerAddress(request);
  if (partnerAddress instanceof NextResponse) return partnerAddress;

  const { submissionId } = await context.params;
  const submission = await getSubmissionStore().get(submissionId);
  if (!submission) return NextResponse.json({ error: "Submission not found." }, { status: 404 });

  const accessError = requireSubmissionAccess(submission, partnerAddress);
  if (accessError) return accessError;

  const projection = await getFacilityMonitoringStore().getProjectionForSubmission(submission);
  return NextResponse.json({
    latestSuiRootCommit: projection.latestSuiRootCommit,
    suiRootCommits: projection.suiRootCommits,
    suiRootStatus: projection.suiRootStatus,
  });
}

export async function POST(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
  const featureError = requireRobomataMonitoring();
  if (featureError) return featureError;

  const partnerAddress = await requirePartnerAddress(request);
  if (partnerAddress instanceof NextResponse) return partnerAddress;

  const { submissionId } = await context.params;
  const submission = await getSubmissionStore().get(submissionId);
  if (!submission) return NextResponse.json({ error: "Submission not found." }, { status: 404 });

  const accessError = requireSubmissionAccess(submission, partnerAddress);
  if (accessError) return accessError;

  const body = await readVerifyBody(request);
  const mode = body.mode === "server_commit" ? "server_commit" : "verify";
  const rootCommitId = typeof body.rootCommitId === "string" ? body.rootCommitId.trim() : "";
  const txDigest = typeof body.txDigest === "string" ? body.txDigest.trim() : undefined;
  if (!rootCommitId) {
    return NextResponse.json({ error: "rootCommitId is required." }, { status: 400 });
  }

  const facilityObjectId = resolveSubmissionFacilityObjectId(submission);
  const facilityOperatorAddress = resolveSubmissionFacilityOperatorAddress(submission);
  if (!facilityObjectId) {
    return NextResponse.json({ error: "Sui facility object is not configured for this submission." }, { status: 400 });
  }

  const store = getFacilityMonitoringStore();
  const projection = await store.getProjectionForSubmission(submission);
  const rootCommit = projection.suiRootCommits.find(root => root.id === rootCommitId);
  if (!rootCommit) {
    return NextResponse.json({ error: "Sui root commit was not found for this submission." }, { status: 404 });
  }

  if (mode === "server_commit") {
    if (!isRobomataSuiCommitRuntimeConfigured({ facilityObjectId, facilityOperatorAddress })) {
      return NextResponse.json(
        { error: "Legacy server-signed Sui root commit is not configured for this app runtime." },
        { status: 400 },
      );
    }

    const committing = await store.updateSuiRootCommit(rootCommit.id, { status: "committing" });
    try {
      const committedTxDigest = await executeServerSuiRootCommit({
        facilityObjectId,
        label: rootCommit.label,
        rootDigest: rootCommit.rootDigest,
      });
      const matchedTxDigest = await findCommittedEvidenceEventInTransaction({
        txDigest: committedTxDigest,
        facilityObjectId,
        label: rootCommit.label,
        rootDigest: rootCommit.rootDigest,
      });
      const updated = await store.updateSuiRootCommit(rootCommit.id, {
        status: matchedTxDigest ? "verified" : "committed",
        txDigest: committedTxDigest,
        verifiedAt: matchedTxDigest ? new Date().toISOString() : undefined,
      });
      return NextResponse.json({
        suiRootCommit: updated,
        suiRootStatus: matchedTxDigest ? "verified" : "committed",
      });
    } catch (error) {
      const updated = await store.updateSuiRootCommit(rootCommit.id, {
        errorMessage: error instanceof Error ? error.message : "Sui monitoring root commit failed.",
        status: "failed",
      });
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Sui monitoring root commit failed.",
          suiRootCommit: updated ?? committing,
          suiRootStatus: "failed",
        },
        { status: 500 },
      );
    }
  }

  try {
    const matchedTxDigest = txDigest
      ? await findCommittedEvidenceEventInTransaction({
          txDigest,
          facilityObjectId,
          label: rootCommit.label,
          rootDigest: rootCommit.rootDigest,
        })
      : await findCommittedEvidenceEvent({
          facilityObjectId,
          label: rootCommit.label,
          rootDigest: rootCommit.rootDigest,
        });

    if (matchedTxDigest) {
      const updated = await store.updateSuiRootCommit(rootCommit.id, {
        status: "verified",
        txDigest: matchedTxDigest,
        verifiedAt: new Date().toISOString(),
      });
      return NextResponse.json({ suiRootCommit: updated, suiRootStatus: "verified" });
    }

    const updated = await store.updateSuiRootCommit(rootCommit.id, {
      errorMessage: txDigest
        ? `Transaction ${txDigest} did not include a matching EvidenceCommitted event for ${rootCommit.label}.`
        : `No matching EvidenceCommitted event is indexed yet for ${rootCommit.label}.`,
      status: txDigest ? "mismatch" : "retryable",
      txDigest,
    });
    return NextResponse.json(
      {
        suiRootCommit: updated,
        suiRootStatus: txDigest ? "mismatch" : "retryable",
      },
      { status: txDigest ? 409 : 202 },
    );
  } catch (error) {
    const failed = isFailedSuiTransactionError(error);
    const updated = await store.updateSuiRootCommit(rootCommit.id, {
      errorMessage: error instanceof Error ? error.message : "Sui root verification failed.",
      status: failed ? "failed" : "retryable",
      txDigest,
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Sui root verification failed.",
        suiRootCommit: updated,
        suiRootStatus: failed ? "failed" : "retryable",
      },
      { status: failed ? 409 : 202 },
    );
  }
}
