import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalBookingsEnabled, isRobomataWorkflowMutationEnabled } from "~~/lib/featureFlags";
import type { RentalClaimCreateInput } from "~~/lib/robomata/rentalClaims";
import { getRentalBookingStore } from "~~/lib/robomata/server/rentalBookingStore";
import { getRentalClaimStore } from "~~/lib/robomata/server/rentalClaimStore";

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
  return NextResponse.json({ error: "Robomata rental claim writes are not enabled." }, { status: 403 });
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

    const input = (await request.json()) as RentalClaimCreateInput;
    const claim = await getRentalClaimStore().createClaim(booking, input);
    const updatedBooking = await getRentalBookingStore().updateBookingState(booking.id, {
      eventKind: "incident_recorded",
      payload: {
        claimId: claim.id,
        payoutHoldStatus: claim.payoutHold.status,
        status: claim.status,
      },
      state: booking.state === "completed" ? "disputed" : booking.state,
    });
    return NextResponse.json({ booking: updatedBooking, claim }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create rental claim." },
      { status: 400 },
    );
  }
}
