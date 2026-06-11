import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "server-only";
import { isRobomataRentalRenterAccountsEnabled } from "~~/lib/featureFlags";
import {
  RENTER_VERIFICATION_POLICY_V1,
  type RenterProfile,
  type RenterProfileInput,
  type RenterVerificationActor,
  type RenterVerificationKind,
  type RenterVerificationUpdate,
  emptyRenterVerification,
} from "~~/lib/robomata/rentalRenters";
import { getRobomataPostgresSql } from "~~/lib/robomata/server/postgres";

type RentalRenterFileStore = {
  renters: RenterProfile[];
};

type RentalRenterStore = {
  getRenter: (renterId: string) => Promise<RenterProfile | null>;
  upsertRenter: (input: RenterProfileInput & { id?: string }) => Promise<RenterProfile>;
  updateVerification: (renterId: string, input: RenterVerificationUpdate) => Promise<RenterProfile | null>;
};

export class RentalRenterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RentalRenterValidationError";
  }
}

let ensuredPostgresTables = false;
let storeSingleton: RentalRenterStore | null = null;
const fileStoreLocks = new Map<string, Promise<void>>();

function hasPostgresConfig() {
  return Boolean(process.env.POSTGRES_URL);
}

function canUseFileStore() {
  return process.env.NODE_ENV === "development";
}

function requireRentalRenterStore() {
  if (!isRobomataRentalRenterAccountsEnabled()) return;
  if (hasPostgresConfig() || canUseFileStore()) return;
  throw new Error("Robomata renter accounts require POSTGRES_URL outside local development.");
}

function fileStorePath(): string {
  return process.env.ROBOMATA_RENTER_ACCOUNTS_FILE || path.join(os.tmpdir(), "robomata-rental-renters.json");
}

function emptyFileStore(): RentalRenterFileStore {
  return { renters: [] };
}

async function readFileStore(filePath: string): Promise<RentalRenterFileStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) return emptyFileStore();
    const parsed = JSON.parse(raw) as Partial<RentalRenterFileStore>;
    return { renters: parsed.renters ?? [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFileStore();
    throw error;
  }
}

