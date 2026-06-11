import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalRenterAccountsEnabled } from "~~/lib/featureFlags";
import type { RenterProfileInput } from "~~/lib/robomata/rentalRenters";
import { RentalRenterValidationError, getRentalRenterStore } from "~~/lib/robomata/server/rentalRenterStore";

export const runtime = "nodejs";

function requireRenterAccounts() {
  if (isRobomataRentalRenterAccountsEnabled()) return null;
  return NextResponse.json({ error: "Robomata renter accounts are not enabled." }, { status: 404 });
}

export async function POST(request: NextRequest) {
  try {
    const featureError = requireRenterAccounts();
    if (featureError) return featureError;

    const body = (await request.json()) as RenterProfileInput;
    const renter = await getRentalRenterStore().upsertRenter(body);
    return NextResponse.json({ renter }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create renter profile." },
      { status: error instanceof RentalRenterValidationError ? 400 : 500 },
    );
  }
}
