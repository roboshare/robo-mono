import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "server-only";
import { isRobomataRentalBookingsEnabled } from "~~/lib/featureFlags";
import {
  type RentalBookingConfirmationInput,
  type RentalBookingEvent,
  type RentalBookingEventKind,
  type RentalBookingRecord,
} from "~~/lib/robomata/rentalBookings";
import type { RentalBookingLifecycleState } from "~~/lib/robomata/rentalOperations";
import { getRobomataPostgresSql } from "~~/lib/robomata/server/postgres";

type RentalBookingFileStore = {
  bookings: RentalBookingRecord[];
};

type RentalBookingStore = {
  createBooking: (
    booking: Omit<RentalBookingRecord, "createdAt" | "events" | "id" | "updatedAt">,
  ) => Promise<RentalBookingRecord>;
  confirmBooking: (bookingId: string, input: RentalBookingConfirmationInput) => Promise<RentalBookingRecord | null>;
  getBooking: (bookingId: string) => Promise<RentalBookingRecord | null>;
  updateBookingState: (
    bookingId: string,
    input: {
      eventKind: RentalBookingEventKind;
      payload?: Record<string, unknown>;
      state: RentalBookingLifecycleState;
    },
  ) => Promise<RentalBookingRecord | null>;
};

export class RentalBookingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RentalBookingConflictError";
  }
}

let ensuredPostgresTables = false;
let storeSingleton: RentalBookingStore | null = null;
const fileStoreLocks = new Map<string, Promise<void>>();
const ACTIVE_BOOKING_STATES: RentalBookingLifecycleState[] = [
  "pending_renter_verification",
  "pending_payment_authorization",
  "host_review",
  "confirmed",
  "check_in_open",
  "in_trip",
  "return_pending",
];

function hasPostgresConfig() {
  return Boolean(process.env.POSTGRES_URL);
}

function canUseFileStore() {
  return process.env.NODE_ENV === "development";
}

function requireRentalBookingStore() {
  if (!isRobomataRentalBookingsEnabled()) return;
  if (hasPostgresConfig() || canUseFileStore()) return;
  throw new Error("Robomata rental bookings require POSTGRES_URL outside local development.");
}

function fileStorePath(): string {
  return process.env.ROBOMATA_RENTAL_BOOKINGS_FILE || path.join(os.tmpdir(), "robomata-rental-bookings.json");
}

function emptyFileStore(): RentalBookingFileStore {
  return { bookings: [] };
}

async function readFileStore(filePath: string): Promise<RentalBookingFileStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) return emptyFileStore();
    const parsed = JSON.parse(raw) as Partial<RentalBookingFileStore>;
    return { bookings: parsed.bookings ?? [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFileStore();
    throw error;
  }
}

