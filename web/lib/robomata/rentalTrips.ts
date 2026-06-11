import type { PlatformVehicleId, ProtocolAssetId } from "~~/lib/robomata/rentalInventory";

export type RentalTripStatus = "check_in_completed" | "in_trip" | "return_completed" | "completed" | "exception";

export type RentalVehicleConditionRating = "clean" | "minor_wear" | "damage_reported" | "unsafe";

export type RentalTripMeterReading = {
  odometerMiles?: number;
  fuelPercent?: number;
  chargePercent?: number;
};

export type RentalTripConditionReport = RentalTripMeterReading & {
  capturedAt: string;
  condition: RentalVehicleConditionRating;
  photoUris: string[];
  notes?: string;
  actor?: string;
};

export type RentalTripException = {
  kind: "damage" | "missing_vehicle" | "late_return" | "safety" | "other";
  severity: "low" | "medium" | "high";
  notes?: string;
  claimRecommended: boolean;
  disputeRecommended: boolean;
};

export type RentalTripRecord = {
  id: string;
  bookingId: string;
  platformVehicleId: PlatformVehicleId;
  facilityAssetId: ProtocolAssetId;
  vehicleAssetId?: ProtocolAssetId;
  status: RentalTripStatus;
  checkIn?: RentalTripConditionReport;
  checkOut?: RentalTripConditionReport;
  exception?: RentalTripException;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type RentalTripCheckInInput = {
  actor?: string;
  capturedAt?: string;
  condition: RentalVehicleConditionRating;
  photoUris: string[];
  odometerMiles?: number;
  fuelPercent?: number;
  chargePercent?: number;
  notes?: string;
};

export type RentalTripCheckOutInput = RentalTripCheckInInput & {
  exception?: RentalTripException;
};

export function tripReportFromInput(input: RentalTripCheckInInput): RentalTripConditionReport {
  return {
    actor: input.actor,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    chargePercent: input.chargePercent,
    condition: input.condition,
    fuelPercent: input.fuelPercent,
    notes: input.notes,
    odometerMiles: input.odometerMiles,
    photoUris: input.photoUris,
  };
}
