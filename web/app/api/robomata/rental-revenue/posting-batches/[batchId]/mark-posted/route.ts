import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalRevenuePostingEnabled, isRobomataWorkflowMutationEnabled } from "~~/lib/featureFlags";
import {
  configuredRentalFacilityOwners,
  rentalFacilityAccessError,
} from "~~/lib/robomata/server/rentalInventoryAccess";
import { getRentalRevenueStore } from "~~/lib/robomata/server/rentalRevenueStore";
import { requirePartnerAddress } from "~~/lib/robomata/server/submissionAccess";

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

    const partnerAddress = await requirePartnerAddress(request);
    if (partnerAddress instanceof NextResponse) return partnerAddress;

    const body = (await request.json()) as MarkPostedBody;
    if (!body.protocolTxHash?.trim()) {
      return NextResponse.json({ error: "protocolTxHash must be provided." }, { status: 400 });
    }

    const { batchId } = await context.params;
    const store = getRentalRevenueStore();
    const currentBatch = await store.getPostingBatch(batchId);
    if (!currentBatch) return NextResponse.json({ error: "Rental revenue posting batch not found." }, { status: 404 });
    const configuredOwner = configuredRentalFacilityOwners()[currentBatch.facilityAssetId]?.toLowerCase();
    const accessError = rentalFacilityAccessError({
      facilityAssetId: currentBatch.facilityAssetId,
      partnerAddress,
    });
    const isCreator = currentBatch.attestation.createdBy.toLowerCase() === partnerAddress.toLowerCase();
    const isConfiguredOwnerMismatch = configuredOwner !== undefined && configuredOwner !== partnerAddress.toLowerCase();
    if (accessError && (!isCreator || isConfiguredOwnerMismatch)) {
      return NextResponse.json({ error: accessError }, { status: 403 });
    }
    const batch = await store.markPostingBatchPosted(batchId, body.protocolTxHash);
    if (!batch) return NextResponse.json({ error: "Rental revenue posting batch not found." }, { status: 404 });
    return NextResponse.json({ batch });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to mark rental revenue posting batch as posted." },
      { status: 400 },
    );
  }
}
