import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalRenterAccountsEnabled, isRobomataWorkflowMutationEnabled } from "~~/lib/featureFlags";
import {
  RENTER_VERIFICATION_POLICY_V1,
  type RenterVerificationUpdate,
  renterCheckoutEligibility,
} from "~~/lib/robomata/rentalRenters";
import { getRentalRenterStore } from "~~/lib/robomata/server/rentalRenterStore";
import {
  normalizeRenterVerificationProviderUpdate,
  renterVerificationProviderPolicy,
} from "~~/lib/robomata/server/rentalVerificationProviders";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ renterId: string }>;
};

function requireRenterAccounts() {
  if (isRobomataRentalRenterAccountsEnabled()) return null;
  return NextResponse.json({ error: "Robomata renter accounts are not enabled." }, { status: 404 });
}

function requireMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata renter verification writes are not enabled." }, { status: 403 });
}

function requireVerificationAuthorization(request: NextRequest) {
  const configuredSecret = process.env.ROBOMATA_RENTER_VERIFICATION_SECRET?.trim();
  if (!configuredSecret && process.env.NODE_ENV === "development") return null;
  if (!configuredSecret) {
    return NextResponse.json({ error: "Renter verification updates require a configured secret." }, { status: 403 });
  }

  const authorization = request.headers.get("authorization");
  if (authorization === `Bearer ${configuredSecret}`) return null;
  return NextResponse.json({ error: "Invalid renter verification authorization." }, { status: 401 });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const featureError = requireRenterAccounts();
    if (featureError) return featureError;
    const mutationError = requireMutation();
    if (mutationError) return mutationError;
    const authorizationError = requireVerificationAuthorization(request);
    if (authorizationError) return authorizationError;

    const { renterId } = await context.params;
    const body = (await request.json()) as RenterVerificationUpdate;
    const providerUpdate = normalizeRenterVerificationProviderUpdate(body);
    const renter = await getRentalRenterStore().updateVerification(renterId, {
      ...providerUpdate,
      policyVersion: providerUpdate.policyVersion ?? RENTER_VERIFICATION_POLICY_V1.version,
    });
    if (!renter) return NextResponse.json({ error: "Renter profile not found." }, { status: 404 });
    return NextResponse.json({
      checkoutEligibility: renterCheckoutEligibility(renter),
      renter,
      verificationProviders: renterVerificationProviderPolicy(),
      verificationPolicy: RENTER_VERIFICATION_POLICY_V1,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update renter verification." },
      { status: 400 },
    );
  }
}
