import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalBookingsEnabled, isRobomataRentalPaymentsEnabled } from "~~/lib/featureFlags";
import type { RentalBookingRecord } from "~~/lib/robomata/rentalBookings";
import type { RentalPaymentProviderEventKind } from "~~/lib/robomata/rentalPayments";
import { getRentalBookingStore } from "~~/lib/robomata/server/rentalBookingStore";
import { getRentalPaymentStore } from "~~/lib/robomata/server/rentalPaymentStore";
import {
  type StripeWebhookEvent,
  retrieveStripeRentalPaymentIntent,
  verifyStripeWebhookPayload,
} from "~~/lib/robomata/server/rentalStripe";

export const runtime = "nodejs";

function requireRentalPayments() {
  if (!isRobomataRentalBookingsEnabled()) {
    return NextResponse.json({ error: "Robomata rental bookings are not enabled." }, { status: 404 });
  }
  if (!isRobomataRentalPaymentsEnabled()) {
    return NextResponse.json({ error: "Robomata rental payments are not enabled." }, { status: 404 });
  }
  return null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataBookingId(object: Record<string, unknown>): string | undefined {
  const metadata = object.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  return stringField((metadata as Record<string, unknown>).bookingId);
}

function eventKindForStripeEvent(event: StripeWebhookEvent): RentalPaymentProviderEventKind | null {
  switch (event.type) {
    case "payment_intent.created":
      return "payment_intent_created";
    case "payment_intent.amount_capturable_updated":
      return "authorization_succeeded";
    case "payment_intent.succeeded":
      return "capture_succeeded";
    case "payment_intent.payment_failed":
      return "payment_failed";
    case "charge.refunded":
      return "refund_succeeded";
    case "charge.refund.updated":
      return event.data.object.status === "failed" ? "refund_failed" : "refund_succeeded";
    case "charge.dispute.created":
      return "dispute_opened";
    case "charge.dispute.funds_withdrawn":
      return "chargeback_recorded";
    default:
      return null;
  }
}

function paymentIntentIdFromEvent(event: StripeWebhookEvent): string | undefined {
  const object = event.data.object;
  if (event.type.startsWith("payment_intent.")) return stringField(object.id);
  return stringField(object.payment_intent);
}

async function bookingForEvent(
  event: StripeWebhookEvent,
  paymentIntentId: string,
): Promise<RentalBookingRecord | undefined> {
  const existingPayment = await getRentalPaymentStore().getPaymentByPaymentIntent(paymentIntentId);
  if (existingPayment) return undefined;

  const bookingId = metadataBookingId(event.data.object);
  if (!bookingId) return undefined;
  return (await getRentalBookingStore().getBooking(bookingId)) ?? undefined;
}

function failureReasonForEvent(event: StripeWebhookEvent): string | undefined {
  const object = event.data.object;
  const lastPaymentError = object.last_payment_error;
  if (lastPaymentError && typeof lastPaymentError === "object") {
    return stringField((lastPaymentError as Record<string, unknown>).message);
  }
  return stringField(object.failure_message) ?? stringField(object.reason);
}

export async function POST(request: NextRequest) {
  try {
    const featureError = requireRentalPayments();
    if (featureError) return featureError;

    const rawPayload = await request.text();
    const event = verifyStripeWebhookPayload({
      payload: rawPayload,
      signatureHeader: request.headers.get("stripe-signature"),
    });
    const eventKind = eventKindForStripeEvent(event);
    if (!eventKind) return NextResponse.json({ ignored: true });

    const paymentIntentId = paymentIntentIdFromEvent(event);
    if (!paymentIntentId) {
      return NextResponse.json({ error: "Stripe event is missing payment_intent reference." }, { status: 400 });
    }

    const snapshot = event.type.startsWith("payment_intent.")
      ? {
          amount: numberField(event.data.object.amount) ?? 0,
          amount_capturable: numberField(event.data.object.amount_capturable),
          amount_received: numberField(event.data.object.amount_received),
          capture_method: stringField(event.data.object.capture_method),
          currency: stringField(event.data.object.currency) ?? "usd",
          customer: stringField(event.data.object.customer),
          id: paymentIntentId,
          latest_charge: stringField(event.data.object.latest_charge),
          status: stringField(event.data.object.status) ?? "requires_payment_method",
        }
      : await retrieveStripeRentalPaymentIntent(paymentIntentId);

    const booking = await bookingForEvent(event, paymentIntentId);
    const payment = await getRentalPaymentStore().recordStripeEvent({
      booking,
      chargeId: stringField(event.data.object.charge) ?? stringField(event.data.object.id),
      disputeId: event.type.startsWith("charge.dispute.") ? stringField(event.data.object.id) : undefined,
      eventKind,
      failureReason: failureReasonForEvent(event),
      occurredAt: event.created ? new Date(event.created * 1_000).toISOString() : undefined,
      providerEventId: event.id,
      refundId: event.type.startsWith("charge.refund.") ? stringField(event.data.object.id) : undefined,
      snapshot,
    });
    return NextResponse.json({ payment });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to process Stripe rental webhook." },
      { status: 400 },
    );
  }
}
