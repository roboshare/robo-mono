import type { PlatformVehicleId, ProtocolAssetId } from "~~/lib/robomata/rentalInventory";
import type {
  RentalRevenueAttestationMetadata,
  RentalRevenueLedgerEntry,
  RentalRevenuePostingBatch,
} from "~~/lib/robomata/rentalRevenue";

export type RentalInvestorKpiKey =
  | "utilization_rate_bps"
  | "booked_days"
  | "gross_booking_value_cents"
  | "recognized_revenue_cents"
  | "cancellation_count"
  | "downtime_days"
  | "dispute_count"
  | "time_to_distribution_hours"
  | "claims_impact_cents"
  | "posted_revenue_cents"
  | "posting_variance_cents";

export type RentalInvestorKpiSource =
  | "rental_inventory"
  | "booking_ledger"
  | "trip_operations"
  | "revenue_ledger"
  | "protocol_subgraph"
  | "manual_adjustment";

export type RentalInvestorKpiFreshnessStatus = "fresh" | "stale" | "partial" | "missing";

export type RentalInvestorKpiAttribution = {
  facilityAssetId: ProtocolAssetId;
  platformVehicleIds: PlatformVehicleId[];
  vehicleAssetId?: ProtocolAssetId;
};

export type RentalInvestorKpiValue = RentalInvestorKpiAttribution & {
  key: RentalInvestorKpiKey;
  periodStart: string;
  periodEnd: string;
  source: RentalInvestorKpiSource;
  freshness: RentalInvestorKpiFreshnessStatus;
  value: number;
  computedAt: string;
  dataGapNotes?: string[];
  manualInterpretationNotes?: string[];
};

export type RentalInvestorKpiSnapshot = {
  facilityAssetId: ProtocolAssetId;
  periodStart: string;
  periodEnd: string;
  computedAt: string;
  freshness: RentalInvestorKpiFreshnessStatus;
  kpis: RentalInvestorKpiValue[];
  platformVehicleIds: PlatformVehicleId[];
  protocolDataSources: string[];
  platformDataSources: string[];
};

export type RentalInvestorDashboardSettlementStatus =
  | "not_started"
  | "partially_posted"
  | "posted"
  | "variance"
  | "stale_or_incomplete";

export type RentalInvestorPostingAttestationSummary = {
  attestationId?: string;
  batchId: string;
  ledgerEntriesDigest?: string;
  postedAt?: string;
  protocolTxHash?: string;
  rolloutMode?: RentalRevenueAttestationMetadata["rolloutMode"];
  status: RentalRevenuePostingBatch["status"];
};

export type RentalInvestorRevenueVarianceDrilldown = {
  platformVehicleId: PlatformVehicleId;
  recognizedRevenueCents: number;
  postedRevenueCents: number;
  varianceCents: number;
  ledgerEntryIds: string[];
};

export type RentalInvestorRevenueVarianceReport = {
  facilityAssetId: ProtocolAssetId;
  vehicleAssetId?: ProtocolAssetId;
  periodStart: string;
  periodEnd: string;
  recognizedRevenueCents: number;
  postedRevenueCents: number;
  varianceCents: number;
  settlementStatus: RentalInvestorDashboardSettlementStatus;
  staleOrIncompleteReasons: string[];
  vehicleDrilldowns: RentalInvestorRevenueVarianceDrilldown[];
  attestations: RentalInvestorPostingAttestationSummary[];
};

export type RentalInvestorDashboard = {
  facilityAssetId: ProtocolAssetId;
  vehicleAssetId?: ProtocolAssetId;
  periodStart: string;
  periodEnd: string;
  computedAt: string;
  snapshot: RentalInvestorKpiSnapshot;
  varianceReport: RentalInvestorRevenueVarianceReport;
  summary: {
    utilizationRateBps: number;
    bookedDays: number;
    recognizedRevenueCents: number;
    postedRevenueCents: number;
    postingVarianceCents: number;
    distributionFrequency: "none" | "single" | "recurring";
    downtimeDays: number;
    claimsImpactCents: number;
    disputeCount: number;
    settlementStatus: RentalInvestorDashboardSettlementStatus;
  };
  disclosureBoundary: {
    audience: "investor";
    allowed: string[];
    excluded: string[];
  };
};

