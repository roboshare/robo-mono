import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "server-only";
import { isRobomataRentalInventoryEnabled } from "~~/lib/featureFlags";
import {
  type FacilityInventoryManifest,
  type FacilityInventoryManifestRef,
  type FacilityInventoryVehicle,
  type PlatformVehicleId,
  RENTAL_FACILITY_INVENTORY_MANIFEST_VERSION,
  type RentalInventoryIngestionInput,
  type RentalInventoryIngestionRun,
  type RentalInventorySyncCheckpoint,
  type RentalVehicleHostControls,
  type RentalVehicleHostControlsUpdate,
  type RentalVehicleHostSetup,
  type RentalVehicleHostSetupUpdate,
  type RentalVehicleRecord,
  type RentalVehicleSetupChecklistKey,
  type RentalVehicleSetupValidationError,
} from "~~/lib/robomata/rentalInventory";
import { assertNoProhibitedRentalPersistenceFields } from "~~/lib/robomata/rentalPersistencePolicy";
import { getRobomataPostgresSql } from "~~/lib/robomata/server/postgres";
import { buildFacilityInventoryManifestRootPayload } from "~~/lib/robomata/server/rentalInventoryRoots";

type RentalInventoryFileStore = {
  ingestionRuns: RentalInventoryIngestionRun[];
  manifestRefs: FacilityInventoryManifestRef[];
  manifests: FacilityInventoryManifest[];
  syncCheckpoints: RentalInventorySyncCheckpoint[];
  vehicles: RentalVehicleRecord[];
};

type ListIngestionRunInput = {
  facilityAssetId?: string;
  manifestId?: string;
};

type ListVehicleInput = {
  facilityAssetId?: string;
  platformVehicleId?: PlatformVehicleId;
};

type RentalInventoryStore = {
  getManifest: (manifestId: string) => Promise<FacilityInventoryManifest | null>;
  getSyncCheckpoint: (id: string) => Promise<RentalInventorySyncCheckpoint | null>;
  getVehicle: (platformVehicleId: PlatformVehicleId) => Promise<RentalVehicleRecord | null>;
  listIngestionRuns: (input?: ListIngestionRunInput) => Promise<RentalInventoryIngestionRun[]>;
  listManifests: (facilityAssetId?: string) => Promise<FacilityInventoryManifestRef[]>;
  listVehicles: (input?: ListVehicleInput) => Promise<RentalVehicleRecord[]>;
  recordIngestionRun: (ingestionRun: RentalInventoryIngestionRun) => Promise<RentalInventoryIngestionRun>;
  replayManifest: (
    manifestId: string,
    input?: RentalInventoryIngestionInput,
  ) => Promise<{
    ingestionRun: RentalInventoryIngestionRun;
    manifest: FacilityInventoryManifest;
    manifestRef: FacilityInventoryManifestRef;
    vehicles: RentalVehicleRecord[];
  } | null>;
  updateVehicleSetup: (
    platformVehicleId: PlatformVehicleId,
    input: RentalVehicleHostSetupUpdate,
  ) => Promise<RentalVehicleRecord | null>;
  updateVehicleControls: (
    platformVehicleId: PlatformVehicleId,
    input: RentalVehicleHostControlsUpdate,
  ) => Promise<RentalVehicleRecord | null>;
  saveSyncCheckpoint: (checkpoint: RentalInventorySyncCheckpoint) => Promise<RentalInventorySyncCheckpoint>;
  upsertManifest: (
    manifest: FacilityInventoryManifest,
    input?: RentalInventoryIngestionInput,
  ) => Promise<{
    ingestionRun: RentalInventoryIngestionRun;
    manifest: FacilityInventoryManifest;
    manifestRef: FacilityInventoryManifestRef;
    vehicles: RentalVehicleRecord[];
  }>;
};

export class RentalInventoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RentalInventoryValidationError";
  }
}

let ensuredPostgresTables = false;
let storeSingleton: RentalInventoryStore | null = null;
const fileStoreLocks = new Map<string, Promise<void>>();

function hasPostgresConfig() {
  return Boolean(process.env.POSTGRES_URL);
}

function canUseFileStore() {
  return process.env.NODE_ENV === "development";
}

function requireRentalInventoryStore() {
  if (!isRobomataRentalInventoryEnabled()) return;
  if (hasPostgresConfig() || canUseFileStore()) return;

  throw new Error("Robomata rental inventory requires POSTGRES_URL outside local development.");
}

function fileStorePath(): string {
  return process.env.ROBOMATA_RENTAL_INVENTORY_FILE || path.join(os.tmpdir(), "robomata-rental-inventory.json");
}

function emptyFileStore(): RentalInventoryFileStore {
  return { ingestionRuns: [], manifestRefs: [], manifests: [], syncCheckpoints: [], vehicles: [] };
}

