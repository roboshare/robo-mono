import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalBookingsEnabled, isRobomataWorkflowMutationEnabled } from "~~/lib/featureFlags";
import type { RentalClaimUpdateInput } from "~~/lib/robomata/rentalClaims";
import { getRentalClaimStore } from "~~/lib/robomata/server/rentalClaimStore";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ claimId: string }>;
};

function requireClaims() {
  if (isRobomataRentalBookingsEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental claims are not enabled." }, { status: 404 });
}

function requireMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental claim writes are not enabled." }, { status: 403 });
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const featureError = requireClaims();
  if (featureError) return featureError;

  const { claimId } = await context.params;
  const claim = await getRentalClaimStore().getClaim(claimId);
  if (!claim) return NextResponse.json({ error: "Rental claim not found." }, { status: 404 });
  return NextResponse.json({ claim });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const featureError = requireClaims();
    if (featureError) return featureError;
    const mutationError = requireMutation();
    if (mutationError) return mutationError;

    const { claimId } = await context.params;
    const input = (await request.json()) as RentalClaimUpdateInput;
    const claim = await getRentalClaimStore().updateClaim(claimId, input);
    if (!claim) return NextResponse.json({ error: "Rental claim not found." }, { status: 404 });
    return NextResponse.json({ claim });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update rental claim." },
      { status: 400 },
    );
  }
}
