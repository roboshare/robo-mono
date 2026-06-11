import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "server-only";
import { isRobomataRentalBookingsEnabled } from "~~/lib/featureFlags";
import {
  type RentalTripCheckInInput,
  type RentalTripCheckOutInput,
  type RentalTripRecord,
  tripReportFromInput,
} from "~~/lib/robomata/rentalTrips";
import { getRobomataPostgresSql } from "~~/lib/robomata/server/postgres";

type RentalTripFileStore = {
  trips: RentalTripRecord[];
};

type RentalTripStore = {
  checkIn: (
    input: Omit<RentalTripRecord, "checkIn" | "createdAt" | "id" | "status" | "updatedAt"> & {
      checkIn: RentalTripCheckInInput;
    },
  ) => Promise<RentalTripRecord>;
  checkOut: (bookingId: string, input: RentalTripCheckOutInput) => Promise<RentalTripRecord | null>;
  getTripByBooking: (bookingId: string) => Promise<RentalTripRecord | null>;
};

let ensuredPostgresTables = false;
let storeSingleton: RentalTripStore | null = null;
const fileStoreLocks = new Map<string, Promise<void>>();

function hasPostgresConfig() {
  return Boolean(process.env.POSTGRES_URL);
}

function canUseFileStore() {
  return process.env.NODE_ENV === "development";
}

function requireRentalTripStore() {
  if (!isRobomataRentalBookingsEnabled()) return;
  if (hasPostgresConfig() || canUseFileStore()) return;
  throw new Error("Robomata rental trips require POSTGRES_URL outside local development.");
}

function fileStorePath(): string {
  return process.env.ROBOMATA_RENTAL_TRIPS_FILE || path.join(os.tmpdir(), "robomata-rental-trips.json");
}

function emptyFileStore(): RentalTripFileStore {
  return { trips: [] };
}

async function readFileStore(filePath: string): Promise<RentalTripFileStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) return emptyFileStore();
    const parsed = JSON.parse(raw) as Partial<RentalTripFileStore>;
    return { trips: parsed.trips ?? [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFileStore();
    throw error;
  }
}

async function writeFileStore(filePath: string, fileStore: RentalTripFileStore) {
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

function validateReportInput(input: RentalTripCheckInInput) {
  if (!Array.isArray(input.photoUris) || input.photoUris.length === 0) {
    throw new Error("Trip condition report requires at least one photo URI.");
  }
  if (input.fuelPercent !== undefined && (input.fuelPercent < 0 || input.fuelPercent > 100)) {
    throw new Error("fuelPercent must be between 0 and 100.");
  }
  if (input.chargePercent !== undefined && (input.chargePercent < 0 || input.chargePercent > 100)) {
    throw new Error("chargePercent must be between 0 and 100.");
  }
  if (input.odometerMiles !== undefined && input.odometerMiles < 0) {
    throw new Error("odometerMiles must be non-negative.");
  }
}

function checkedInTrip(
  input: Omit<RentalTripRecord, "checkIn" | "createdAt" | "id" | "status" | "updatedAt"> & {
    checkIn: RentalTripCheckInInput;
  },
): RentalTripRecord {
  validateReportInput(input.checkIn);
  const now = new Date().toISOString();
  return {
    id: `rt_${randomUUID()}`,
    bookingId: input.bookingId,
    platformVehicleId: input.platformVehicleId,
    facilityAssetId: input.facilityAssetId,
    vehicleAssetId: input.vehicleAssetId,
    status: "in_trip",
    checkIn: tripReportFromInput(input.checkIn),
    createdAt: now,
    updatedAt: now,
  };
}

function checkedOutTrip(current: RentalTripRecord, input: RentalTripCheckOutInput): RentalTripRecord {
  validateReportInput(input);
  const now = new Date().toISOString();
  const status = input.exception ? "exception" : "completed";
  return {
    ...current,
    status,
    checkOut: tripReportFromInput(input),
    exception: input.exception,
    completedAt: now,
    updatedAt: now,
  };
}

async function ensurePostgresTables() {
  if (ensuredPostgresTables) return;
  const sql = getRobomataPostgresSql();
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_rental_trips (
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
    CREATE UNIQUE INDEX IF NOT EXISTS robomata_rental_trips_booking_idx
      ON robomata_rental_trips (booking_id);
  `;
  ensuredPostgresTables = true;
}

function createFileStore(): RentalTripStore {
  const filePath = fileStorePath();
  return {
    async checkIn(input) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const existing = fileStore.trips.find(trip => trip.bookingId === input.bookingId);
        if (existing) throw new Error("Trip already has a check-in report.");
        const trip = checkedInTrip(input);
        fileStore.trips = [trip, ...fileStore.trips];
        await writeFileStore(filePath, fileStore);
        return trip;
      });
    },
    async checkOut(bookingId, input) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const current = fileStore.trips.find(trip => trip.bookingId === bookingId);
        if (!current) return null;
        const trip = checkedOutTrip(current, input);
        fileStore.trips = [trip, ...fileStore.trips.filter(candidate => candidate.id !== trip.id)];
        await writeFileStore(filePath, fileStore);
        return trip;
      });
    },
    async getTripByBooking(bookingId) {
      const fileStore = await readFileStore(filePath);
      return fileStore.trips.find(trip => trip.bookingId === bookingId) ?? null;
    },
  };
}

function createPostgresStore(): RentalTripStore {
  const sql = getRobomataPostgresSql();
  return {
    async checkIn(input) {
      await ensurePostgresTables();
      const trip = checkedInTrip(input);
      await sql`
        INSERT INTO robomata_rental_trips (
          id, booking_id, platform_vehicle_id, facility_asset_id, status, payload, created_at, updated_at
        )
        VALUES (
          ${trip.id},
          ${trip.bookingId},
          ${trip.platformVehicleId},
          ${trip.facilityAssetId},
          ${trip.status},
          ${JSON.stringify(trip)}::jsonb,
          ${trip.createdAt}::timestamptz,
          ${trip.updatedAt}::timestamptz
        );
      `;
      return trip;
    },
    async checkOut(bookingId, input) {
      await ensurePostgresTables();
      const current = await this.getTripByBooking(bookingId);
      if (!current) return null;
      const trip = checkedOutTrip(current, input);
      await sql`
        UPDATE robomata_rental_trips
        SET status = ${trip.status},
            payload = ${JSON.stringify(trip)}::jsonb,
            updated_at = ${trip.updatedAt}::timestamptz
        WHERE id = ${trip.id};
      `;
      return trip;
    },
    async getTripByBooking(bookingId) {
      await ensurePostgresTables();
      const rows = (await sql`
        SELECT payload
        FROM robomata_rental_trips
        WHERE booking_id = ${bookingId}
        LIMIT 1;
      `) as Array<{ payload: RentalTripRecord }>;
      return rows[0]?.payload ?? null;
    },
  };
}

export function getRentalTripStore(): RentalTripStore {
  if (!storeSingleton) {
    requireRentalTripStore();
    storeSingleton = hasPostgresConfig() ? createPostgresStore() : createFileStore();
  }
  return storeSingleton;
}
