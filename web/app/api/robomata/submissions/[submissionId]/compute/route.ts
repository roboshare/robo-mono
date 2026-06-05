import { NextRequest, NextResponse } from "next/server";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import { computeSubmissionArtifacts } from "~~/lib/robomata/submissionAdapters";
import { addAuditEvent } from "~~/lib/robomata/submissions";

export const runtime = "nodejs";

export async function POST(_: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
  try {
    const { submissionId } = await context.params;
    const store = getSubmissionStore();
    const submission = await store.get(submissionId);

    if (!submission) {
      return NextResponse.json({ error: "Submission not found." }, { status: 404 });
    }

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
    return NextResponse.json({ submission: saved });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to compute borrowing base." },
      { status: 500 },
    );
  }
}
