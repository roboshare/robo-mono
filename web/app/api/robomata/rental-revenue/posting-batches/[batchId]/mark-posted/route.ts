import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalRevenuePostingEnabled, isRobomataWorkflowMutationEnabled } from "~~/lib/featureFlags";
import { getRentalRevenueStore } from "~~/lib/robomata/server/rentalRevenueStore";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ batchId: string }>;
};

type MarkPostedBody = {
  protocolTxHash?: string;
};

function requireRevenuePosting() {
  if (isRobomataRentalRevenuePostingEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental revenue posting is not enabled." }, { status: 404 });
}

function requireMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental revenue posting writes are not enabled." }, { status: 403 });
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const featureError = requireRevenuePosting();
    if (featureError) return featureError;
    const mutationError = requireMutation();
    if (mutationError) return mutationError;

    const body = (await request.json()) as MarkPostedBody;
    if (!body.protocolTxHash?.trim()) {
      return NextResponse.json({ error: "protocolTxHash must be provided." }, { status: 400 });
    }

    const { batchId } = await context.params;
    const batch = await getRentalRevenueStore().markPostingBatchPosted(batchId, body.protocolTxHash);
    if (!batch) return NextResponse.json({ error: "Rental revenue posting batch not found." }, { status: 404 });
    return NextResponse.json({ batch });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to mark rental revenue posting batch as posted." },
      { status: 400 },
    );
  }
}
