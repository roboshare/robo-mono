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
      patch: ReceivablePatch;
    }
  | {
      action: "updateEvidenceStatus";
      evidenceId: string;
      status: "verified" | "exception" | "pending";
    };

type ReceivablePatch = Partial<{
  obligor: string;
  vehicleCount: number;
  outstandingCents: number;
  daysPastDue: number;
  utilizationPct: number;
  insured: boolean;
  titleClear: boolean;
  lockboxMatched: boolean;
}>;

function normalizeNumberPatch(
  value: unknown,
  field: string,
  options: { integer?: boolean; min?: number; max?: number } = {},
) {
  if (value === undefined) return undefined;
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

function normalizeBooleanPatch(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}

function normalizeStringPatch(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeReceivablePatch(patch: ReceivablePatch): ReceivablePatch {
  const next: ReceivablePatch = {};

  if (patch.obligor !== undefined) {
    if (typeof patch.obligor !== "string" || !patch.obligor.trim()) {
      throw new Error("obligor must be a non-empty string.");
    }
    next.obligor = patch.obligor.trim();
  }

  next.vehicleCount = normalizeNumberPatch(patch.vehicleCount, "vehicleCount", { integer: true, min: 0 });
  next.outstandingCents = normalizeNumberPatch(patch.outstandingCents, "outstandingCents", {
    integer: true,
    min: 0,
  });
  next.daysPastDue = normalizeNumberPatch(patch.daysPastDue, "daysPastDue", { integer: true, min: 0 });
  next.utilizationPct = normalizeNumberPatch(patch.utilizationPct, "utilizationPct", { min: 0, max: 100 });
  next.insured = normalizeBooleanPatch(patch.insured, "insured");
  next.titleClear = normalizeBooleanPatch(patch.titleClear, "titleClear");
  next.lockboxMatched = normalizeBooleanPatch(patch.lockboxMatched, "lockboxMatched");

  return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined));
}

export async function GET(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
  const featureError = requireRobomataWorkflow();
  if (featureError) return featureError;

  const partnerAddress = await requirePartnerAddress(request);
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

    const partnerAddress = await requirePartnerAddress(request);
    if (partnerAddress instanceof NextResponse) return partnerAddress;

    const accessError = requireSubmissionAccess(submission, partnerAddress);
    if (accessError) return accessError;

    const body = (await request.json()) as SubmissionPatchAction;

    if (body.action === "updateSubmission") {
      const operatorName = normalizeStringPatch(body.patch.operatorName, "operatorName");
      const facilityName = normalizeStringPatch(body.patch.facilityName, "facilityName");
      const asOfDate = normalizeStringPatch(body.patch.asOfDate, "asOfDate");
      submission.operatorName = operatorName ?? submission.operatorName;
      submission.facilityName = facilityName ?? submission.facilityName;
      submission.asOfDate = asOfDate ?? submission.asOfDate;
      addAuditEvent(submission, "submission_updated", `Updated submission details for ${submission.facilityName}.`);
      invalidateSubmissionArtifacts(submission);
    }

    if (body.action === "excludeReceivable") {
      const excluded = normalizeBooleanPatch(body.excluded, "excluded");
      if (excluded === undefined) throw new Error("excluded must be provided.");
      submission.receivables = submission.receivables.map(receivable =>
        receivable.id === body.receivableId ? { ...receivable, excluded } : receivable,
      );
      addAuditEvent(
        submission,
        "receivable_excluded",
        `${excluded ? "Excluded" : "Reinstated"} receivable ${body.receivableId}.`,
        { receivableId: body.receivableId, excluded },
      );
      invalidateSubmissionArtifacts(submission);
    }

    if (body.action === "updateReceivable") {
      const patch = normalizeReceivablePatch(body.patch);
      submission.receivables = submission.receivables.map(receivable =>
        receivable.id === body.receivableId ? { ...receivable, ...patch } : receivable,
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
