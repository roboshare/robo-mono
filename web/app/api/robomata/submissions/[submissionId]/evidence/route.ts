import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataWalrusUploadsEnabled,
  isRobomataWorkflowMutationEnabled,
  isRobomataWorkflowServerEnabled,
} from "~~/lib/featureFlags";
import { createEvidenceRecord } from "~~/lib/robomata/server/evidenceStorage";
import {
  requirePartnerAddress,
  requireSubmissionAccess,
  requireSubmissionMutable,
} from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import {
  type FacilitySubmission,
  type SubmissionComputation,
  type SubmissionEvidence,
  type SubmissionEvidenceCommit,
  addAuditEvent,
  invalidateSubmissionArtifacts,
  resolveSubmissionFacilityObjectId,
} from "~~/lib/robomata/submissions";

export const runtime = "nodejs";

const DEFAULT_EVIDENCE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const MULTIPART_UPLOAD_OVERHEAD_BYTES = 1024 * 1024;
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

function getEvidenceUploadMaxBytes() {
  const parsed = Number.parseInt(process.env.ROBOMATA_EVIDENCE_UPLOAD_MAX_BYTES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EVIDENCE_UPLOAD_MAX_BYTES;
}

function buildUploadTooLargeResponse(maxBytes: number) {
  return NextResponse.json(
    { error: `Evidence upload exceeds the configured ${maxBytes} byte limit.` },
    { status: 413 },
  );
}

type EvidenceUploadReservation = {
  evidenceCount: number;
  computation: SubmissionComputation | null;
  exceptions: FacilitySubmission["exceptions"];
  evidenceCommit: SubmissionEvidenceCommit;
  reservedArtifactState: {
    computation: SubmissionComputation | null;
    exceptions: FacilitySubmission["exceptions"];
    evidenceCommit: SubmissionEvidenceCommit;
  };
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
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
}): Promise<EvidenceUploadReservation> {
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

    const evidenceCount = latestSubmission.evidence.length;
    const previousComputation = cloneJson(latestSubmission.computation);
    const previousExceptions = cloneJson(latestSubmission.exceptions);
    const previousEvidenceCommit = cloneJson(latestSubmission.evidenceCommit);
    invalidateSubmissionArtifacts(latestSubmission);
    const reservation: EvidenceUploadReservation = {
      evidenceCount,
      computation: previousComputation,
      exceptions: previousExceptions,
      evidenceCommit: previousEvidenceCommit,
      reservedArtifactState: {
        computation: cloneJson(latestSubmission.computation),
        exceptions: cloneJson(latestSubmission.exceptions),
        evidenceCommit: cloneJson(latestSubmission.evidenceCommit),
      },
    };
    addAuditEvent(latestSubmission, "evidence_updated", `Reserved evidence upload for ${label}.`, {
      label,
    });

    try {
      await store.save(latestSubmission);
      return reservation;
    } catch (error) {
      lastError = error;
      if (!isConcurrentSubmissionChange(error)) break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to reserve evidence upload.");
}

async function rollbackEvidenceUploadReservation({
  partnerAddress,
  reservation,
  submissionId,
  store,
}: {
  partnerAddress: string;
  reservation: EvidenceUploadReservation;
  submissionId: string;
  store: ReturnType<typeof getSubmissionStore>;
}) {
  const latestSubmission = await store.get(submissionId);
  if (!latestSubmission || latestSubmission.evidence.length !== reservation.evidenceCount) return;

  const accessError = requireSubmissionAccess(latestSubmission, partnerAddress);
  if (accessError) return;
  if (latestSubmission.evidenceCommit.status === "committing") return;
  if (
    !sameJson(latestSubmission.computation, reservation.reservedArtifactState.computation) ||
    !sameJson(latestSubmission.exceptions, reservation.reservedArtifactState.exceptions) ||
    !sameJson(latestSubmission.evidenceCommit, reservation.reservedArtifactState.evidenceCommit)
  ) {
    return;
  }

  latestSubmission.computation = reservation.computation;
  latestSubmission.exceptions = reservation.exceptions;
  latestSubmission.evidenceCommit = reservation.evidenceCommit;
  addAuditEvent(latestSubmission, "evidence_updated", "Rolled back failed evidence upload reservation.");
  await store.save(latestSubmission);
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
    if (isRobomataWalrusUploadsEnabled() && !resolveSubmissionFacilityObjectId(submission)) {
      return NextResponse.json(
        {
          error:
            "Real Seal/Walrus evidence upload requires an assigned Sui facility identity. Reopen the submission after Sui facility assignment completes.",
        },
        { status: 409 },
      );
    }

    const maxEvidenceUploadBytes = getEvidenceUploadMaxBytes();
    const contentLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > maxEvidenceUploadBytes + MULTIPART_UPLOAD_OVERHEAD_BYTES) {
      return buildUploadTooLargeResponse(maxEvidenceUploadBytes);
    }

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
    if (file.size > maxEvidenceUploadBytes) {
      return buildUploadTooLargeResponse(maxEvidenceUploadBytes);
    }

    const reservation = await reserveEvidenceUpload({ label, partnerAddress, submissionId, store });

    let evidence: SubmissionEvidence;
    try {
      evidence = await createEvidenceRecord({
        file,
        label,
        source,
        scope,
        status,
        sealPolicyId,
        sealIdentity: resolveSubmissionFacilityObjectId(submission),
        linkedReceivableIds,
      });
    } catch (error) {
      await rollbackEvidenceUploadReservation({ partnerAddress, reservation, submissionId, store });
      throw error;
    }

    const saved = await saveEvidenceRecord({ evidence, partnerAddress, submissionId, store });
    return NextResponse.json({ submission: saved, evidence });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to upload evidence." },
      { status: isCommitInProgressError(error) ? 409 : 500 },
    );
  }
}
