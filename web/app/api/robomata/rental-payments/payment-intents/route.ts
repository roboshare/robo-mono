import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import {
  isRobomataRentalBookingsEnabled,
  isRobomataRentalPaymentsEnabled,
  isRobomataWorkflowMutationEnabled,
} from "~~/lib/featureFlags";
import type { RentalPaymentRecord } from "~~/lib/robomata/rentalPayments";
import { getRentalBookingStore } from "~~/lib/robomata/server/rentalBookingStore";
import { getRentalPaymentStore } from "~~/lib/robomata/server/rentalPaymentStore";
import {
  createStripeRentalPaymentIntent,
  retrieveStripeRentalPaymentIntent,
} from "~~/lib/robomata/server/rentalStripe";

export const runtime = "nodejs";

const DEFAULT_STRIPE_MANUAL_CAPTURE_WINDOW_DAYS = 7;

type CreatePaymentIntentBody = {
  bookingId?: string;
  checkoutAccessToken?: string;
  renterId?: string;
};

function requireRentalPaymentWrites() {
  if (!isRobomataRentalBookingsEnabled()) {
    return NextResponse.json({ error: "Robomata rental bookings are not enabled." }, { status: 404 });
  }
  if (!isRobomataRentalPaymentsEnabled()) {
    return NextResponse.json({ error: "Robomata rental payments are not enabled." }, { status: 404 });
  }
  if (!isRobomataWorkflowMutationEnabled()) {
    return NextResponse.json({ error: "Robomata rental payment writes are not enabled." }, { status: 403 });
  }
  return null;
}

function stripeManualCaptureWindowMs() {
  const days = Number.parseInt(
    process.env.ROBOMATA_RENTAL_STRIPE_CAPTURE_WINDOW_DAYS ?? String(DEFAULT_STRIPE_MANUAL_CAPTURE_WINDOW_DAYS),
    10,
  );
  return Math.max(Number.isFinite(days) ? days : DEFAULT_STRIPE_MANUAL_CAPTURE_WINDOW_DAYS, 1) * 24 * 60 * 60 * 1_000;
}

function paymentUpdatedTime(payment: RentalPaymentRecord) {
  const updatedAt = Date.parse(payment.updatedAt);
  return Number.isFinite(updatedAt) ? updatedAt : 0;
}

function checkoutAccessTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function POST(request: NextRequest) {
  try {
    const featureError = requireRentalPaymentWrites();
    if (featureError) return featureError;

    const body = (await request.json()) as CreatePaymentIntentBody;
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
        { error: `Booking cannot create a PaymentIntent from state ${booking.state}.` },
        { status: 409 },
      );
    }
    const bookingEndMs = Date.parse(booking.dateTo);
    if (!Number.isFinite(bookingEndMs)) {
      return NextResponse.json(
        { error: "Booking dateTo must be valid before payment authorization." },
        { status: 400 },
      );
    }
    if (bookingEndMs - Date.now() > stripeManualCaptureWindowMs()) {
      return NextResponse.json(
        { error: "Booking ends outside Stripe manual-capture authorization window." },
        { status: 409 },
      );
    }

    const paymentStore = getRentalPaymentStore();
    const existingPayments = (
      await paymentStore.listPaymentsByReferences({
        bookingIds: [booking.id],
      })
    )
      .filter(payment => Boolean(payment.providerReference.paymentIntentId))
      .sort((left, right) => paymentUpdatedTime(right) - paymentUpdatedTime(left));

    for (const payment of existingPayments) {
      if (payment.status === "cancelled") continue;
      const paymentIntent = await retrieveStripeRentalPaymentIntent(payment.providerReference.paymentIntentId!);
      if (paymentIntent.status === "canceled") continue;
      return NextResponse.json({
        clientSecret: paymentIntent.client_secret,
        payment,
      });
    }

    if (existingPayments.length > 0) {
      const replacementIntent = await createStripeRentalPaymentIntent({
        booking,
        idempotencyKey: `robomata-rental-booking-${booking.id}-replacement-${existingPayments[0].id}`,
      });
      const replacementPayment = await paymentStore.recordStripeEvent({
        booking,
        eventKind: "payment_intent_created",
        snapshot: replacementIntent,
      });
      return NextResponse.json(
        {
          clientSecret: replacementIntent.client_secret,
          payment: replacementPayment,
        },
        { status: 201 },
      );
    }

    const paymentIntent = await createStripeRentalPaymentIntent({ booking });
    const payment = await paymentStore.recordStripeEvent({
      booking,
      eventKind: "payment_intent_created",
      snapshot: paymentIntent,
    });
    return NextResponse.json(
      {
        clientSecret: paymentIntent.client_secret,
        payment,
      },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create rental PaymentIntent." },
      { status: 400 },
    );
  }
}
