import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalBookingsEnabled, isRobomataWorkflowMutationEnabled } from "~~/lib/featureFlags";
import type { RentalIncidentRecord } from "~~/lib/robomata/rentalSupport";
import { getRentalBookingStore } from "~~/lib/robomata/server/rentalBookingStore";
import { requireRentalBookingAccess } from "~~/lib/robomata/server/rentalRouteAccess";
import { getRentalSupportStore } from "~~/lib/robomata/server/rentalSupportStore";
import { requirePartnerAddress } from "~~/lib/robomata/server/submissionAccess";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ bookingId: string }>;
};

type IncidentInput = Pick<
  RentalIncidentRecord,
  "actor" | "kind" | "notes" | "refundAdjustmentCents" | "status" | "supportCaseId"
>;

function requireBookings() {
  if (isRobomataRentalBookingsEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental bookings are not enabled." }, { status: 404 });
}

function requireMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental support writes are not enabled." }, { status: 403 });
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
    const booking = await getRentalBookingStore().getBooking(bookingId);
    if (!booking) return NextResponse.json({ error: "Rental booking not found." }, { status: 404 });
    const accessError = await requireRentalBookingAccess(booking, partnerAddress);
    if (accessError) return accessError;

    const input = (await request.json()) as IncidentInput;
    const result = await getRentalSupportStore().recordIncident({
      bookingId: booking.id,
      platformVehicleId: booking.platformVehicleId,
      facilityAssetId: booking.facilityAssetId,
      vehicleAssetId: booking.vehicleAssetId,
      actor: input.actor,
      kind: input.kind,
      notes: input.notes,
      refundAdjustmentCents: input.refundAdjustmentCents,
      status: input.status ?? "open",
      supportCaseId: input.supportCaseId,
    });
    const updatedBooking = await getRentalBookingStore().updateBookingState(booking.id, {
      eventKind: "incident_recorded",
      payload: {
        auditEventId: result.auditEvent.id,
        incidentId: result.incident.id,
        refundAdjustmentCents: result.incident.refundAdjustmentCents,
      },
      state: booking.state,
    });
    return NextResponse.json(
      { auditEvent: result.auditEvent, booking: updatedBooking, incident: result.incident },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to record rental booking incident." },
      { status: 400 },
    );
  }
}
