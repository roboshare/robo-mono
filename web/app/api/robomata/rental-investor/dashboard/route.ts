import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalInvestorReportingEnabled } from "~~/lib/featureFlags";
import { type RentalInvestorDashboardInput, buildRentalInvestorDashboard } from "~~/lib/robomata/rentalInvestorKpis";

export const runtime = "nodejs";

function requireInvestorReporting() {
  if (isRobomataRentalInvestorReportingEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental investor reporting is not enabled." }, { status: 404 });
}

function validateDashboardInput(input: RentalInvestorDashboardInput) {
  if (!input.attribution?.facilityAssetId) throw new Error("attribution.facilityAssetId must be provided.");
  if (!Array.isArray(input.attribution.platformVehicleIds) || input.attribution.platformVehicleIds.length === 0) {
    throw new Error("attribution.platformVehicleIds must include at least one platform vehicle.");
  }
  if (!input.metrics?.periodStart || !input.metrics.periodEnd) {
    throw new Error("metrics.periodStart and metrics.periodEnd must be provided.");
  }
}

export async function POST(request: NextRequest) {
  try {
    const featureError = requireInvestorReporting();
    if (featureError) return featureError;

    const body = (await request.json()) as RentalInvestorDashboardInput;
    validateDashboardInput(body);

    return NextResponse.json({ dashboard: buildRentalInvestorDashboard(body) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to build rental investor dashboard." },
      { status: 400 },
    );
  }
}
