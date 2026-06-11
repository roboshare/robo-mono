import { NextRequest, NextResponse } from "next/server";
import { isRobomataRentalRevenuePostingEnabled, isRobomataWorkflowMutationEnabled } from "~~/lib/featureFlags";
import type { RentalFinancingTarget, RentalRevenueLedgerEntry } from "~~/lib/robomata/rentalRevenue";
import { getRentalRevenueStore } from "~~/lib/robomata/server/rentalRevenueStore";

export const runtime = "nodejs";

type CreatePostingBatchBody = {
  auditEventId?: string;
  createdBy?: string;
  entries?: RentalRevenueLedgerEntry[];
  periodEnd?: string;
  periodStart?: string;
  target?: RentalFinancingTarget;
};

function requireRevenuePosting() {
  if (isRobomataRentalRevenuePostingEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental revenue posting is not enabled." }, { status: 404 });
}

function requireMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata rental revenue posting writes are not enabled." }, { status: 403 });
}

export async function POST(request: NextRequest) {
  try {
    const featureError = requireRevenuePosting();
    if (featureError) return featureError;
    const mutationError = requireMutation();
    if (mutationError) return mutationError;

    const body = (await request.json()) as CreatePostingBatchBody;
    if (!body.periodStart || !body.periodEnd) {
      return NextResponse.json({ error: "periodStart and periodEnd must be provided." }, { status: 400 });
    }
    if (!body.target) return NextResponse.json({ error: "target must be provided." }, { status: 400 });
    if (!Array.isArray(body.entries) || body.entries.length === 0) {
      return NextResponse.json({ error: "entries must include at least one ledger entry." }, { status: 400 });
    }

    const result = await getRentalRevenueStore().createPostingBatch({
      auditEventId: body.auditEventId,
      createdBy: body.createdBy,
      entries: body.entries,
      periodEnd: body.periodEnd,
      periodStart: body.periodStart,
      target: body.target,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create rental revenue posting batch." },
      { status: 400 },
    );
  }
}
