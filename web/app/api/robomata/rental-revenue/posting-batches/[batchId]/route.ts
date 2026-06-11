import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalRevenuePostingEnabled } from "~~/lib/featureFlags";
import { getRentalRevenueStore } from "~~/lib/robomata/server/rentalRevenueStore";
import { requireRentalRevenueBatchAccess } from "~~/lib/robomata/server/rentalRouteAccess";
import { requirePartnerAddress } from "~~/lib/robomata/server/submissionAccess";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ batchId: string }>;
};

function requireRevenuePosting() {
  if (isRobomataRentalRevenuePostingEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental revenue posting is not enabled." }, { status: 404 });
}

export async function GET(request: NextRequest, context: RouteContext) {
  const featureError = requireRevenuePosting();
  if (featureError) return featureError;

  const partnerAddress = await requirePartnerAddress(request);
  if (partnerAddress instanceof NextResponse) return partnerAddress;

  const { batchId } = await context.params;
  const batch = await getRentalRevenueStore().getPostingBatch(batchId);
  if (!batch) return NextResponse.json({ error: "Rental revenue posting batch not found." }, { status: 404 });
  const accessError = await requireRentalRevenueBatchAccess(batch, partnerAddress);
  if (accessError) return accessError;

  return NextResponse.json({ batch });
}
