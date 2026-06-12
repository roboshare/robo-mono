import { createHash } from "node:crypto";
import { encodeFunctionData } from "viem";
import type { PlatformVehicleId, ProtocolAssetId } from "~~/lib/robomata/rentalInventory";

const PROTOCOL_PAYMENT_TOKEN_DECIMALS = 6;
const MIN_PROTOCOL_FEE_BASE_UNITS = 1_000_000n;
const PROTOCOL_BPS_PRECISION = 10_000n;
const EARNINGS_MANAGER_DISTRIBUTE_EARNINGS_ABI = [
  {
    inputs: [
      { internalType: "uint256", name: "assetId", type: "uint256" },
      { internalType: "uint256", name: "totalRevenue", type: "uint256" },
      { internalType: "bool", name: "tryAutoRelease", type: "bool" },
    ],
    name: "distributeEarnings",
    outputs: [{ internalType: "uint256", name: "collateralReleased", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export type RentalRevenueCurrency = "USD";

export type RentalFinancingTarget = {
  facilityAssetId: ProtocolAssetId;
  vehicleAssetId?: ProtocolAssetId;
  postingAssetId: ProtocolAssetId;
  postingAssetKind: "facility" | "vehicle";
  protocolInvestorShareBps?: number;
};

export type RecognizedRevenueInputs = {
  completedTripRentalRevenueCents: number;
  refundsCents?: number;
  chargebacksCents?: number;
  taxesCents?: number;
  passThroughInsuranceCostCents?: number;
  waivedFeesCents?: number;
};

export type RentalRevenueLedgerEntryKind =
  | "booking_charge"
  | "host_adjustment"
  | "renter_refund"
  | "chargeback"
  | "tax_exclusion"
  | "insurance_pass_through"
  | "waived_fee"
  | "recognized_revenue";

export type RentalRevenueLedgerSource = {
  bookingId: string;
  tripId?: string;
  adjustmentId?: string;
  disputeId?: string;
  paymentIntentId?: string;
  refundId?: string;
};

export type RentalRevenueLedgerEntry = RentalFinancingTarget & {
  id: string;
  platformVehicleId: PlatformVehicleId;
  kind: RentalRevenueLedgerEntryKind;
  source: RentalRevenueLedgerSource;
  amountCents: number;
  currency: RentalRevenueCurrency;
  occurredAt: string;
  createdAt: string;
  postingBatchId?: string;
  supersedesEntryId?: string;
  auditEventId?: string;
  notes?: string;
};

export type RentalRevenuePostingBatchStatus = "draft" | "ready" | "posting" | "posted" | "failed" | "voided";

export type RentalRevenueAttestationMetadata = {
  schema: "robomata.rental_revenue_attestation";
  version: "v1";
  attestationId: string;
  batchId: string;
  postingAssetId: ProtocolAssetId;
  postingAssetKind: RentalFinancingTarget["postingAssetKind"];
  periodStart: string;
  periodEnd: string;
  ledgerEntryIds: string[];
  ledgerEntryCount: number;
  totalRecognizedRevenueCents: number;
  currency: RentalRevenueCurrency;
  sourceSystem: "robomata-rental-platform";
  createdBy: string;
  createdAt: string;
  ledgerEntriesDigest: string;
  platformBoundary: string;
  protocolBoundary: string;
  rolloutMode: "metadata_only" | "protocol_attested";
};

export type RentalRevenuePostingBatch = RentalFinancingTarget & {
  id: string;
  status: RentalRevenuePostingBatchStatus;
  periodStart: string;
  periodEnd: string;
  entryIds: string[];
  totalRecognizedRevenueCents: number;
  currency: RentalRevenueCurrency;
  idempotencyKey: string;
  createdAt: string;
  attestation: RentalRevenueAttestationMetadata;
  postedAt?: string;
  protocolTxChainId?: number;
  protocolTxHash?: string;
  protocolTxConfirmationMode?: "operator_confirmed" | "submitted";
  protocolTxConfirmedBy?: string;
  auditEventId?: string;
  errorMessage?: string;
};

export type RentalProtocolEarningsDistributionCall = {
  contractName: "EarningsManager";
  functionName: "distributeEarnings";
  functionSignature: "distributeEarnings(uint256,uint256,bool)";
  args: {
    assetId: string;
    totalRevenue: string;
    tryAutoRelease: boolean;
  };
  calldata: `0x${string}`;
  paymentTokenDecimals: typeof PROTOCOL_PAYMENT_TOKEN_DECIMALS;
};

export type RentalProtocolEarningsDistributionRequest = {
  batchId: string;
  functionName: "distributeEarnings";
  idempotencyKey: string;
  ledgerEntryIds: string[];
  postingAssetId: ProtocolAssetId;
  postingAssetKind: RentalFinancingTarget["postingAssetKind"];
  amountCents: number;
  currency: RentalRevenueCurrency;
  protocolCall?: RentalProtocolEarningsDistributionCall;
  provenance: {
    periodStart: string;
    periodEnd: string;
    auditEventId?: string;
    attestation: RentalRevenueAttestationMetadata;
  };
};

function protocolAssetId(input: ProtocolAssetId): bigint | null {
  if (!/^\d+$/.test(input)) return null;
  const assetId = BigInt(input);
  if (assetId <= 0n || assetId % 2n === 0n) return null;
  return assetId;
}

function centsToPaymentTokenBaseUnits(amountCents: number): bigint {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new Error("Protocol distribution amount must be a non-negative integer cent amount.");
  }
  return BigInt(amountCents) * 10n ** BigInt(PROTOCOL_PAYMENT_TOKEN_DECIMALS - 2);
}

function protocolInvestorShareBps(value: number | undefined): bigint | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 0 || value > Number(PROTOCOL_BPS_PRECISION)) {
    throw new Error("Protocol investor share must be an integer basis-point value between 0 and 10000.");
  }
  return BigInt(value);
}

export function buildProtocolEarningsDistributionCall(input: {
  amountCents: number;
  postingAssetId: ProtocolAssetId;
  protocolInvestorShareBps?: number;
  tryAutoRelease?: boolean;
}): RentalProtocolEarningsDistributionCall | null {
  const assetId = protocolAssetId(input.postingAssetId);
  if (assetId === null) return null;
  const totalRevenue = centsToPaymentTokenBaseUnits(input.amountCents);
  const investorShareBps = protocolInvestorShareBps(input.protocolInvestorShareBps);
  if (investorShareBps === null) return null;
  const estimatedInvestorAmount = (totalRevenue * investorShareBps) / PROTOCOL_BPS_PRECISION;
  if (estimatedInvestorAmount < MIN_PROTOCOL_FEE_BASE_UNITS) return null;
  const tryAutoRelease = input.tryAutoRelease ?? false;
  return {
    contractName: "EarningsManager",
    functionName: "distributeEarnings",
    functionSignature: "distributeEarnings(uint256,uint256,bool)",
    args: {
      assetId: assetId.toString(),
      totalRevenue: totalRevenue.toString(),
      tryAutoRelease,
    },
    calldata: encodeFunctionData({
      abi: EARNINGS_MANAGER_DISTRIBUTE_EARNINGS_ABI,
      functionName: "distributeEarnings",
      args: [assetId, totalRevenue, tryAutoRelease],
    }),
    paymentTokenDecimals: PROTOCOL_PAYMENT_TOKEN_DECIMALS,
  };
}

export function calculateRecognizedRevenueCents(input: RecognizedRevenueInputs): number {
  return (
    input.completedTripRentalRevenueCents -
    (input.refundsCents ?? 0) -
    (input.chargebacksCents ?? 0) -
    (input.taxesCents ?? 0) -
    (input.passThroughInsuranceCostCents ?? 0) -
    (input.waivedFeesCents ?? 0)
  );
}

export function financingTarget(input: {
  facilityAssetId: ProtocolAssetId;
  vehicleAssetId?: ProtocolAssetId;
  useVehicleAssetForPosting?: boolean;
}): RentalFinancingTarget {
  const postToVehicle = Boolean(input.useVehicleAssetForPosting && input.vehicleAssetId);
  return {
    facilityAssetId: input.facilityAssetId,
    vehicleAssetId: input.vehicleAssetId,
    postingAssetId: postToVehicle ? input.vehicleAssetId! : input.facilityAssetId,
    postingAssetKind: postToVehicle ? "vehicle" : "facility",
  };
}

export function revenuePostingBatchId(input: {
  periodEnd: string;
  periodStart: string;
  postingAssetId: ProtocolAssetId;
}): string {
  return `rpb_${input.postingAssetId}_${input.periodStart}_${input.periodEnd}`.replace(/[^0-9a-z_]+/gi, "_");
}

export function revenuePostingIdempotencyKey(batch: Pick<RentalRevenuePostingBatch, "entryIds" | "id">): string {
  return `${batch.id}:${[...batch.entryIds].sort().join(",")}`;
}

function rentalRevenueAttestationId(input: { batchId: string; ledgerEntriesDigest: string }): string {
  return `rpa_${input.batchId}_${input.ledgerEntriesDigest.slice(0, 16)}`.replace(/[^0-9a-z_]+/gi, "_");
}

function ledgerEntriesDigest(entries: RentalRevenueLedgerEntry[]): string {
  const digestInput = [...entries]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(entry => ({
      id: entry.id,
      amountCents: entry.amountCents,
      auditEventId: entry.auditEventId,
      currency: entry.currency,
      kind: entry.kind,
      occurredAt: entry.occurredAt,
      platformVehicleId: entry.platformVehicleId,
      postingAssetId: entry.postingAssetId,
      source: entry.source,
    }));
  return createHash("sha256").update(JSON.stringify(digestInput)).digest("hex");
}

function parsePeriodBoundary(value: string, boundary: "end" | "start"): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return Number.NaN;
  if (boundary === "end" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return parsed + 24 * 60 * 60 * 1_000 - 1;
  }
  return parsed;
}

