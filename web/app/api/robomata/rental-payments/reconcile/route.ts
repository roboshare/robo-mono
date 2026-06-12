import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataRentalBookingsEnabled,
  isRobomataRentalInventoryEnabled,
  isRobomataRentalPaymentsEnabled,
  isRobomataWorkflowMutationEnabled,
} from "~~/lib/featureFlags";
import type { RentalBookingRecord } from "~~/lib/robomata/rentalBookings";
import { getRentalBookingStore } from "~~/lib/robomata/server/rentalBookingStore";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";
import { getRentalPaymentStore } from "~~/lib/robomata/server/rentalPaymentStore";
import type { StripePaymentIntentSnapshot } from "~~/lib/robomata/server/rentalPaymentStore";
import { retrieveStripeRentalPaymentIntent } from "~~/lib/robomata/server/rentalStripe";

export const runtime = "nodejs";

type ReconcilePaymentBody = {
  bookingId?: string;
  paymentIntentId?: string;
};

function requireRentalPaymentReconciliation(request: NextRequest) {
  if (!isRobomataRentalBookingsEnabled()) {
    return NextResponse.json({ error: "Robomata rental bookings are not enabled." }, { status: 404 });
  }
  if (!isRobomataRentalPaymentsEnabled()) {
    return NextResponse.json({ error: "Robomata rental payments are not enabled." }, { status: 404 });
  }
  if (!isRobomataWorkflowMutationEnabled()) {
    return NextResponse.json({ error: "Robomata rental payment writes are not enabled." }, { status: 403 });
  }

  const secret = process.env.ROBOMATA_RENTAL_PAYMENT_CONFIRMATION_SECRET?.trim();
  if (!secret && process.env.NODE_ENV === "development") return null;
  if (!secret) return NextResponse.json({ error: "Rental payment reconciliation is not configured." }, { status: 503 });

  const provided = request.headers.get("x-robomata-payment-confirmation")?.trim();
  if (provided === secret) return null;
  return NextResponse.json(
    { error: "Missing or invalid rental payment reconciliation authorization." },
    { status: 403 },
  );
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

function bookingStillAllowsPaymentAuthorization(booking: RentalBookingRecord) {
  const dateFrom = Date.parse(booking.dateFrom);
  const dateTo = Date.parse(booking.dateTo);
  return Number.isFinite(dateFrom) && Number.isFinite(dateTo) && dateTo > dateFrom && dateFrom > Date.now();
}

async function advanceBookingAfterReconciliation(input: {
  booking?: RentalBookingRecord;
  paymentIntentId: string;
  snapshot: StripePaymentIntentSnapshot;
}) {
  if (input.snapshot.status !== "requires_capture" && input.snapshot.status !== "succeeded") return;

  const booking =
    input.booking ??
    (await getRentalBookingStore().getBooking(
      (await getRentalPaymentStore().getPaymentByPaymentIntent(input.paymentIntentId))?.bookingId ?? "",
    ));
  if (!booking || booking.state !== "pending_payment_authorization") return;
  if (!bookingStillAllowsPaymentAuthorization(booking)) return;

  let hostReviewRequired = false;
  if (isRobomataRentalInventoryEnabled()) {
    const vehicle = await getRentalInventoryStore().getVehicle(booking.platformVehicleId);
    if (!vehicle || vehicle.operationalStatus !== "listed") return;
    hostReviewRequired = vehicle.hostControls?.bookingReview.requireManualApproval === true;
  }

  await getRentalBookingStore().confirmBooking(booking.id, {
    hostReviewRequired,
    paymentAuthorized: true,
    paymentProviderReference: {
      provider: "stripe",
      chargeId:
        typeof input.snapshot.latest_charge === "string"
          ? input.snapshot.latest_charge
          : input.snapshot.latest_charge?.id,
      customerId: typeof input.snapshot.customer === "string" ? input.snapshot.customer : undefined,
      paymentIntentId: input.snapshot.id,
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const featureError = requireRentalPaymentReconciliation(request);
    if (featureError) return featureError;

    const body = (await request.json()) as ReconcilePaymentBody;
    if (!body.paymentIntentId?.trim()) {
      return NextResponse.json({ error: "paymentIntentId must be provided." }, { status: 400 });
    }
    const paymentIntentId = body.paymentIntentId.trim();

    const existingPayment = await getRentalPaymentStore().getPaymentByPaymentIntent(paymentIntentId);
    const booking =
      existingPayment || !body.bookingId?.trim()
        ? undefined
        : ((await getRentalBookingStore().getBooking(body.bookingId)) ?? undefined);
    const snapshot = await retrieveStripeRentalPaymentIntent(paymentIntentId);
    if (!existingPayment && body.bookingId?.trim()) {
      if (!booking) return NextResponse.json({ error: "Rental booking not found." }, { status: 404 });
      if (!snapshotMatchesBooking({ booking, paymentIntentId, snapshot })) {
        return NextResponse.json(
          { error: "Stripe PaymentIntent metadata does not match the rental booking." },
          { status: 409 },
        );
      }
    }
    const payment = await getRentalPaymentStore().recordStripeEvent({
      booking,
      eventKind: "reconciliation_refetched",
      snapshot,
    });
    await advanceBookingAfterReconciliation({ booking, paymentIntentId, snapshot });
    return NextResponse.json({ payment });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to reconcile rental payment." },
      { status: 400 },
    );
  }
}
