import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalRevenuePostingEnabled } from "~~/lib/featureFlags";
import { getRentalRevenueStore } from "~~/lib/robomata/server/rentalRevenueStore";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ batchId: string }>;
};

function requireRevenuePosting() {
  if (isRobomataRentalRevenuePostingEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental revenue posting is not enabled." }, { status: 404 });
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const featureError = requireRevenuePosting();
  if (featureError) return featureError;

  const { batchId } = await context.params;
  const batch = await getRentalRevenueStore().getPostingBatch(batchId);
  if (!batch) return NextResponse.json({ error: "Rental revenue posting batch not found." }, { status: 404 });
  return NextResponse.json({ batch });
}
