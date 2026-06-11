import type { RentalBookingRecord } from "~~/lib/robomata/rentalBookings";
import type { PlatformVehicleId, ProtocolAssetId } from "~~/lib/robomata/rentalInventory";

export type RentalSupportActor = {
  id: string;
  role: "renter" | "host" | "ops" | "system";
};

export type RentalCancellationReason =
  | "renter_cancelled"
  | "host_cancelled"
  | "payment_failure"
  | "verification_failure"
  | "vehicle_unavailable"
  | "weather_or_force_majeure"
  | "support_adjustment";

export type RentalCancellationInput = {
  actor: RentalSupportActor;
  cancelledAt?: string;
  reason: RentalCancellationReason;
  notes?: string;
  supportCaseId?: string;
};

export type RentalCancellationOutcome = {
  bookingId: string;
  policyId: string;
  reason: RentalCancellationReason;
  cancelledAt: string;
  tripChargeCents: number;
  refundableAmountCents: number;
  cancellationFeeCents: number;
  refundBps: number;
  auditEventId: string;
  notes?: string;
  supportCaseId?: string;
};

export type RentalIncidentKind =
  | "renter_support"
  | "host_support"
  | "refund_adjustment"
  | "late_return"
  | "vehicle_condition"
  | "payment_exception"
  | "safety";

export type RentalIncidentStatus = "open" | "waiting" | "resolved" | "escalated";

export type RentalIncidentRecord = {
  id: string;
  bookingId: string;
  platformVehicleId: PlatformVehicleId;
  facilityAssetId: ProtocolAssetId;
  vehicleAssetId?: ProtocolAssetId;
  kind: RentalIncidentKind;
  status: RentalIncidentStatus;
  actor: RentalSupportActor;
  notes?: string;
  refundAdjustmentCents?: number;
  supportCaseId?: string;
  auditEventId: string;
  createdAt: string;
  updatedAt: string;
};

export type RentalAuditEvent = {
  id: string;
  bookingId: string;
  actor: RentalSupportActor;
  action: "booking_cancelled" | "incident_recorded" | "manual_override";
  occurredAt: string;
  reason?: string;
  supportCaseId?: string;
  payload?: Record<string, unknown>;
};

function refundBpsForCancellation(booking: RentalBookingRecord, cancelledAt: string): number {
  const cancelledTime = Date.parse(cancelledAt);
  const tripStart = Date.parse(booking.dateFrom);
  if (!Number.isFinite(cancelledTime) || !Number.isFinite(tripStart)) return 0;

  const hoursBeforeStart = (tripStart - cancelledTime) / (60 * 60 * 1_000);
  const matchingPolicy = booking.cancellationPolicy.refundSchedule
    .filter(item => item.untilHoursBeforeStart === undefined || hoursBeforeStart >= item.untilHoursBeforeStart)
    .sort((left, right) => (right.untilHoursBeforeStart ?? -1) - (left.untilHoursBeforeStart ?? -1))[0];
  return matchingPolicy?.refundBps ?? 0;
}

function cancellationTimestamp(input: RentalCancellationInput): string {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  if (!input.cancelledAt) return now;

  const requestedMs = Date.parse(input.cancelledAt);
  if (!Number.isFinite(requestedMs)) throw new Error("cancelledAt must be a valid timestamp when provided.");
  if (requestedMs > nowMs) throw new Error("cancelledAt cannot be in the future.");

  const hasSupportOverride = input.actor.role === "ops" && Boolean(input.supportCaseId?.trim());
  return hasSupportOverride ? new Date(requestedMs).toISOString() : now;
}

export function buildRentalCancellationOutcome(
  booking: RentalBookingRecord,
  input: RentalCancellationInput,
): RentalCancellationOutcome {
  const cancelledAt = cancellationTimestamp(input);
  const tripChargeCents = booking.paymentPlan.rentalCharge.totalAuthorizeCents;
  const refundBps = refundBpsForCancellation(booking, cancelledAt);
  const refundableAmountCents = Math.floor((tripChargeCents * refundBps) / 10_000);
  return {
    bookingId: booking.id,
    policyId: booking.cancellationPolicy.policyId,
    reason: input.reason,
    cancelledAt,
    tripChargeCents,
    refundableAmountCents,
    cancellationFeeCents: tripChargeCents - refundableAmountCents,
    refundBps,
    auditEventId: `rae_${booking.id}_${Date.parse(cancelledAt) || Date.now()}`,
    notes: input.notes,
    supportCaseId: input.supportCaseId,
  };
}
