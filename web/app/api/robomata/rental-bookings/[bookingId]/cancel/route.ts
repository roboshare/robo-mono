import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataRentalBookingsEnabled,
  isRobomataRentalInventoryEnabled,
  isRobomataRentalPaymentsEnabled,
  isRobomataWorkflowMutationEnabled,
} from "~~/lib/featureFlags";
import type { RentalBookingRecord } from "~~/lib/robomata/rentalBookings";
import type { RentalCancellationInput } from "~~/lib/robomata/rentalSupport";
import { getRentalBookingStore } from "~~/lib/robomata/server/rentalBookingStore";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";
import { getRentalPaymentStore } from "~~/lib/robomata/server/rentalPaymentStore";
import { requireRentalBookingAccess } from "~~/lib/robomata/server/rentalRouteAccess";
import { cancelStripeRentalPaymentIntent } from "~~/lib/robomata/server/rentalStripe";
import { getRentalSupportStore } from "~~/lib/robomata/server/rentalSupportStore";
import { requirePartnerAddress } from "~~/lib/robomata/server/submissionAccess";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ bookingId: string }>;
};

function requireBookings() {
  if (isRobomataRentalBookingsEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental bookings are not enabled." }, { status: 404 });
}

function requireMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental booking writes are not enabled." }, { status: 403 });
}

function cancellablePaymentStatus(status: string) {
  return status === "requires_payment_method" || status === "requires_confirmation" || status === "requires_capture";
}

async function cancelOpenPaymentIntents(booking: RentalBookingRecord) {
  if (!isRobomataRentalPaymentsEnabled()) return [];
  const paymentStore = getRentalPaymentStore();
  const payments = await paymentStore.listPaymentsByReferences({ bookingIds: [booking.id] });
  const cancelled = [];
  for (const payment of payments) {
    const paymentIntentId = payment.providerReference.paymentIntentId;
    if (!paymentIntentId || !cancellablePaymentStatus(payment.status)) continue;
    const snapshot = await cancelStripeRentalPaymentIntent(paymentIntentId);
    cancelled.push(
      await paymentStore.recordStripeEvent({
        booking,
        eventKind: "payment_cancelled",
        snapshot,
      }),
    );
  }
  return cancelled;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const featureError = requireBookings();
    if (featureError) return featureError;
    const mutationError = requireMutation();
    if (mutationError) return mutationError;

    const partnerAddress = await requirePartnerAddress(request);
    if (partnerAddress instanceof NextResponse) return partnerAddress;

    const { bookingId } = await context.params;
    const booking = await getRentalBookingStore().getBooking(bookingId);
    if (!booking) return NextResponse.json({ error: "Rental booking not found." }, { status: 404 });
    const accessError = await requireRentalBookingAccess(booking, partnerAddress);
    if (accessError) return accessError;

    if (booking.state === "cancelled") {
      const cancelledPayments = await cancelOpenPaymentIntents(booking);
      return NextResponse.json({ booking, payments: cancelledPayments });
    }
    if (["closed", "completed", "disputed"].includes(booking.state)) {
      return NextResponse.json({ error: `Booking cannot be cancelled from state ${booking.state}.` }, { status: 409 });
    }

    const input = (await request.json()) as RentalCancellationInput;
    const result = await getRentalSupportStore().recordCancellation(booking, input);
    const updatedBooking = await getRentalBookingStore().updateBookingState(booking.id, {
      eventKind: "booking_cancelled",
      payload: {
        auditEventId: result.auditEvent.id,
        cancellationFeeCents: result.outcome.cancellationFeeCents,
        refundableAmountCents: result.outcome.refundableAmountCents,
      },
      state: "cancelled",
    });
    if (isRobomataRentalInventoryEnabled()) {
      const operationalStatus = ["in_trip", "return_pending"].includes(booking.state) ? "suspended" : "listed";
      await getRentalInventoryStore().updateVehicleControls(booking.platformVehicleId, { operationalStatus });
    }
    const cancelledPayments = await cancelOpenPaymentIntents(booking);
    return NextResponse.json({
      auditEvent: result.auditEvent,
      booking: updatedBooking,
      cancellation: result.outcome,
      payments: cancelledPayments,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to cancel rental booking." },
      { status: 400 },
    );
  }
}
