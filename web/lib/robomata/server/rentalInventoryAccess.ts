import "server-only";
import type { FacilityInventoryManifest } from "~~/lib/robomata/rentalInventory";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";

export function configuredRentalFacilityOwners(): Record<string, string> {
  const raw = process.env.ROBOMATA_RENTAL_INVENTORY_FACILITY_OWNERS_JSON?.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([facilityAssetId, partnerAddress]) =>
      typeof partnerAddress === "string" ? [[facilityAssetId, partnerAddress.toLowerCase()]] : [],
    ),
  );
}

export function rentalFacilityAccessError(input: {
  facilityAssetId: string;
  partnerAddress: string;
  sourceId?: string;
}): string | null {
  const normalizedPartner = input.partnerAddress.toLowerCase();
  const configuredOwner = configuredRentalFacilityOwners()[input.facilityAssetId]?.toLowerCase();
  if (configuredOwner && configuredOwner !== normalizedPartner) {
    return "Partner is not authorized for this rental facility.";
  }

  const sourceId = input.sourceId?.trim().toLowerCase();
  if (sourceId && sourceId !== normalizedPartner) {
    return "Rental facility sourceId must match the authorized partner.";
  }

  if (!configuredOwner && !sourceId && process.env.NODE_ENV === "production") {
    return "Rental facility ownership must be configured or source-attributed.";
  }

  return null;
}

export function rentalManifestAccessError(manifest: FacilityInventoryManifest, partnerAddress: string): string | null {
  return rentalFacilityAccessError({
    facilityAssetId: manifest.facilityAssetId,
    partnerAddress,
    sourceId: manifest.source?.sourceId,
  });
}

export async function sourceIdForRentalFacilityAccess(facilityAssetId: string): Promise<string | undefined> {
  const configuredOwner = configuredRentalFacilityOwners()[facilityAssetId]?.toLowerCase();
  if (configuredOwner) return undefined;

  const store = getRentalInventoryStore();
  const manifestRefs = await store.listManifests(facilityAssetId);
  const latestManifest = manifestRefs[0] ? await store.getManifest(manifestRefs[0].manifestId) : null;
  return latestManifest?.source?.sourceId?.trim();
}

export async function rentalStoredFacilityAccessError(
  facilityAssetId: string,
  partnerAddress: string,
): Promise<string | null> {
  const sourceId = await sourceIdForRentalFacilityAccess(facilityAssetId);
  return rentalFacilityAccessError({ facilityAssetId, partnerAddress, sourceId });
}

export async function authorizedRentalFacilityAssetIds(partnerAddress: string): Promise<Set<string>> {
  const normalizedPartner = partnerAddress.toLowerCase();
  const configuredOwners = configuredRentalFacilityOwners();
  const configuredIds = Object.entries(configuredOwners)
    .filter(([, owner]) => owner.toLowerCase() === normalizedPartner)
    .map(([facilityAssetId]) => facilityAssetId);
  const store = getRentalInventoryStore();
  const manifestRefs = await store.listManifests();
  const latestRefsByFacility = new Map<string, string>();
  for (const ref of manifestRefs) {
    if (!latestRefsByFacility.has(ref.facilityAssetId)) latestRefsByFacility.set(ref.facilityAssetId, ref.manifestId);
  }
  const manifests = await Promise.all(
    [...latestRefsByFacility.values()].map(manifestId => store.getManifest(manifestId)),
  );
  const sourceAttributedIds = manifests.flatMap(manifest => {
    if (!manifest || configuredOwners[manifest.facilityAssetId]) return [];
    return manifest.source?.sourceId?.trim().toLowerCase() === normalizedPartner ? [manifest.facilityAssetId] : [];
  });
  return new Set([...configuredIds, ...sourceAttributedIds]);
}
