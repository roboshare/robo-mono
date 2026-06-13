import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataRentalBookingsEnabled,
  isRobomataRentalBridgePaymentsEnabled,
  isRobomataRentalInventoryEnabled,
  isRobomataRentalPaymentsEnabled,
  isRobomataWorkflowMutationEnabled,
} from "~~/lib/featureFlags";
import type { RentalBookingRecord } from "~~/lib/robomata/rentalBookings";
import type { RentalPaymentProviderEventKind, RentalPaymentRecord } from "~~/lib/robomata/rentalPayments";
import { getRentalBookingStore } from "~~/lib/robomata/server/rentalBookingStore";
import { type BridgeWebhookEvent, verifyBridgeWebhookPayload } from "~~/lib/robomata/server/rentalBridge";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";
import { type BridgeTransferSnapshot, getRentalPaymentStore } from "~~/lib/robomata/server/rentalPaymentStore";

export const runtime = "nodejs";

function requireBridgePayments() {
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

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function bridgeTransferSnapshot(event: BridgeWebhookEvent): BridgeTransferSnapshot {
  const transfer = event.event_object;
  const id = stringField(transfer.id);
  const state = stringField(transfer.state);
  if (!id || !state) throw new Error("Bridge webhook event object is missing transfer id or state.");
  return {
    amount: stringField(transfer.amount),
    client_reference_id: stringField(transfer.client_reference_id),
    created_at: stringField(transfer.created_at),
    currency: stringField(transfer.currency),
    destination: objectRecord(transfer.destination) as BridgeTransferSnapshot["destination"],
    id,
    on_behalf_of: stringField(transfer.on_behalf_of),
    receipt: objectRecord(transfer.receipt) as BridgeTransferSnapshot["receipt"],
    source: objectRecord(transfer.source) as BridgeTransferSnapshot["source"],
    state,
    updated_at: stringField(transfer.updated_at),
  };
}

function eventKindForBridgeTransfer(snapshot: BridgeTransferSnapshot): RentalPaymentProviderEventKind {
  switch (snapshot.state) {
    case "awaiting_funds":
      return "stablecoin_transfer_awaiting_funds";
    case "funds_received":
      return "stablecoin_transfer_funds_received";
    case "payment_submitted":
    case "in_review":
      return "stablecoin_transfer_submitted";
    case "payment_processed":
      return "stablecoin_transfer_processed";
    case "canceled":
      return "stablecoin_transfer_cancelled";
    case "returned":
    case "refunded":
      return "stablecoin_transfer_returned";
    case "undeliverable":
    case "refund_failed":
      return "payment_failed";
    default:
      return "stablecoin_transfer_created";
  }
}

function failureReasonForBridgeTransfer(snapshot: BridgeTransferSnapshot): string | undefined {
  if (snapshot.state === "undeliverable") return "Bridge transfer is undeliverable.";
  if (snapshot.state === "refund_failed") return "Bridge transfer refund failed.";
  return undefined;
}

function bookingStillAllowsPaymentConfirmation(booking: RentalBookingRecord) {
  const dateFrom = Date.parse(booking.dateFrom);
  const dateTo = Date.parse(booking.dateTo);
  return Number.isFinite(dateFrom) && Number.isFinite(dateTo) && dateTo > dateFrom && dateFrom > Date.now();
}

async function bookingForBridgeTransfer(snapshot: BridgeTransferSnapshot): Promise<RentalBookingRecord | undefined> {
  const existingPayment = await getRentalPaymentStore().getPaymentByPaymentIntent(snapshot.id);
  if (existingPayment) return undefined;

  const bookingId = snapshot.client_reference_id;
  if (!bookingId) return undefined;
  const booking = (await getRentalBookingStore().getBooking(bookingId)) ?? undefined;
  if (!booking) return undefined;
  if (booking.paymentPlan.totalDueAtAuthorizationCents <= 0) {
    throw new Error("Rental booking payment amount is invalid for Bridge transfer reconciliation.");
  }
  return booking;
}

async function advanceBookingAfterBridgePayment(input: {
  eventKind: RentalPaymentProviderEventKind;
  payment: RentalPaymentRecord;
}) {
  if (input.eventKind !== "stablecoin_transfer_processed") return;
  if (input.payment.status !== "captured" || input.payment.postingBlocked) return;
  const booking = await getRentalBookingStore().getBooking(input.payment.bookingId);
  if (!booking || booking.state !== "pending_payment_authorization") return;
  if (!bookingStillAllowsPaymentConfirmation(booking)) return;

  let hostReviewRequired = false;
  if (isRobomataRentalInventoryEnabled()) {
    const vehicle = await getRentalInventoryStore().getVehicle(booking.platformVehicleId);
    if (!vehicle || vehicle.operationalStatus !== "listed") return;
    hostReviewRequired = vehicle.hostControls?.bookingReview.requireManualApproval === true;
  }

  await getRentalBookingStore().confirmBooking(booking.id, {
    hostReviewRequired,
    paymentAuthorized: true,
    paymentProviderReference: input.payment.providerReference,
  });
}

export async function POST(request: NextRequest) {
  try {
    const featureError = requireBridgePayments();
    if (featureError) return featureError;

    const rawPayload = await request.text();
    const event = verifyBridgeWebhookPayload({
      payload: rawPayload,
      signatureHeader: request.headers.get("x-webhook-signature"),
    });
    if (event.event_category && event.event_category !== "transfer") return NextResponse.json({ ignored: true });
    if (!event.event_type.startsWith("transfer.")) return NextResponse.json({ ignored: true });

    const snapshot = bridgeTransferSnapshot(event);
    const eventKind = eventKindForBridgeTransfer(snapshot);
    const booking = await bookingForBridgeTransfer(snapshot);
    const payment = await getRentalPaymentStore().recordBridgeEvent({
      booking,
      eventKind,
      failureReason: failureReasonForBridgeTransfer(snapshot),
      occurredAt: event.event_created_at,
      providerEventId: event.event_id,
      snapshot,
    });
    await advanceBookingAfterBridgePayment({ eventKind, payment });
    return NextResponse.json({ payment });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to process Bridge rental webhook." },
      { status: 400 },
    );
  }
}
