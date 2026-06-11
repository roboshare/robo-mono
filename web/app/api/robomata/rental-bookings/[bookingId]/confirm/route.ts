import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalBookingsEnabled, isRobomataRentalInventoryEnabled } from "~~/lib/featureFlags";
import type { RentalBookingConfirmationInput } from "~~/lib/robomata/rentalBookings";
import { renterCheckoutEligibility } from "~~/lib/robomata/rentalRenters";
import { RentalBookingConflictError, getRentalBookingStore } from "~~/lib/robomata/server/rentalBookingStore";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";
import { getRentalRenterStore } from "~~/lib/robomata/server/rentalRenterStore";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ bookingId: string }>;
};

function requireBookings() {
  if (isRobomataRentalBookingsEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental bookings are not enabled." }, { status: 404 });
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const featureError = requireBookings();
    if (featureError) return featureError;

    const { bookingId } = await context.params;
    const body = (await request.json()) as RentalBookingConfirmationInput;
    if (!body.paymentAuthorized) {
      return NextResponse.json({ error: "paymentAuthorized must be true before confirmation." }, { status: 409 });
    }

    let current = await getRentalBookingStore().getBooking(bookingId);
    if (!current) return NextResponse.json({ error: "Rental booking not found." }, { status: 404 });
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
    if (current.state !== "pending_payment_authorization") {
      return NextResponse.json({ error: `Booking cannot be confirmed from state ${current.state}.` }, { status: 409 });
    }
    if (isRobomataRentalInventoryEnabled()) {
      const vehicle = await getRentalInventoryStore().getVehicle(current.platformVehicleId);
      if (!vehicle) return NextResponse.json({ error: "Rental vehicle not found." }, { status: 404 });
    }

    const booking = await getRentalBookingStore().confirmBooking(bookingId, body);
    if (!booking) return NextResponse.json({ error: "Rental booking not found." }, { status: 404 });
    if (isRobomataRentalInventoryEnabled()) {
      await getRentalInventoryStore().updateVehicleControls(booking.platformVehicleId, {
        operationalStatus: "reserved",
      });
    }
    return NextResponse.json({ booking });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to confirm rental booking." },
      { status: error instanceof RentalBookingConflictError ? 409 : 400 },
    );
  }
}
