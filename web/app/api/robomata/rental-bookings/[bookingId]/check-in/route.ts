import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataRentalBookingsEnabled,
  isRobomataRentalInventoryEnabled,
  isRobomataWorkflowMutationEnabled,
} from "~~/lib/featureFlags";
import type { RentalTripCheckInInput } from "~~/lib/robomata/rentalTrips";
import { getRentalBookingStore } from "~~/lib/robomata/server/rentalBookingStore";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";
import { getRentalTripStore } from "~~/lib/robomata/server/rentalTripStore";

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

    const { bookingId } = await context.params;
    const booking = await getRentalBookingStore().getBooking(bookingId);
    if (!booking) return NextResponse.json({ error: "Rental booking not found." }, { status: 404 });
    if (booking.state !== "confirmed" && booking.state !== "check_in_open") {
      return NextResponse.json({ error: `Booking cannot check in from state ${booking.state}.` }, { status: 409 });
    }

    const input = (await request.json()) as RentalTripCheckInInput;
    const trip = await getRentalTripStore().checkIn({
      bookingId: booking.id,
      platformVehicleId: booking.platformVehicleId,
      facilityAssetId: booking.facilityAssetId,
      vehicleAssetId: booking.vehicleAssetId,
      checkIn: input,
    });
    const updatedBooking = await getRentalBookingStore().updateBookingState(booking.id, {
      eventKind: "check_in_completed",
      payload: { tripId: trip.id },
      state: "in_trip",
    });
    if (isRobomataRentalInventoryEnabled()) {
      await getRentalInventoryStore().updateVehicleControls(booking.platformVehicleId, {
        operationalStatus: "in_trip",
      });
    }
    return NextResponse.json({ booking: updatedBooking, trip }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to complete rental check-in." },
      { status: 400 },
    );
  }
}
