import { NextRequest, NextResponse } from "next/server";
import { importReceivablesCsv } from "~~/lib/robomata/server/csv";
import { requirePartnerAddress, requireSubmissionAccess } from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import { addAuditEvent, invalidateSubmissionArtifacts } from "~~/lib/robomata/submissions";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
  try {
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

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing receivables CSV upload." }, { status: 400 });
    }

    const receivables = importReceivablesCsv(await file.text());
    submission.receivables = receivables;
    invalidateSubmissionArtifacts(submission);
    addAuditEvent(submission, "receivables_imported", `Imported ${receivables.length} receivables from ${file.name}.`, {
      filename: file.name,
      receivableCount: receivables.length,
    });

    const saved = await store.save(submission);
    return NextResponse.json({ submission: saved });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to import receivables." },
      { status: 500 },
    );
  }
}
