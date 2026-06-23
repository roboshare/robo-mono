import { NextRequest, NextResponse } from "next/server";
import { isRobomataWorkflowMutationEnabled, isRobomataWorkflowServerEnabled } from "~~/lib/featureFlags";
import { deriveSubmissionEvidenceStatuses } from "~~/lib/robomata/evidenceStatus";
import { resolveRobomataFacilityPolicyArtifact } from "~~/lib/robomata/policyRules";
import {
  requirePartnerAddress,
  requireSubmissionAccess,
  requireSubmissionMutable,
} from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import {
  addAuditEvent,
  canDeleteDraftFacilitySubmission,
  createSubmissionPolicyReview,
  invalidateSubmissionArtifacts,
  upsertSubmissionPolicyReview,
} from "~~/lib/robomata/submissions";

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
      action: "reviewPolicy";
      rationale?: unknown;
      status: "accepted" | "needs_changes";
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

const policyReviewStatuses = new Set(["accepted", "needs_changes"]);

class PatchValidationError extends Error {}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function itemNotFound(message: string) {
  return NextResponse.json({ error: message }, { status: 404 });
}

function normalizeNumberPatch(
  value: unknown,
  field: string,
  options: { integer?: boolean; min?: number; max?: number } = {},
) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PatchValidationError(`${field} must be a finite number.`);
  }
  if (options.integer && !Number.isInteger(value)) {
    throw new PatchValidationError(`${field} must be an integer.`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new PatchValidationError(`${field} must be at least ${options.min}.`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new PatchValidationError(`${field} must be at most ${options.max}.`);
  }
  return value;
}

function normalizeBooleanPatch(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new PatchValidationError(`${field} must be a boolean.`);
  return value;
}

function normalizeStringPatch(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new PatchValidationError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizePolicyReviewStatus(value: unknown) {
  if (typeof value !== "string" || !policyReviewStatuses.has(value)) {
    throw new PatchValidationError("status must be accepted or needs_changes.");
  }

  return value as "accepted" | "needs_changes";
}

function normalizeOptionalRationale(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new PatchValidationError("rationale must be a string.");
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 500) : undefined;
}

function normalizeReceivablePatch(patch: unknown): ReceivablePatch {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new PatchValidationError("patch must be an object.");
  }
  const input = patch as ReceivablePatch;
  const next: ReceivablePatch = {};

  if (input.obligor !== undefined) {
    if (typeof input.obligor !== "string" || !input.obligor.trim()) {
      throw new PatchValidationError("obligor must be a non-empty string.");
    }
    next.obligor = input.obligor.trim();
  }

  next.vehicleCount = normalizeNumberPatch(input.vehicleCount, "vehicleCount", { integer: true, min: 0 });
  next.outstandingCents = normalizeNumberPatch(input.outstandingCents, "outstandingCents", {
    integer: true,
    min: 0,
  });
  next.daysPastDue = normalizeNumberPatch(input.daysPastDue, "daysPastDue", { integer: true, min: 0 });
  next.utilizationPct = normalizeNumberPatch(input.utilizationPct, "utilizationPct", { min: 0, max: 100 });
  next.insured = normalizeBooleanPatch(input.insured, "insured");
  next.titleClear = normalizeBooleanPatch(input.titleClear, "titleClear");
  next.lockboxMatched = normalizeBooleanPatch(input.lockboxMatched, "lockboxMatched");

  return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined));
}

