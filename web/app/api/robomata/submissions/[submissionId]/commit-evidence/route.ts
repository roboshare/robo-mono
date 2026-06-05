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
  SUI_COMMIT_MODULE_PATH,
  addAuditEvent,
  resolveSubmissionFacilityObjectId,
  resolveSubmissionFacilityOperatorAddress,
} from "~~/lib/robomata/submissions";

const execFileAsync = promisify(execFile);

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

export async function POST(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
  const featureError = requireRobomataWorkflow();
  if (featureError) return featureError;
  const mutationError = requireRobomataMutation();
  if (mutationError) return mutationError;

  const { submissionId } = await context.params;
  const store = getSubmissionStore();
  const submission = await store.get(submissionId);

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

  if (submission.evidenceCommit.status === "committing") {
    return NextResponse.json({ error: "Evidence commit is already in progress for this submission." }, { status: 409 });
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

  try {
    const committingSubmission = await store.beginEvidenceCommit(submission.id, submission.evidenceCommit.rootDigest);
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

    const label = `submission_${submission.id}`;
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
      submission.evidenceCommit.rootDigest,
      "--gas-budget",
      gasBudget,
      "--json",
    ];

    const { stdout } = await execFileAsync("sui", args);
    const payload = JSON.parse(stdout);
    const txDigest =
      payload?.digest ?? payload?.effects?.transactionDigest ?? payload?.effects?.status?.success ?? undefined;

    committingSubmission.evidenceCommit = {
      ...committingSubmission.evidenceCommit,
      status: "committed",
      txDigest: typeof txDigest === "string" ? txDigest : undefined,
      committedAt: new Date().toISOString(),
      commitMode: "configured",
      modulePath: SUI_COMMIT_MODULE_PATH,
      facilityObjectId,
      facilityOperatorAddress,
      errorMessage: undefined,
    };
    addAuditEvent(
      committingSubmission,
      "sui_commit_completed",
      `Committed evidence root for ${committingSubmission.facilityName}.`,
      {
        txDigest: committingSubmission.evidenceCommit.txDigest ?? null,
      },
    );

    const saved = await store.save(committingSubmission);
    return NextResponse.json({ submission: saved });
  } catch (error) {
    const latest = await store.get(submission.id);
    if (latest?.evidenceCommit.status === "committed") {
      return NextResponse.json({ submission: latest });
    }

    if (
      !latest ||
      latest.evidenceCommit.status !== "committing" ||
      latest.evidenceCommit.rootDigest !== submission.evidenceCommit.rootDigest
    ) {
      return NextResponse.json(
        { error: "Evidence commit state changed before the failed commit could be recorded." },
        { status: 409 },
      );
    }

    const failedSubmission = latest;
    failedSubmission.evidenceCommit = {
      ...failedSubmission.evidenceCommit,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Unknown Sui commit failure.",
    };
    await store.save(failedSubmission);

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to commit evidence." },
      { status: 500 },
    );
  }
}
