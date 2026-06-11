import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalInventoryEnabled, isRobomataRentalPaymentsEnabled } from "~~/lib/featureFlags";
import { rentalMarketplaceListingFromVehicle } from "~~/lib/robomata/rentalMarketplace";
import {
  DEFAULT_RENTAL_DEPOSIT_POLICY,
  type RentalDepositPolicy,
  type RentalPaymentFees,
  buildRentalCheckoutPaymentPlan,
  buildStripeAuthorizationRequest,
} from "~~/lib/robomata/rentalPayments";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";

export const runtime = "nodejs";

type PaymentPlanRequestBody = {
  bookingId?: string;
  dateFrom?: string;
  dateTo?: string;
  depositPolicy?: RentalDepositPolicy;
  fees?: RentalPaymentFees;
  platformVehicleId?: string;
};

function requireRentalPayments() {
  if (!isRobomataRentalInventoryEnabled()) {
    return NextResponse.json({ error: "Robomata rental inventory is not enabled." }, { status: 404 });
  }
  if (!isRobomataRentalPaymentsEnabled()) {
    return NextResponse.json({ error: "Robomata rental payments are not enabled." }, { status: 404 });
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const featureError = requireRentalPayments();
    if (featureError) return featureError;

    const body = (await request.json()) as PaymentPlanRequestBody;
    if (!body.platformVehicleId?.trim()) {
      return NextResponse.json({ error: "platformVehicleId must be provided." }, { status: 400 });
    }

    const vehicle = await getRentalInventoryStore().getVehicle(body.platformVehicleId);
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
      bookingId: body.bookingId,
      depositPolicy: body.depositPolicy ?? DEFAULT_RENTAL_DEPOSIT_POLICY,
      fees: body.fees,
      listing,
      tripEstimate: listing.tripEstimate,
    });
    return NextResponse.json({
      paymentPlan,
      providerAuthorizationRequest: buildStripeAuthorizationRequest(paymentPlan),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to build rental payment plan." },
      { status: 400 },
    );
  }
}
