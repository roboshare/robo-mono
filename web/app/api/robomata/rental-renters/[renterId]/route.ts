import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalRenterAccountsEnabled } from "~~/lib/featureFlags";
import { RENTER_VERIFICATION_POLICY_V1, renterCheckoutEligibility } from "~~/lib/robomata/rentalRenters";
import { getRentalRenterStore } from "~~/lib/robomata/server/rentalRenterStore";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ renterId: string }>;
};

function requireRenterAccounts() {
  if (isRobomataRentalRenterAccountsEnabled()) return null;
  return NextResponse.json({ error: "Robomata renter accounts are not enabled." }, { status: 404 });
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const featureError = requireRenterAccounts();
  if (featureError) return featureError;

  const { renterId } = await context.params;
  const renter = await getRentalRenterStore().getRenter(renterId);
  if (!renter) return NextResponse.json({ error: "Renter profile not found." }, { status: 404 });

  return NextResponse.json({
    checkoutEligibility: renterCheckoutEligibility(renter),
    renter,
    verificationPolicy: RENTER_VERIFICATION_POLICY_V1,
  });
}
