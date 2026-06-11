import { NextResponse } from "next/server";
import { isRobomataRentalRenterAccountsEnabled } from "~~/lib/featureFlags";
import { RENTER_VERIFICATION_POLICY_V1 } from "~~/lib/robomata/rentalRenters";

export const runtime = "nodejs";

export async function GET() {
  if (!isRobomataRentalRenterAccountsEnabled()) {
    return NextResponse.json({ error: "Robomata renter accounts are not enabled." }, { status: 404 });
  }

  return NextResponse.json({ verificationPolicy: RENTER_VERIFICATION_POLICY_V1 });
}
