import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalInventoryEnabled } from "~~/lib/featureFlags";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";
import { requirePartnerAddress } from "~~/lib/robomata/server/submissionAccess";

export const runtime = "nodejs";

function requireRentalInventory() {
  if (isRobomataRentalInventoryEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental inventory is not enabled." }, { status: 404 });
}

export async function GET(request: NextRequest) {
  const featureError = requireRentalInventory();
  if (featureError) return featureError;

  const partnerAddress = await requirePartnerAddress(request);
  if (partnerAddress instanceof NextResponse) return partnerAddress;

  const facilityAssetId = request.nextUrl.searchParams.get("facilityAssetId")?.trim() || undefined;
  const manifestId = request.nextUrl.searchParams.get("manifestId")?.trim() || undefined;
  const ingestionRuns = await getRentalInventoryStore().listIngestionRuns({ facilityAssetId, manifestId });
  return NextResponse.json({ ingestionRuns });
}