export type RentalInvestorKpiInput = {
  availableVehicleDays: number;
  bookedDays: number;
  cancellationCount: number;
  disputeCount: number;
  distributionPostedAt?: string;
  downtimeDays: number;
  grossBookingValueCents: number;
  periodEnd: string;
  periodStart: string;
  platformVehicleIds: PlatformVehicleId[];
  recognizedRevenueCents: number;
  revenueRecognizedAt?: string;
};

export type RentalInvestorDashboardInput = {
  attribution: RentalInvestorKpiAttribution;
  computedAt?: string;
  freshness?: RentalInvestorKpiFreshnessStatus;
  ledgerEntries?: RentalRevenueLedgerEntry[];
  metrics: RentalInvestorKpiInput;
  postingBatches?: RentalRevenuePostingBatch[];
};

export function utilizationRateBps(input: Pick<RentalInvestorKpiInput, "availableVehicleDays" | "bookedDays">): number {
  if (input.availableVehicleDays <= 0) return 0;
  return Math.round((input.bookedDays / input.availableVehicleDays) * 10_000);
}

export function timeToDistributionHours(
  input: Pick<RentalInvestorKpiInput, "distributionPostedAt" | "revenueRecognizedAt">,
): number | null {
  if (!input.distributionPostedAt || !input.revenueRecognizedAt) return null;
  const recognizedAtMs = Date.parse(input.revenueRecognizedAt);
  const postedAtMs = Date.parse(input.distributionPostedAt);
  if (!Number.isFinite(recognizedAtMs) || !Number.isFinite(postedAtMs) || postedAtMs < recognizedAtMs) return null;
  return Math.round((postedAtMs - recognizedAtMs) / (60 * 60 * 1000));
}

export function buildInvestorKpiValues(input: {
  attribution: RentalInvestorKpiAttribution;
  computedAt: string;
  freshness: RentalInvestorKpiFreshnessStatus;
  metrics: RentalInvestorKpiInput;
}): RentalInvestorKpiValue[] {
  const base = {
    ...input.attribution,
    computedAt: input.computedAt,
    freshness: input.freshness,
    periodEnd: input.metrics.periodEnd,
    periodStart: input.metrics.periodStart,
  };
  const timeToDistribution = timeToDistributionHours(input.metrics);
  return [
    {
      ...base,
      key: "utilization_rate_bps",
      source: "trip_operations",
      value: utilizationRateBps(input.metrics),
    },
    { ...base, key: "booked_days", source: "booking_ledger", value: input.metrics.bookedDays },
    {
      ...base,
      key: "gross_booking_value_cents",
      source: "booking_ledger",
      value: input.metrics.grossBookingValueCents,
    },
    {
      ...base,
      key: "recognized_revenue_cents",
      source: "revenue_ledger",
      value: input.metrics.recognizedRevenueCents,
    },
    { ...base, key: "cancellation_count", source: "booking_ledger", value: input.metrics.cancellationCount },
    { ...base, key: "downtime_days", source: "trip_operations", value: input.metrics.downtimeDays },
    { ...base, key: "dispute_count", source: "trip_operations", value: input.metrics.disputeCount },
    {
      ...base,
      dataGapNotes:
        timeToDistribution === null ? ["Distribution timestamp is not available for this period."] : undefined,
      key: "time_to_distribution_hours",
      source: "protocol_subgraph",
      value: timeToDistribution ?? 0,
    },
  ];
}

function parsePeriodBoundary(value: string, boundary: "end" | "start"): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return Number.NaN;
  if (boundary === "end" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return parsed + 24 * 60 * 60 * 1_000 - 1;
  }
  return parsed;
}

function periodContains(timestamp: string, periodStart: string, periodEnd: string): boolean {
  const value = Date.parse(timestamp);
  const start = parsePeriodBoundary(periodStart, "start");
  const end = parsePeriodBoundary(periodEnd, "end");
  if (!Number.isFinite(value) || !Number.isFinite(start) || !Number.isFinite(end)) return false;
  return value >= start && value <= end;
}

function matchingLedgerEntries(input: {
  attribution: RentalInvestorKpiAttribution;
  ledgerEntries: RentalRevenueLedgerEntry[];
  periodEnd: string;
  periodStart: string;
}) {
  return input.ledgerEntries.filter(entry => {
    if (entry.facilityAssetId !== input.attribution.facilityAssetId) return false;
    if (input.attribution.vehicleAssetId && entry.vehicleAssetId !== input.attribution.vehicleAssetId) return false;
    if (!input.attribution.platformVehicleIds.includes(entry.platformVehicleId)) return false;
    return periodContains(entry.occurredAt, input.periodStart, input.periodEnd);
  });
}

