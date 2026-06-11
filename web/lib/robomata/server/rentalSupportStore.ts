import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "server-only";
import { isRobomataRentalBookingsEnabled } from "~~/lib/featureFlags";
import type { RentalBookingRecord } from "~~/lib/robomata/rentalBookings";
import { assertNoProhibitedRentalPersistenceFields } from "~~/lib/robomata/rentalPersistencePolicy";
import {
  type RentalAuditEvent,
  type RentalCancellationInput,
  type RentalCancellationOutcome,
  type RentalIncidentRecord,
  buildRentalCancellationOutcome,
} from "~~/lib/robomata/rentalSupport";
import { getRobomataPostgresSql } from "~~/lib/robomata/server/postgres";

type RentalSupportFileStore = {
  auditEvents: RentalAuditEvent[];
  incidents: RentalIncidentRecord[];
};

type RentalSupportStore = {
  recordCancellation: (
    booking: RentalBookingRecord,
    input: RentalCancellationInput,
  ) => Promise<{ auditEvent: RentalAuditEvent; outcome: RentalCancellationOutcome }>;
  recordIncident: (
    input: Omit<RentalIncidentRecord, "auditEventId" | "createdAt" | "id" | "updatedAt">,
  ) => Promise<{ auditEvent: RentalAuditEvent; incident: RentalIncidentRecord }>;
};

let ensuredPostgresTables = false;
let storeSingleton: RentalSupportStore | null = null;
const fileStoreLocks = new Map<string, Promise<void>>();

function hasPostgresConfig() {
  return Boolean(process.env.POSTGRES_URL);
}

function canUseFileStore() {
  return process.env.NODE_ENV === "development";
}

function requireRentalSupportStore() {
  if (!isRobomataRentalBookingsEnabled()) return;
  if (hasPostgresConfig() || canUseFileStore()) return;
  throw new Error("Robomata rental support records require POSTGRES_URL outside local development.");
}

function fileStorePath(): string {
  return process.env.ROBOMATA_RENTAL_SUPPORT_FILE || path.join(os.tmpdir(), "robomata-rental-support.json");
}

function emptyFileStore(): RentalSupportFileStore {
  return { auditEvents: [], incidents: [] };
}

async function readFileStore(filePath: string): Promise<RentalSupportFileStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) return emptyFileStore();
    const parsed = JSON.parse(raw) as Partial<RentalSupportFileStore>;
    return {
      auditEvents: parsed.auditEvents ?? [],
      incidents: parsed.incidents ?? [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFileStore();
    throw error;
  }
}

async function writeFileStore(filePath: string, fileStore: RentalSupportFileStore) {
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

function cancellationAuditEvent(
  booking: RentalBookingRecord,
  input: RentalCancellationInput,
  outcome: RentalCancellationOutcome,
): RentalAuditEvent {
  assertNoProhibitedRentalPersistenceFields(input, "rental cancellation input");
  return {
    id: outcome.auditEventId,
    bookingId: booking.id,
    actor: input.actor,
    action: "booking_cancelled",
    occurredAt: outcome.cancelledAt,
    reason: input.reason,
    supportCaseId: input.supportCaseId,
    payload: {
      cancellationFeeCents: outcome.cancellationFeeCents,
      refundableAmountCents: outcome.refundableAmountCents,
      refundBps: outcome.refundBps,
    },
  };
}

function incidentFromInput(input: Omit<RentalIncidentRecord, "auditEventId" | "createdAt" | "id" | "updatedAt">): {
  auditEvent: RentalAuditEvent;
  incident: RentalIncidentRecord;
} {
  assertNoProhibitedRentalPersistenceFields(input, "rental incident input");
  const now = new Date().toISOString();
  const incidentId = `ri_${randomUUID()}`;
  const auditEventId = `rae_${randomUUID()}`;
  const incident: RentalIncidentRecord = {
    ...input,
    id: incidentId,
    auditEventId,
    createdAt: now,
    updatedAt: now,
  };
  return {
    auditEvent: {
      id: auditEventId,
      bookingId: input.bookingId,
      actor: input.actor,
      action: "incident_recorded",
      occurredAt: now,
      reason: input.kind,
      supportCaseId: input.supportCaseId,
      payload: {
        incidentId,
        refundAdjustmentCents: input.refundAdjustmentCents,
        status: input.status,
      },
    },
    incident,
  };
}

async function ensurePostgresTables() {
  if (ensuredPostgresTables) return;
  const sql = getRobomataPostgresSql();
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_rental_support_incidents (
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
    CREATE TABLE IF NOT EXISTS robomata_rental_audit_events (
      id text PRIMARY KEY,
      booking_id text NOT NULL,
      action text NOT NULL,
      payload jsonb NOT NULL,
      occurred_at timestamptz NOT NULL
    );
  `;
  ensuredPostgresTables = true;
}

function createFileStore(): RentalSupportStore {
  const filePath = fileStorePath();
  return {
    async recordCancellation(booking, input) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const outcome = buildRentalCancellationOutcome(booking, input);
        const auditEvent = cancellationAuditEvent(booking, input, outcome);
        fileStore.auditEvents = [auditEvent, ...fileStore.auditEvents];
        await writeFileStore(filePath, fileStore);
        return { auditEvent, outcome };
      });
    },
    async recordIncident(input) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const result = incidentFromInput(input);
        fileStore.incidents = [result.incident, ...fileStore.incidents];
        fileStore.auditEvents = [result.auditEvent, ...fileStore.auditEvents];
        await writeFileStore(filePath, fileStore);
        return result;
      });
    },
  };
}

function createPostgresStore(): RentalSupportStore {
  const sql = getRobomataPostgresSql();
  return {
    async recordCancellation(booking, input) {
      await ensurePostgresTables();
      const outcome = buildRentalCancellationOutcome(booking, input);
      const auditEvent = cancellationAuditEvent(booking, input, outcome);
      await sql`
        INSERT INTO robomata_rental_audit_events (id, booking_id, action, payload, occurred_at)
        VALUES (
          ${auditEvent.id},
          ${auditEvent.bookingId},
          ${auditEvent.action},
          ${JSON.stringify(auditEvent)}::jsonb,
          ${auditEvent.occurredAt}::timestamptz
        );
      `;
      return { auditEvent, outcome };
    },
    async recordIncident(input) {
      await ensurePostgresTables();
      const result = incidentFromInput(input);
      await sql`
        INSERT INTO robomata_rental_support_incidents (
          id, booking_id, platform_vehicle_id, facility_asset_id, status, payload, created_at, updated_at
        )
        VALUES (
          ${result.incident.id},
          ${result.incident.bookingId},
          ${result.incident.platformVehicleId},
          ${result.incident.facilityAssetId},
          ${result.incident.status},
          ${JSON.stringify(result.incident)}::jsonb,
          ${result.incident.createdAt}::timestamptz,
          ${result.incident.updatedAt}::timestamptz
        );
      `;
      await sql`
        INSERT INTO robomata_rental_audit_events (id, booking_id, action, payload, occurred_at)
        VALUES (
          ${result.auditEvent.id},
          ${result.auditEvent.bookingId},
          ${result.auditEvent.action},
          ${JSON.stringify(result.auditEvent)}::jsonb,
          ${result.auditEvent.occurredAt}::timestamptz
        );
      `;
      return result;
    },
  };
}

export function getRentalSupportStore(): RentalSupportStore {
  if (!storeSingleton) {
    requireRentalSupportStore();
    storeSingleton = hasPostgresConfig() ? createPostgresStore() : createFileStore();
  }
  return storeSingleton;
}
