import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataRentalBookingsEnabled,
  isRobomataRentalInventoryEnabled,
  isRobomataWorkflowMutationEnabled,
} from "~~/lib/featureFlags";
import type {
  RentalPaymentProviderEventKind,
  RentalPaymentProviderReference,
  RentalPaymentRecord,
} from "~~/lib/robomata/rentalPayments";
import { RentalBookingConflictError, getRentalBookingStore } from "~~/lib/robomata/server/rentalBookingStore";
import { retrieveBridgeRentalTransfer } from "~~/lib/robomata/server/rentalBridge";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";
import {
  type BridgeTransferSnapshot,
  type StripePaymentIntentSnapshot,
  getRentalPaymentStore,
} from "~~/lib/robomata/server/rentalPaymentStore";
import { requireRentalBookingAccess } from "~~/lib/robomata/server/rentalRouteAccess";
import { retrieveStripeRentalPaymentIntent } from "~~/lib/robomata/server/rentalStripe";
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

function paymentReferenceId(reference: RentalPaymentProviderReference) {
  return reference.paymentIntentId ?? reference.transferId;
}

function paymentMatchesBookingReference(input: {
  bookingId: string;
  payment: RentalPaymentRecord;
  reference: RentalPaymentProviderReference;
}) {
  return (
    input.payment.bookingId === input.bookingId &&
    input.payment.provider === input.reference.provider &&
    paymentReferenceId(input.payment.providerReference) === paymentReferenceId(input.reference)
  );
}

function paymentCanApproveBooking(payment: RentalPaymentRecord) {
  if (payment.provider === "stripe") return payment.status === "requires_capture" || payment.status === "captured";
  return payment.status === "captured";
}

function stripeApprovalSyncEventKind(snapshot: StripePaymentIntentSnapshot): RentalPaymentProviderEventKind {
  switch (snapshot.status) {
    case "canceled":
      return "payment_cancelled";
    case "succeeded":
      return "capture_succeeded";
    case "requires_capture":
      return "authorization_succeeded";
    default:
      return "reconciliation_refetched";
  }
}

function bridgeApprovalSyncEventKind(snapshot: BridgeTransferSnapshot): RentalPaymentProviderEventKind {
  switch (snapshot.state) {
    case "payment_processed":
      return "stablecoin_transfer_processed";
    case "canceled":
      return "stablecoin_transfer_cancelled";
    case "returned":
    case "refund_in_flight":
      return "stablecoin_transfer_return_in_flight";
    case "refunded":
      return "stablecoin_transfer_returned";
    case "undeliverable":
      return "payment_failed";
    case "refund_failed":
      return "refund_failed";
    case "error":
    case "missing_return_policy":
      return "stablecoin_transfer_exception";
    default:
      return "reconciliation_refetched";
  }
}

