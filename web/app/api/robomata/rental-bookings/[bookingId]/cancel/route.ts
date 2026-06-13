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

function cancellableStripePaymentStatus(status: string) {
  return status === "requires_payment_method" || status === "requires_confirmation" || status === "requires_capture";
}

function blockingBridgePaymentStatus(status: string) {
  return status === "processing" || status === "captured";
}

function bridgeAmountFromCents(amountCents: number) {
  return (amountCents / 100).toFixed(2);
}

async function bridgePaymentsBlockingCancellation(booking: RentalBookingRecord) {
  if (!isRobomataRentalPaymentsEnabled()) return [];
  const payments = await getRentalPaymentStore().listPaymentsByReferences({ bookingIds: [booking.id] });
  return payments.filter(
    payment =>
      payment.provider === "bridge" &&
      payment.providerReference.transferId &&
      blockingBridgePaymentStatus(payment.status),
  );
}

async function cancelOpenPaymentIntents(booking: RentalBookingRecord) {
  if (!isRobomataRentalPaymentsEnabled()) return [];
  const paymentStore = getRentalPaymentStore();
  const payments = await paymentStore.listPaymentsByReferences({ bookingIds: [booking.id] });
  const cancelled = [];
  for (const payment of payments) {
    if (payment.provider === "stripe") {
      const paymentIntentId = payment.providerReference.paymentIntentId;
      if (!paymentIntentId || !cancellableStripePaymentStatus(payment.status)) continue;
      const snapshot = await cancelStripeRentalPaymentIntent(paymentIntentId);
      cancelled.push(
        await paymentStore.recordStripeEvent({
          booking,
          eventKind: "payment_cancelled",
          snapshot,
        }),
      );
      continue;
    }
    if (payment.provider === "bridge") {
      const transferId = payment.providerReference.transferId;
      if (!transferId || payment.status !== "awaiting_funds") continue;
      cancelled.push(
        await paymentStore.recordBridgeEvent({
          booking,
          eventKind: "stablecoin_transfer_cancelled",
          snapshot: {
            amount: bridgeAmountFromCents(payment.authorizedAmountCents),
            client_reference_id: booking.id,
            currency: "usd",
            id: transferId,
            state: "canceled",
          },
        }),
      );
    }
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

    const input = (await request.json()) as RentalCancellationInput;

    const runCancellation = async () => {
      const lockedBooking = await getRentalBookingStore().getBooking(booking.id);
      if (!lockedBooking) return NextResponse.json({ error: "Rental booking not found." }, { status: 404 });
      const lockedAccessError = await requireRentalBookingAccess(lockedBooking, partnerAddress);
      if (lockedAccessError) return lockedAccessError;

      if (lockedBooking.state === "cancelled") {
        const cancelledPayments = await cancelOpenPaymentIntents(lockedBooking);
        return NextResponse.json({ booking: lockedBooking, payments: cancelledPayments });
      }
      if (["closed", "completed", "disputed"].includes(lockedBooking.state)) {
        return NextResponse.json(
          { error: `Booking cannot be cancelled from state ${lockedBooking.state}.` },
          { status: 409 },
        );
      }
      const blockingBridgePayments = await bridgePaymentsBlockingCancellation(lockedBooking);
      if (blockingBridgePayments.length > 0) {
        return NextResponse.json(
          {
            error:
              "Booking has an in-flight Bridge transfer. Cancel or return the Bridge transfer before cancelling the booking.",
            payments: blockingBridgePayments,
          },
          { status: 409 },
        );
      }

      const result = await getRentalSupportStore().recordCancellation(lockedBooking, input);
      const updatedBooking = await getRentalBookingStore().updateBookingState(lockedBooking.id, {
        eventKind: "booking_cancelled",
        payload: {
          auditEventId: result.auditEvent.id,
          cancellationFeeCents: result.outcome.cancellationFeeCents,
          refundableAmountCents: result.outcome.refundableAmountCents,
        },
        state: "cancelled",
      });
      if (isRobomataRentalInventoryEnabled()) {
        const operationalStatus = ["in_trip", "return_pending"].includes(lockedBooking.state) ? "suspended" : "listed";
        await getRentalInventoryStore().updateVehicleControls(lockedBooking.platformVehicleId, { operationalStatus });
      }
      const cancelledPayments = await cancelOpenPaymentIntents(lockedBooking);
      return NextResponse.json({
        auditEvent: result.auditEvent,
        booking: updatedBooking,
        cancellation: result.outcome,
        payments: cancelledPayments,
      });
    };

    const paymentStore = isRobomataRentalPaymentsEnabled() ? getRentalPaymentStore() : undefined;
    return await (paymentStore
      ? paymentStore.withBookingPaymentRailLock(booking.id, runCancellation)
      : runCancellation());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to cancel rental booking." },
      { status: 400 },
    );
  }
}
