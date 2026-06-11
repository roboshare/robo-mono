import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalInventoryEnabled } from "~~/lib/featureFlags";
import {
  authorizedRentalFacilityAssetIds,
  rentalStoredFacilityAccessError,
} from "~~/lib/robomata/server/rentalInventoryAccess";
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
  const platformVehicleId = request.nextUrl.searchParams.get("platformVehicleId")?.trim() || undefined;
  const store = getRentalInventoryStore();

  if (facilityAssetId) {
    const accessError = await rentalStoredFacilityAccessError(facilityAssetId, partnerAddress);
    if (accessError) return NextResponse.json({ error: accessError }, { status: 403 });
  }

  const allowedFacilityAssetIds = facilityAssetId
    ? new Set([facilityAssetId])
    : await authorizedRentalFacilityAssetIds(partnerAddress);
  const vehicles = (await store.listVehicles({ facilityAssetId, platformVehicleId })).filter(vehicle =>
    allowedFacilityAssetIds.has(vehicle.facilityAssetId),
  );
  return NextResponse.json({ vehicles });
}
