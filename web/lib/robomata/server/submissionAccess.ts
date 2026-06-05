import { NextRequest, NextResponse } from "next/server";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";

export function getPartnerAddress(request: NextRequest): string | null {
  const partnerAddress = request.nextUrl.searchParams.get("partnerAddress")?.trim();
  return partnerAddress || null;
}

export function requirePartnerAddress(request: NextRequest): string | NextResponse {
  const partnerAddress = getPartnerAddress(request);

  if (!partnerAddress) {
    return NextResponse.json({ error: "Missing partner address." }, { status: 401 });
  }

  return partnerAddress;
}

export function requireSubmissionAccess(submission: FacilitySubmission, partnerAddress: string): NextResponse | null {
  if (submission.partnerAddress.toLowerCase() !== partnerAddress.toLowerCase()) {
    return NextResponse.json({ error: "Submission not found." }, { status: 404 });
  }

  return null;
}
