import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataRentalPaymentsEnabled,
  isRobomataRentalRevenuePostingEnabled,
  isRobomataWorkflowMutationEnabled,
} from "~~/lib/featureFlags";
import type { RentalPaymentRecord } from "~~/lib/robomata/rentalPayments";
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

function paymentMatchesEntry(payment: RentalPaymentRecord, entry: RentalRevenueLedgerEntry) {
  const bookingMatches = !entry.source.bookingId || payment.bookingId === entry.source.bookingId;
  const intentMatches =
    !entry.source.paymentIntentId || payment.providerReference.paymentIntentId === entry.source.paymentIntentId;
  const facilityMatches = payment.facilityAssetId === entry.facilityAssetId;
  const vehicleMatches = !entry.vehicleAssetId || payment.vehicleAssetId === entry.vehicleAssetId;
  return bookingMatches && intentMatches && facilityMatches && vehicleMatches;
}

function paymentForEntry(payments: RentalPaymentRecord[], entry: RentalRevenueLedgerEntry) {
  const candidates = payments
    .filter(payment => paymentMatchesEntry(payment, entry))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  if (entry.source.paymentIntentId) return candidates[0];
  return candidates.find(payment => !payment.postingBlocked) ?? candidates[0];
}

function paymentCanBackPosting(payment: RentalPaymentRecord) {
  return (
    !payment.postingBlocked &&
    (payment.status === "captured" || payment.status === "partially_captured" || payment.status === "refunded")
  );
}

function netCapturedAmountCents(payment: RentalPaymentRecord) {
  return Math.max(payment.capturedAmountCents - payment.refundedAmountCents, 0);
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
      const paymentBackedEntries = body.entries.filter(entry => entry.source.bookingId || entry.source.paymentIntentId);
      const bookingIds = [
        ...new Set(paymentBackedEntries.flatMap(entry => (entry.source.bookingId ? [entry.source.bookingId] : []))),
      ];
      const paymentIntentIds = [
        ...new Set(
          paymentBackedEntries.flatMap(entry => (entry.source.paymentIntentId ? [entry.source.paymentIntentId] : [])),
        ),
      ];
      const paymentStore = getRentalPaymentStore();
      const referencedPayments = await paymentStore.listPaymentsByReferences({ bookingIds, paymentIntentIds });
      const blockedEntries = paymentBackedEntries
        .map(entry => ({ entry, payment: paymentForEntry(referencedPayments, entry) }))
        .filter(item => item.payment?.postingBlocked);
      if (blockedEntries.length > 0) {
        return NextResponse.json(
          {
            blockingPayments: blockedEntries.map(({ entry, payment }) => ({
              bookingId: entry.source.bookingId,
              id: entry.id,
              paymentIntentId: entry.source.paymentIntentId ?? payment?.providerReference.paymentIntentId,
              postingBlockReason: payment?.postingBlockReason,
              status: payment?.status,
            })),
            error: "Payment reconciliation blocks rental revenue posting.",
          },
          { status: 409 },
        );
      }
      const unreconciledEntries = paymentBackedEntries.filter(entry => {
        const payment = paymentForEntry(referencedPayments, entry);
        return !payment || !paymentCanBackPosting(payment);
      });
      if (unreconciledEntries.length > 0) {
        return NextResponse.json(
          {
            entries: unreconciledEntries.map(entry => ({
              bookingId: entry.source.bookingId,
              id: entry.id,
              paymentIntentId: entry.source.paymentIntentId,
            })),
            error: "Captured payment reconciliation is required before rental revenue posting.",
          },
          { status: 409 },
        );
      }
      const paymentBackedTotals = new Map<
        string,
        { amountCents: number; entries: RentalRevenueLedgerEntry[]; payment: RentalPaymentRecord }
      >();
      for (const entry of paymentBackedEntries) {
        const payment = paymentForEntry(referencedPayments, entry);
        if (!payment) continue;
        const current = paymentBackedTotals.get(payment.id) ?? { amountCents: 0, entries: [], payment };
        current.amountCents += entry.amountCents;
        current.entries.push(entry);
        paymentBackedTotals.set(payment.id, current);
      }
      const overCapturedPayment = [...paymentBackedTotals.values()].find(
        item => item.amountCents > netCapturedAmountCents(item.payment),
      );
      if (overCapturedPayment) {
        return NextResponse.json(
          {
            entries: overCapturedPayment.entries.map(entry => ({
              amountCents: entry.amountCents,
              bookingId: entry.source.bookingId,
              id: entry.id,
              paymentIntentId: entry.source.paymentIntentId,
            })),
            error: "Payment-backed revenue exceeds captured payment amount.",
            payment: {
              bookingId: overCapturedPayment.payment.bookingId,
              capturedAmountCents: overCapturedPayment.payment.capturedAmountCents,
              netCapturedAmountCents: netCapturedAmountCents(overCapturedPayment.payment),
              paymentIntentId: overCapturedPayment.payment.providerReference.paymentIntentId,
              refundedAmountCents: overCapturedPayment.payment.refundedAmountCents,
              status: overCapturedPayment.payment.status,
            },
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
