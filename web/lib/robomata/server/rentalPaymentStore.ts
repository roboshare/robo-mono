import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "server-only";
import { isRobomataRentalPaymentsEnabled } from "~~/lib/featureFlags";
import type { RentalBookingRecord } from "~~/lib/robomata/rentalBookings";
import type {
  RentalPaymentIntentStatus,
  RentalPaymentProviderEventKind,
  RentalPaymentProviderReference,
  RentalPaymentRecord,
} from "~~/lib/robomata/rentalPayments";
import { assertNoProhibitedRentalPersistenceFields } from "~~/lib/robomata/rentalPersistencePolicy";
import { getRobomataPostgresSql } from "~~/lib/robomata/server/postgres";

export type StripePaymentIntentSnapshot = {
  id: string;
  amount: number;
  amount_capturable?: number;
  amount_received?: number;
  capture_method?: string;
  client_secret?: string;
  currency: string;
  customer?: string | null;
  latest_charge?: string | { id?: string } | null;
  metadata?: Record<string, string>;
  status: string;
};

export type BridgeTransferSnapshot = {
  id: string;
  amount?: string;
  client_reference_id?: string;
  created_at?: string;
  currency?: string;
  destination?: {
    currency?: string;
    payment_rail?: string;
    to_address?: string;
    transaction_id?: string;
  };
  on_behalf_of?: string;
  receipt?: {
    destination_tx_hash?: string;
    destination_transaction_hash?: string;
    final_amount?: string;
    initial_amount?: string;
    source_tx_hash?: string;
    transaction_hash?: string;
  };
  source?: {
    currency?: string;
    from_address?: string;
    payment_rail?: string;
    payment_received_rail?: string;
    transaction_id?: string;
  };
  source_deposit_instructions?: Record<string, unknown>;
  state: string;
  updated_at?: string;
};

export type RentalStripePaymentProviderEventInput = {
  booking?: RentalBookingRecord;
  chargeId?: string;
  disputeId?: string;
  eventKind: RentalPaymentProviderEventKind;
  failureReason?: string;
  occurredAt?: string;
  providerEventId?: string;
  refundAmountCents?: number;
  refundId?: string;
  snapshot: StripePaymentIntentSnapshot;
};

export type RentalBridgePaymentProviderEventInput = {
  booking?: RentalBookingRecord;
  eventKind: RentalPaymentProviderEventKind;
  failureReason?: string;
  occurredAt?: string;
  providerEventId?: string;
  refundAmountCents?: number;
  refundId?: string;
  snapshot: BridgeTransferSnapshot;
};

type RentalPaymentFileStore = {
  payments: RentalPaymentRecord[];
};

type RentalPaymentStore = {
  getPaymentByBooking: (bookingId: string) => Promise<RentalPaymentRecord | null>;
  getPaymentByPaymentIntent: (paymentIntentId: string) => Promise<RentalPaymentRecord | null>;
  listBlockingPaymentsByReferences: (input: {
    bookingIds?: string[];
    paymentIntentIds?: string[];
  }) => Promise<RentalPaymentRecord[]>;
  listPaymentsByReferences: (input: {
    bookingIds?: string[];
    paymentIntentIds?: string[];
  }) => Promise<RentalPaymentRecord[]>;
  recordBridgeEvent: (input: RentalBridgePaymentProviderEventInput) => Promise<RentalPaymentRecord>;
  recordStripeEvent: (input: RentalStripePaymentProviderEventInput) => Promise<RentalPaymentRecord>;
};

let ensuredPostgresTables = false;
let storeSingleton: RentalPaymentStore | null = null;
const fileStoreLocks = new Map<string, Promise<void>>();

function hasPostgresConfig() {
  return Boolean(process.env.POSTGRES_URL);
}

function canUseFileStore() {
  return process.env.NODE_ENV === "development";
}

function requireRentalPaymentStore() {
  if (!isRobomataRentalPaymentsEnabled()) return;
  if (hasPostgresConfig() || canUseFileStore()) return;
  throw new Error("Robomata rental payments require POSTGRES_URL outside local development.");
}

function fileStorePath(): string {
  return process.env.ROBOMATA_RENTAL_PAYMENTS_FILE || path.join(os.tmpdir(), "robomata-rental-payments.json");
}

