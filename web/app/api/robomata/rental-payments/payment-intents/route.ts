import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataRentalBookingsEnabled,
  isRobomataRentalPaymentsEnabled,
  isRobomataWorkflowMutationEnabled,
} from "~~/lib/featureFlags";
import { getRentalBookingStore } from "~~/lib/robomata/server/rentalBookingStore";
import { getRentalPaymentStore } from "~~/lib/robomata/server/rentalPaymentStore";
import { createStripeRentalPaymentIntent } from "~~/lib/robomata/server/rentalStripe";

export const runtime = "nodejs";

type CreatePaymentIntentBody = {
  bookingId?: string;
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

export async function POST(request: NextRequest) {
  try {
    const featureError = requireRentalPaymentWrites();
    if (featureError) return featureError;

    const body = (await request.json()) as CreatePaymentIntentBody;
    if (!body.bookingId?.trim()) return NextResponse.json({ error: "bookingId must be provided." }, { status: 400 });

    const booking = await getRentalBookingStore().getBooking(body.bookingId);
    if (!booking) return NextResponse.json({ error: "Rental booking not found." }, { status: 404 });
    if (body.renterId?.trim() && body.renterId.trim() !== booking.renterId) {
      return NextResponse.json({ error: "Renter does not match booking." }, { status: 403 });
    }
    if (booking.state !== "pending_payment_authorization") {
      return NextResponse.json(
        { error: `Booking cannot create a PaymentIntent from state ${booking.state}.` },
        { status: 409 },
      );
    }

    const existingPayment = await getRentalPaymentStore().getPaymentByBooking(booking.id);
    if (existingPayment?.providerReference.paymentIntentId) {
      return NextResponse.json({
        clientSecret: undefined,
        payment: existingPayment,
      });
    }

    const paymentIntent = await createStripeRentalPaymentIntent({ booking });
    const payment = await getRentalPaymentStore().recordStripeEvent({
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
