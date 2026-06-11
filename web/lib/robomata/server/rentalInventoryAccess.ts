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

export async function sourceIdForRentalFacilityAccess(
  facilityAssetId: string,
  partnerAddress: string,
): Promise<string | undefined> {
  const normalizedPartner = partnerAddress.toLowerCase();
  const configuredOwner = configuredRentalFacilityOwners()[facilityAssetId]?.toLowerCase();
  if (configuredOwner) return undefined;

  const store = getRentalInventoryStore();
  const manifestRefs = await store.listManifests(facilityAssetId);
  const manifests = await Promise.all(manifestRefs.map(ref => store.getManifest(ref.manifestId)));
  return (
    manifests.find(manifest => manifest?.source?.sourceId?.trim().toLowerCase() === normalizedPartner)?.source
      .sourceId ?? manifests.find(manifest => manifest?.source?.sourceId)?.source.sourceId
  );
}

export async function rentalStoredFacilityAccessError(
  facilityAssetId: string,
  partnerAddress: string,
): Promise<string | null> {
  const sourceId = await sourceIdForRentalFacilityAccess(facilityAssetId, partnerAddress);
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
  const manifestIds = new Set(manifestRefs.map(ref => ref.manifestId));
  const manifests = await Promise.all([...manifestIds].map(manifestId => store.getManifest(manifestId)));
  const sourceAttributedIds = manifests.flatMap(manifest => {
    if (!manifest || configuredOwners[manifest.facilityAssetId]) return [];
    return manifest.source?.sourceId?.trim().toLowerCase() === normalizedPartner ? [manifest.facilityAssetId] : [];
  });
  return new Set([...configuredIds, ...sourceAttributedIds]);
}
