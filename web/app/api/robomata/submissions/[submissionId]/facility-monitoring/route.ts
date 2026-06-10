import { NextRequest, NextResponse } from "next/server";
import { isRobomataFacilityMonitoringEnabled, isRobomataWorkflowServerEnabled } from "~~/lib/featureFlags";
import { getFacilityMonitoringStore } from "~~/lib/robomata/server/facilityMonitoringStore";
import { requirePartnerAddress, requireSubmissionAccess } from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";

export const runtime = "nodejs";

function requireRobomataMonitoring() {
  if (isRobomataWorkflowServerEnabled() && isRobomataFacilityMonitoringEnabled()) return null;
  return NextResponse.json({ error: "Robomata facility monitoring is not enabled." }, { status: 404 });
}

export async function GET(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
  try {
    const featureError = requireRobomataMonitoring();
    if (featureError) return featureError;

    const { submissionId } = await context.params;
    const submission = await getSubmissionStore().get(submissionId);
    if (!submission) return NextResponse.json({ error: "Submission not found." }, { status: 404 });

    const partnerAddress = await requirePartnerAddress(request);
    if (partnerAddress instanceof NextResponse) return partnerAddress;

    const accessError = requireSubmissionAccess(submission, partnerAddress);
    if (accessError) return accessError;

    const monitoring = await getFacilityMonitoringStore().getProjectionForSubmission(submission);
    return NextResponse.json({ monitoring });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load facility monitoring." },
      { status: 500 },
    );
  }
}
