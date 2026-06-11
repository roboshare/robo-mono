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
  status: string;
};

export type RentalPaymentProviderEventInput = {
  booking?: RentalBookingRecord;
  chargeId?: string;
  disputeId?: string;
  eventKind: RentalPaymentProviderEventKind;
  failureReason?: string;
  occurredAt?: string;
  providerEventId?: string;
  refundId?: string;
  snapshot: StripePaymentIntentSnapshot;
};

type RentalPaymentFileStore = {
  payments: RentalPaymentRecord[];
};

type RentalPaymentStore = {
  getPaymentByBooking: (bookingId: string) => Promise<RentalPaymentRecord | null>;
  getPaymentByPaymentIntent: (paymentIntentId: string) => Promise<RentalPaymentRecord | null>;
  listBlockingPaymentsByPaymentIntentIds: (paymentIntentIds: string[]) => Promise<RentalPaymentRecord[]>;
  recordStripeEvent: (input: RentalPaymentProviderEventInput) => Promise<RentalPaymentRecord>;
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
  if (input.eventKind === "refund_succeeded") return "refunded";
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
  return { postingBlocked: false, postingBlockReason: undefined };
}

function providerReference(input: RentalPaymentProviderEventInput): RentalPaymentProviderReference {
  return {
    provider: "stripe",
    chargeId: input.chargeId ?? latestChargeId(input.snapshot),
    customerId: typeof input.snapshot.customer === "string" ? input.snapshot.customer : undefined,
    disputeId: input.disputeId,
    paymentIntentId: input.snapshot.id,
    refundId: input.refundId,
  };
}

function paymentRecordFromEvent(
  existing: RentalPaymentRecord | undefined,
  input: RentalPaymentProviderEventInput,
): RentalPaymentRecord {
  const booking = input.booking;
  if (!existing && !booking) {
    throw new Error(`PaymentIntent ${input.snapshot.id} is not linked to a known rental booking.`);
  }

  const now = new Date().toISOString();
  const status = statusFromStripe(input);
  const reference = providerReference(input);
  const capturedAmountCents =
    status === "captured" || status === "partially_captured"
      ? Math.max(input.snapshot.amount_received ?? existing?.capturedAmountCents ?? 0, 0)
      : (existing?.capturedAmountCents ?? 0);
  const refundedAmountCents =
    status === "refunded"
      ? Math.max(existing?.refundedAmountCents ?? 0, input.snapshot.amount_received ?? 0)
      : (existing?.refundedAmountCents ?? 0);
  const postingBlock = paymentPostingBlock({ failureReason: input.failureReason, status });
  const event = {
    amountCents: input.snapshot.amount,
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
      return fileStore.payments.find(payment => payment.providerReference.paymentIntentId === paymentIntentId) ?? null;
    },
    async listBlockingPaymentsByPaymentIntentIds(paymentIntentIds) {
      const ids = new Set(paymentIntentIds);
      const fileStore = await readFileStore(filePath);
      return fileStore.payments.filter(
        payment =>
          payment.postingBlocked &&
          payment.providerReference.paymentIntentId &&
          ids.has(payment.providerReference.paymentIntentId),
      );
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
      return rows[0]?.payload ?? null;
    },
    async listBlockingPaymentsByPaymentIntentIds(paymentIntentIds) {
      await ensurePostgresTables();
      if (paymentIntentIds.length === 0) return [];
      const rows = (await sql`
        SELECT payload
        FROM robomata_rental_payments
        WHERE provider_payment_intent_id = ANY(${paymentIntentIds})
          AND posting_blocked = true;
      `) as Array<{ payload: RentalPaymentRecord }>;
      return rows.map(row => row.payload);
    },
    async recordStripeEvent(input) {
      await ensurePostgresTables();
      const existing = await this.getPaymentByPaymentIntent(input.snapshot.id);
      const payment = paymentRecordFromEvent(existing ?? undefined, input);
      const paymentIntentId = payment.providerReference.paymentIntentId;
      if (!paymentIntentId) throw new Error("Rental payment record requires a provider PaymentIntent ID.");
      await sql`
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
