import { NextRequest, NextResponse } from "next/server";
import { isRobomataWorkflowMutationEnabled, isRobomataWorkflowServerEnabled } from "~~/lib/featureFlags";
import { createEvidenceRecord } from "~~/lib/robomata/server/evidenceStorage";
import {
  requirePartnerAddress,
  requireSubmissionAccess,
  requireSubmissionMutable,
} from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import {
  type FacilitySubmission,
  type SubmissionEvidence,
  addAuditEvent,
  invalidateSubmissionArtifacts,
} from "~~/lib/robomata/submissions";

export const runtime = "nodejs";

const evidenceStatuses = new Set(["verified", "exception", "pending"]);

function requireRobomataWorkflow() {
  if (isRobomataWorkflowServerEnabled()) return null;
  return NextResponse.json({ error: "Robomata workflow is not enabled." }, { status: 404 });
}

function requireRobomataMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata submission writes are not enabled." }, { status: 403 });
}

function normalizeEvidenceStatus(value: FormDataEntryValue | null) {
  const status = String(value ?? "pending").trim();
  if (!evidenceStatuses.has(status)) {
    throw new Error("Evidence status must be verified, exception, or pending.");
  }

  return status as "verified" | "exception" | "pending";
}

function isConcurrentSubmissionChange(error: unknown) {
  return error instanceof Error && error.message.includes("Submission changed while this update was in progress");
}

function isCommitInProgressError(error: unknown) {
  return error instanceof Error && error.message.includes("Evidence commit is in progress");
}

async function reserveEvidenceUpload({
  label,
  partnerAddress,
  submissionId,
  store,
}: {
  label: string;
  partnerAddress: string;
  submissionId: string;
  store: ReturnType<typeof getSubmissionStore>;
}): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    const latestSubmission = await store.get(submissionId);
    if (!latestSubmission) {
      throw new Error("Submission not found.");
    }

    const accessError = requireSubmissionAccess(latestSubmission, partnerAddress);
    if (accessError) {
      throw new Error("Submission not found.");
    }
    const mutabilityError = requireSubmissionMutable(latestSubmission);
    if (mutabilityError) {
      throw new Error("Evidence commit is in progress for this submission. Try again after it completes.");
    }

    invalidateSubmissionArtifacts(latestSubmission);
    addAuditEvent(latestSubmission, "evidence_updated", `Reserved evidence upload for ${label}.`, {
      label,
    });

    try {
      await store.save(latestSubmission);
      return;
    } catch (error) {
      lastError = error;
      if (!isConcurrentSubmissionChange(error)) break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to reserve evidence upload.");
}

async function saveEvidenceRecord({
  evidence,
  partnerAddress,
  submissionId,
  store,
}: {
  evidence: SubmissionEvidence;
  partnerAddress: string;
  submissionId: string;
  store: ReturnType<typeof getSubmissionStore>;
}): Promise<FacilitySubmission> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    const latestSubmission = await store.get(submissionId);
    if (!latestSubmission) {
      throw new Error("Submission not found.");
    }

    const accessError = requireSubmissionAccess(latestSubmission, partnerAddress);
    if (accessError) {
      throw new Error("Submission not found.");
    }
    const mutabilityError = requireSubmissionMutable(latestSubmission);
    if (mutabilityError) {
      throw new Error("Evidence commit is in progress for this submission. Try again after it completes.");
    }

    latestSubmission.evidence = [evidence, ...latestSubmission.evidence.filter(record => record.id !== evidence.id)];
    invalidateSubmissionArtifacts(latestSubmission);
    addAuditEvent(latestSubmission, "evidence_uploaded", `Uploaded evidence package ${evidence.label}.`, {
      evidenceId: evidence.id,
      storageBackend: evidence.storageBackend,
    });

    try {
      return await store.save(latestSubmission);
    } catch (error) {
      lastError = error;
      if (!isConcurrentSubmissionChange(error)) break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to persist evidence.");
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

    const formData = await request.formData();
    const file = formData.get("file");
    const label = String(formData.get("label") ?? "").trim();
    const source = String(formData.get("source") ?? "").trim();
    const scope = String(formData.get("scope") ?? "").trim();
    const status = normalizeEvidenceStatus(formData.get("status"));
    const sealPolicyId = String(formData.get("sealPolicyId") ?? "seal://policy/lender-auditor-read").trim();
    const linkedReceivableIds = String(formData.get("linkedReceivableIds") ?? "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean);

    if (!(file instanceof File) || !label || !source || !scope) {
      return NextResponse.json({ error: "Evidence upload is missing required fields." }, { status: 400 });
    }

    await reserveEvidenceUpload({ label, partnerAddress, submissionId, store });

    const evidence = await createEvidenceRecord({
      file,
      label,
      source,
      scope,
      status,
      sealPolicyId,
      linkedReceivableIds,
    });

    const saved = await saveEvidenceRecord({ evidence, partnerAddress, submissionId, store });
    return NextResponse.json({ submission: saved, evidence });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to upload evidence." },
      { status: isCommitInProgressError(error) ? 409 : 500 },
    );
  }
}
