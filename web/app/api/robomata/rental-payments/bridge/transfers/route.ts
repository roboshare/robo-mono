import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import {
  isRobomataRentalBookingsEnabled,
  isRobomataRentalBridgePaymentsEnabled,
  isRobomataRentalInventoryEnabled,
  isRobomataRentalPaymentsEnabled,
  isRobomataWorkflowMutationEnabled,
} from "~~/lib/featureFlags";
import type { RentalBookingRecord } from "~~/lib/robomata/rentalBookings";
import type { RentalPaymentRecord } from "~~/lib/robomata/rentalPayments";
import { getRentalBookingStore } from "~~/lib/robomata/server/rentalBookingStore";
import { createBridgeRentalTransfer } from "~~/lib/robomata/server/rentalBridge";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";
import { getRentalPaymentStore } from "~~/lib/robomata/server/rentalPaymentStore";
import { retrieveStripeRentalPaymentIntent } from "~~/lib/robomata/server/rentalStripe";

export const runtime = "nodejs";

type CreateBridgeTransferBody = {
  bookingId?: string;
  checkoutAccessToken?: string;
  fromAddress?: string;
  renterId?: string;
  returnAddress?: string;
};

function requireBridgePaymentWrites() {
  if (!isRobomataRentalBookingsEnabled()) {
    return NextResponse.json({ error: "Robomata rental bookings are not enabled." }, { status: 404 });
  }
  if (!isRobomataRentalPaymentsEnabled()) {
    return NextResponse.json({ error: "Robomata rental payments are not enabled." }, { status: 404 });
  }
  if (!isRobomataRentalBridgePaymentsEnabled()) {
    return NextResponse.json({ error: "Robomata Bridge rental payments are not enabled." }, { status: 404 });
  }
  if (!isRobomataWorkflowMutationEnabled()) {
    return NextResponse.json({ error: "Robomata rental payment writes are not enabled." }, { status: 403 });
  }
  return null;
}

function checkoutAccessTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function bookingStillAllowsStablecoinPayment(booking: RentalBookingRecord) {
  const dateFrom = Date.parse(booking.dateFrom);
  const dateTo = Date.parse(booking.dateTo);
  return Number.isFinite(dateFrom) && Number.isFinite(dateTo) && dateTo > dateFrom && dateFrom > Date.now();
}

function cleanAddress(value: string | undefined) {
  return value?.trim() || undefined;
}

function paymentUpdatedTime(payment: { updatedAt: string }) {
  const updatedAt = Date.parse(payment.updatedAt);
  return Number.isFinite(updatedAt) ? updatedAt : 0;
}

function activeStripePaymentStatus(status: string) {
  return (
    status === "requires_payment_method" ||
    status === "requires_confirmation" ||
    status === "requires_capture" ||
    status === "captured" ||
    status === "failed"
  );
}

function bridgePaymentBlocksBridgeCheckout(payment: RentalPaymentRecord) {
  return (
    payment.status === "awaiting_funds" ||
    payment.status === "processing" ||
    payment.status === "captured" ||
    (payment.status === "failed" && payment.postingBlocked)
  );
}

async function stripePaymentsBlockingBridgeCheckout(input: {
  booking: RentalBookingRecord;
  payments: RentalPaymentRecord[];
  paymentStore: ReturnType<typeof getRentalPaymentStore>;
}) {
  const blockers = [];
  for (const payment of input.payments) {
    if (payment.provider !== "stripe" || !activeStripePaymentStatus(payment.status)) continue;
    const paymentIntentId = payment.providerReference.paymentIntentId;
    if (!paymentIntentId) continue;
    const snapshot = await retrieveStripeRentalPaymentIntent(paymentIntentId);
    if (snapshot.status === "canceled") {
      await input.paymentStore.recordStripeEvent({
        booking: input.booking,
        eventKind: "payment_cancelled",
        snapshot,
      });
      continue;
    }
    blockers.push(payment);
  }
  return blockers;
}