function emptyFileStore(): RentalPaymentFileStore {
  return { payments: [] };
}

async function readFileStore(filePath: string): Promise<RentalPaymentFileStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) return emptyFileStore();
    const parsed = JSON.parse(raw) as Partial<RentalPaymentFileStore>;
    return { payments: parsed.payments ?? [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFileStore();
    throw error;
  }
}

async function writeFileStore(filePath: string, fileStore: RentalPaymentFileStore) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(fileStore, null, 2), "utf8");
}

async function withFileStoreWriteLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileStoreLocks.get(filePath) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = previous.then(() => new Promise<void>(resolve => (release = resolve)));
  fileStoreLocks.set(filePath, current);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (fileStoreLocks.get(filePath) === current) fileStoreLocks.delete(filePath);
  }
}

function latestChargeId(snapshot: StripePaymentIntentSnapshot): string | undefined {
  if (typeof snapshot.latest_charge === "string") return snapshot.latest_charge;
  return snapshot.latest_charge?.id;
}

function statusFromStripe(input: {
  eventKind: RentalPaymentProviderEventKind;
  failureReason?: string;
  snapshot: StripePaymentIntentSnapshot;
}): RentalPaymentIntentStatus {
  if (input.eventKind === "dispute_opened" || input.eventKind === "chargeback_recorded") return "disputed";
  if (input.eventKind === "dispute_closed") return "captured";
  if (input.eventKind === "refund_succeeded") return "refunded";
  if (input.eventKind === "payment_cancelled") return "cancelled";
  if (input.eventKind === "refund_failed" || input.eventKind === "payment_failed") return "failed";

  switch (input.snapshot.status) {
    case "requires_capture":
      return "requires_capture";
    case "succeeded":
      return "captured";
    case "canceled":
      return "cancelled";
    case "requires_confirmation":
      return "requires_confirmation";
    case "requires_payment_method":
      return input.failureReason ? "failed" : "requires_payment_method";
    default:
      return "requires_payment_method";
  }
}

function statusFromBridge(input: {
  eventKind: RentalPaymentProviderEventKind;
  failureReason?: string;
  snapshot: BridgeTransferSnapshot;
}): RentalPaymentIntentStatus {
  if (input.eventKind === "stablecoin_transfer_cancelled") return "cancelled";
  if (input.eventKind === "stablecoin_transfer_return_in_flight") return "processing";
  if (input.eventKind === "stablecoin_transfer_returned") return "refunded";
  if (input.eventKind === "stablecoin_transfer_exception") return "failed";
  if (input.eventKind === "refund_failed" || input.eventKind === "payment_failed") return "failed";

  switch (input.snapshot.state) {
    case "awaiting_funds":
      return "awaiting_funds";
    case "in_review":
    case "funds_received":
    case "payment_submitted":
    case "refund_in_flight":
      return "processing";
    case "payment_processed":
      return "captured";
    case "canceled":
      return "cancelled";
    case "returned":
      return "processing";
    case "refunded":
      return "refunded";
    case "undeliverable":
    case "refund_failed":
      return "failed";
    default:
      return input.failureReason ? "failed" : "awaiting_funds";
  }
}

function monotonicPaymentStatus(input: {
  eventKind: RentalPaymentProviderEventKind;
  existing?: RentalPaymentRecord;
  nextStatus: RentalPaymentIntentStatus;
  refundId?: string;
  disputeId?: string;
}): RentalPaymentIntentStatus {
  if (!input.existing) return input.nextStatus;
  if (input.existing.status === "cancelled") {
    return "cancelled";
  }
  if (input.existing.status === "refunded" && input.eventKind === "refund_failed") {
    return "refunded";
  }
  if (input.existing.status === "requires_capture" && input.eventKind === "payment_failed") {
    return "requires_capture";
  }
  if (
    input.existing.status === "requires_capture" &&
    (input.nextStatus === "requires_payment_method" || input.nextStatus === "requires_confirmation")
  ) {
    return "requires_capture";
  }
  if (
    input.eventKind === "dispute_opened" &&
    input.disputeId &&
    input.existing.events.some(
      event => event.kind === "dispute_closed" && event.providerReference.disputeId === input.disputeId,
    )
  ) {
    return input.existing.status;
  }
  if (input.existing.status === "disputed" && input.eventKind !== "dispute_closed") {
    return "disputed";
  }
  if (input.existing.status === "captured" && input.eventKind === "stablecoin_transfer_return_in_flight") {
    return "processing";
  }
  if (
    input.existing.status === "processing" &&
    input.existing.events[0]?.kind === "stablecoin_transfer_return_in_flight" &&
    input.eventKind !== "stablecoin_transfer_return_in_flight" &&
    input.eventKind !== "stablecoin_transfer_returned" &&
    input.eventKind !== "refund_failed"
  ) {
    return "processing";
  }
  if (
    (input.existing.status === "disputed" ||
      input.existing.status === "refunded" ||
      (input.existing.status === "failed" && input.existing.events[0]?.kind === "refund_failed")) &&
    input.eventKind === "reconciliation_refetched"
  ) {
    return input.existing.status;
  }
  if (
    input.existing.status === "captured" &&
    input.eventKind !== "refund_failed" &&
    input.nextStatus !== "disputed" &&
    input.nextStatus !== "refunded"
  ) {
    return "captured";
  }
  return input.nextStatus;
}