async function requireValidApprovalPayment(input: {
  bookingId: string;
  paymentProviderReference: RentalPaymentProviderReference;
}) {
  const providerReferenceId = paymentReferenceId(input.paymentProviderReference);
  if (!providerReferenceId) {
    return NextResponse.json(
      { error: "Booking payment authorization is missing a provider reference." },
      { status: 409 },
    );
  }

  const paymentStore = getRentalPaymentStore();
  let payment = await paymentStore.getPaymentByPaymentIntent(providerReferenceId);
  if (
    !payment ||
    !paymentMatchesBookingReference({
      bookingId: input.bookingId,
      payment,
      reference: input.paymentProviderReference,
    })
  ) {
    return NextResponse.json({ error: "Booking payment authorization could not be verified." }, { status: 409 });
  }

  if (payment.provider === "stripe") {
    const paymentIntentId = input.paymentProviderReference.paymentIntentId;
    if (!paymentIntentId) {
      return NextResponse.json(
        { error: "Stripe payment authorization is missing a PaymentIntent reference." },
        { status: 409 },
      );
    }

    const snapshot = await retrieveStripeRentalPaymentIntent(paymentIntentId);
    payment = await paymentStore.recordStripeEvent({
      booking: undefined,
      eventKind: stripeApprovalSyncEventKind(snapshot),
      snapshot,
    });
    // The monotonic guard may preserve a stale local status (e.g. requires_capture
    // when Stripe has moved to requires_payment_method), so gate on live status.
    if (snapshot.status !== "requires_capture" && snapshot.status !== "succeeded") {
      return NextResponse.json(
        { error: "Booking cannot be approved without a valid payment authorization." },
        { status: 409 },
      );
    }
  } else if (payment.provider === "bridge") {
    const transferId = input.paymentProviderReference.transferId;
    if (!transferId) {
      return NextResponse.json(
        { error: "Bridge payment authorization is missing a transfer reference." },
        { status: 409 },
      );
    }

    const snapshot = await retrieveBridgeRentalTransfer(transferId);
    payment = await paymentStore.recordBridgeEvent({
      booking: undefined,
      eventKind: bridgeApprovalSyncEventKind(snapshot),
      snapshot,
    });
    // Mirror the Stripe live status gate: only payment_processed is approvable.
    if (snapshot.state !== "payment_processed") {
      return NextResponse.json(
        { error: "Booking cannot be approved without a valid payment authorization." },
        { status: 409 },
      );
    }
  }

  if (!paymentCanApproveBooking(payment)) {
    return NextResponse.json(
      { error: "Booking cannot be approved without a valid payment authorization." },
      { status: 409 },
    );
  }
  return null;
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
    const current = await getRentalBookingStore().getBooking(bookingId);
    if (!current) return NextResponse.json({ error: "Rental booking not found." }, { status: 404 });
    const accessError = await requireRentalBookingAccess(current, partnerAddress);
    if (accessError) return accessError;
    if (current.state !== "host_review") {
      return NextResponse.json({ error: `Booking cannot be approved from state ${current.state}.` }, { status: 409 });
    }
    if (!current.paymentProviderReference) {
      return NextResponse.json({ error: "Booking cannot be approved before payment authorization." }, { status: 409 });
    }

    const paymentStore = getRentalPaymentStore();
    return await paymentStore.withBookingPaymentRailLock(bookingId, async () => {
      const lockedBooking = await getRentalBookingStore().getBooking(bookingId);
      if (!lockedBooking) return NextResponse.json({ error: "Rental booking not found." }, { status: 404 });
      if (lockedBooking.state !== "host_review") {
        return NextResponse.json(
          { error: `Booking cannot be approved from state ${lockedBooking.state}.` },
          { status: 409 },
        );
      }
      if (!lockedBooking.paymentProviderReference) {
        return NextResponse.json(
          { error: "Booking cannot be approved before payment authorization." },
          { status: 409 },
        );
      }

      const paymentError = await requireValidApprovalPayment({
        bookingId: lockedBooking.id,
        paymentProviderReference: lockedBooking.paymentProviderReference,
      });
      if (paymentError) return paymentError;

      if (isRobomataRentalInventoryEnabled()) {
        const vehicle = await getRentalInventoryStore().getVehicle(lockedBooking.platformVehicleId);
        if (!vehicle) return NextResponse.json({ error: "Rental vehicle not found." }, { status: 404 });
        if (vehicle.operationalStatus !== "listed") {
          return NextResponse.json({ error: "Rental vehicle is no longer available for approval." }, { status: 409 });
        }
      }

      const booking = await getRentalBookingStore().confirmBooking(bookingId, {
        hostReviewRequired: false,
        paymentAuthorized: true,
      });
      if (!booking) return NextResponse.json({ error: "Rental booking not found." }, { status: 404 });
      return NextResponse.json({ booking });
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to approve rental booking." },
      { status: error instanceof RentalBookingConflictError ? 409 : 400 },
    );
  }
}
