import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataRentalBookingsEnabled,
  isRobomataRentalInventoryEnabled,
  isRobomataRentalPaymentsEnabled,
} from "~~/lib/featureFlags";
import type { RentalBookingRecord } from "~~/lib/robomata/rentalBookings";
import type { RentalPaymentProviderEventKind, RentalPaymentRecord } from "~~/lib/robomata/rentalPayments";
import { getRentalBookingStore } from "~~/lib/robomata/server/rentalBookingStore";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";
import { getRentalPaymentStore } from "~~/lib/robomata/server/rentalPaymentStore";
import type { StripePaymentIntentSnapshot } from "~~/lib/robomata/server/rentalPaymentStore";
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

function metadataFromObject(object: Record<string, unknown>): Record<string, string> | undefined {
  const metadata = object.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const entries = Object.entries(metadata as Record<string, unknown>).flatMap(([key, value]) =>
    typeof value === "string" ? [[key, value] as const] : [],
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function eventKindForStripeEvent(event: StripeWebhookEvent): RentalPaymentProviderEventKind | null {
  switch (event.type) {
    case "payment_intent.created":
      return "payment_intent_created";
    case "payment_intent.amount_capturable_updated":
      return "authorization_succeeded";
    case "payment_intent.succeeded":
      return "capture_succeeded";
    case "payment_intent.canceled":
      return "payment_cancelled";
    case "payment_intent.payment_failed":
      return "payment_failed";
    case "charge.refunded":
      return "refund_succeeded";
    case "charge.refund.updated":
    case "refund.failed":
    case "refund.updated":
      if (event.data.object.status === "failed") return "refund_failed";
      if (event.data.object.status === "succeeded") return "refund_succeeded";
      return null;
    case "charge.dispute.created":
      return "dispute_opened";
    case "charge.dispute.closed":
      if (event.data.object.status === "lost") return "chargeback_recorded";
      return "dispute_closed";
    case "charge.dispute.funds_withdrawn":
      return "chargeback_recorded";
    default:
      return null;
  }
}

function refundAmountForEvent(event: StripeWebhookEvent): number | undefined {
  if (event.type === "charge.refunded") return numberField(event.data.object.amount_refunded);
  if (event.type.startsWith("charge.refund.")) return numberField(event.data.object.amount);
  if (event.type.startsWith("refund.")) return numberField(event.data.object.amount);
  return undefined;
}

function paymentIntentIdFromEvent(event: StripeWebhookEvent): string | undefined {
  const object = event.data.object;
  if (event.type.startsWith("payment_intent.")) return stringField(object.id);
  return stringField(object.payment_intent);
}

function chargeIdFromEvent(event: StripeWebhookEvent): string | undefined {
  const object = event.data.object;
  if (event.type.startsWith("payment_intent.")) return stringField(object.latest_charge);
  if (
    event.type.startsWith("charge.refund.") ||
    event.type.startsWith("charge.dispute.") ||
    event.type.startsWith("refund.")
  ) {
    return stringField(object.charge);
  }
  return stringField(object.id);
}

async function bookingForEvent(
  event: StripeWebhookEvent,
  paymentIntentId: string,
  snapshot: StripePaymentIntentSnapshot,
): Promise<RentalBookingRecord | undefined> {
  const existingPayment = await getRentalPaymentStore().getPaymentByPaymentIntent(paymentIntentId);
  if (existingPayment) return undefined;

  const bookingId = metadataBookingId(event.data.object);
  if (!bookingId) return undefined;
  const booking = (await getRentalBookingStore().getBooking(bookingId)) ?? undefined;
  if (!booking) return undefined;
  if (!snapshotMatchesBooking({ booking, paymentIntentId, snapshot })) {
    throw new Error("Stripe PaymentIntent metadata does not match the rental booking.");
  }
  return booking;
}

function snapshotMatchesBooking(input: {
  booking: RentalBookingRecord;
  paymentIntentId: string;
  snapshot: StripePaymentIntentSnapshot;
}) {
  const metadata = input.snapshot.metadata ?? {};
  return (
    metadata.bookingId === input.booking.id &&
    metadata.facilityAssetId === input.booking.facilityAssetId &&
    metadata.platformVehicleId === input.booking.platformVehicleId &&
    (!input.booking.vehicleAssetId || metadata.vehicleAssetId === input.booking.vehicleAssetId) &&
    input.snapshot.amount === input.booking.paymentPlan.totalDueAtAuthorizationCents &&
    input.snapshot.currency.toUpperCase() === input.booking.paymentPlan.currency &&
    input.snapshot.id === input.paymentIntentId
  );
}

function failureReasonForEvent(event: StripeWebhookEvent): string | undefined {
  const object = event.data.object;
  const lastPaymentError = object.last_payment_error;
  if (lastPaymentError && typeof lastPaymentError === "object") {
    return stringField((lastPaymentError as Record<string, unknown>).message);
  }
  return stringField(object.failure_message) ?? stringField(object.reason);
}

function bookingStillAllowsPaymentAuthorization(booking: RentalBookingRecord) {
  const dateFrom = Date.parse(booking.dateFrom);
  const dateTo = Date.parse(booking.dateTo);
  return Number.isFinite(dateFrom) && Number.isFinite(dateTo) && dateTo > dateFrom && dateFrom > Date.now();
}

async function advanceBookingAfterPaymentAuthorization(input: {
  eventKind: RentalPaymentProviderEventKind;
  payment: RentalPaymentRecord;
}) {
  if (input.eventKind !== "authorization_succeeded" && input.eventKind !== "capture_succeeded") return;
  const booking = await getRentalBookingStore().getBooking(input.payment.bookingId);
  if (!booking || booking.state !== "pending_payment_authorization") return;
  if (!bookingStillAllowsPaymentAuthorization(booking)) return;

  let hostReviewRequired = false;
  if (isRobomataRentalInventoryEnabled()) {
    const vehicle = await getRentalInventoryStore().getVehicle(booking.platformVehicleId);
    if (!vehicle || vehicle.operationalStatus !== "listed") return;
    hostReviewRequired = vehicle?.hostControls?.bookingReview.requireManualApproval === true;
  }

  await getRentalBookingStore().confirmBooking(booking.id, {
    hostReviewRequired,
    paymentAuthorized: true,
    paymentProviderReference: input.payment.providerReference,
  });
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
          metadata: metadataFromObject(event.data.object),
          status: stringField(event.data.object.status) ?? "requires_payment_method",
        }
      : await retrieveStripeRentalPaymentIntent(paymentIntentId);

    const booking = await bookingForEvent(event, paymentIntentId, snapshot);
    const payment = await getRentalPaymentStore().recordStripeEvent({
      booking,
      chargeId: chargeIdFromEvent(event),
      disputeId: event.type.startsWith("charge.dispute.") ? stringField(event.data.object.id) : undefined,
      eventKind,
      failureReason: failureReasonForEvent(event),
      occurredAt: event.created ? new Date(event.created * 1_000).toISOString() : undefined,
      providerEventId: event.id,
      refundAmountCents: refundAmountForEvent(event),
      refundId:
        event.type.startsWith("charge.refund.") || event.type.startsWith("refund.")
          ? stringField(event.data.object.id)
          : undefined,
      snapshot,
    });
    await advanceBookingAfterPaymentAuthorization({ eventKind, payment });
    return NextResponse.json({ payment });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to process Stripe rental webhook." },
      { status: 400 },
    );
  }
}
