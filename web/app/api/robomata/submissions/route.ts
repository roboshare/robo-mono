import { NextRequest, NextResponse } from "next/server";
import { requirePartnerAddress } from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const partnerAddress = requirePartnerAddress(request);
  if (partnerAddress instanceof NextResponse) return partnerAddress;

  const submissions = await getSubmissionStore().list(partnerAddress);
  return NextResponse.json({ submissions });
}

export async function POST(request: NextRequest) {
  try {
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