export async function POST(request: NextRequest) {
  try {
    const featureError = requireBridgePaymentWrites();
    if (featureError) return featureError;

    const body = (await request.json()) as CreateBridgeTransferBody;
    if (!body.bookingId?.trim()) return NextResponse.json({ error: "bookingId must be provided." }, { status: 400 });
    if (!body.renterId?.trim()) return NextResponse.json({ error: "renterId must be provided." }, { status: 400 });
    if (!body.checkoutAccessToken?.trim()) {
      return NextResponse.json({ error: "checkoutAccessToken must be provided." }, { status: 400 });
    }

    const booking = await getRentalBookingStore().getBooking(body.bookingId);
    if (!booking) return NextResponse.json({ error: "Rental booking not found." }, { status: 404 });
    if (body.renterId.trim() !== booking.renterId) {
      return NextResponse.json({ error: "Renter does not match booking." }, { status: 403 });
    }
    if (!booking.checkoutAccessTokenHash) {
      return NextResponse.json({ error: "Booking checkout authorization is not available." }, { status: 409 });
    }
    if (checkoutAccessTokenHash(body.checkoutAccessToken.trim()) !== booking.checkoutAccessTokenHash) {
      return NextResponse.json({ error: "Invalid checkout authorization token." }, { status: 403 });
    }
    if (booking.state !== "pending_payment_authorization") {
      return NextResponse.json(
        { error: `Booking cannot create a Bridge transfer from state ${booking.state}.` },
        { status: 409 },
      );
    }
    if (!bookingStillAllowsStablecoinPayment(booking)) {
      return NextResponse.json({ error: "Booking dates are no longer valid for payment." }, { status: 409 });
    }
    if (isRobomataRentalInventoryEnabled()) {
      const vehicle = await getRentalInventoryStore().getVehicle(booking.platformVehicleId);
      if (!vehicle || vehicle.operationalStatus !== "listed") {
        return NextResponse.json({ error: "Rental vehicle is no longer available for payment." }, { status: 409 });
      }
    }

    const paymentStore = getRentalPaymentStore();
    return await paymentStore.withBookingPaymentRailLock(booking.id, async () => {
      const lockedBooking = await getRentalBookingStore().getBooking(booking.id);
      if (!lockedBooking) return NextResponse.json({ error: "Rental booking not found." }, { status: 404 });
      if (lockedBooking.state !== "pending_payment_authorization") {
        return NextResponse.json(
          { error: `Booking cannot create a Bridge transfer from state ${lockedBooking.state}.` },
          { status: 409 },
        );
      }
      if (!bookingStillAllowsStablecoinPayment(lockedBooking)) {
        return NextResponse.json({ error: "Booking dates are no longer valid for payment." }, { status: 409 });
      }
      if (isRobomataRentalInventoryEnabled()) {
        const vehicle = await getRentalInventoryStore().getVehicle(lockedBooking.platformVehicleId);
        if (!vehicle || vehicle.operationalStatus !== "listed") {
          return NextResponse.json({ error: "Rental vehicle is no longer available for payment." }, { status: 409 });
        }
      }

      const bookingPayments = await paymentStore.listPaymentsByReferences({ bookingIds: [lockedBooking.id] });
      const activeStripePayments = await stripePaymentsBlockingBridgeCheckout({
        booking: lockedBooking,
        paymentStore,
        payments: bookingPayments,
      });
      if (activeStripePayments.length > 0) {
        return NextResponse.json(
          {
            error:
              "Booking has an active Stripe PaymentIntent. Cancel or reconcile the card payment before Bridge checkout.",
            payments: activeStripePayments,
          },
          { status: 409 },
        );
      }

      const priorBridgePayments = bookingPayments
        .filter(payment => payment.provider === "bridge")
        .sort((left, right) => paymentUpdatedTime(right) - paymentUpdatedTime(left));
      const activeBridgePayments = priorBridgePayments.filter(bridgePaymentBlocksBridgeCheckout);
      if (activeBridgePayments.length > 0) {
        const activeBridgePayment = activeBridgePayments[0];
        return NextResponse.json(
          {
            error:
              "Booking has an active Bridge transfer. Cancel or return the Bridge transfer before retrying checkout.",
            payments: activeBridgePayments,
            sourceDepositInstructions: activeBridgePayment?.providerReference.sourceDepositInstructions,
          },
          { status: 409 },
        );
      }

      const transfer = await createBridgeRentalTransfer({
        booking: lockedBooking,
        fromAddress: cleanAddress(body.fromAddress),
        idempotencyKey:
          priorBridgePayments.length > 0
            ? `robomata-rental-booking-${lockedBooking.id}-bridge-replacement-${priorBridgePayments[0].id}`
            : undefined,
        returnAddress: cleanAddress(body.returnAddress) ?? cleanAddress(body.fromAddress),
      });
      const payment = await paymentStore.recordBridgeEvent({
        booking: lockedBooking,
        eventKind:
          transfer.state === "awaiting_funds" ? "stablecoin_transfer_awaiting_funds" : "stablecoin_transfer_created",
        snapshot: transfer,
      });
      return NextResponse.json(
        {
          payment,
          sourceDepositInstructions: transfer.source_deposit_instructions,
          transfer,
        },
        { status: 201 },
      );
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create Bridge rental transfer." },
      { status: 400 },
    );
  }
}
