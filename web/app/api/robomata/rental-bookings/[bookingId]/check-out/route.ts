import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataRentalBookingsEnabled,
  isRobomataRentalInventoryEnabled,
  isRobomataWorkflowMutationEnabled,
} from "~~/lib/featureFlags";
import type { RentalTripCheckOutInput } from "~~/lib/robomata/rentalTrips";
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
    if (booking.state !== "in_trip" && booking.state !== "return_pending") {
      return NextResponse.json({ error: `Booking cannot check out from state ${booking.state}.` }, { status: 409 });
    }

    const input = (await request.json()) as RentalTripCheckOutInput;
    const trip = await getRentalTripStore().checkOut(booking.id, input);
    if (!trip) return NextResponse.json({ error: "Rental trip check-in not found." }, { status: 404 });

    const updatedBooking = await getRentalBookingStore().updateBookingState(booking.id, {
      eventKind: trip.exception ? "trip_exception_reported" : "trip_completed",
      payload: {
        facilityAssetId: trip.facilityAssetId,
        platformVehicleId: trip.platformVehicleId,
        tripId: trip.id,
        vehicleAssetId: trip.vehicleAssetId,
      },
      state: trip.exception ? "disputed" : "completed",
    });
    if (isRobomataRentalInventoryEnabled()) {
      await getRentalInventoryStore().updateVehicleControls(booking.platformVehicleId, {
        operationalStatus: trip.exception ? "suspended" : "turnaround",
      });
    }
    return NextResponse.json({ booking: updatedBooking, trip });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to complete rental check-out." },
      { status: 400 },
    );
  }
}