function matchingPostingBatches(input: {
  attribution: RentalInvestorKpiAttribution;
  periodEnd: string;
  periodStart: string;
  postingBatches: RentalRevenuePostingBatch[];
}) {
  return input.postingBatches.filter(batch => {
    if (batch.facilityAssetId !== input.attribution.facilityAssetId) return false;
    if (
      input.attribution.vehicleAssetId &&
      (batch.postingAssetKind !== "vehicle" || batch.postingAssetId !== input.attribution.vehicleAssetId)
    ) {
      return false;
    }
    if (!input.attribution.vehicleAssetId && batch.postingAssetKind !== "facility") return false;
    return (
      periodContains(batch.periodStart, input.periodStart, input.periodEnd) &&
      periodContains(batch.periodEnd, input.periodStart, input.periodEnd)
    );
  });
}

function postedRevenueCents(batches: RentalRevenuePostingBatch[], ledgerEntries: RentalRevenueLedgerEntry[]): number {
  return batches
    .filter(batch => batch.status === "posted")
    .reduce(
      (total, batch) =>
        total +
        ledgerEntries
          .filter(entry => batch.entryIds.includes(entry.id))
          .reduce((entryTotal, entry) => entryTotal + entry.amountCents, 0),
      0,
    );
}

function claimsImpactCents(entries: RentalRevenueLedgerEntry[]): number {
  return entries
    .filter(entry => entry.kind === "chargeback" || entry.kind === "renter_refund")
    .reduce((total, entry) => total + Math.abs(entry.amountCents), 0);
}

function recognizedRevenueCents(entries: RentalRevenueLedgerEntry[], fallback: number): number {
  const recognizedEntries = entries.filter(entry => entry.kind === "recognized_revenue");
  if (recognizedEntries.length === 0) return fallback;
  return recognizedEntries.reduce((total, entry) => total + entry.amountCents, 0);
}

function distributionFrequency(
  batches: Array<Pick<RentalRevenuePostingBatch, "status">>,
): RentalInvestorDashboard["summary"]["distributionFrequency"] {
  const postedCount = batches.filter(batch => batch.status === "posted").length;
  if (postedCount === 0) return "none";
  if (postedCount === 1) return "single";
  return "recurring";
}

function settlementStatus(input: {
  hasIncompleteData: boolean;
  postedRevenueCents: number;
  varianceCents: number;
}): RentalInvestorDashboardSettlementStatus {
  if (input.hasIncompleteData) return "stale_or_incomplete";
  if (input.postedRevenueCents === 0) return "not_started";
  if (input.varianceCents === 0) return "posted";
  if (input.varianceCents < 0) return "variance";
  if (input.postedRevenueCents > 0) return "partially_posted";
  return "variance";
}

export function buildInvestorKpiSnapshot(input: {
  attribution: RentalInvestorKpiAttribution;
  computedAt: string;
  freshness: RentalInvestorKpiFreshnessStatus;
  metrics: RentalInvestorKpiInput;
}): RentalInvestorKpiSnapshot {
  return {
    facilityAssetId: input.attribution.facilityAssetId,
    periodStart: input.metrics.periodStart,
    periodEnd: input.metrics.periodEnd,
    computedAt: input.computedAt,
    freshness: input.freshness,
    kpis: buildInvestorKpiValues(input),
    platformVehicleIds: input.attribution.platformVehicleIds,
    protocolDataSources: ["FacilityRegistry", "Treasury.distributeEarnings", "posting batch attestation"],
    platformDataSources: ["rental inventory", "booking ledger", "trip operations", "revenue ledger", "claims"],
  };
}

