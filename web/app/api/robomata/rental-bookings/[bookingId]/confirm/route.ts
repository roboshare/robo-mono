import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataRentalBookingsEnabled,
  isRobomataRentalInventoryEnabled,
  isRobomataWorkflowMutationEnabled,
} from "~~/lib/featureFlags";
import type { RentalBookingConfirmationInput } from "~~/lib/robomata/rentalBookings";
import { renterCheckoutEligibility } from "~~/lib/robomata/rentalRenters";
import { RentalBookingConflictError, getRentalBookingStore } from "~~/lib/robomata/server/rentalBookingStore";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";
import { getRentalRenterStore } from "~~/lib/robomata/server/rentalRenterStore";
import { requireRentalBookingAccess } from "~~/lib/robomata/server/rentalRouteAccess";
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

function requireServerPaymentAuthorization(request: NextRequest): NextResponse | null {
  const secret = process.env.ROBOMATA_RENTAL_PAYMENT_CONFIRMATION_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ error: "Rental payment confirmation is not configured." }, { status: 503 });
  }

  const provided = request.headers.get("x-robomata-payment-confirmation")?.trim();
  if (!provided || provided !== secret) {
    return NextResponse.json({ error: "Missing or invalid server-side payment confirmation." }, { status: 403 });
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

    const paymentAuthorizationError = requireServerPaymentAuthorization(request);
    if (paymentAuthorizationError) return paymentAuthorizationError;

    const { bookingId } = await context.params;
    const body = (await request.json()) as RentalBookingConfirmationInput;

    let current = await getRentalBookingStore().getBooking(bookingId);
    if (!current) return NextResponse.json({ error: "Rental booking not found." }, { status: 404 });
    const accessError = await requireRentalBookingAccess(current, partnerAddress);
    if (accessError) return accessError;

    if (current.state === "pending_renter_verification") {
      const renter = await getRentalRenterStore().getRenter(current.renterId);
      if (!renter) return NextResponse.json({ error: "Renter profile not found." }, { status: 404 });
      const checkoutEligibility = renterCheckoutEligibility(renter);
      if (!checkoutEligibility.eligible) {
        return NextResponse.json(
          { checkoutEligibility, error: "Renter verification still blocks booking confirmation." },
          { status: 409 },
        );
      }
      current = await getRentalBookingStore().updateBookingState(current.id, {
        eventKind: "payment_authorization_required",
        payload: { verificationPolicyVersion: checkoutEligibility.policyVersion },
        state: "pending_payment_authorization",
      });
      if (!current) return NextResponse.json({ error: "Rental booking not found." }, { status: 404 });
    }
    if (!["pending_payment_authorization", "host_review"].includes(current.state)) {
      return NextResponse.json({ error: `Booking cannot be confirmed from state ${current.state}.` }, { status: 409 });
    }
    if (current.state === "host_review") {
      return NextResponse.json({ booking: current });
    }
    let hostReviewRequiredByControls = false;
    if (isRobomataRentalInventoryEnabled()) {
      const vehicle = await getRentalInventoryStore().getVehicle(current.platformVehicleId);
      if (!vehicle) return NextResponse.json({ error: "Rental vehicle not found." }, { status: 404 });
      if (vehicle.operationalStatus !== "listed") {
        return NextResponse.json({ error: "Rental vehicle is no longer available for confirmation." }, { status: 409 });
      }
      hostReviewRequiredByControls = vehicle.hostControls?.bookingReview.requireManualApproval === true;
    }

    const booking = await getRentalBookingStore().confirmBooking(bookingId, {
      ...body,
      hostReviewRequired: body.hostReviewRequired === true || hostReviewRequiredByControls,
      paymentAuthorized: true,
    });
    if (!booking) return NextResponse.json({ error: "Rental booking not found." }, { status: 404 });
    return NextResponse.json({ booking });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to confirm rental booking." },
      { status: error instanceof RentalBookingConflictError ? 409 : 400 },
    );
  }
}
