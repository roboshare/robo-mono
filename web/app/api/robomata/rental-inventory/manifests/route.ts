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

function configuredFacilityOwners(): Record<string, string> {
  const raw = process.env.ROBOMATA_RENTAL_INVENTORY_FACILITY_OWNERS_JSON?.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([facilityAssetId, partnerAddress]) =>
      typeof partnerAddress === "string" ? [[facilityAssetId, partnerAddress.toLowerCase()]] : [],
    ),
  );
}

function requireManifestFacilityAccess(manifest: FacilityInventoryManifest, partnerAddress: string) {
  const normalizedPartner = partnerAddress.toLowerCase();
  const configuredOwner = configuredFacilityOwners()[manifest.facilityAssetId]?.toLowerCase();
  if (configuredOwner && configuredOwner !== normalizedPartner) {
    return NextResponse.json(
      { error: "Partner is not authorized for this rental facility manifest." },
      { status: 403 },
    );
  }

  const sourceId = manifest.source?.sourceId?.trim().toLowerCase();
  if (sourceId && sourceId !== normalizedPartner) {
    return NextResponse.json({ error: "Manifest sourceId must match the authorized partner." }, { status: 403 });
  }
  if (!configuredOwner && !sourceId && process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Manifest facility ownership must be configured or source-attributed." },
      { status: 403 },
    );
  }
  return null;
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
    const accessError = requireManifestFacilityAccess(body.manifest, partnerAddress);
    if (accessError) return accessError;

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
