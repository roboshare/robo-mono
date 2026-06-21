import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataFacilityMonitoringEnabled,
  isRobomataWorkflowMutationEnabled,
  isRobomataWorkflowServerEnabled,
} from "~~/lib/featureFlags";
import { deriveSubmissionEvidenceStatuses } from "~~/lib/robomata/evidenceStatus";
import { importReceivablesCsv } from "~~/lib/robomata/server/csv";
import { getFacilityMonitoringStore } from "~~/lib/robomata/server/facilityMonitoringStore";
import {
  requirePartnerAddress,
  requireSubmissionAccess,
  requireSubmissionMutable,
} from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import { addAuditEvent, invalidateSubmissionArtifacts } from "~~/lib/robomata/submissions";

export const runtime = "nodejs";

const DEFAULT_RECEIVABLES_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const MULTIPART_UPLOAD_OVERHEAD_BYTES = 1024 * 1024;

function requireRobomataWorkflow() {
  if (isRobomataWorkflowServerEnabled()) return null;
  return NextResponse.json({ error: "Robomata workflow is not enabled." }, { status: 404 });
}

function requireRobomataMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata submission writes are not enabled." }, { status: 403 });
}

function getReceivablesImportMaxBytes() {
  const parsed = Number.parseInt(process.env.ROBOMATA_RECEIVABLES_IMPORT_MAX_BYTES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RECEIVABLES_IMPORT_MAX_BYTES;
}

function buildImportTooLargeResponse(maxBytes: number) {
  return NextResponse.json(
    { error: `Receivables CSV upload exceeds the configured ${maxBytes} byte limit.` },
    { status: 413 },
  );
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

    const maxReceivablesImportBytes = getReceivablesImportMaxBytes();
    const contentLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > maxReceivablesImportBytes + MULTIPART_UPLOAD_OVERHEAD_BYTES) {
      return buildImportTooLargeResponse(maxReceivablesImportBytes);
    }

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing receivables CSV upload." }, { status: 400 });
    }
    if (file.size > maxReceivablesImportBytes) {
      return buildImportTooLargeResponse(maxReceivablesImportBytes);
    }

    const receivables = importReceivablesCsv(await file.text());
    submission.receivables = receivables;
    const evidenceStatusChanges = deriveSubmissionEvidenceStatuses(submission);
    invalidateSubmissionArtifacts(submission);
    addAuditEvent(submission, "receivables_imported", `Imported ${receivables.length} receivables from ${file.name}.`, {
      filename: file.name,
      receivableCount: receivables.length,
    });
    if (evidenceStatusChanges.length > 0) {
      addAuditEvent(
        submission,
        "evidence_updated",
        `Updated ${evidenceStatusChanges.length} evidence status derivation(s) after receivables import.`,
        {
          evidenceStatusChangeCount: evidenceStatusChanges.length,
        },
      );
    }

    const saved = await store.save(submission);
    if (isRobomataFacilityMonitoringEnabled()) {
      await getFacilityMonitoringStore().createReceivablesImportObservation({
        filename: file.name,
        importedAt: saved.updatedAt,
        receivableCount: saved.receivables.length,
        submission: saved,
      });
    }
    return NextResponse.json({ submission: saved });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to import receivables." },
      { status: 500 },
    );
  }
}