function canonicalPeriodBoundary(value: string, boundary: "end" | "start"): string {
  const parsed = parsePeriodBoundary(value, boundary);
  if (!Number.isFinite(parsed)) throw new Error("Posting batch periods must be valid dates.");
  return new Date(parsed).toISOString();
}

function periodContains(timestamp: string, periodStart: string, periodEnd: string): boolean {
  const value = Date.parse(timestamp);
  const start = parsePeriodBoundary(periodStart, "start");
  const end = parsePeriodBoundary(periodEnd, "end");
  if (![value, start, end].every(Number.isFinite) || end < start) {
    throw new Error("Posting batch period and ledger entry timestamps must be valid dates.");
  }
  return value >= start && value <= end;
}

export function buildRentalRevenueAttestationMetadata(input: {
  batchId: string;
  createdAt: string;
  createdBy?: string;
  entries: RentalRevenueLedgerEntry[];
  periodEnd: string;
  periodStart: string;
  target: RentalFinancingTarget;
  totalRecognizedRevenueCents: number;
}): RentalRevenueAttestationMetadata {
  const digest = ledgerEntriesDigest(input.entries);
  return {
    schema: "robomata.rental_revenue_attestation",
    version: "v1",
    attestationId: rentalRevenueAttestationId({ batchId: input.batchId, ledgerEntriesDigest: digest }),
    batchId: input.batchId,
    postingAssetId: input.target.postingAssetId,
    postingAssetKind: input.target.postingAssetKind,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    ledgerEntryIds: input.entries.map(entry => entry.id),
    ledgerEntryCount: input.entries.length,
    totalRecognizedRevenueCents: input.totalRecognizedRevenueCents,
    currency: "USD",
    sourceSystem: "robomata-rental-platform",
    createdBy: input.createdBy ?? "rental-revenue-posting-service",
    createdAt: input.createdAt,
    ledgerEntriesDigest: digest,
    platformBoundary:
      "Robomata platform owns booking, payment, refund, dispute, and recognized-revenue ledger evidence.",
    protocolBoundary:
      "Protocol receives finalized distribution amount, posting asset, transaction hash, and attestation reference.",
    rolloutMode: "metadata_only",
  };
}