async function writeFileStore(filePath: string, fileStore: RentalBookingFileStore) {
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

function bookingEvent(
  kind: RentalBookingEventKind,
  bookingId: string,
  payload?: Record<string, unknown>,
): RentalBookingEvent {
  return {
    id: `rbe_${randomUUID()}`,
    bookingId,
    kind,
    occurredAt: new Date().toISOString(),
    payload,
  };
}

function createBookingRecord(
  input: Omit<RentalBookingRecord, "createdAt" | "events" | "id" | "updatedAt">,
): RentalBookingRecord {
  const now = new Date().toISOString();
  const id = `rb_${randomUUID()}`;
  const events: RentalBookingEvent[] = [bookingEvent("checkout_started", id)];
  if (input.state === "pending_renter_verification") {
    events.push(bookingEvent("verification_required", id));
  }
  if (input.state === "pending_payment_authorization") {
    events.push(bookingEvent("payment_authorization_required", id));
  }
  return {
    ...input,
    id,
    paymentPlan: {
      ...input.paymentPlan,
      bookingId: input.paymentPlan.bookingId ?? id,
    },
    createdAt: now,
    events,
    updatedAt: now,
  };
}

function hasDateOverlap(
  left: Pick<RentalBookingRecord, "dateFrom" | "dateTo">,
  right: Pick<RentalBookingRecord, "dateFrom" | "dateTo">,
) {
  const leftStart = Date.parse(left.dateFrom);
  const leftEnd = Date.parse(left.dateTo);
  const rightStart = Date.parse(right.dateFrom);
  const rightEnd = Date.parse(right.dateTo);
  if (![leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite)) return false;
  return leftStart < rightEnd && leftEnd > rightStart;
}

function isActiveBooking(booking: RentalBookingRecord): boolean {
  return ACTIVE_BOOKING_STATES.includes(booking.state);
}

function assertNoOverlappingActiveBooking(
  candidate: Pick<RentalBookingRecord, "dateFrom" | "dateTo" | "platformVehicleId">,
  bookings: RentalBookingRecord[],
  excludingBookingId?: string,
) {
  const conflict = bookings.find(booking => {
    if (booking.id === excludingBookingId) return false;
    if (booking.platformVehicleId !== candidate.platformVehicleId) return false;
    if (!isActiveBooking(booking)) return false;
    return hasDateOverlap(candidate, booking);
  });
  if (!conflict) return;
  throw new RentalBookingConflictError(
    `Rental vehicle ${candidate.platformVehicleId} already has active booking ${conflict.id} for overlapping dates.`,
  );
}

function confirmedBooking(current: RentalBookingRecord, input: RentalBookingConfirmationInput): RentalBookingRecord {
  const now = new Date().toISOString();
  const state = input.hostReviewRequired ? "host_review" : "confirmed";
  const events = [
    ...current.events,
    bookingEvent(input.hostReviewRequired ? "host_review_required" : "booking_confirmed", current.id),
    ...(input.hostReviewRequired ? [] : [bookingEvent("booking_reminder_scheduled", current.id)]),
  ];
  return {
    ...current,
    paymentProviderReference: input.paymentProviderReference ?? current.paymentProviderReference,
    state,
    events,
    updatedAt: now,
  };
}

function bookingWithState(
  current: RentalBookingRecord,
  input: {
    eventKind: RentalBookingEventKind;
    payload?: Record<string, unknown>;
    state: RentalBookingLifecycleState;
  },
): RentalBookingRecord {
  return {
    ...current,
    state: input.state,
    events: [...current.events, bookingEvent(input.eventKind, current.id, input.payload)],
    updatedAt: new Date().toISOString(),
  };
}

async function ensurePostgresTables() {
  if (ensuredPostgresTables) return;
  const sql = getRobomataPostgresSql();
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_rental_bookings (
      id text PRIMARY KEY,
      renter_id text NOT NULL,
      platform_vehicle_id text NOT NULL,
      facility_asset_id text NOT NULL,
      state text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_rental_bookings_vehicle_idx
      ON robomata_rental_bookings (platform_vehicle_id, created_at DESC);
  `;
  ensuredPostgresTables = true;
}

function createFileStore(): RentalBookingStore {
  const filePath = fileStorePath();
  return {
    async createBooking(input) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        assertNoOverlappingActiveBooking(input, fileStore.bookings);
        const booking = createBookingRecord(input);
        fileStore.bookings = [booking, ...fileStore.bookings];
        await writeFileStore(filePath, fileStore);
        return booking;
      });
    },
    async confirmBooking(bookingId, input) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const current = fileStore.bookings.find(booking => booking.id === bookingId);
        if (!current) return null;
        assertNoOverlappingActiveBooking(current, fileStore.bookings, current.id);
        const booking = confirmedBooking(current, input);
        fileStore.bookings = [booking, ...fileStore.bookings.filter(candidate => candidate.id !== booking.id)];
        await writeFileStore(filePath, fileStore);
        return booking;
      });
    },
    async getBooking(bookingId) {
      const fileStore = await readFileStore(filePath);
      return fileStore.bookings.find(booking => booking.id === bookingId) ?? null;
    },
    async updateBookingState(bookingId, input) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const current = fileStore.bookings.find(booking => booking.id === bookingId);
        if (!current) return null;
        const booking = bookingWithState(current, input);
        fileStore.bookings = [booking, ...fileStore.bookings.filter(candidate => candidate.id !== booking.id)];
        await writeFileStore(filePath, fileStore);
        return booking;
      });
    },
  };
}

function createPostgresStore(): RentalBookingStore {
  const sql = getRobomataPostgresSql();
  return {
    async createBooking(input) {
      await ensurePostgresTables();
      const rows = (await sql`
        SELECT payload
        FROM robomata_rental_bookings
        WHERE platform_vehicle_id = ${input.platformVehicleId}
          AND state = ANY(${ACTIVE_BOOKING_STATES});
      `) as Array<{ payload: RentalBookingRecord }>;
      assertNoOverlappingActiveBooking(
        input,
        rows.map(row => row.payload),
      );
      const booking = createBookingRecord(input);
      await sql`
        INSERT INTO robomata_rental_bookings (
          id, renter_id, platform_vehicle_id, facility_asset_id, state, payload, created_at, updated_at
        )
        VALUES (
          ${booking.id},
          ${booking.renterId},
          ${booking.platformVehicleId},
          ${booking.facilityAssetId},
          ${booking.state},
          ${JSON.stringify(booking)}::jsonb,
          ${booking.createdAt}::timestamptz,
          ${booking.updatedAt}::timestamptz
        );
      `;
      return booking;
    },
    async confirmBooking(bookingId, input) {
      await ensurePostgresTables();
      const current = await this.getBooking(bookingId);
      if (!current) return null;
      const rows = (await sql`
        SELECT payload
        FROM robomata_rental_bookings
        WHERE platform_vehicle_id = ${current.platformVehicleId}
          AND state = ANY(${ACTIVE_BOOKING_STATES})
          AND id != ${bookingId};
      `) as Array<{ payload: RentalBookingRecord }>;
      assertNoOverlappingActiveBooking(
        current,
        rows.map(row => row.payload),
        current.id,
      );
      const booking = confirmedBooking(current, input);
      await sql`
        UPDATE robomata_rental_bookings
        SET state = ${booking.state},
            payload = ${JSON.stringify(booking)}::jsonb,
            updated_at = ${booking.updatedAt}::timestamptz
        WHERE id = ${bookingId};
      `;
      return booking;
    },
    async getBooking(bookingId) {
      await ensurePostgresTables();
      const rows = (await sql`
        SELECT payload
        FROM robomata_rental_bookings
        WHERE id = ${bookingId}
        LIMIT 1;
      `) as Array<{ payload: RentalBookingRecord }>;
      return rows[0]?.payload ?? null;
    },
    async updateBookingState(bookingId, input) {
      await ensurePostgresTables();
      const current = await this.getBooking(bookingId);
      if (!current) return null;
      const booking = bookingWithState(current, input);
      await sql`
        UPDATE robomata_rental_bookings
        SET state = ${booking.state},
            payload = ${JSON.stringify(booking)}::jsonb,
            updated_at = ${booking.updatedAt}::timestamptz
        WHERE id = ${bookingId};
      `;
      return booking;
    },
  };
}

export function getRentalBookingStore(): RentalBookingStore {
  if (!storeSingleton) {
    requireRentalBookingStore();
    storeSingleton = hasPostgresConfig() ? createPostgresStore() : createFileStore();
  }
  return storeSingleton;
}
