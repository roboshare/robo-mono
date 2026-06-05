import { NextRequest, NextResponse } from "next/server";
import { isRobomataWorkflowMutationEnabled, isRobomataWorkflowServerEnabled } from "~~/lib/featureFlags";
import { createEvidenceRecord } from "~~/lib/robomata/server/evidenceStorage";
import { requirePartnerAddress, requireSubmissionAccess } from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import { addAuditEvent, invalidateSubmissionArtifacts } from "~~/lib/robomata/submissions";

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

    const evidence = await createEvidenceRecord({
      file,
      label,
      source,
      scope,
      status,
      sealPolicyId,
      linkedReceivableIds,
    });

    submission.evidence = [evidence, ...submission.evidence.filter(record => record.label !== evidence.label)];
    invalidateSubmissionArtifacts(submission);
    addAuditEvent(submission, "evidence_uploaded", `Uploaded evidence package ${evidence.label}.`, {
      evidenceId: evidence.id,
      storageBackend: evidence.storageBackend,
    });

    const saved = await store.save(submission);
    return NextResponse.json({ submission: saved, evidence });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to upload evidence." },
      { status: 500 },
    );
  }
}