function revenueEligibleAmountFromBooking(booking: RentalBookingRecord | undefined): number | undefined {
  if (!booking) return undefined;
  const rentalCharge = booking.paymentPlan.rentalCharge;
  return Math.max(rentalCharge.totalAuthorizeCents - rentalCharge.taxesCents - rentalCharge.protectionPlanCents, 0);
}

function paymentPostingBlock(input: {
  failureReason?: string;
  status: RentalPaymentIntentStatus;
}): Pick<RentalPaymentRecord, "postingBlocked" | "postingBlockReason"> {
  if (input.status === "failed") {
    return {
      postingBlocked: true,
      postingBlockReason: input.failureReason ?? "Payment provider state failed and requires reconciliation.",
    };
  }
  if (input.status === "disputed") {
    return {
      postingBlocked: true,
      postingBlockReason: "Payment provider dispute or chargeback is unresolved.",
    };
  }
  if (
    input.status === "awaiting_funds" ||
    input.status === "processing" ||
    input.status === "requires_payment_method" ||
    input.status === "requires_confirmation" ||
    input.status === "requires_capture" ||
    input.status === "cancelled"
  ) {
    return {
      postingBlocked: true,
      postingBlockReason: "Payment has not been captured and must be reconciled before revenue posting.",
    };
  }
  return { postingBlocked: false, postingBlockReason: undefined };
}

function providerReference(input: RentalStripePaymentProviderEventInput): RentalPaymentProviderReference {
  return {
    provider: "stripe",
    chargeId: input.chargeId ?? latestChargeId(input.snapshot),
    customerId: typeof input.snapshot.customer === "string" ? input.snapshot.customer : undefined,
    disputeId: input.disputeId,
    paymentIntentId: input.snapshot.id,
    refundId: input.refundId,
  };
}

function bridgeAmountCents(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (!/^\d+(\.\d{1,6})?$/.test(value)) return undefined;
  const [dollars, cents = ""] = value.split(".");
  return Number(dollars) * 100 + Number(cents.padEnd(2, "0").slice(0, 2));
}

function bridgeProviderReference(input: RentalBridgePaymentProviderEventInput): RentalPaymentProviderReference {
  return {
    provider: "bridge",
    customerId: input.snapshot.on_behalf_of,
    refundId: input.refundId,
    sourceTxHash: input.snapshot.receipt?.source_tx_hash ?? input.snapshot.receipt?.transaction_hash,
    destinationTxHash:
      input.snapshot.receipt?.destination_tx_hash ??
      input.snapshot.receipt?.destination_transaction_hash ??
      input.snapshot.receipt?.transaction_hash ??
      input.snapshot.destination?.transaction_id ??
      input.snapshot.source?.transaction_id,
    transferId: input.snapshot.id,
  };
}