export function buildRentalRevenuePostingBatch(input: {
  auditEventId?: string;
  createdBy?: string;
  entries: RentalRevenueLedgerEntry[];
  periodEnd: string;
  periodStart: string;
  target: RentalFinancingTarget;
}): RentalRevenuePostingBatch {
  if (input.entries.length === 0) throw new Error("Posting batch requires at least one ledger entry.");
  const periodStart = canonicalPeriodBoundary(input.periodStart, "start");
  const periodEnd = canonicalPeriodBoundary(input.periodEnd, "end");
  if (Date.parse(periodEnd) < Date.parse(periodStart)) {
    throw new Error("Posting batch periodEnd must be on or after periodStart.");
  }

  if (input.target.postingAssetKind === "facility" && input.target.postingAssetId !== input.target.facilityAssetId) {
    throw new Error("Facility-level posting targets must post to the facilityAssetId.");
  }
  if (input.target.postingAssetKind === "vehicle") {
    if (!input.target.vehicleAssetId) throw new Error("Vehicle-level posting targets must include vehicleAssetId.");
    if (input.target.postingAssetId !== input.target.vehicleAssetId) {
      throw new Error("Vehicle-level posting targets must post to the vehicleAssetId.");
    }
  }

  const mismatchedEntry = input.entries.find(entry => {
    if (entry.facilityAssetId !== input.target.facilityAssetId) return true;
    if (entry.postingAssetId !== input.target.postingAssetId) return true;
    if (entry.postingAssetKind !== input.target.postingAssetKind) return true;
    if (input.target.postingAssetKind === "vehicle" && entry.vehicleAssetId !== input.target.vehicleAssetId) {
      return true;
    }
    return false;
  });
  if (mismatchedEntry) {
    throw new Error(`Ledger entry ${mismatchedEntry.id} does not match the full posting target attribution.`);
  }
  const seenEntryIds = new Set<string>();
  const duplicateEntry = input.entries.find(entry => {
    if (seenEntryIds.has(entry.id)) return true;
    seenEntryIds.add(entry.id);
    return false;
  });
  if (duplicateEntry) {
    throw new Error(`Ledger entry ${duplicateEntry.id} appears more than once in the posting batch.`);
  }
  const invalidAmountEntry = input.entries.find(
    entry => typeof entry.amountCents !== "number" || !Number.isFinite(entry.amountCents),
  );
  if (invalidAmountEntry) {
    throw new Error(`Ledger entry ${invalidAmountEntry.id} must include a numeric amountCents value.`);
  }
  const nonUsdEntry = input.entries.find(entry => entry.currency !== "USD");
  if (nonUsdEntry) {
    throw new Error(`Ledger entry ${nonUsdEntry.id} must use USD currency before posting.`);
  }
  const nonRecognizedEntry = input.entries.find(entry => entry.kind !== "recognized_revenue");
  if (nonRecognizedEntry) {
    throw new Error(`Ledger entry ${nonRecognizedEntry.id} is not recognized revenue and cannot be posted.`);
  }
  const outOfPeriodEntry = input.entries.find(entry => !periodContains(entry.occurredAt, periodStart, periodEnd));
  if (outOfPeriodEntry) {
    throw new Error(`Ledger entry ${outOfPeriodEntry.id} is outside the posting batch period.`);
  }

  const totalRecognizedRevenueCents = input.entries.reduce((total, entry) => total + entry.amountCents, 0);
  if (totalRecognizedRevenueCents < 0) throw new Error("Posting batch total recognized revenue must be non-negative.");

  const batchId = revenuePostingBatchId({
    periodEnd,
    periodStart,
    postingAssetId: input.target.postingAssetId,
  });
  const createdAt = new Date().toISOString();
  const attestation = buildRentalRevenueAttestationMetadata({
    batchId,
    createdAt,
    createdBy: input.createdBy,
    entries: input.entries,
    periodEnd,
    periodStart,
    target: input.target,
    totalRecognizedRevenueCents,
  });
  const batch: RentalRevenuePostingBatch = {
    ...input.target,
    id: batchId,
    status: "ready",
    periodStart,
    periodEnd,
    entryIds: input.entries.map(entry => entry.id),
    totalRecognizedRevenueCents,
    currency: "USD",
    idempotencyKey: "",
    createdAt,
    attestation,
    auditEventId: input.auditEventId,
  };
  return {
    ...batch,
    idempotencyKey: revenuePostingIdempotencyKey(batch),
  };
}

export function buildProtocolEarningsDistributionRequest(
  batch: RentalRevenuePostingBatch,
): RentalProtocolEarningsDistributionRequest {
  if (batch.status !== "ready" && batch.status !== "failed") {
    throw new Error(`Posting batch ${batch.id} is not ready for protocol distribution.`);
  }
  return {
    batchId: batch.id,
    functionName: "distributeEarnings",
    idempotencyKey: batch.idempotencyKey,
    ledgerEntryIds: batch.entryIds,
    postingAssetId: batch.postingAssetId,
    postingAssetKind: batch.postingAssetKind,
    amountCents: batch.totalRecognizedRevenueCents,
    currency: batch.currency,
    protocolCall:
      buildProtocolEarningsDistributionCall({
        amountCents: batch.totalRecognizedRevenueCents,
        postingAssetId: batch.postingAssetId,
        protocolInvestorShareBps: batch.protocolInvestorShareBps,
      }) ?? undefined,
    provenance: {
      periodStart: batch.periodStart,
      periodEnd: batch.periodEnd,
      auditEventId: batch.auditEventId,
      attestation: batch.attestation,
    },
  };
}
