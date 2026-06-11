import "server-only";
import type { FacilityInventoryManifest } from "~~/lib/robomata/rentalInventory";

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
