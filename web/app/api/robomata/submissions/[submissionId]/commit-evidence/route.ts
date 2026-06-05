import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isRobomataWorkflowMutationEnabled, isRobomataWorkflowServerEnabled } from "~~/lib/featureFlags";
import { requirePartnerAddress, requireSubmissionAccess } from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import { SUI_COMMIT_MODULE_PATH, addAuditEvent } from "~~/lib/robomata/submissions";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";

function isCommitConfigured() {
  return Boolean(
    process.env.ROBOMATA_SUI_PACKAGE_ID &&
      process.env.ROBOMATA_SUI_FACILITY_ID &&
      process.env.ROBOMATA_SUI_CLIENT_CONFIG,
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

  if (!submission.evidenceCommit.evidenceRoot || !submission.evidenceCommit.rootDigest) {
    return NextResponse.json({ error: "Compute the submission before committing evidence." }, { status: 400 });
  }

  if (!isCommitConfigured()) {
    return NextResponse.json(
      { error: "Sui commit environment is not configured for this app runtime." },
      { status: 400 },
    );
  }

  try {
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
      process.env.ROBOMATA_SUI_FACILITY_ID as string,
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

    submission.evidenceCommit = {
      ...submission.evidenceCommit,
      status: "committed",
      txDigest: typeof txDigest === "string" ? txDigest : undefined,
      committedAt: new Date().toISOString(),
      commitMode: "configured",
      modulePath: SUI_COMMIT_MODULE_PATH,
      facilityObjectId: process.env.ROBOMATA_SUI_FACILITY_ID,
      errorMessage: undefined,
    };
    addAuditEvent(submission, "sui_commit_completed", `Committed evidence root for ${submission.facilityName}.`, {
      txDigest: submission.evidenceCommit.txDigest ?? null,
    });

    const saved = await store.save(submission);
    return NextResponse.json({ submission: saved });
  } catch (error) {
    submission.evidenceCommit = {
      ...submission.evidenceCommit,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Unknown Sui commit failure.",
    };
    await store.save(submission);

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to commit evidence." },
      { status: 500 },
    );
  }
}
