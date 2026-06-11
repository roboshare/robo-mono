import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataRentalBookingsEnabled,
  isRobomataRentalInventoryEnabled,
  isRobomataRentalPaymentsEnabled,
  isRobomataRentalRenterAccountsEnabled,
  isRobomataWorkflowMutationEnabled,
} from "~~/lib/featureFlags";
import { defaultRentalCancellationPolicy } from "~~/lib/robomata/rentalBookings";
import { rentalMarketplaceListingFromVehicle } from "~~/lib/robomata/rentalMarketplace";
import { buildRentalCheckoutPaymentPlan } from "~~/lib/robomata/rentalPayments";
import { renterCheckoutEligibility } from "~~/lib/robomata/rentalRenters";
import { RentalBookingConflictError, getRentalBookingStore } from "~~/lib/robomata/server/rentalBookingStore";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";
import { getRentalRenterStore } from "~~/lib/robomata/server/rentalRenterStore";

export const runtime = "nodejs";

type CheckoutRequestBody = {
  dateFrom?: string;
  dateTo?: string;
  platformVehicleId?: string;
  renterId?: string;
};

function requireBookingCheckout() {
  if (!isRobomataRentalBookingsEnabled()) {
    return NextResponse.json({ error: "Robomata rental bookings are not enabled." }, { status: 404 });
  }
  if (
    !isRobomataRentalInventoryEnabled() ||
    !isRobomataRentalPaymentsEnabled() ||
    !isRobomataRentalRenterAccountsEnabled()
  ) {
    return NextResponse.json({ error: "Rental checkout dependencies are not enabled." }, { status: 404 });
  }
  if (!isRobomataWorkflowMutationEnabled()) {
    return NextResponse.json({ error: "Robomata rental booking writes are not enabled." }, { status: 403 });
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const featureError = requireBookingCheckout();
    if (featureError) return featureError;

    const body = (await request.json()) as CheckoutRequestBody;
    if (!body.renterId?.trim()) return NextResponse.json({ error: "renterId must be provided." }, { status: 400 });
    if (!body.platformVehicleId?.trim()) {
      return NextResponse.json({ error: "platformVehicleId must be provided." }, { status: 400 });
    }
    if (!body.dateFrom?.trim() || !body.dateTo?.trim()) {
      return NextResponse.json({ error: "dateFrom and dateTo must be provided." }, { status: 400 });
    }
    const dateFrom = Date.parse(body.dateFrom);
    const dateTo = Date.parse(body.dateTo);
    if (!Number.isFinite(dateFrom) || !Number.isFinite(dateTo) || dateTo <= dateFrom) {
      return NextResponse.json({ error: "dateFrom and dateTo must be valid ordered timestamps." }, { status: 400 });
    }
    if (dateFrom < Date.now()) {
      return NextResponse.json({ error: "dateFrom cannot be in the past." }, { status: 400 });
    }

    const [renter, vehicle] = await Promise.all([
      getRentalRenterStore().getRenter(body.renterId),
      getRentalInventoryStore().getVehicle(body.platformVehicleId),
    ]);
    if (!renter) return NextResponse.json({ error: "Renter profile not found." }, { status: 404 });
    if (!vehicle) return NextResponse.json({ error: "Rental vehicle not found." }, { status: 404 });

    const listing = rentalMarketplaceListingFromVehicle(vehicle, {
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      platformVehicleId: body.platformVehicleId,
    });
    if (listing.status !== "available") {
      return NextResponse.json({ error: "Rental vehicle is not available for the requested dates." }, { status: 409 });
    }
    if (!listing.tripEstimate) {
      return NextResponse.json({ error: "Rental vehicle does not have pricing configured." }, { status: 409 });
    }

    const paymentPlan = buildRentalCheckoutPaymentPlan({
      listing,
      tripEstimate: listing.tripEstimate,
    });
    const eligibility = renterCheckoutEligibility(renter);
    const booking = await getRentalBookingStore().createBooking({
      renterId: renter.id,
      platformVehicleId: listing.platformVehicleId,
      facilityAssetId: listing.facilityAssetId,
      vehicleAssetId: listing.vehicleAssetId,
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      state: eligibility.eligible ? "pending_payment_authorization" : "pending_renter_verification",
      paymentPlan,
      cancellationPolicy: defaultRentalCancellationPolicy(body.dateFrom),
    });

    return NextResponse.json({ booking, checkoutEligibility: eligibility }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start rental booking checkout." },
      { status: error instanceof RentalBookingConflictError ? 409 : 400 },
    );
  }
}