async function writeFileStore(filePath: string, fileStore: RentalRenterFileStore) {
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

function normalizeContact(input: RenterProfileInput): RenterProfileInput {
  return {
    email: input.email?.trim().toLowerCase() || undefined,
    phone: input.phone?.trim() || undefined,
    displayName: input.displayName?.trim() || undefined,
  };
}

function validateRenterInput(input: RenterProfileInput) {
  const normalized = normalizeContact(input);
  if (!normalized.email && !normalized.phone) {
    throw new RentalRenterValidationError("Renter profile requires at least email or phone.");
  }
  return normalized;
}

function verificationRecord(now: string): RenterProfile["verification"] {
  return {
    driver_license: emptyRenterVerification("driver_license", now),
    identity: emptyRenterVerification("identity", now),
    sanctions: emptyRenterVerification("sanctions", now),
  };
}

function normalizeRenterProfile(renter: RenterProfile): RenterProfile {
  const now = new Date().toISOString();
  return {
    ...renter,
    verification: {
      driver_license: renter.verification.driver_license ?? emptyRenterVerification("driver_license", now),
      identity: renter.verification.identity ?? emptyRenterVerification("identity", now),
      sanctions: renter.verification.sanctions ?? emptyRenterVerification("sanctions", now),
    },
    verificationAuditLog: renter.verificationAuditLog ?? [],
  };
}

function createRenter(input: RenterProfileInput & { id?: string }, existing?: RenterProfile): RenterProfile {
  const now = new Date().toISOString();
  const normalized = validateRenterInput(input);
  const current = existing ? normalizeRenterProfile(existing) : undefined;
  return {
    id: current?.id ?? input.id ?? `rr_${randomUUID()}`,
    email: normalized.email ?? current?.email,
    phone: normalized.phone ?? current?.phone,
    displayName: normalized.displayName ?? current?.displayName,
    verification: current?.verification ?? verificationRecord(now),
    verificationAuditLog: current?.verificationAuditLog ?? [],
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
}

function defaultVerificationActor(input: RenterVerificationUpdate): RenterVerificationActor {
  if (input.actor) return input.actor;
  if (input.decisionSource === "admin_override") {
    return { id: input.reviewedBy ?? "unknown-admin", type: "admin", displayName: input.reviewedBy };
  }
  if (input.provider) return { id: input.provider, type: "provider", displayName: input.provider };
  return { id: "rental-verification-control-plane", type: "system" };
}

function validateVerificationUpdate(input: RenterVerificationUpdate) {
  if (!input.kind) throw new RentalRenterValidationError("Verification update requires a check kind.");
  if (!input.status) throw new RentalRenterValidationError("Verification update requires a status.");
  if (input.decisionSource === "admin_override" && !input.reason?.trim()) {
    throw new RentalRenterValidationError("Manual verification overrides require a reason.");
  }
  if (input.decisionSource === "admin_override" && !input.reviewedBy?.trim() && !input.actor?.id.trim()) {
    throw new RentalRenterValidationError("Manual verification overrides require actor attribution.");
  }
}

function updateVerificationRecord(renter: RenterProfile, input: RenterVerificationUpdate): RenterProfile {
  validateVerificationUpdate(input);
  const now = new Date().toISOString();
  const normalized = normalizeRenterProfile(renter);
  const current = normalized.verification[input.kind] ?? emptyRenterVerification(input.kind, now);
  const decisionSource = input.decisionSource ?? "provider";
  const policyVersion = input.policyVersion ?? current.policyVersion ?? RENTER_VERIFICATION_POLICY_V1.version;
  const actor = defaultVerificationActor({ ...input, decisionSource });
  const nextCheck = {
    ...current,
    ...input,
    actor,
    decisionSource,
    policyVersion,
    reviewedAt: input.reviewedAt ?? current.reviewedAt,
    updatedAt: now,
  };
  return {
    ...normalized,
    verification: {
      ...normalized.verification,
      [input.kind]: nextCheck,
    } as Record<RenterVerificationKind, RenterProfile["verification"][RenterVerificationKind]>,
    verificationAuditLog: [
      {
        id: `rva_${randomUUID()}`,
        action: decisionSource === "admin_override" ? "manual_override_applied" : "verification_updated",
        kind: input.kind,
        fromStatus: current.status,
        toStatus: input.status,
        decisionSource,
        policyVersion,
        actor,
        provider: input.provider,
        providerReferenceId: input.providerReferenceId,
        reason: input.reason,
        createdAt: now,
      },
      ...normalized.verificationAuditLog,
    ],
    updatedAt: now,
  };
}

async function ensurePostgresTables() {
  if (ensuredPostgresTables) return;
  const sql = getRobomataPostgresSql();
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_rental_renters (
      id text PRIMARY KEY,
      email text,
      phone text,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_rental_renters_email_idx
      ON robomata_rental_renters (email);
  `;
  ensuredPostgresTables = true;
}

function createFileStore(): RentalRenterStore {
  const filePath = fileStorePath();
  return {
    async getRenter(renterId) {
      const fileStore = await readFileStore(filePath);
      const renter = fileStore.renters.find(candidate => candidate.id === renterId);
      return renter ? normalizeRenterProfile(renter) : null;
    },
    async upsertRenter(input) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const existing = input.id ? fileStore.renters.find(renter => renter.id === input.id) : undefined;
        const renter = createRenter(input, existing);
        fileStore.renters = [renter, ...fileStore.renters.filter(candidate => candidate.id !== renter.id)];
        await writeFileStore(filePath, fileStore);
        return renter;
      });
    },
    async updateVerification(renterId, input) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const current = fileStore.renters.find(renter => renter.id === renterId);
        if (!current) return null;
        const renter = updateVerificationRecord(current, input);
        fileStore.renters = [renter, ...fileStore.renters.filter(candidate => candidate.id !== renter.id)];
        await writeFileStore(filePath, fileStore);
        return renter;
      });
    },
  };
}

function createPostgresStore(): RentalRenterStore {
  const sql = getRobomataPostgresSql();
  return {
    async getRenter(renterId) {
      await ensurePostgresTables();
      const rows = (await sql`
        SELECT payload
        FROM robomata_rental_renters
        WHERE id = ${renterId}
        LIMIT 1;
      `) as Array<{ payload: RenterProfile }>;
      return rows[0]?.payload ? normalizeRenterProfile(rows[0].payload) : null;
    },
    async upsertRenter(input) {
      await ensurePostgresTables();
      const existing = input.id ? await this.getRenter(input.id) : null;
      const renter = createRenter(input, existing ?? undefined);
      await sql`
        INSERT INTO robomata_rental_renters (id, email, phone, payload, created_at, updated_at)
        VALUES (
          ${renter.id},
          ${renter.email ?? null},
          ${renter.phone ?? null},
          ${JSON.stringify(renter)}::jsonb,
          ${renter.createdAt}::timestamptz,
          ${renter.updatedAt}::timestamptz
        )
        ON CONFLICT (id) DO UPDATE
        SET
          email = EXCLUDED.email,
          phone = EXCLUDED.phone,
          payload = EXCLUDED.payload,
          updated_at = EXCLUDED.updated_at;
      `;
      return renter;
    },
    async updateVerification(renterId, input) {
      await ensurePostgresTables();
      const current = await this.getRenter(renterId);
      if (!current) return null;
      const renter = updateVerificationRecord(current, input);
      await sql`
        UPDATE robomata_rental_renters
        SET payload = ${JSON.stringify(renter)}::jsonb,
            updated_at = ${renter.updatedAt}::timestamptz
        WHERE id = ${renterId};
      `;
      return renter;
    },
  };
}

export function getRentalRenterStore(): RentalRenterStore {
  if (!storeSingleton) {
    requireRentalRenterStore();
    storeSingleton = hasPostgresConfig() ? createPostgresStore() : createFileStore();
  }
  return storeSingleton;
}
