import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "server-only";
import { isRobomataRentalBookingsEnabled } from "~~/lib/featureFlags";
import type { RentalBookingRecord } from "~~/lib/robomata/rentalBookings";
import {
  type RentalClaimCreateInput,
  type RentalClaimRecord,
  type RentalClaimUpdateInput,
} from "~~/lib/robomata/rentalClaims";
import { getRobomataPostgresSql } from "~~/lib/robomata/server/postgres";

type RentalClaimFileStore = {
  claims: RentalClaimRecord[];
};

type RentalClaimStore = {
  createClaim: (booking: RentalBookingRecord, input: RentalClaimCreateInput) => Promise<RentalClaimRecord>;
  getClaim: (claimId: string) => Promise<RentalClaimRecord | null>;
  updateClaim: (claimId: string, input: RentalClaimUpdateInput) => Promise<RentalClaimRecord | null>;
};

let ensuredPostgresTables = false;
let storeSingleton: RentalClaimStore | null = null;
const fileStoreLocks = new Map<string, Promise<void>>();

function hasPostgresConfig() {
  return Boolean(process.env.POSTGRES_URL);
}

function canUseFileStore() {
  return process.env.NODE_ENV === "development";
}

function requireRentalClaimStore() {
  if (!isRobomataRentalBookingsEnabled()) return;
  if (hasPostgresConfig() || canUseFileStore()) return;
  throw new Error("Robomata rental claims require POSTGRES_URL outside local development.");
}

function fileStorePath(): string {
  return process.env.ROBOMATA_RENTAL_CLAIMS_FILE || path.join(os.tmpdir(), "robomata-rental-claims.json");
}

function emptyFileStore(): RentalClaimFileStore {
  return { claims: [] };
}

async function readFileStore(filePath: string): Promise<RentalClaimFileStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) return emptyFileStore();
    const parsed = JSON.parse(raw) as Partial<RentalClaimFileStore>;
    return { claims: parsed.claims ?? [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFileStore();
    throw error;
  }
}

async function writeFileStore(filePath: string, fileStore: RentalClaimFileStore) {
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

function claimFromInput(booking: RentalBookingRecord, input: RentalClaimCreateInput): RentalClaimRecord {
  const now = new Date().toISOString();
  if (
    input.payoutHoldAmountCents !== undefined &&
    (!Number.isFinite(input.payoutHoldAmountCents) || input.payoutHoldAmountCents <= 0)
  ) {
    throw new Error("payoutHoldAmountCents must be a positive finite amount when provided.");
  }
  return {
    id: `rc_${randomUUID()}`,
    bookingId: booking.id,
    platformVehicleId: booking.platformVehicleId,
    facilityAssetId: booking.facilityAssetId,
    vehicleAssetId: booking.vehicleAssetId,
    kind: input.kind,
    status: input.evidence?.length ? "adjudicating" : "evidence_collection",
    severity: input.severity,
    openedBy: input.openedBy,
    evidence: input.evidence ?? [],
    payoutHold: input.payoutHoldAmountCents
      ? {
          status: "held",
          amountCents: input.payoutHoldAmountCents,
          reason: input.payoutHoldReason,
          heldAt: now,
          releaseConditions: input.releaseConditions,
        }
      : { status: "not_held" },
    supportCaseId: input.supportCaseId,
    createdAt: now,
    updatedAt: now,
  };
}

function updatedClaim(current: RentalClaimRecord, input: RentalClaimUpdateInput): RentalClaimRecord {
  const now = new Date().toISOString();
  const status = input.status ?? current.status;
  const payoutHold = { ...current.payoutHold, ...(input.payoutHold ?? {}) };
  if (
    payoutHold.amountCents !== undefined &&
    (!Number.isFinite(payoutHold.amountCents) || payoutHold.amountCents <= 0)
  ) {
    throw new Error("payoutHold.amountCents must be a positive finite amount when provided.");
  }
  if (
    ["held", "partially_released", "captured"].includes(payoutHold.status) &&
    (payoutHold.amountCents === undefined || payoutHold.amountCents <= 0)
  ) {
    throw new Error("payoutHold.amountCents must be provided for active payout holds.");
  }
  return {
    ...current,
    assignedTo: input.assignedTo ?? current.assignedTo,
    adjudicationNotes: input.adjudicationNotes ?? current.adjudicationNotes,
    evidence: [...current.evidence, ...(input.evidence ?? [])],
    payoutHold,
    status,
    updatedAt: now,
    closedAt: ["settled", "closed", "denied"].includes(status) ? (current.closedAt ?? now) : current.closedAt,
  };
}

async function ensurePostgresTables() {
  if (ensuredPostgresTables) return;
  const sql = getRobomataPostgresSql();
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_rental_claims (
      id text PRIMARY KEY,
      booking_id text NOT NULL,
      platform_vehicle_id text NOT NULL,
      facility_asset_id text NOT NULL,
      status text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_rental_claims_booking_idx
      ON robomata_rental_claims (booking_id, created_at DESC);
  `;
  ensuredPostgresTables = true;
}

function createFileStore(): RentalClaimStore {
  const filePath = fileStorePath();
  return {
    async createClaim(booking, input) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const claim = claimFromInput(booking, input);
        fileStore.claims = [claim, ...fileStore.claims];
        await writeFileStore(filePath, fileStore);
        return claim;
      });
    },
    async getClaim(claimId) {
      const fileStore = await readFileStore(filePath);
      return fileStore.claims.find(claim => claim.id === claimId) ?? null;
    },
    async updateClaim(claimId, input) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const current = fileStore.claims.find(claim => claim.id === claimId);
        if (!current) return null;
        const claim = updatedClaim(current, input);
        fileStore.claims = [claim, ...fileStore.claims.filter(candidate => candidate.id !== claim.id)];
        await writeFileStore(filePath, fileStore);
        return claim;
      });
    },
  };
}

function createPostgresStore(): RentalClaimStore {
  const sql = getRobomataPostgresSql();
  return {
    async createClaim(booking, input) {
      await ensurePostgresTables();
      const claim = claimFromInput(booking, input);
      await sql`
        INSERT INTO robomata_rental_claims (
          id, booking_id, platform_vehicle_id, facility_asset_id, status, payload, created_at, updated_at
        )
        VALUES (
          ${claim.id},
          ${claim.bookingId},
          ${claim.platformVehicleId},
          ${claim.facilityAssetId},
          ${claim.status},
          ${JSON.stringify(claim)}::jsonb,
          ${claim.createdAt}::timestamptz,
          ${claim.updatedAt}::timestamptz
        );
      `;
      return claim;
    },
    async getClaim(claimId) {
      await ensurePostgresTables();
      const rows = (await sql`
        SELECT payload
        FROM robomata_rental_claims
        WHERE id = ${claimId}
        LIMIT 1;
      `) as Array<{ payload: RentalClaimRecord }>;
      return rows[0]?.payload ?? null;
    },
    async updateClaim(claimId, input) {
      await ensurePostgresTables();
      const current = await this.getClaim(claimId);
      if (!current) return null;
      const claim = updatedClaim(current, input);
      await sql`
        UPDATE robomata_rental_claims
        SET status = ${claim.status},
            payload = ${JSON.stringify(claim)}::jsonb,
            updated_at = ${claim.updatedAt}::timestamptz
        WHERE id = ${claimId};
      `;
      return claim;
    },
  };
}

export function getRentalClaimStore(): RentalClaimStore {
  if (!storeSingleton) {
    requireRentalClaimStore();
    storeSingleton = hasPostgresConfig() ? createPostgresStore() : createFileStore();
  }
  return storeSingleton;
}
