import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalRevenuePostingEnabled, isRobomataWorkflowMutationEnabled } from "~~/lib/featureFlags";
import { ROBOMATA_AUTH_HEADERS } from "~~/lib/robomata/auth";
import { getRentalRevenueStore } from "~~/lib/robomata/server/rentalRevenueStore";
import { requireRentalRevenueBatchAccess } from "~~/lib/robomata/server/rentalRouteAccess";
import { requirePartnerAddress } from "~~/lib/robomata/server/submissionAccess";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ batchId: string }>;
};

type MarkPostedBody = {
  chainId?: number;
  confirmationMode?: "operator_confirmed" | "submitted";
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

    const partnerAddress = await requirePartnerAddress(request);
    if (partnerAddress instanceof NextResponse) return partnerAddress;

    const body = (await request.json()) as MarkPostedBody;
    if (!body.protocolTxHash?.trim()) {
      return NextResponse.json({ error: "protocolTxHash must be provided." }, { status: 400 });
    }
    const chainId = body.chainId;
    if (typeof chainId !== "number" || !Number.isInteger(chainId) || chainId <= 0) {
      return NextResponse.json({ error: "chainId must be provided." }, { status: 400 });
    }
    const authenticatedChainId = Number.parseInt(request.headers.get(ROBOMATA_AUTH_HEADERS.chainId) ?? "", 10);
    if (!Number.isInteger(authenticatedChainId) || authenticatedChainId <= 0 || authenticatedChainId !== chainId) {
      return NextResponse.json({ error: "chainId must match the authenticated request chain." }, { status: 400 });
    }
    if (body.confirmationMode !== "operator_confirmed" && body.confirmationMode !== "submitted") {
      return NextResponse.json({ error: "confirmationMode must be operator_confirmed or submitted." }, { status: 400 });
    }

    const { batchId } = await context.params;
    const store = getRentalRevenueStore();
    const currentBatch = await store.getPostingBatch(batchId);
    if (!currentBatch) return NextResponse.json({ error: "Rental revenue posting batch not found." }, { status: 404 });
    const accessError = await requireRentalRevenueBatchAccess(currentBatch, partnerAddress);
    if (accessError) return accessError;

    const batch = await store.markPostingBatchPosted(batchId, {
      chainId,
      confirmationMode: body.confirmationMode,
      confirmedBy: partnerAddress,
      protocolTxHash: body.protocolTxHash,
    });
    if (!batch) return NextResponse.json({ error: "Rental revenue posting batch not found." }, { status: 404 });
    return NextResponse.json({ batch });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to mark rental revenue posting batch as posted." },
      { status: 400 },
    );
  }
}
