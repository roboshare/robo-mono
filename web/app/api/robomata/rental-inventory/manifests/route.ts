import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalInventoryEnabled, isRobomataWorkflowMutationEnabled } from "~~/lib/featureFlags";
import type { FacilityInventoryManifest, RentalInventorySourceEvent } from "~~/lib/robomata/rentalInventory";
import { RentalInventoryValidationError, getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";
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

export async function GET(request: NextRequest) {
  const featureError = requireRentalInventory();
  if (featureError) return featureError;

  const partnerAddress = await requirePartnerAddress(request);
  if (partnerAddress instanceof NextResponse) return partnerAddress;

  const facilityAssetId = request.nextUrl.searchParams.get("facilityAssetId")?.trim() || undefined;
  const manifests = await getRentalInventoryStore().listManifests(facilityAssetId);
  return NextResponse.json({ manifests });
}

export async function POST(request: NextRequest) {
  try {
    const featureError = requireRentalInventory();
    if (featureError) return featureError;
    const mutationError = requireRobomataMutation();
    if (mutationError) return mutationError;

    const partnerAddress = await requirePartnerAddress(request);
    if (partnerAddress instanceof NextResponse) return partnerAddress;

    const body = (await request.json()) as {
      manifest?: FacilityInventoryManifest;
      sourceEvent?: RentalInventorySourceEvent;
    };
    if (!body.manifest || typeof body.manifest !== "object") {
      return NextResponse.json({ error: "manifest must be provided." }, { status: 400 });
    }

    const result = await getRentalInventoryStore().upsertManifest(body.manifest, {
      actor: partnerAddress,
      sourceEvent: body.sourceEvent,
      trigger: body.sourceEvent ? "registry_event" : "api_upload",
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to upsert rental inventory manifest." },
      { status: error instanceof RentalInventoryValidationError ? 400 : 500 },
    );
  }
}