async function readFileStore(filePath: string): Promise<RentalInventoryFileStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) return emptyFileStore();
    const parsed = JSON.parse(raw) as Partial<RentalInventoryFileStore>;
    return {
      ingestionRuns: parsed.ingestionRuns ?? [],
      manifestRefs: parsed.manifestRefs ?? [],
      manifests: parsed.manifests ?? [],
      syncCheckpoints: parsed.syncCheckpoints ?? [],
      vehicles: parsed.vehicles ?? [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFileStore();
    throw error;
  }
}

async function writeFileStore(filePath: string, fileStore: RentalInventoryFileStore) {
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

function upsertManifest(manifests: FacilityInventoryManifest[], manifest: FacilityInventoryManifest) {
  return [manifest, ...manifests.filter(candidate => candidate.manifestId !== manifest.manifestId)];
}

function upsertManifestRef(items: FacilityInventoryManifestRef[], item: FacilityInventoryManifestRef) {
  return [item, ...items.filter(candidate => candidate.digest !== item.digest)];
}

function ingestionRunSort(left: RentalInventoryIngestionRun, right: RentalInventoryIngestionRun) {
  return right.startedAt.localeCompare(left.startedAt);
}

function ingestionRunMatchesInput(run: RentalInventoryIngestionRun, input: ListIngestionRunInput | undefined): boolean {
  if (input?.facilityAssetId && run.facilityAssetId !== input.facilityAssetId) return false;
  if (input?.manifestId && run.manifestId !== input.manifestId) return false;
  return true;
}

function upsertSyncCheckpoint(checkpoints: RentalInventorySyncCheckpoint[], checkpoint: RentalInventorySyncCheckpoint) {
  return [checkpoint, ...checkpoints.filter(candidate => candidate.id !== checkpoint.id)];
}

function assertNonEmptyString(value: string | undefined, field: string) {
  if (!value?.trim()) throw new RentalInventoryValidationError(`${field} must be a non-empty string.`);
}

function validateVehicle(vehicle: FacilityInventoryVehicle, manifest: FacilityInventoryManifest) {
  assertNonEmptyString(vehicle.platformVehicleId, "vehicle.platformVehicleId");
  assertNonEmptyString(vehicle.facilityAssetId, "vehicle.facilityAssetId");
  if (vehicle.facilityAssetId !== manifest.facilityAssetId) {
    throw new RentalInventoryValidationError(
      `Vehicle ${vehicle.platformVehicleId} facilityAssetId must match the manifest facilityAssetId.`,
    );
  }
}

function validateManifest(manifest: FacilityInventoryManifest) {
  assertNoProhibitedRentalPersistenceFields(manifest, "rental inventory manifest");
  if (manifest.version !== RENTAL_FACILITY_INVENTORY_MANIFEST_VERSION) {
    throw new RentalInventoryValidationError(`Unsupported rental inventory manifest version: ${manifest.version}.`);
  }
  assertNonEmptyString(manifest.manifestId, "manifestId");
  assertNonEmptyString(manifest.facilityAssetId, "facilityAssetId");
  assertNonEmptyString(manifest.asOfDate, "asOfDate");
  assertNonEmptyString(manifest.generatedAt, "generatedAt");
  if (!manifest.source?.system) throw new RentalInventoryValidationError("source.system must be provided.");
  if (!Array.isArray(manifest.vehicles) || manifest.vehicles.length === 0) {
    throw new RentalInventoryValidationError("vehicles must include at least one rental vehicle.");
  }

  const platformVehicleIds = new Set<string>();
  for (const vehicle of manifest.vehicles) {
    validateVehicle(vehicle, manifest);
    if (platformVehicleIds.has(vehicle.platformVehicleId)) {
      throw new RentalInventoryValidationError(
        `Duplicate platformVehicleId in manifest: ${vehicle.platformVehicleId}.`,
      );
    }
    platformVehicleIds.add(vehicle.platformVehicleId);
  }
}

function buildManifestRef(manifest: FacilityInventoryManifest): FacilityInventoryManifestRef {
  const root = buildFacilityInventoryManifestRootPayload(manifest);
  return {
    version: root.version,
    manifestId: manifest.manifestId,
    facilityAssetId: root.facilityAssetId,
    digest: root.rootDigest,
    storageBackend: "platform-db",
    generatedAt: root.generatedAt,
    vehicleCount: root.vehicleCount,
  };
}

function createIngestionRun(input: {
  createdVehicleCount?: number;
  errorMessage?: string;
  ingestionInput?: RentalInventoryIngestionInput;
  manifest?: FacilityInventoryManifest;
  manifestRef?: FacilityInventoryManifestRef;
  startedAt: string;
  status: RentalInventoryIngestionRun["status"];
  updatedVehicleCount?: number;
  vehicleCount?: number;
}): RentalInventoryIngestionRun {
  const completedAt = new Date().toISOString();
  return {
    id: `rii_${randomUUID()}`,
    actor: input.ingestionInput?.actor,
    completedAt,
    createdVehicleCount: input.createdVehicleCount ?? 0,
    errorMessage: input.errorMessage,
    facilityAssetId: input.manifest?.facilityAssetId,
    manifestDigest: input.manifestRef?.digest,
    manifestId: input.manifest?.manifestId,
    replayOfRunId: input.ingestionInput?.replayOfRunId,
    sourceEvent: input.ingestionInput?.sourceEvent,
    startedAt: input.startedAt,
    status: input.status,
    trigger: input.ingestionInput?.trigger ?? "api_upload",
    updatedVehicleCount: input.updatedVehicleCount ?? 0,
    vehicleCount: input.vehicleCount ?? input.manifest?.vehicles.length ?? 0,
  };
}

function vehicleRecordFromManifestVehicle(
  vehicle: FacilityInventoryVehicle,
  manifest: FacilityInventoryManifest,
  manifestRef: FacilityInventoryManifestRef,
  now: string,
  existing?: RentalVehicleRecord,
): RentalVehicleRecord {
  const operationalStatus =
    vehicle.status === "removed"
      ? "retired"
      : vehicle.status === "ineligible"
        ? "suspended"
        : vehicle.status === "pending_review"
          ? existing?.operationalStatus === "retired"
            ? "retired"
            : "setup"
          : (existing?.operationalStatus ?? "setup");

  return {
    platformVehicleId: vehicle.platformVehicleId,
    facilityAssetId: vehicle.facilityAssetId,
    vehicleAssetId: vehicle.vehicleAssetId,
    inventoryManifestDigest: manifestRef.digest,
    display: vehicle.display,
    facilityName: manifest.facilityName,
    hostControls: existing?.hostControls,
    hostSetup: existing?.hostSetup,
    operatorName: manifest.operatorName,
    operationalStatus,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function vehicleMatchesInput(vehicle: RentalVehicleRecord, input: ListVehicleInput | undefined): boolean {
  if (input?.platformVehicleId && vehicle.platformVehicleId !== input.platformVehicleId) return false;
  if (input?.facilityAssetId && vehicle.facilityAssetId !== input.facilityAssetId) return false;
  return true;
}

const HOST_SETUP_CHECKLIST_KEYS: RentalVehicleSetupChecklistKey[] = [
  "photos",
  "description",
  "pickup_dropoff",
  "pricing",
  "availability",
  "rules",
];

function emptyHostSetup(now: string): RentalVehicleHostSetup {
  return {
    status: "not_started",
    checklist: {
      availability: false,
      description: false,
      photos: false,
      pickup_dropoff: false,
      pricing: false,
      rules: false,
    },
    validationErrors: [],
    photoUris: [],
    updatedAt: now,
  };
}

function positiveNumber(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function setupValidationErrors(setup: RentalVehicleHostSetup): RentalVehicleSetupValidationError[] {
  const errors: RentalVehicleSetupValidationError[] = [];
  if (setup.photoUris.length === 0) errors.push({ field: "photos", message: "At least one public photo is required." });
  if (!setup.publicDescription?.trim()) {
    errors.push({ field: "description", message: "A public vehicle description is required." });
  }
  if (!setup.pickupDropoff?.addressLabel?.trim()) {
    errors.push({ field: "pickup_dropoff", message: "Pickup/dropoff location is required." });
  }
  if (!positiveNumber(setup.pricing?.dailyRateCents)) {
    errors.push({ field: "pricing", message: "A positive daily rate is required." });
  }
  if (!setup.availability?.timezone?.trim()) {
    errors.push({ field: "availability", message: "Availability timezone is required." });
  }
  if (setup.rules?.mileageLimitPerDay !== undefined && setup.rules.mileageLimitPerDay <= 0) {
    errors.push({ field: "rules", message: "Mileage limit must be positive when provided." });
  }
  return errors;
}

function mergeVehicleSetup(
  current: RentalVehicleHostSetup | undefined,
  input: RentalVehicleHostSetupUpdate,
  now: string,
): RentalVehicleHostSetup {
  const base = current ?? emptyHostSetup(now);
  const next: RentalVehicleHostSetup = {
    ...base,
    availability: input.availability ?? base.availability,
    checklist: {
      ...base.checklist,
      ...(input.checklist ?? {}),
    },
    photoUris: input.photoUris ?? base.photoUris,
    pickupDropoff: input.pickupDropoff ?? base.pickupDropoff,
    pricing: input.pricing ?? base.pricing,
    publicDescription: input.publicDescription ?? base.publicDescription,
    rules: input.rules ?? base.rules,
    updatedAt: now,
  };
  const validationErrors = setupValidationErrors(next);
  const derivedChecklist: Record<RentalVehicleSetupChecklistKey, boolean> = {
    availability: Boolean(next.availability?.timezone?.trim()),
    description: Boolean(next.publicDescription?.trim()),
    photos: next.photoUris.length > 0,
    pickup_dropoff: Boolean(next.pickupDropoff?.addressLabel?.trim()),
    pricing: positiveNumber(next.pricing?.dailyRateCents),
    rules: validationErrors.every(error => error.field !== "rules"),
  };
  const checklist = {
    ...derivedChecklist,
    ...Object.fromEntries(HOST_SETUP_CHECKLIST_KEYS.map(key => [key, input.checklist?.[key] ?? derivedChecklist[key]])),
  } as Record<RentalVehicleSetupChecklistKey, boolean>;
  const complete = HOST_SETUP_CHECKLIST_KEYS.every(key => checklist[key]) && validationErrors.length === 0;
  return {
    ...next,
    checklist,
    completedAt: complete ? (base.completedAt ?? now) : undefined,
    status: complete ? "complete" : validationErrors.length > 0 ? "incomplete" : "not_started",
    validationErrors,
  };
}

function vehicleWithSetup(
  vehicle: RentalVehicleRecord,
  input: RentalVehicleHostSetupUpdate,
  now: string,
): RentalVehicleRecord {
  const hostSetup = mergeVehicleSetup(vehicle.hostSetup, input, now);
  const operationalStatus =
    hostSetup.status === "complete" && vehicle.operationalStatus === "setup" ? "ready" : vehicle.operationalStatus;
  return {
    ...vehicle,
    hostSetup,
    operationalStatus,
    updatedAt: now,
  };
}

function emptyHostControls(vehicle: RentalVehicleRecord, now: string): RentalVehicleHostControls {
  return {
    pricing: vehicle.hostSetup?.pricing,
    availability: vehicle.hostSetup?.availability,
    blackoutRanges: [],
    maintenanceHolds: [],
    bookingReview: {
      autoAcceptEnabled: vehicle.hostSetup?.availability?.instantBookEnabled ?? false,
    },
    updatedAt: now,
  };
}

function assertOrderedDateRange(range: { id: string; startsAt: string; endsAt: string }, field: string) {
  assertNonEmptyString(range.id, `${field}.id`);
  assertNonEmptyString(range.startsAt, `${field}.startsAt`);
  assertNonEmptyString(range.endsAt, `${field}.endsAt`);
  const startsAt = Date.parse(range.startsAt);
  const endsAt = Date.parse(range.endsAt);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
    throw new RentalInventoryValidationError(`${field} must have a valid startsAt before endsAt range.`);
  }
}

function vehicleWithControls(
  vehicle: RentalVehicleRecord,
  input: RentalVehicleHostControlsUpdate,
  now: string,
): RentalVehicleRecord {
  if (input.pricing?.dailyRateCents !== undefined && !positiveNumber(input.pricing.dailyRateCents)) {
    throw new RentalInventoryValidationError("pricing.dailyRateCents must be positive when provided.");
  }
  input.blackoutRanges?.forEach((range, index) => assertOrderedDateRange(range, `blackoutRanges[${index}]`));
  input.maintenanceHolds?.forEach((range, index) => assertOrderedDateRange(range, `maintenanceHolds[${index}]`));
  if (input.operationalStatus === "listed" && vehicle.hostSetup?.status !== "complete") {
    throw new RentalInventoryValidationError("Vehicle setup must be complete before the vehicle can be listed.");
  }
  if (input.operationalStatus === "listed" && vehicle.operationalStatus === "retired") {
    throw new RentalInventoryValidationError(
      "Retired rental inventory cannot be listed without a new eligible manifest.",
    );
  }

  const current = vehicle.hostControls ?? emptyHostControls(vehicle, now);
  const hostControls: RentalVehicleHostControls = {
    ...current,
    pricing: input.pricing ?? current.pricing,
    availability: input.availability ?? current.availability,
    blackoutRanges: input.blackoutRanges ?? current.blackoutRanges,
    maintenanceHolds: input.maintenanceHolds ?? current.maintenanceHolds,
    bookingReview: {
      ...current.bookingReview,
      ...(input.bookingReview ?? {}),
    },
    updatedAt: now,
  };

  return {
    ...vehicle,
    hostControls,
    operationalStatus: input.operationalStatus ?? vehicle.operationalStatus,
    updatedAt: now,
  };
}

async function ensurePostgresTables() {
  if (ensuredPostgresTables) return;

  const sql = getRobomataPostgresSql();
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_rental_inventory_manifests (
      id text PRIMARY KEY,
      facility_asset_id text NOT NULL,
      digest text NOT NULL,
      generated_at timestamptz NOT NULL,
      payload jsonb NOT NULL,
      ref jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_rental_inventory_manifests_facility_idx
      ON robomata_rental_inventory_manifests (facility_asset_id, generated_at DESC);
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_rental_vehicles (
      platform_vehicle_id text PRIMARY KEY,
      facility_asset_id text NOT NULL,
      vehicle_asset_id text,
      inventory_manifest_digest text NOT NULL,
      operational_status text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_rental_vehicles_facility_idx
      ON robomata_rental_vehicles (facility_asset_id, platform_vehicle_id);
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_rental_inventory_ingestion_runs (
      id text PRIMARY KEY,
      facility_asset_id text,
      manifest_id text,
      manifest_digest text,
      status text NOT NULL,
      trigger text NOT NULL,
      payload jsonb NOT NULL,
      started_at timestamptz NOT NULL,
      completed_at timestamptz NOT NULL
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_rental_inventory_ingestion_runs_manifest_idx
      ON robomata_rental_inventory_ingestion_runs (manifest_id, started_at DESC);
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_rental_inventory_ingestion_runs_facility_idx
      ON robomata_rental_inventory_ingestion_runs (facility_asset_id, started_at DESC);
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_rental_inventory_sync_checkpoints (
      id text PRIMARY KEY,
      chain_id integer NOT NULL,
      registry text NOT NULL,
      registry_address text NOT NULL,
      next_block numeric NOT NULL,
      payload jsonb NOT NULL,
      updated_at timestamptz NOT NULL
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_rental_inventory_sync_checkpoints_registry_idx
      ON robomata_rental_inventory_sync_checkpoints (chain_id, registry_address);
  `;

  ensuredPostgresTables = true;
}

function createFileStore(): RentalInventoryStore {
  const filePath = fileStorePath();

  return {
    async getManifest(manifestId) {
      const fileStore = await readFileStore(filePath);
      return fileStore.manifests.find(manifest => manifest.manifestId === manifestId) ?? null;
    },
    async getSyncCheckpoint(id) {
      const fileStore = await readFileStore(filePath);
      return fileStore.syncCheckpoints.find(checkpoint => checkpoint.id === id) ?? null;
    },
    async getVehicle(platformVehicleId) {
      const fileStore = await readFileStore(filePath);
      return fileStore.vehicles.find(vehicle => vehicle.platformVehicleId === platformVehicleId) ?? null;
    },
    async listIngestionRuns(input) {
      const fileStore = await readFileStore(filePath);
      return fileStore.ingestionRuns.filter(run => ingestionRunMatchesInput(run, input)).sort(ingestionRunSort);
    },
    async listManifests(facilityAssetId) {
      const fileStore = await readFileStore(filePath);
      return fileStore.manifestRefs
        .filter(ref => !facilityAssetId || ref.facilityAssetId === facilityAssetId)
        .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
    },
    async listVehicles(input) {
      const fileStore = await readFileStore(filePath);
      return fileStore.vehicles.filter(vehicle => vehicleMatchesInput(vehicle, input));
    },
    async recordIngestionRun(ingestionRun) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        fileStore.ingestionRuns = [ingestionRun, ...fileStore.ingestionRuns.filter(run => run.id !== ingestionRun.id)];
        await writeFileStore(filePath, fileStore);
        return ingestionRun;
      });
    },
    async replayManifest(manifestId, input) {
      const fileStore = await readFileStore(filePath);
      const manifest = fileStore.manifests.find(candidate => candidate.manifestId === manifestId);
      if (!manifest) return null;
      return this.upsertManifest(manifest, { ...input, trigger: input?.trigger ?? "manual_replay" });
    },
    async saveSyncCheckpoint(checkpoint) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        fileStore.syncCheckpoints = upsertSyncCheckpoint(fileStore.syncCheckpoints, checkpoint);
        await writeFileStore(filePath, fileStore);
        return checkpoint;
      });
    },
    async updateVehicleSetup(platformVehicleId, input) {
      return withFileStoreWriteLock(filePath, async () => {
        const now = new Date().toISOString();
        const fileStore = await readFileStore(filePath);
        const current = fileStore.vehicles.find(vehicle => vehicle.platformVehicleId === platformVehicleId);
        if (!current) return null;
        const updated = vehicleWithSetup(current, input, now);
        fileStore.vehicles = [
          updated,
          ...fileStore.vehicles.filter(vehicle => vehicle.platformVehicleId !== platformVehicleId),
        ];
        await writeFileStore(filePath, fileStore);
        return updated;
      });
    },
    async updateVehicleControls(platformVehicleId, input) {
      return withFileStoreWriteLock(filePath, async () => {
        const now = new Date().toISOString();
        const fileStore = await readFileStore(filePath);
        const current = fileStore.vehicles.find(vehicle => vehicle.platformVehicleId === platformVehicleId);
        if (!current) return null;
        const updated = vehicleWithControls(current, input, now);
        fileStore.vehicles = [
          updated,
          ...fileStore.vehicles.filter(vehicle => vehicle.platformVehicleId !== platformVehicleId),
        ];
        await writeFileStore(filePath, fileStore);
        return updated;
      });
    },
    async upsertManifest(manifest, input) {
      return withFileStoreWriteLock(filePath, async () => {
        const startedAt = new Date().toISOString();
        const fileStore = await readFileStore(filePath);
        try {
          validateManifest(manifest);
        } catch (error) {
          const ingestionRun = createIngestionRun({
            errorMessage: error instanceof Error ? error.message : "Rental inventory ingestion failed.",
            ingestionInput: input,
            manifest,
            startedAt,
            status: "failed",
          });
          fileStore.ingestionRuns = [ingestionRun, ...fileStore.ingestionRuns];
          await writeFileStore(filePath, fileStore);
          throw error;
        }

        const now = new Date().toISOString();
        const manifestRef = buildManifestRef(manifest);
        const existingVehicleIds = new Set(fileStore.vehicles.map(vehicle => vehicle.platformVehicleId));
        const vehicles = manifest.vehicles.map(vehicle =>
          vehicleRecordFromManifestVehicle(
            vehicle,
            manifest,
            manifestRef,
            now,
            fileStore.vehicles.find(existing => existing.platformVehicleId === vehicle.platformVehicleId),
          ),
        );
        fileStore.manifests = upsertManifest(fileStore.manifests, manifest);
        fileStore.manifestRefs = upsertManifestRef(fileStore.manifestRefs, manifestRef);
        for (const vehicle of vehicles) {
          fileStore.vehicles = [
            vehicle,
            ...fileStore.vehicles.filter(candidate => candidate.platformVehicleId !== vehicle.platformVehicleId),
          ];
        }
        const createdVehicleCount = vehicles.filter(
          vehicle => !existingVehicleIds.has(vehicle.platformVehicleId),
        ).length;
        const ingestionRun = createIngestionRun({
          createdVehicleCount,
          ingestionInput: input,
          manifest,
          manifestRef,
          startedAt,
          status: "succeeded",
          updatedVehicleCount: vehicles.length - createdVehicleCount,
        });
        fileStore.ingestionRuns = [ingestionRun, ...fileStore.ingestionRuns];
        await writeFileStore(filePath, fileStore);
        return { ingestionRun, manifest, manifestRef, vehicles };
      });
    },
  };
}

function createPostgresStore(): RentalInventoryStore {
  const sql = getRobomataPostgresSql();

  return {
    async getManifest(manifestId) {
      await ensurePostgresTables();
      const rows = (await sql`
        SELECT payload
        FROM robomata_rental_inventory_manifests
        WHERE id = ${manifestId}
        LIMIT 1;
      `) as Array<{ payload: FacilityInventoryManifest }>;
      return rows[0]?.payload ?? null;
    },
    async getSyncCheckpoint(id) {
      await ensurePostgresTables();
      const rows = (await sql`
        SELECT payload
        FROM robomata_rental_inventory_sync_checkpoints
        WHERE id = ${id}
        LIMIT 1;
      `) as Array<{ payload: RentalInventorySyncCheckpoint }>;
      return rows[0]?.payload ?? null;
    },
    async getVehicle(platformVehicleId) {
      await ensurePostgresTables();
      const rows = (await sql`
        SELECT payload
        FROM robomata_rental_vehicles
        WHERE platform_vehicle_id = ${platformVehicleId}
        LIMIT 1;
      `) as Array<{ payload: RentalVehicleRecord }>;
      return rows[0]?.payload ?? null;
    },
    async listIngestionRuns(input) {
      await ensurePostgresTables();
      const rows = input?.manifestId
        ? ((await sql`
            SELECT payload
            FROM robomata_rental_inventory_ingestion_runs
            WHERE manifest_id = ${input.manifestId}
            ORDER BY started_at DESC;
          `) as Array<{ payload: RentalInventoryIngestionRun }>)
        : input?.facilityAssetId
          ? ((await sql`
              SELECT payload
              FROM robomata_rental_inventory_ingestion_runs
              WHERE facility_asset_id = ${input.facilityAssetId}
              ORDER BY started_at DESC;
            `) as Array<{ payload: RentalInventoryIngestionRun }>)
          : ((await sql`
              SELECT payload
              FROM robomata_rental_inventory_ingestion_runs
              ORDER BY started_at DESC;
            `) as Array<{ payload: RentalInventoryIngestionRun }>);
      return rows.map(row => row.payload).filter(run => ingestionRunMatchesInput(run, input));
    },
    async listManifests(facilityAssetId) {
      await ensurePostgresTables();
      const rows = facilityAssetId
        ? ((await sql`
            SELECT ref
            FROM robomata_rental_inventory_manifests
            WHERE facility_asset_id = ${facilityAssetId}
            ORDER BY generated_at DESC;
          `) as Array<{ ref: FacilityInventoryManifestRef }>)
        : ((await sql`
            SELECT ref
            FROM robomata_rental_inventory_manifests
            ORDER BY generated_at DESC;
          `) as Array<{ ref: FacilityInventoryManifestRef }>);
      return rows.map(row => row.ref);
    },
    async listVehicles(input) {
      await ensurePostgresTables();
      const rows = input?.platformVehicleId
        ? ((await sql`
            SELECT payload
            FROM robomata_rental_vehicles
            WHERE platform_vehicle_id = ${input.platformVehicleId}
            ORDER BY updated_at DESC;
          `) as Array<{ payload: RentalVehicleRecord }>)
        : input?.facilityAssetId
          ? ((await sql`
              SELECT payload
              FROM robomata_rental_vehicles
              WHERE facility_asset_id = ${input.facilityAssetId}
              ORDER BY platform_vehicle_id ASC;
            `) as Array<{ payload: RentalVehicleRecord }>)
          : ((await sql`
              SELECT payload
              FROM robomata_rental_vehicles
              ORDER BY facility_asset_id ASC, platform_vehicle_id ASC;
            `) as Array<{ payload: RentalVehicleRecord }>);
      return rows.map(row => row.payload).filter(vehicle => vehicleMatchesInput(vehicle, input));
    },
    async recordIngestionRun(ingestionRun) {
      await ensurePostgresTables();
      await sql`
        INSERT INTO robomata_rental_inventory_ingestion_runs (
          id, facility_asset_id, manifest_id, manifest_digest, status, trigger, payload, started_at, completed_at
        )
        VALUES (
          ${ingestionRun.id},
          ${ingestionRun.facilityAssetId ?? null},
          ${ingestionRun.manifestId ?? null},
          ${ingestionRun.manifestDigest ?? null},
          ${ingestionRun.status},
          ${ingestionRun.trigger},
          ${JSON.stringify(ingestionRun)}::jsonb,
          ${ingestionRun.startedAt}::timestamptz,
          ${ingestionRun.completedAt}::timestamptz
        )
        ON CONFLICT (id) DO UPDATE
        SET
          facility_asset_id = EXCLUDED.facility_asset_id,
          manifest_id = EXCLUDED.manifest_id,
          manifest_digest = EXCLUDED.manifest_digest,
          status = EXCLUDED.status,
          trigger = EXCLUDED.trigger,
          payload = EXCLUDED.payload,
          started_at = EXCLUDED.started_at,
          completed_at = EXCLUDED.completed_at;
      `;
      return ingestionRun;
    },
    async replayManifest(manifestId, input) {
      const manifest = await this.getManifest(manifestId);
      if (!manifest) return null;
      return this.upsertManifest(manifest, { ...input, trigger: input?.trigger ?? "manual_replay" });
    },
    async saveSyncCheckpoint(checkpoint) {
      await ensurePostgresTables();
      await sql`
        INSERT INTO robomata_rental_inventory_sync_checkpoints (
          id, chain_id, registry, registry_address, next_block, payload, updated_at
        )
        VALUES (
          ${checkpoint.id},
          ${checkpoint.chainId},
          ${checkpoint.registry},
          ${checkpoint.registryAddress},
          ${checkpoint.nextBlock},
          ${JSON.stringify(checkpoint)}::jsonb,
          ${checkpoint.updatedAt}::timestamptz
        )
        ON CONFLICT (id) DO UPDATE
        SET
          chain_id = EXCLUDED.chain_id,
          registry = EXCLUDED.registry,
          registry_address = EXCLUDED.registry_address,
          next_block = EXCLUDED.next_block,
          payload = EXCLUDED.payload,
          updated_at = EXCLUDED.updated_at;
      `;
      return checkpoint;
    },
    async updateVehicleSetup(platformVehicleId, input) {
      await ensurePostgresTables();
      const current = await this.getVehicle(platformVehicleId);
      if (!current) return null;
      const updated = vehicleWithSetup(current, input, new Date().toISOString());
      await sql`
        UPDATE robomata_rental_vehicles
        SET
          operational_status = ${updated.operationalStatus},
          payload = ${JSON.stringify(updated)}::jsonb,
          updated_at = ${updated.updatedAt}::timestamptz
        WHERE platform_vehicle_id = ${platformVehicleId};
      `;
      return updated;
    },
    async updateVehicleControls(platformVehicleId, input) {
      await ensurePostgresTables();
      const current = await this.getVehicle(platformVehicleId);
      if (!current) return null;
      const updated = vehicleWithControls(current, input, new Date().toISOString());
      await sql`
        UPDATE robomata_rental_vehicles
        SET
          operational_status = ${updated.operationalStatus},
          payload = ${JSON.stringify(updated)}::jsonb,
          updated_at = ${updated.updatedAt}::timestamptz
        WHERE platform_vehicle_id = ${platformVehicleId};
      `;
      return updated;
    },
    async upsertManifest(manifest, input) {
      await ensurePostgresTables();
      const startedAt = new Date().toISOString();
      try {
        validateManifest(manifest);
      } catch (error) {
        const ingestionRun = createIngestionRun({
          errorMessage: error instanceof Error ? error.message : "Rental inventory ingestion failed.",
          ingestionInput: input,
          manifest,
          startedAt,
          status: "failed",
        });
        await sql`
          INSERT INTO robomata_rental_inventory_ingestion_runs (
            id, facility_asset_id, manifest_id, manifest_digest, status, trigger, payload, started_at, completed_at
          )
          VALUES (
            ${ingestionRun.id},
            ${ingestionRun.facilityAssetId ?? null},
            ${ingestionRun.manifestId ?? null},
            ${ingestionRun.manifestDigest ?? null},
            ${ingestionRun.status},
            ${ingestionRun.trigger},
            ${JSON.stringify(ingestionRun)}::jsonb,
            ${ingestionRun.startedAt}::timestamptz,
            ${ingestionRun.completedAt}::timestamptz
          );
        `;
        throw error;
      }

      const now = new Date().toISOString();
      const manifestRef = buildManifestRef(manifest);
      const currentRows = (await sql`
        SELECT payload
        FROM robomata_rental_vehicles
        WHERE platform_vehicle_id = ANY(${manifest.vehicles.map(vehicle => vehicle.platformVehicleId)});
      `) as Array<{ payload: RentalVehicleRecord }>;
      const currentByVehicleId = new Map(currentRows.map(row => [row.payload.platformVehicleId, row.payload]));
      const createdVehicleCount = manifest.vehicles.filter(
        vehicle => !currentByVehicleId.has(vehicle.platformVehicleId),
      ).length;
      const vehicles = manifest.vehicles.map(vehicle =>
        vehicleRecordFromManifestVehicle(
          vehicle,
          manifest,
          manifestRef,
          now,
          currentByVehicleId.get(vehicle.platformVehicleId),
        ),
      );

      await sql`
        INSERT INTO robomata_rental_inventory_manifests (
          id, facility_asset_id, digest, generated_at, payload, ref, updated_at
        )
        VALUES (
          ${manifest.manifestId},
          ${manifest.facilityAssetId},
          ${manifestRef.digest},
          ${manifest.generatedAt}::timestamptz,
          ${JSON.stringify(manifest)}::jsonb,
          ${JSON.stringify(manifestRef)}::jsonb,
          ${now}::timestamptz
        )
        ON CONFLICT (id) DO UPDATE
        SET
          facility_asset_id = EXCLUDED.facility_asset_id,
          digest = EXCLUDED.digest,
          generated_at = EXCLUDED.generated_at,
          payload = EXCLUDED.payload,
          ref = EXCLUDED.ref,
          updated_at = EXCLUDED.updated_at;
      `;

      for (const vehicle of vehicles) {
        await sql`
          INSERT INTO robomata_rental_vehicles (
            platform_vehicle_id,
            facility_asset_id,
            vehicle_asset_id,
            inventory_manifest_digest,
            operational_status,
            payload,
            created_at,
            updated_at
          )
          VALUES (
            ${vehicle.platformVehicleId},
            ${vehicle.facilityAssetId},
            ${vehicle.vehicleAssetId ?? null},
            ${vehicle.inventoryManifestDigest},
            ${vehicle.operationalStatus},
            ${JSON.stringify(vehicle)}::jsonb,
            ${vehicle.createdAt}::timestamptz,
            ${vehicle.updatedAt}::timestamptz
          )
          ON CONFLICT (platform_vehicle_id) DO UPDATE
          SET
            facility_asset_id = EXCLUDED.facility_asset_id,
            vehicle_asset_id = EXCLUDED.vehicle_asset_id,
            inventory_manifest_digest = EXCLUDED.inventory_manifest_digest,
            operational_status = EXCLUDED.operational_status,
            payload = EXCLUDED.payload,
          updated_at = EXCLUDED.updated_at;
        `;
      }

      const ingestionRun = createIngestionRun({
        createdVehicleCount,
        ingestionInput: input,
        manifest,
        manifestRef,
        startedAt,
        status: "succeeded",
        updatedVehicleCount: vehicles.length - createdVehicleCount,
      });
      await sql`
        INSERT INTO robomata_rental_inventory_ingestion_runs (
          id, facility_asset_id, manifest_id, manifest_digest, status, trigger, payload, started_at, completed_at
        )
        VALUES (
          ${ingestionRun.id},
          ${ingestionRun.facilityAssetId ?? null},
          ${ingestionRun.manifestId ?? null},
          ${ingestionRun.manifestDigest ?? null},
          ${ingestionRun.status},
          ${ingestionRun.trigger},
          ${JSON.stringify(ingestionRun)}::jsonb,
          ${ingestionRun.startedAt}::timestamptz,
          ${ingestionRun.completedAt}::timestamptz
        );
      `;

      return { ingestionRun, manifest, manifestRef, vehicles };
    },
  };
}

export function getRentalInventoryStore(): RentalInventoryStore {
  if (!storeSingleton) {
    requireRentalInventoryStore();
    storeSingleton = hasPostgresConfig() ? createPostgresStore() : createFileStore();
  }

  return storeSingleton;
}
