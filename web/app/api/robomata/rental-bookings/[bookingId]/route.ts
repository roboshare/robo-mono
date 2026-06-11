import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalBookingsEnabled } from "~~/lib/featureFlags";
import { getRentalBookingStore } from "~~/lib/robomata/server/rentalBookingStore";
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

export async function GET(request: NextRequest, context: RouteContext) {
  const featureError = requireBookings();
  if (featureError) return featureError;

  const partnerAddress = await requirePartnerAddress(request);
  if (partnerAddress instanceof NextResponse) return partnerAddress;

  const { bookingId } = await context.params;
  const booking = await getRentalBookingStore().getBooking(bookingId);
  if (!booking) return NextResponse.json({ error: "Rental booking not found." }, { status: 404 });
  const accessError = await requireRentalBookingAccess(booking, partnerAddress);
  if (accessError) return accessError;

  return NextResponse.json({ booking });
}
