import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataRentalBookingsEnabled,
  isRobomataRentalInventoryEnabled,
  isRobomataWorkflowMutationEnabled,
} from "~~/lib/featureFlags";
import { RentalBookingConflictError, getRentalBookingStore } from "~~/lib/robomata/server/rentalBookingStore";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";
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

    if (isRobomataRentalInventoryEnabled()) {
      const vehicle = await getRentalInventoryStore().getVehicle(current.platformVehicleId);
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
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to approve rental booking." },
      { status: error instanceof RentalBookingConflictError ? 409 : 400 },
    );
  }
}
