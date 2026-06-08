import { NextRequest, NextResponse } from "next/server";
import { isRobomataWorkflowMutationEnabled, isRobomataWorkflowServerEnabled } from "~~/lib/featureFlags";
import {
  getPrivyUserFromRequest,
  requirePartnerAddress,
  requireSubmissionAccess,
  requireSubmissionMutable,
} from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import { ensureSubmissionSuiFacility } from "~~/lib/robomata/server/suiFacilityAssignment";
import { computeSubmissionArtifacts } from "~~/lib/robomata/submissionAdapters";
import { addAuditEvent } from "~~/lib/robomata/submissions";

export const runtime = "nodejs";

function requireRobomataWorkflow() {
  if (isRobomataWorkflowServerEnabled()) return null;
  return NextResponse.json({ error: "Robomata workflow is not enabled." }, { status: 404 });
}

function requireRobomataMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata submission writes are not enabled." }, { status: 403 });
}

export async function POST(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
  try {
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
    const mutabilityError = requireSubmissionMutable(submission);
    if (mutabilityError) return mutabilityError;

    if (submission.receivables.length === 0) {
      return NextResponse.json({ error: "Import receivables before computing the borrowing base." }, { status: 400 });
    }

    if (submission.evidence.length === 0) {
      return NextResponse.json({ error: "Upload evidence before computing the borrowing base." }, { status: 400 });
    }

    submission.computation = await computeSubmissionArtifacts(submission);
    addAuditEvent(submission, "borrowing_base_computed", `Computed borrowing base for ${submission.facilityName}.`, {
      exceptionCount: submission.computation.borrowingBase.exceptionCount,
    });

    const saved = await store.save(submission);
    const privyUser = await getPrivyUserFromRequest(request).catch(() => null);
    const assignment = await ensureSubmissionSuiFacility({
      partnerAddress,
      privyUserId: privyUser?.id ?? null,
      store,
      submission: saved,
    });

    return NextResponse.json({ submission: assignment.submission });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to compute borrowing base." },
      { status: 500 },
    );
  }
}
