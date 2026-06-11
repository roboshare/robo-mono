import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataRentalInventoryEnabled,
  isRobomataRentalInventoryScheduledSyncEnabled,
  isRobomataWorkflowMutationEnabled,
} from "~~/lib/featureFlags";
import { ROBOMATA_AUTH_HEADERS } from "~~/lib/robomata/auth";
import { syncFacilityRegistryRentalInventory } from "~~/lib/robomata/server/rentalInventoryFacilityRegistrySync";
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

function requireScheduledSync(request: NextRequest) {
  if (!isRobomataRentalInventoryScheduledSyncEnabled()) {
    return NextResponse.json({ error: "Robomata rental inventory scheduled sync is not enabled." }, { status: 403 });
  }

  const configuredSecret = process.env.CRON_SECRET?.trim() || process.env.ROBOMATA_RENTAL_INVENTORY_SYNC_SECRET?.trim();
  if (!configuredSecret) {
    return NextResponse.json(
      { error: "Rental inventory scheduled sync requires a configured bearer secret." },
      { status: 403 },
    );
  }

  const authorization = request.headers.get("authorization");
  if (authorization === `Bearer ${configuredSecret}`) return null;
  return NextResponse.json({ error: "Invalid rental inventory sync authorization." }, { status: 401 });
}

function parseOptionalInteger(value: unknown, field: string): bigint | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`${field} must be a non-negative integer.`);
}

function parseOptionalChainId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("chainId must be a positive integer.");
  return parsed;
}

async function parseBody(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function POST(request: NextRequest) {
  try {
    const featureError = requireRentalInventory();
    if (featureError) return featureError;
    const mutationError = requireRobomataMutation();
    if (mutationError) return mutationError;

    const partnerAddress = await requirePartnerAddress(request);
    if (partnerAddress instanceof NextResponse) return partnerAddress;

    const body = await parseBody(request);
    const chainId = parseOptionalChainId(body.chainId ?? request.headers.get(ROBOMATA_AUTH_HEADERS.chainId));
    const result = await syncFacilityRegistryRentalInventory({
      actor: partnerAddress,
      chainId,
      fromBlock: parseOptionalInteger(body.fromBlock, "fromBlock"),
      maxBlockRange: parseOptionalInteger(body.maxBlockRange, "maxBlockRange"),
      toBlock: parseOptionalInteger(body.toBlock, "toBlock"),
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to sync FacilityRegistry rental inventory." },
      { status: 400 },
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const featureError = requireRentalInventory();
    if (featureError) return featureError;
    const scheduledSyncError = requireScheduledSync(request);
    if (scheduledSyncError) return scheduledSyncError;

    const chainId = parseOptionalChainId(request.nextUrl.searchParams.get("chainId"));
    const result = await syncFacilityRegistryRentalInventory({
      actor: "scheduled-sync",
      chainId,
      fromBlock: parseOptionalInteger(request.nextUrl.searchParams.get("fromBlock"), "fromBlock"),
      maxBlockRange: parseOptionalInteger(request.nextUrl.searchParams.get("maxBlockRange"), "maxBlockRange"),
      toBlock: parseOptionalInteger(request.nextUrl.searchParams.get("toBlock"), "toBlock"),
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to sync FacilityRegistry rental inventory." },
      { status: 400 },
    );
  }
}
