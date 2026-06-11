import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalInventoryEnabled, isRobomataWorkflowMutationEnabled } from "~~/lib/featureFlags";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";
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

export async function POST(request: NextRequest, context: { params: Promise<{ manifestId: string }> }) {
  try {
    const featureError = requireRentalInventory();
    if (featureError) return featureError;
    const mutationError = requireRobomataMutation();
    if (mutationError) return mutationError;

    const partnerAddress = await requirePartnerAddress(request);
    if (partnerAddress instanceof NextResponse) return partnerAddress;

    const { manifestId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { replayOfRunId?: string };
    const result = await getRentalInventoryStore().replayManifest(decodeURIComponent(manifestId), {
      actor: partnerAddress,
      replayOfRunId: body.replayOfRunId,
      trigger: "manual_replay",
    });
    if (!result) return NextResponse.json({ error: "Rental inventory manifest not found." }, { status: 404 });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to replay rental inventory manifest." },
      { status: 500 },
    );
  }
}
