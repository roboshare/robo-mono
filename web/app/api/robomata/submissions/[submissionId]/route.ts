import { NextRequest, NextResponse } from "next/server";
import { isRobomataWorkflowMutationEnabled, isRobomataWorkflowServerEnabled } from "~~/lib/featureFlags";
import { requirePartnerAddress, requireSubmissionAccess } from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import { addAuditEvent, invalidateSubmissionArtifacts } from "~~/lib/robomata/submissions";

export const runtime = "nodejs";

function requireRobomataWorkflow() {
  if (isRobomataWorkflowServerEnabled()) return null;
  return NextResponse.json({ error: "Robomata workflow is not enabled." }, { status: 404 });
}

function requireRobomataMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata submission writes are not enabled." }, { status: 403 });
}

type SubmissionPatchAction =
  | {
      action: "updateSubmission";
      patch: Partial<{
        operatorName: string;
        facilityName: string;
        asOfDate: string;
      }>;
    }
  | {
      action: "excludeReceivable";
      receivableId: string;
      excluded: boolean;
    }
  | {
      action: "updateReceivable";
      receivableId: string;
      patch: Partial<{
        obligor: string;
        vehicleCount: number;
        outstandingCents: number;
        daysPastDue: number;
        utilizationPct: number;
        insured: boolean;
        titleClear: boolean;
        lockboxMatched: boolean;
      }>;
    }
  | {
      action: "updateEvidenceStatus";
      evidenceId: string;
      status: "verified" | "exception" | "pending";
    };

export async function GET(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
  const featureError = requireRobomataWorkflow();
  if (featureError) return featureError;

  const partnerAddress = requirePartnerAddress(request);
  if (partnerAddress instanceof NextResponse) return partnerAddress;

  const { submissionId } = await context.params;
  const submission = await getSubmissionStore().get(submissionId);

  if (!submission) {
    return NextResponse.json({ error: "Submission not found." }, { status: 404 });
  }

  const accessError = requireSubmissionAccess(submission, partnerAddress);
  if (accessError) return accessError;

  return NextResponse.json({ submission });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
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

    const partnerAddress = requirePartnerAddress(request);
    if (partnerAddress instanceof NextResponse) return partnerAddress;

    const accessError = requireSubmissionAccess(submission, partnerAddress);
    if (accessError) return accessError;

    const body = (await request.json()) as SubmissionPatchAction;

    if (body.action === "updateSubmission") {
      submission.operatorName = body.patch.operatorName ?? submission.operatorName;
      submission.facilityName = body.patch.facilityName ?? submission.facilityName;
      submission.asOfDate = body.patch.asOfDate ?? submission.asOfDate;
      addAuditEvent(submission, "submission_updated", `Updated submission details for ${submission.facilityName}.`);
      invalidateSubmissionArtifacts(submission);
    }

    if (body.action === "excludeReceivable") {
      submission.receivables = submission.receivables.map(receivable =>
        receivable.id === body.receivableId ? { ...receivable, excluded: body.excluded } : receivable,
      );
      addAuditEvent(
        submission,
        "receivable_excluded",
        `${body.excluded ? "Excluded" : "Reinstated"} receivable ${body.receivableId}.`,
        { receivableId: body.receivableId, excluded: body.excluded },
      );
      invalidateSubmissionArtifacts(submission);
    }

    if (body.action === "updateReceivable") {
      submission.receivables = submission.receivables.map(receivable =>
        receivable.id === body.receivableId ? { ...receivable, ...body.patch } : receivable,
      );
      addAuditEvent(submission, "receivable_updated", `Updated receivable ${body.receivableId}.`, {
        receivableId: body.receivableId,
      });
      invalidateSubmissionArtifacts(submission);
    }

    if (body.action === "updateEvidenceStatus") {
      submission.evidence = submission.evidence.map(evidence =>
        evidence.id === body.evidenceId ? { ...evidence, status: body.status } : evidence,
      );
      addAuditEvent(submission, "evidence_updated", `Updated evidence status for ${body.evidenceId}.`, {
        evidenceId: body.evidenceId,
        status: body.status,
      });
      invalidateSubmissionArtifacts(submission);
    }

    const saved = await store.save(submission);
    return NextResponse.json({ submission: saved });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update submission." },
      { status: 500 },
    );
  }
}
