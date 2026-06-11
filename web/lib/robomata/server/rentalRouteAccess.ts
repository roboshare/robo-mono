import { NextResponse } from "next/server";
import "server-only";
import type { RentalBookingRecord } from "~~/lib/robomata/rentalBookings";
import type { RentalClaimRecord } from "~~/lib/robomata/rentalClaims";
import type { PlatformVehicleId, RentalVehicleRecord } from "~~/lib/robomata/rentalInventory";
import type { RentalRevenuePostingBatch } from "~~/lib/robomata/rentalRevenue";
import {
  configuredRentalFacilityOwners,
  rentalStoredFacilityAccessError,
} from "~~/lib/robomata/server/rentalInventoryAccess";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";

export function rentalAccessResponse(message: string, status = 403) {
  return NextResponse.json({ error: message }, { status });
}

export async function requireRentalFacilityAccess(
  facilityAssetId: string,
  partnerAddress: string,
): Promise<NextResponse | null> {
  const accessError = await rentalStoredFacilityAccessError(facilityAssetId, partnerAddress);
  return accessError ? rentalAccessResponse(accessError) : null;
}

export async function requireRentalVehicleAccess(input: {
  partnerAddress: string;
  platformVehicleId: PlatformVehicleId;
}): Promise<{ vehicle: RentalVehicleRecord } | NextResponse> {
  const vehicle = await getRentalInventoryStore().getVehicle(input.platformVehicleId);
  if (!vehicle) return rentalAccessResponse("Rental vehicle not found.", 404);

  const accessError = await requireRentalFacilityAccess(vehicle.facilityAssetId, input.partnerAddress);
  return accessError ?? { vehicle };
}

export async function requireRentalBookingAccess(
  booking: RentalBookingRecord,
  partnerAddress: string,
): Promise<NextResponse | null> {
  return requireRentalFacilityAccess(booking.facilityAssetId, partnerAddress);
}

export async function requireRentalClaimAccess(
  claim: RentalClaimRecord,
  partnerAddress: string,
): Promise<NextResponse | null> {
  return requireRentalFacilityAccess(claim.facilityAssetId, partnerAddress);
}

export async function requireRentalRevenueBatchAccess(
  batch: RentalRevenuePostingBatch,
  partnerAddress: string,
): Promise<NextResponse | null> {
  const normalizedPartner = partnerAddress.toLowerCase();
  const configuredOwner = configuredRentalFacilityOwners()[batch.facilityAssetId]?.toLowerCase();
  const accessError = await rentalStoredFacilityAccessError(batch.facilityAssetId, partnerAddress);
  const isCreator = batch.attestation?.createdBy?.toLowerCase() === normalizedPartner;
  const isConfiguredOwnerMismatch = configuredOwner !== undefined && configuredOwner !== normalizedPartner;

  if (accessError && (!isCreator || isConfiguredOwnerMismatch)) {
    return rentalAccessResponse(accessError);
  }
  return null;
}