function refundedAmountFromEvent(
  existing: RentalPaymentRecord | undefined,
  input: RentalStripePaymentProviderEventInput,
  status: RentalPaymentIntentStatus,
) {
  if (status !== "refunded") return existing?.refundedAmountCents ?? 0;
  if (input.eventKind !== "refund_succeeded") return existing?.refundedAmountCents ?? 0;
  const refundAmount = Math.max(input.refundAmountCents ?? 0, 0);
  const existingTotal = existing?.refundedAmountCents ?? 0;
  if (!input.refundId) return Math.max(existingTotal, refundAmount);

  let cumulativeChargeRefundAmount = 0;
  const refundAmountsById = new Map<string, number>();
  for (const event of existing?.events ?? []) {
    const refundId = event.providerReference.refundId;
    if (event.kind !== "refund_succeeded") continue;
    if (!refundId) {
      cumulativeChargeRefundAmount = Math.max(cumulativeChargeRefundAmount, event.amountCents ?? 0);
      continue;
    }
    refundAmountsById.set(refundId, Math.max(refundAmountsById.get(refundId) ?? 0, event.amountCents ?? 0));
  }
  refundAmountsById.set(input.refundId, Math.max(refundAmountsById.get(input.refundId) ?? 0, refundAmount));
  const distinctRefundTotal = [...refundAmountsById.values()].reduce((sum, amount) => sum + amount, 0);
  return Math.max(cumulativeChargeRefundAmount, distinctRefundTotal);
}

function paymentRecordFromEvent(
  existing: RentalPaymentRecord | undefined,
  input: RentalStripePaymentProviderEventInput,
): RentalPaymentRecord {
  const booking = input.booking;
  if (!existing && !booking) {
    throw new Error(`PaymentIntent ${input.snapshot.id} is not linked to a known rental booking.`);
  }

  const now = new Date().toISOString();
  const nextStatus = statusFromStripe(input);
  const status = monotonicPaymentStatus({
    disputeId: input.disputeId,
    eventKind: input.eventKind,
    existing,
    nextStatus,
    refundId: input.refundId,
  });
  const reference = providerReference(input);
  const capturedAmountCents =
    status === "captured" || status === "partially_captured" || status === "refunded"
      ? Math.max(input.snapshot.amount_received ?? 0, existing?.capturedAmountCents ?? 0, 0)
      : (existing?.capturedAmountCents ?? 0);
  const refundedAmountCents = refundedAmountFromEvent(existing, input, status);
  const postingBlock = paymentPostingBlock({ failureReason: input.failureReason, status });
  const event = {
    amountCents: input.refundAmountCents ?? input.snapshot.amount,
    failureReason: input.failureReason,
    id: `rpe_${randomUUID()}`,
    kind: input.eventKind,
    occurredAt: input.occurredAt ?? now,
    providerEventId: input.providerEventId,
    providerReference: reference,
    status,
  };

  const payment: RentalPaymentRecord = {
    authorizedAmountCents: input.snapshot.amount,
    authorizedAt: status === "requires_capture" ? (existing?.authorizedAt ?? now) : existing?.authorizedAt,
    cancelledAt: status === "cancelled" ? (existing?.cancelledAt ?? now) : existing?.cancelledAt,
    capturedAmountCents,
    capturedAt: status === "captured" ? (existing?.capturedAt ?? now) : existing?.capturedAt,
    captureBefore: existing?.captureBefore,
    createdAt: existing?.createdAt ?? now,
    currency: "USD",
    events: [event, ...(existing?.events ?? [])],
    facilityAssetId: existing?.facilityAssetId ?? booking!.facilityAssetId,
    failureReason: input.failureReason ?? existing?.failureReason,
    id: existing?.id ?? `rpay_${randomUUID()}`,
    platformVehicleId: existing?.platformVehicleId ?? booking!.platformVehicleId,
    provider: "stripe",
    providerReference: {
      ...existing?.providerReference,
      ...reference,
      chargeId: reference.chargeId ?? existing?.providerReference.chargeId,
      customerId: reference.customerId ?? existing?.providerReference.customerId,
      disputeId: reference.disputeId ?? existing?.providerReference.disputeId,
      refundId: reference.refundId ?? existing?.providerReference.refundId,
    },
    reconciliationCheckedAt: input.eventKind === "reconciliation_refetched" ? now : existing?.reconciliationCheckedAt,
    revenueEligibleAmountCents:
      existing?.revenueEligibleAmountCents ??
      revenueEligibleAmountFromBooking(booking) ??
      Math.min(existing?.authorizedAmountCents ?? input.snapshot.amount, input.snapshot.amount),
    refundedAmountCents,
    status,
    updatedAt: now,
    vehicleAssetId: existing?.vehicleAssetId ?? booking?.vehicleAssetId,
    bookingId: existing?.bookingId ?? booking!.id,
    ...postingBlock,
  };
  assertNoProhibitedRentalPersistenceFields(payment, "rental payment record");
  return payment;
}

