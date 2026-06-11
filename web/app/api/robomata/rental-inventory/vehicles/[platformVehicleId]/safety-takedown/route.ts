import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalInventoryEnabled, isRobomataWorkflowMutationEnabled } from "~~/lib/featureFlags";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ platformVehicleId: string }>;
};

type SafetyTakedownBody = {
  reason?: string;
  supportCaseId?: string;
};

function requireRentalInventory() {
  if (isRobomataRentalInventoryEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental inventory is not enabled." }, { status: 404 });
}

function requireMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental inventory writes are not enabled." }, { status: 403 });
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const featureError = requireRentalInventory();
    if (featureError) return featureError;
    const mutationError = requireMutation();
    if (mutationError) return mutationError;

    const { platformVehicleId } = await context.params;
    const body = (await request.json()) as SafetyTakedownBody;
    const vehicle = await getRentalInventoryStore().updateVehicleControls(platformVehicleId, {
      operationalStatus: "suspended",
    });
    if (!vehicle) return NextResponse.json({ error: "Rental vehicle not found." }, { status: 404 });

    return NextResponse.json({
      vehicle,
      takedown: {
        platformVehicleId,
        reason: body.reason,
        supportCaseId: body.supportCaseId,
        status: "suspended",
        occurredAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to perform rental vehicle safety takedown." },
      { status: 400 },
    );
  }
}