export function buildRentalInvestorRevenueVarianceReport(
  input: RentalInvestorDashboardInput,
): RentalInvestorRevenueVarianceReport {
  const ledgerEntries = matchingLedgerEntries({
    attribution: input.attribution,
    ledgerEntries: input.ledgerEntries ?? [],
    periodEnd: input.metrics.periodEnd,
    periodStart: input.metrics.periodStart,
  });
  const postingBatches = matchingPostingBatches({
    attribution: input.attribution,
    periodEnd: input.metrics.periodEnd,
    periodStart: input.metrics.periodStart,
    postingBatches: input.postingBatches ?? [],
  });
  const recognized = recognizedRevenueCents(ledgerEntries, input.metrics.recognizedRevenueCents);
  const posted = postedRevenueCents(postingBatches, ledgerEntries);
  const staleOrIncompleteReasons = [
    ...(ledgerEntries.length === 0 ? ["No matching revenue ledger entries were supplied for this period."] : []),
    ...(postingBatches.length === 0 ? ["No matching posting batches were supplied for this period."] : []),
    ...postingBatches
      .filter(batch => !batch.attestation)
      .map(batch => `Posting batch ${batch.id} does not include attestation metadata.`),
  ];
  const vehicleDrilldowns = input.attribution.platformVehicleIds.map(platformVehicleId => {
    const vehicleEntries = ledgerEntries.filter(entry => entry.platformVehicleId === platformVehicleId);
    const vehicleRecognized = recognizedRevenueCents(vehicleEntries, 0);
    const vehiclePosted = postingBatches
      .filter(batch => batch.status === "posted")
      .reduce(
        (total, batch) =>
          total +
          vehicleEntries
            .filter(entry => batch.entryIds.includes(entry.id))
            .reduce((vehicleTotal, entry) => vehicleTotal + entry.amountCents, 0),
        0,
      );
    return {
      platformVehicleId,
      recognizedRevenueCents: vehicleRecognized,
      postedRevenueCents: vehiclePosted,
      varianceCents: vehicleRecognized - vehiclePosted,
      ledgerEntryIds: vehicleEntries.map(entry => entry.id),
    };
  });
  const varianceCents = recognized - posted;
  return {
    facilityAssetId: input.attribution.facilityAssetId,
    vehicleAssetId: input.attribution.vehicleAssetId,
    periodStart: input.metrics.periodStart,
    periodEnd: input.metrics.periodEnd,
    recognizedRevenueCents: recognized,
    postedRevenueCents: posted,
    varianceCents,
    settlementStatus: settlementStatus({
      hasIncompleteData: staleOrIncompleteReasons.length > 0,
      postedRevenueCents: posted,
      varianceCents,
    }),
    staleOrIncompleteReasons,
    vehicleDrilldowns,
    attestations: postingBatches.map(batch => ({
      attestationId: batch.attestation?.attestationId,
      batchId: batch.id,
      ledgerEntriesDigest: batch.attestation?.ledgerEntriesDigest,
      postedAt: batch.postedAt,
      protocolTxHash: batch.protocolTxHash,
      rolloutMode: batch.attestation?.rolloutMode,
      status: batch.status,
    })),
  };
}

export function buildRentalInvestorDashboard(input: RentalInvestorDashboardInput): RentalInvestorDashboard {
  const computedAt = input.computedAt ?? new Date().toISOString();
  const freshness = input.freshness ?? "partial";
  const snapshot = buildInvestorKpiSnapshot({
    attribution: input.attribution,
    computedAt,
    freshness,
    metrics: input.metrics,
  });
  const varianceReport = buildRentalInvestorRevenueVarianceReport(input);
  const ledgerEntries = matchingLedgerEntries({
    attribution: input.attribution,
    ledgerEntries: input.ledgerEntries ?? [],
    periodEnd: input.metrics.periodEnd,
    periodStart: input.metrics.periodStart,
  });
  return {
    facilityAssetId: input.attribution.facilityAssetId,
    vehicleAssetId: input.attribution.vehicleAssetId,
    periodStart: input.metrics.periodStart,
    periodEnd: input.metrics.periodEnd,
    computedAt,
    snapshot,
    varianceReport,
    summary: {
      utilizationRateBps: utilizationRateBps(input.metrics),
      bookedDays: input.metrics.bookedDays,
      recognizedRevenueCents: varianceReport.recognizedRevenueCents,
      postedRevenueCents: varianceReport.postedRevenueCents,
      postingVarianceCents: varianceReport.varianceCents,
      distributionFrequency: distributionFrequency(varianceReport.attestations),
      downtimeDays: input.metrics.downtimeDays,
      claimsImpactCents: claimsImpactCents(ledgerEntries),
      disputeCount: input.metrics.disputeCount,
      settlementStatus: varianceReport.settlementStatus,
    },
    disclosureBoundary: {
      audience: "investor",
      allowed: [
        "facility-level operational KPIs",
        "per-vehicle aggregates when permitted by financing structure",
        "recognized revenue and posted earnings",
        "posting batch attestation references",
      ],
      excluded: [
        "renter identity",
        "driver-license or sanctions verification results",
        "raw support narratives",
        "unresolved claim details",
        "projected or guaranteed investment returns",
      ],
    },
  };
}
