import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalInventoryEnabled } from "~~/lib/featureFlags";
import { type RentalMarketplaceSearchInput, buildRentalMarketplaceListings } from "~~/lib/robomata/rentalMarketplace";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";

export const runtime = "nodejs";

function requireRentalInventory() {
  if (isRobomataRentalInventoryEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental marketplace is not enabled." }, { status: 404 });
}

function parseOptionalInteger(value: string | null, field: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${field} must be a non-negative integer.`);
  return parsed;
}

function parseOptionalBoolean(value: string | null): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("Boolean query parameters must be true or false.");
}

function searchFromRequest(request: NextRequest): RentalMarketplaceSearchInput {
  const params = request.nextUrl.searchParams;
  return {
    city: params.get("city")?.trim() || undefined,
    country: params.get("country")?.trim() || undefined,
    dateFrom: params.get("dateFrom")?.trim() || undefined,
    dateTo: params.get("dateTo")?.trim() || undefined,
    deliveryAvailable: parseOptionalBoolean(params.get("deliveryAvailable")),
    evOnly: parseOptionalBoolean(params.get("evOnly")),
    facilityAssetId: params.get("facilityAssetId")?.trim() || undefined,
    instantBookEnabled: parseOptionalBoolean(params.get("instantBookEnabled")),
    maxDailyRateCents: parseOptionalInteger(params.get("maxDailyRateCents"), "maxDailyRateCents"),
    minDailyRateCents: parseOptionalInteger(params.get("minDailyRateCents"), "minDailyRateCents"),
    minSeats: parseOptionalInteger(params.get("minSeats"), "minSeats"),
    platformVehicleId: params.get("platformVehicleId")?.trim() || undefined,
    region: params.get("region")?.trim() || undefined,
    vehicleType: params.get("vehicleType")?.trim() || undefined,
  };
}

export async function GET(request: NextRequest) {
  try {
    const featureError = requireRentalInventory();
    if (featureError) return featureError;

    const search = searchFromRequest(request);
    const vehicles = await getRentalInventoryStore().listVehicles({
      facilityAssetId: search.facilityAssetId,
      platformVehicleId: search.platformVehicleId,
    });
    const listings = buildRentalMarketplaceListings(vehicles, search);
    return NextResponse.json({ listings, search });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to search rental marketplace listings." },
      { status: 400 },
    );
  }
}