function requireStringId(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PatchValidationError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function refreshDerivedEvidenceStatuses(submission: Parameters<typeof deriveSubmissionEvidenceStatuses>[0]) {
  const changes = deriveSubmissionEvidenceStatuses(submission);
  if (changes.length === 0) return;

  addAuditEvent(
    submission,
    "evidence_updated",
    `Updated ${changes.length} evidence status derivation(s) from current receivable data.`,
    {
      evidenceStatusChangeCount: changes.length,
    },
  );
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

    const body = (await request.json().catch(() => null)) as Partial<SubmissionPatchAction> | null;
    if (!body || typeof body !== "object" || typeof body.action !== "string") {
      return badRequest("PATCH action is required.");
    }

    if (body.action !== "reviewPolicy") {
      const mutabilityError = requireSubmissionMutable(submission);
      if (mutabilityError) return mutabilityError;
    }

    if (body.action === "updateSubmission") {
      if (!body.patch || typeof body.patch !== "object" || Array.isArray(body.patch)) {
        return badRequest("patch must be an object.");
      }
      const patch = body.patch as Partial<{ operatorName: unknown; facilityName: unknown; asOfDate: unknown }>;
      const operatorName = normalizeStringPatch(patch.operatorName, "operatorName");
      const facilityName = normalizeStringPatch(patch.facilityName, "facilityName");
      const asOfDate = normalizeStringPatch(patch.asOfDate, "asOfDate");
      submission.operatorName = operatorName ?? submission.operatorName;
      submission.facilityName = facilityName ?? submission.facilityName;
      submission.asOfDate = asOfDate ?? submission.asOfDate;
      addAuditEvent(submission, "submission_updated", `Updated submission details for ${submission.facilityName}.`);
      invalidateSubmissionArtifacts(submission);
    } else if (body.action === "excludeReceivable") {
      const receivableId = requireStringId(body.receivableId, "receivableId");
      if (!submission.receivables.some(receivable => receivable.id === receivableId)) {
        return itemNotFound(`Receivable ${receivableId} was not found.`);
      }
      const excluded = normalizeBooleanPatch(body.excluded, "excluded");
      if (excluded === undefined) throw new PatchValidationError("excluded must be provided.");
      submission.receivables = submission.receivables.map(receivable =>
        receivable.id === receivableId ? { ...receivable, excluded } : receivable,
      );
      addAuditEvent(
        submission,
        "receivable_excluded",
        `${excluded ? "Excluded" : "Reinstated"} receivable ${receivableId}.`,
        { receivableId, excluded },
      );
      refreshDerivedEvidenceStatuses(submission);
      invalidateSubmissionArtifacts(submission);
    } else if (body.action === "updateReceivable") {
      const receivableId = requireStringId(body.receivableId, "receivableId");
      if (!submission.receivables.some(receivable => receivable.id === receivableId)) {
        return itemNotFound(`Receivable ${receivableId} was not found.`);
      }
      const patch = normalizeReceivablePatch(body.patch);
      submission.receivables = submission.receivables.map(receivable =>
        receivable.id === receivableId ? { ...receivable, ...patch } : receivable,
      );
      addAuditEvent(submission, "receivable_updated", `Updated receivable ${receivableId}.`, {
        receivableId,
      });
      refreshDerivedEvidenceStatuses(submission);
      invalidateSubmissionArtifacts(submission);
    } else if (body.action === "reviewPolicy") {
      const status = normalizePolicyReviewStatus(body.status);
      const artifact = resolveRobomataFacilityPolicyArtifact({
        facilityId: submission.facilityMonitoring?.facilityId,
        submissionId: submission.id,
      }).artifact;
      const review = createSubmissionPolicyReview({
        artifactId: artifact.id,
        artifactName: artifact.name,
        artifactVersion: artifact.version,
        rationale: normalizeOptionalRationale(body.rationale),
        reviewedBy: partnerAddress,
        reviewSurface: "operator_submission_access",
        role: "operator",
        status,
      });
      upsertSubmissionPolicyReview(submission, review);
      addAuditEvent(
        submission,
        "policy_reviewed",
        `Operator ${status === "accepted" ? "accepted" : "requested changes to"} policy artifact ${artifact.version}.`,
        {
          policyArtifactId: artifact.id,
          policyArtifactVersion: artifact.version,
          policyReviewRole: "operator",
          policyReviewStatus: status,
        },
      );
    } else {
      return badRequest(`Unsupported submission update action: ${body.action}.`);
    }

    const saved = await store.save(submission);
    return NextResponse.json({ submission: saved });
  } catch (error) {
    if (error instanceof PatchValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (
      error instanceof Error &&
      error.message === "Submission changed while this update was in progress. Reload and try again."
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update submission." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
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

    if (!canDeleteDraftFacilitySubmission(submission)) {
      return NextResponse.json(
        {
          error: "Only draft facility packages without evidence commit or tokenization activity can be deleted.",
        },
        { status: 409 },
      );
    }

    const deleted = await store.deleteDraft(submission.id, submission.updatedAt);
    if (!deleted) {
      return NextResponse.json(
        { error: "Submission changed while this delete was in progress. Reload and try again." },
        { status: 409 },
      );
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete submission." },
      { status: 500 },
    );
  }
}
