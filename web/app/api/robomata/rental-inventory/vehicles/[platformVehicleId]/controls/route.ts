import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalInventoryEnabled, isRobomataWorkflowMutationEnabled } from "~~/lib/featureFlags";
import type { RentalVehicleHostControlsUpdate } from "~~/lib/robomata/rentalInventory";
import { RentalInventoryValidationError, getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";
import { requireRentalVehicleAccess } from "~~/lib/robomata/server/rentalRouteAccess";
import { requirePartnerAddress } from "~~/lib/robomata/server/submissionAccess";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ platformVehicleId: string }>;
};

function requireRentalInventory() {
  if (isRobomataRentalInventoryEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental inventory is not enabled." }, { status: 404 });
}

function requireRobomataMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental inventory writes are not enabled." }, { status: 403 });
}

export async function GET(request: NextRequest, context: RouteContext) {
  const featureError = requireRentalInventory();
  if (featureError) return featureError;

  const partnerAddress = await requirePartnerAddress(request);
  if (partnerAddress instanceof NextResponse) return partnerAddress;

  const { platformVehicleId } = await context.params;
  const access = await requireRentalVehicleAccess({ partnerAddress, platformVehicleId });
  if (access instanceof NextResponse) return access;
  const { vehicle } = access;
  return NextResponse.json({ controls: vehicle.hostControls ?? null, vehicle });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const featureError = requireRentalInventory();
    if (featureError) return featureError;
    const mutationError = requireRobomataMutation();
    if (mutationError) return mutationError;

    const partnerAddress = await requirePartnerAddress(request);
    if (partnerAddress instanceof NextResponse) return partnerAddress;

    const { platformVehicleId } = await context.params;
    const input = (await request.json()) as RentalVehicleHostControlsUpdate;
    const access = await requireRentalVehicleAccess({ partnerAddress, platformVehicleId });
    if (access instanceof NextResponse) return access;

    const vehicle = await getRentalInventoryStore().updateVehicleControls(platformVehicleId, input);
    if (!vehicle) return NextResponse.json({ error: "Rental vehicle not found." }, { status: 404 });
    return NextResponse.json({ controls: vehicle.hostControls ?? null, vehicle });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update rental vehicle controls." },
      { status: error instanceof RentalInventoryValidationError ? 400 : 500 },
    );
  }
}