function paymentRecordFromBridgeEvent(
  existing: RentalPaymentRecord | undefined,
  input: RentalBridgePaymentProviderEventInput,
): RentalPaymentRecord {
  const booking = input.booking;
  if (!existing && !booking) {
    throw new Error(`Bridge transfer ${input.snapshot.id} is not linked to a known rental booking.`);
  }

  const now = new Date().toISOString();
  const nextStatus = statusFromBridge(input);
  const status = monotonicPaymentStatus({
    eventKind: input.eventKind,
    existing,
    nextStatus,
    refundId: input.refundId,
  });
  const reference = bridgeProviderReference(input);
  const authorizedAmountCents =
    bridgeAmountCents(input.snapshot.amount) ??
    existing?.authorizedAmountCents ??
    booking?.paymentPlan.totalDueAtAuthorizationCents ??
    0;
  const capturedAmountCents =
    status === "captured" || status === "partially_captured" || status === "refunded"
      ? Math.max(
          bridgeAmountCents(input.snapshot.receipt?.final_amount) ?? authorizedAmountCents,
          existing?.capturedAmountCents ?? 0,
          0,
        )
      : (existing?.capturedAmountCents ?? 0);
  const refundedAmountCents =
    status === "refunded"
      ? Math.max(input.refundAmountCents ?? authorizedAmountCents, existing?.refundedAmountCents ?? 0, 0)
      : (existing?.refundedAmountCents ?? 0);
  const postingBlock = paymentPostingBlock({ failureReason: input.failureReason, status });
  const event = {
    amountCents: input.refundAmountCents ?? authorizedAmountCents,
    failureReason: input.failureReason,
    id: `rpe_${randomUUID()}`,
    kind: input.eventKind,
    occurredAt: input.occurredAt ?? input.snapshot.updated_at ?? now,
    providerEventId: input.providerEventId,
    providerReference: reference,
    status,
  };

  const payment: RentalPaymentRecord = {
    authorizedAmountCents,
    authorizedAt:
      status === "awaiting_funds" || status === "processing" || status === "captured"
        ? (existing?.authorizedAt ?? now)
        : existing?.authorizedAt,
    cancelledAt: status === "cancelled" ? (existing?.cancelledAt ?? now) : existing?.cancelledAt,
    capturedAmountCents,
    capturedAt: status === "captured" ? (existing?.capturedAt ?? now) : existing?.capturedAt,
    captureBefore: existing?.captureBefore,
    createdAt: existing?.createdAt ?? input.snapshot.created_at ?? now,
    currency: "USD",
    events: [event, ...(existing?.events ?? [])],
    facilityAssetId: existing?.facilityAssetId ?? booking!.facilityAssetId,
    failureReason: input.failureReason ?? existing?.failureReason,
    id: existing?.id ?? `rpay_${randomUUID()}`,
    platformVehicleId: existing?.platformVehicleId ?? booking!.platformVehicleId,
    provider: "bridge",
    providerReference: {
      ...existing?.providerReference,
      ...reference,
      destinationTxHash: reference.destinationTxHash ?? existing?.providerReference.destinationTxHash,
      sourceTxHash: reference.sourceTxHash ?? existing?.providerReference.sourceTxHash,
      transferId: reference.transferId ?? existing?.providerReference.transferId,
    },
    reconciliationCheckedAt: input.eventKind === "reconciliation_refetched" ? now : existing?.reconciliationCheckedAt,
    revenueEligibleAmountCents:
      existing?.revenueEligibleAmountCents ??
      revenueEligibleAmountFromBooking(booking) ??
      Math.min(existing?.authorizedAmountCents ?? authorizedAmountCents, authorizedAmountCents),
    refundedAmountCents,
    status,
    updatedAt: now,
    vehicleAssetId: existing?.vehicleAssetId ?? booking?.vehicleAssetId,
    bookingId: existing?.bookingId ?? booking!.id,
    ...postingBlock,
  };
  assertNoProhibitedRentalPersistenceFields(payment, "rental payment record");
  return payment;
}

