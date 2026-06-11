import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalInventoryEnabled } from "~~/lib/featureFlags";
import {
  configuredRentalFacilityOwners,
  rentalFacilityAccessError,
} from "~~/lib/robomata/server/rentalInventoryAccess";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";
import { requirePartnerAddress } from "~~/lib/robomata/server/submissionAccess";

export const runtime = "nodejs";

function requireRentalInventory() {
  if (isRobomataRentalInventoryEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental inventory is not enabled." }, { status: 404 });
}

async function authorizedFacilityAssetIds(partnerAddress: string): Promise<Set<string>> {
  const normalizedPartner = partnerAddress.toLowerCase();
  const store = getRentalInventoryStore();
  const configuredIds = Object.entries(configuredRentalFacilityOwners())
    .filter(([, owner]) => owner.toLowerCase() === normalizedPartner)
    .map(([facilityAssetId]) => facilityAssetId);
  const manifestRefs = await store.listManifests();
  const manifestIds = new Set(manifestRefs.map(ref => ref.manifestId));
  const manifests = await Promise.all([...manifestIds].map(manifestId => store.getManifest(manifestId)));
  const sourceAttributedIds = manifests.flatMap(manifest => {
    if (!manifest) return [];
    return manifest.source?.sourceId?.trim().toLowerCase() === normalizedPartner ? [manifest.facilityAssetId] : [];
  });
  return new Set([...configuredIds, ...sourceAttributedIds]);
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
    const manifestRefs = await store.listManifests(facilityAssetId);
    const manifests = await Promise.all(manifestRefs.map(ref => store.getManifest(ref.manifestId)));
    const normalizedPartner = partnerAddress.toLowerCase();
    const sourceId =
      manifests.find(manifest => manifest?.source?.sourceId?.trim().toLowerCase() === normalizedPartner)?.source
        .sourceId ?? manifests.find(manifest => manifest?.source?.sourceId)?.source.sourceId;
    const accessError = rentalFacilityAccessError({ facilityAssetId, partnerAddress, sourceId });
    if (accessError) return NextResponse.json({ error: accessError }, { status: 403 });
  }

  const allowedFacilityAssetIds = facilityAssetId
    ? new Set([facilityAssetId])
    : await authorizedFacilityAssetIds(partnerAddress);
  const vehicles = (await store.listVehicles({ facilityAssetId, platformVehicleId })).filter(vehicle =>
    allowedFacilityAssetIds.has(vehicle.facilityAssetId),
  );
  return NextResponse.json({ vehicles });
}
