import type { PlatformVehicleId, ProtocolAssetId } from "~~/lib/robomata/rentalInventory";
import type { RentalBookingLifecycleState } from "~~/lib/robomata/rentalOperations";
import type { RentalCheckoutPaymentPlan, RentalPaymentProviderReference } from "~~/lib/robomata/rentalPayments";

export type RentalBookingEventKind =
  | "checkout_started"
  | "verification_required"
  | "payment_authorization_required"
  | "host_review_required"
  | "booking_confirmed"
  | "booking_reminder_scheduled"
  | "check_in_completed"
  | "check_out_completed"
  | "trip_completed"
  | "trip_exception_reported"
  | "booking_cancelled"
  | "incident_recorded";

export type RentalBookingEvent = {
  id: string;
  bookingId: string;
  kind: RentalBookingEventKind;
  occurredAt: string;
  payload?: Record<string, unknown>;
};

export type RentalCancellationPolicy = {
  policyId: string;
  summary: string;
  freeCancellationUntil?: string;
  refundSchedule: Array<{
    label: string;
    refundBps: number;
    untilHoursBeforeStart?: number;
  }>;
};

export type RentalBookingRecord = {
  id: string;
  renterId: string;
  platformVehicleId: PlatformVehicleId;
  facilityAssetId: ProtocolAssetId;
  vehicleAssetId?: ProtocolAssetId;
  dateFrom: string;
  dateTo: string;
  state: RentalBookingLifecycleState;
  paymentPlan: RentalCheckoutPaymentPlan;
  paymentProviderReference?: RentalPaymentProviderReference;
  cancellationPolicy: RentalCancellationPolicy;
  events: RentalBookingEvent[];
  createdAt: string;
  updatedAt: string;
};

export type RentalBookingCheckoutInput = {
  renterId: string;
  platformVehicleId: PlatformVehicleId;
  dateFrom: string;
  dateTo: string;
};

export type RentalBookingConfirmationInput = {
  paymentProviderReference?: RentalPaymentProviderReference;
  paymentAuthorized?: boolean;
  hostReviewRequired?: boolean;
};

export function defaultRentalCancellationPolicy(dateFrom: string): RentalCancellationPolicy {
  const startsAt = Date.parse(dateFrom);
  const freeCancellationUntil = Number.isFinite(startsAt)
    ? new Date(startsAt - 24 * 60 * 60 * 1_000).toISOString()
    : undefined;
  return {
    policyId: "standard_flexible_v1",
    summary: "Free cancellation until 24 hours before pickup. Later cancellations may be partially refundable.",
    freeCancellationUntil,
    refundSchedule: [
      { label: "Free cancellation window", refundBps: 10_000, untilHoursBeforeStart: 24 },
      { label: "Late cancellation", refundBps: 5_000, untilHoursBeforeStart: 0 },
    ],
  };
}