function providerPaymentReferenceId(payment: RentalPaymentRecord): string | undefined {
  return payment.providerReference.paymentIntentId ?? payment.providerReference.transferId;
}

async function ensurePostgresTables() {
  if (ensuredPostgresTables) return;
  const sql = getRobomataPostgresSql();
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_rental_payments (
      id text PRIMARY KEY,
      booking_id text NOT NULL,
      provider text NOT NULL,
      provider_payment_intent_id text UNIQUE NOT NULL,
      status text NOT NULL,
      posting_blocked boolean NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_rental_payments_booking_idx
      ON robomata_rental_payments (booking_id);
  `;
  ensuredPostgresTables = true;
}

function createFileStore(): RentalPaymentStore {
  const filePath = fileStorePath();
  return {
    async getPaymentByBooking(bookingId) {
      const fileStore = await readFileStore(filePath);
      return fileStore.payments.find(payment => payment.bookingId === bookingId) ?? null;
    },
    async getPaymentByPaymentIntent(paymentIntentId) {
      const fileStore = await readFileStore(filePath);
      return (
        fileStore.payments.find(
          payment =>
            payment.providerReference.paymentIntentId === paymentIntentId ||
            payment.providerReference.transferId === paymentIntentId,
        ) ?? null
      );
    },
    async listBlockingPaymentsByReferences(input) {
      const payments = await this.listPaymentsByReferences(input);
      return payments.filter(payment => payment.postingBlocked);
    },
    async listPaymentsByReferences(input) {
      const paymentIntentIds = new Set(input.paymentIntentIds ?? []);
      const bookingIds = new Set(input.bookingIds ?? []);
      const fileStore = await readFileStore(filePath);
      return fileStore.payments.filter(
        payment =>
          (providerPaymentReferenceId(payment) && paymentIntentIds.has(providerPaymentReferenceId(payment)!)) ||
          bookingIds.has(payment.bookingId),
      );
    },
    async recordBridgeEvent(input) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const existing = fileStore.payments.find(payment => payment.providerReference.transferId === input.snapshot.id);
        const payment = paymentRecordFromBridgeEvent(existing, input);
        fileStore.payments = [payment, ...fileStore.payments.filter(candidate => candidate.id !== payment.id)];
        await writeFileStore(filePath, fileStore);
        return payment;
      });
    },
    async recordStripeEvent(input) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const existing = fileStore.payments.find(
          payment => payment.providerReference.paymentIntentId === input.snapshot.id,
        );
        const payment = paymentRecordFromEvent(existing, input);
        fileStore.payments = [payment, ...fileStore.payments.filter(candidate => candidate.id !== payment.id)];
        await writeFileStore(filePath, fileStore);
        return payment;
      });
    },
  };
}

function createPostgresStore(): RentalPaymentStore {
  const sql = getRobomataPostgresSql();
  return {
    async getPaymentByBooking(bookingId) {
      await ensurePostgresTables();
      const rows = (await sql`
        SELECT payload
        FROM robomata_rental_payments
        WHERE booking_id = ${bookingId}
        ORDER BY updated_at DESC
        LIMIT 1;
      `) as Array<{ payload: RentalPaymentRecord }>;
      return rows[0]?.payload ?? null;
    },
    async getPaymentByPaymentIntent(paymentIntentId) {
      await ensurePostgresTables();
      const rows = (await sql`
        SELECT payload
        FROM robomata_rental_payments
        WHERE provider_payment_intent_id = ${paymentIntentId}
        LIMIT 1;
      `) as Array<{ payload: RentalPaymentRecord }>;
      if (rows[0]?.payload) return rows[0].payload;
      const fallbackRows = (await sql`
        SELECT payload
        FROM robomata_rental_payments
        WHERE payload->'providerReference'->>'transferId' = ${paymentIntentId}
        LIMIT 1;
      `) as Array<{ payload: RentalPaymentRecord }>;
      return fallbackRows[0]?.payload ?? null;
    },
    async listBlockingPaymentsByReferences(input) {
      const payments = await this.listPaymentsByReferences(input);
      return payments.filter(payment => payment.postingBlocked);
    },
    async listPaymentsByReferences(input) {
      await ensurePostgresTables();
      const paymentIntentIds = input.paymentIntentIds ?? [];
      const bookingIds = input.bookingIds ?? [];
      if (paymentIntentIds.length === 0 && bookingIds.length === 0) return [];
      const paymentIntentRows =
        paymentIntentIds.length > 0
          ? ((await sql`
              SELECT payload
              FROM robomata_rental_payments
              WHERE provider_payment_intent_id = ANY(${paymentIntentIds})
                 OR payload->'providerReference'->>'transferId' = ANY(${paymentIntentIds});
            `) as Array<{ payload: RentalPaymentRecord }>)
          : [];
      const bookingRows =
        bookingIds.length > 0
          ? ((await sql`
              SELECT payload
              FROM robomata_rental_payments
              WHERE booking_id = ANY(${bookingIds});
            `) as Array<{ payload: RentalPaymentRecord }>)
          : [];
      const payments = [...paymentIntentRows, ...bookingRows].map(row => row.payload);
      return [...new Map(payments.map(payment => [payment.id, payment])).values()];
    },
    async recordBridgeEvent(input) {
      await ensurePostgresTables();
      return sql.begin(async transaction => {
        await transaction`SELECT pg_advisory_xact_lock(hashtext(${input.snapshot.id}));`;
        const rows = (await transaction`
          SELECT payload
          FROM robomata_rental_payments
          WHERE payload->'providerReference'->>'transferId' = ${input.snapshot.id}
          FOR UPDATE;
        `) as Array<{ payload: RentalPaymentRecord }>;
        const payment = paymentRecordFromBridgeEvent(rows[0]?.payload, input);
        const providerReferenceId = providerPaymentReferenceId(payment);
        if (!providerReferenceId) throw new Error("Rental payment record requires a provider payment reference ID.");
        await transaction`
          INSERT INTO robomata_rental_payments (
            id, booking_id, provider, provider_payment_intent_id, status, posting_blocked, payload, created_at, updated_at
          )
          VALUES (
            ${payment.id},
            ${payment.bookingId},
            ${payment.provider},
            ${providerReferenceId},
            ${payment.status},
            ${payment.postingBlocked},
            ${JSON.stringify(payment)}::jsonb,
            ${payment.createdAt}::timestamptz,
            ${payment.updatedAt}::timestamptz
          )
          ON CONFLICT (provider_payment_intent_id) DO UPDATE
          SET status = EXCLUDED.status,
              posting_blocked = EXCLUDED.posting_blocked,
              payload = EXCLUDED.payload,
              updated_at = EXCLUDED.updated_at;
        `;
        return payment;
      });
    },
    async recordStripeEvent(input) {
      await ensurePostgresTables();
      return sql.begin(async transaction => {
        await transaction`SELECT pg_advisory_xact_lock(hashtext(${input.snapshot.id}));`;
        const rows = (await transaction`
          SELECT payload
          FROM robomata_rental_payments
          WHERE provider_payment_intent_id = ${input.snapshot.id}
          FOR UPDATE;
        `) as Array<{ payload: RentalPaymentRecord }>;
        const payment = paymentRecordFromEvent(rows[0]?.payload, input);
        const paymentIntentId = providerPaymentReferenceId(payment);
        if (!paymentIntentId) throw new Error("Rental payment record requires a provider PaymentIntent ID.");
        await transaction`
          INSERT INTO robomata_rental_payments (
            id, booking_id, provider, provider_payment_intent_id, status, posting_blocked, payload, created_at, updated_at
          )
          VALUES (
            ${payment.id},
            ${payment.bookingId},
            ${payment.provider},
            ${paymentIntentId},
            ${payment.status},
            ${payment.postingBlocked},
            ${JSON.stringify(payment)}::jsonb,
            ${payment.createdAt}::timestamptz,
            ${payment.updatedAt}::timestamptz
          )
          ON CONFLICT (provider_payment_intent_id) DO UPDATE
          SET status = EXCLUDED.status,
              posting_blocked = EXCLUDED.posting_blocked,
              payload = EXCLUDED.payload,
              updated_at = EXCLUDED.updated_at;
        `;
        return payment;
      });
    },
  };
}

export function getRentalPaymentStore(): RentalPaymentStore {
  if (!storeSingleton) {
    requireRentalPaymentStore();
    storeSingleton = hasPostgresConfig() ? createPostgresStore() : createFileStore();
  }
  return storeSingleton;
}
