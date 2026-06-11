import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalBookingsEnabled } from "~~/lib/featureFlags";
import { getRentalTripStore } from "~~/lib/robomata/server/rentalTripStore";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ bookingId: string }>;
};

function requireBookings() {
  if (isRobomataRentalBookingsEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental bookings are not enabled." }, { status: 404 });
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const featureError = requireBookings();
  if (featureError) return featureError;

  const { bookingId } = await context.params;
  const trip = await getRentalTripStore().getTripByBooking(bookingId);
  if (!trip) return NextResponse.json({ error: "Rental trip not found." }, { status: 404 });
  return NextResponse.json({ trip });
}
