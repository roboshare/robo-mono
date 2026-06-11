import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalInventoryEnabled, isRobomataWorkflowMutationEnabled } from "~~/lib/featureFlags";
import type { RentalVehicleHostSetupUpdate } from "~~/lib/robomata/rentalInventory";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";
import { requireRentalVehicleAccess } from "~~/lib/robomata/server/rentalRouteAccess";
import { requirePartnerAddress } from "~~/lib/robomata/server/submissionAccess";

export const runtime = "nodejs";

function requireRentalInventory() {
  if (isRobomataRentalInventoryEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental inventory is not enabled." }, { status: 404 });
}

function requireRobomataMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental inventory writes are not enabled." }, { status: 403 });
}

export async function GET(request: NextRequest, context: { params: Promise<{ platformVehicleId: string }> }) {
  const featureError = requireRentalInventory();
  if (featureError) return featureError;

  const partnerAddress = await requirePartnerAddress(request);
  if (partnerAddress instanceof NextResponse) return partnerAddress;

  const { platformVehicleId } = await context.params;
  const access = await requireRentalVehicleAccess({
    partnerAddress,
    platformVehicleId: decodeURIComponent(platformVehicleId),
  });
  if (access instanceof NextResponse) return access;
  const { vehicle } = access;
  return NextResponse.json({ setup: vehicle.hostSetup ?? null, vehicle });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ platformVehicleId: string }> }) {
  try {
    const featureError = requireRentalInventory();
    if (featureError) return featureError;
    const mutationError = requireRobomataMutation();
    if (mutationError) return mutationError;

    const partnerAddress = await requirePartnerAddress(request);
    if (partnerAddress instanceof NextResponse) return partnerAddress;

    const { platformVehicleId } = await context.params;
    const body = (await request.json()) as { setup?: RentalVehicleHostSetupUpdate };
    if (!body.setup || typeof body.setup !== "object") {
      return NextResponse.json({ error: "setup must be provided." }, { status: 400 });
    }

    const access = await requireRentalVehicleAccess({
      partnerAddress,
      platformVehicleId: decodeURIComponent(platformVehicleId),
    });
    if (access instanceof NextResponse) return access;

    const vehicle = await getRentalInventoryStore().updateVehicleSetup(
      decodeURIComponent(platformVehicleId),
      body.setup,
    );
    if (!vehicle) return NextResponse.json({ error: "Rental vehicle not found." }, { status: 404 });
    return NextResponse.json({ setup: vehicle.hostSetup, vehicle });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update rental vehicle setup." },
      { status: 500 },
    );
  }
}
