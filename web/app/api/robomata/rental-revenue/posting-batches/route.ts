import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataRentalPaymentsEnabled,
  isRobomataRentalRevenuePostingEnabled,
  isRobomataWorkflowMutationEnabled,
} from "~~/lib/featureFlags";
import type { RentalFinancingTarget, RentalRevenueLedgerEntry } from "~~/lib/robomata/rentalRevenue";
import { rentalStoredFacilityAccessError } from "~~/lib/robomata/server/rentalInventoryAccess";
import { getRentalPaymentStore } from "~~/lib/robomata/server/rentalPaymentStore";
import { getRentalRevenueStore } from "~~/lib/robomata/server/rentalRevenueStore";
import { requirePartnerAddress } from "~~/lib/robomata/server/submissionAccess";

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

    const partnerAddress = await requirePartnerAddress(request);
    if (partnerAddress instanceof NextResponse) return partnerAddress;

    const body = (await request.json()) as CreatePostingBatchBody;
    if (!body.periodStart || !body.periodEnd) {
      return NextResponse.json({ error: "periodStart and periodEnd must be provided." }, { status: 400 });
    }
    if (!body.target) return NextResponse.json({ error: "target must be provided." }, { status: 400 });
    const accessError = await rentalStoredFacilityAccessError(body.target.facilityAssetId, partnerAddress);
    if (accessError) return NextResponse.json({ error: accessError }, { status: 403 });
    if (!Array.isArray(body.entries) || body.entries.length === 0) {
      return NextResponse.json({ error: "entries must include at least one ledger entry." }, { status: 400 });
    }
    if (isRobomataRentalPaymentsEnabled()) {
      const paymentIntentIds = [
        ...new Set(body.entries.flatMap(entry => (entry.source.paymentIntentId ? [entry.source.paymentIntentId] : []))),
      ];
      const blockingPayments = await getRentalPaymentStore().listBlockingPaymentsByPaymentIntentIds(paymentIntentIds);
      if (blockingPayments.length > 0) {
        return NextResponse.json(
          {
            blockingPayments: blockingPayments.map(payment => ({
              bookingId: payment.bookingId,
              paymentIntentId: payment.providerReference.paymentIntentId,
              postingBlockReason: payment.postingBlockReason,
              status: payment.status,
            })),
            error: "Payment reconciliation blocks rental revenue posting.",
          },
          { status: 409 },
        );
      }
    }

    const result = await getRentalRevenueStore().createPostingBatch({
      auditEventId: body.auditEventId,
      createdBy: partnerAddress,
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
