import { NextRequest, NextResponse } from "next/server";
import { isRobomataWorkflowMutationEnabled, isRobomataWorkflowServerEnabled } from "~~/lib/featureFlags";
import { requirePartnerAddress } from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";

export const runtime = "nodejs";

function requireRobomataWorkflow() {
  if (isRobomataWorkflowServerEnabled()) return null;
  return NextResponse.json({ error: "Robomata workflow is not enabled." }, { status: 404 });
}

function requireRobomataMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata submission writes are not enabled." }, { status: 403 });
}

export async function GET(request: NextRequest) {
  const featureError = requireRobomataWorkflow();
  if (featureError) return featureError;

  const partnerAddress = requirePartnerAddress(request);
  if (partnerAddress instanceof NextResponse) return partnerAddress;

  const submissions = await getSubmissionStore().list(partnerAddress);
  return NextResponse.json({ submissions });
}

export async function POST(request: NextRequest) {
  try {
    const featureError = requireRobomataWorkflow();
    if (featureError) return featureError;
    const mutationError = requireRobomataMutation();
    if (mutationError) return mutationError;

    const body = (await request.json()) as {
      partnerAddress?: string;
      operatorName?: string;
      facilityName?: string;
      asOfDate?: string;
    };

    if (!body.partnerAddress || !body.operatorName || !body.facilityName || !body.asOfDate) {
      return NextResponse.json({ error: "Missing submission create fields." }, { status: 400 });
    }

    const submission = await getSubmissionStore().create({
      partnerAddress: body.partnerAddress,
      operatorName: body.operatorName,
      facilityName: body.facilityName,
      asOfDate: body.asOfDate,
    });

    return NextResponse.json({ submission }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create submission." },
      { status: 500 },
    );
  }
}
