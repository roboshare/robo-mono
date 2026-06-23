import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "server-only";
import { isRobomataRentalRevenuePostingEnabled } from "~~/lib/featureFlags";
import { assertNoProhibitedRentalPersistenceFields } from "~~/lib/robomata/rentalPersistencePolicy";
import {
  type RentalFinancingTarget,
  type RentalRevenueLedgerEntry,
  type RentalRevenuePostingBatch,
  buildProtocolEarningsDistributionRequest,
  buildRentalRevenuePostingBatch,
} from "~~/lib/robomata/rentalRevenue";
import { getRobomataPostgresSql } from "~~/lib/robomata/server/postgres";

type RentalRevenueFileStore = {
  batches: RentalRevenuePostingBatch[];
  ledgerEntries: RentalRevenueLedgerEntry[];
};

type CreatePostingBatchInput = {
  auditEventId?: string;
  createdBy?: string;
  entries: RentalRevenueLedgerEntry[];
  periodEnd: string;
  periodStart: string;
  target: RentalFinancingTarget;
};

type RentalRevenueStore = {
  createPostingBatch: (input: CreatePostingBatchInput) => Promise<{
    batch: RentalRevenuePostingBatch;
    protocolRequest: ReturnType<typeof buildProtocolEarningsDistributionRequest> | null;
  }>;
  getPostingBatch: (batchId: string) => Promise<RentalRevenuePostingBatch | null>;
  markPostingBatchPosted: (batchId: string, protocolTxHash: string) => Promise<RentalRevenuePostingBatch | null>;
};

let ensuredPostgresTables = false;
let storeSingleton: RentalRevenueStore | null = null;
const fileStoreLocks = new Map<string, Promise<void>>();

function protocolRequestForBatch(batch: RentalRevenuePostingBatch) {
  return batch.status === "ready" || batch.status === "failed" ? buildProtocolEarningsDistributionRequest(batch) : null;
}

function advisoryLockKey(batchId: string): string {
  return `robomata:rental-revenue:${batchId}`;
}

function assertMatchingBatchId(existingBatch: RentalRevenuePostingBatch | undefined, batch: RentalRevenuePostingBatch) {
  if (!existingBatch || existingBatch.idempotencyKey === batch.idempotencyKey) return;
  throw new Error(
    `Posting batch ${batch.id} already exists for this asset and period with a different ledger entry set.`,
  );
}

function hasPostgresConfig() {
  return Boolean(process.env.POSTGRES_URL);
}

function canUseFileStore() {
  return process.env.NODE_ENV === "development";
}

function requireRentalRevenueStore() {
  if (!isRobomataRentalRevenuePostingEnabled()) return;
  if (hasPostgresConfig() || canUseFileStore()) return;
  throw new Error("Robomata rental revenue posting requires POSTGRES_URL outside local development.");
}

function fileStorePath(): string {
  return process.env.ROBOMATA_RENTAL_REVENUE_FILE || path.join(os.tmpdir(), "robomata-rental-revenue.json");
}

function emptyFileStore(): RentalRevenueFileStore {
  return { batches: [], ledgerEntries: [] };
}

async function readFileStore(filePath: string): Promise<RentalRevenueFileStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) return emptyFileStore();
    const parsed = JSON.parse(raw) as Partial<RentalRevenueFileStore>;
    return {
      batches: parsed.batches ?? [],
      ledgerEntries: parsed.ledgerEntries ?? [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFileStore();
    throw error;
  }
}

async function writeFileStore(filePath: string, fileStore: RentalRevenueFileStore) {
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

function upsertEntries(
  existingEntries: RentalRevenueLedgerEntry[],
  entries: RentalRevenueLedgerEntry[],
): RentalRevenueLedgerEntry[] {
  const incomingIds = new Set(entries.map(entry => entry.id));
  return [...entries, ...existingEntries.filter(entry => !incomingIds.has(entry.id))];
}

async function ensurePostgresTables() {
  if (ensuredPostgresTables) return;
  const sql = getRobomataPostgresSql();
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_rental_revenue_ledger_entries (
      id text PRIMARY KEY,
      platform_vehicle_id text NOT NULL,
      posting_asset_id text NOT NULL,
      payload jsonb NOT NULL,
      occurred_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL
    );
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_rental_revenue_posting_batches (
      id text PRIMARY KEY,
      idempotency_key text UNIQUE NOT NULL,
      posting_asset_id text NOT NULL,
      status text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
  `;
  ensuredPostgresTables = true;
}

function createFileStore(): RentalRevenueStore {
  const filePath = fileStorePath();
  return {
    async createPostingBatch(input) {
      assertNoProhibitedRentalPersistenceFields(input, "rental revenue posting batch input");
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const batch = buildRentalRevenuePostingBatch(input);
        const existingBatch = fileStore.batches.find(candidate => candidate.idempotencyKey === batch.idempotencyKey);
        if (existingBatch) {
          return {
            batch: existingBatch,
            protocolRequest: protocolRequestForBatch(existingBatch),
          };
        }
        assertMatchingBatchId(
          fileStore.batches.find(candidate => candidate.id === batch.id),
          batch,
        );
        fileStore.ledgerEntries = upsertEntries(fileStore.ledgerEntries, input.entries);
        fileStore.batches = [batch, ...fileStore.batches];
        await writeFileStore(filePath, fileStore);
        return { batch, protocolRequest: protocolRequestForBatch(batch) };
      });
    },
    async getPostingBatch(batchId) {
      const fileStore = await readFileStore(filePath);
      return fileStore.batches.find(batch => batch.id === batchId) ?? null;
    },
    async markPostingBatchPosted(batchId, protocolTxHash) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const current = fileStore.batches.find(batch => batch.id === batchId);
        if (!current) return null;
        if (current.status === "posted") {
          if (current.protocolTxHash === protocolTxHash) return current;
          throw new Error(`Posting batch ${batchId} is already posted with a different protocol transaction.`);
        }
        const batch: RentalRevenuePostingBatch = {
          ...current,
          status: "posted",
          postedAt: new Date().toISOString(),
          protocolTxHash,
        };
        fileStore.batches = [batch, ...fileStore.batches.filter(candidate => candidate.id !== batch.id)];
        await writeFileStore(filePath, fileStore);
        return batch;
      });
    },
  };
}

function createPostgresStore(): RentalRevenueStore {
  const sql = getRobomataPostgresSql();
  return {
    async createPostingBatch(input) {
      assertNoProhibitedRentalPersistenceFields(input, "rental revenue posting batch input");
      await ensurePostgresTables();
      const batch = buildRentalRevenuePostingBatch(input);
      return sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${advisoryLockKey(batch.id)}));`;
        const existingRows = (await tx`
          SELECT payload
          FROM robomata_rental_revenue_posting_batches
          WHERE idempotency_key = ${batch.idempotencyKey}
          LIMIT 1;
        `) as Array<{ payload: RentalRevenuePostingBatch }>;
        if (existingRows[0]?.payload) {
          return {
            batch: existingRows[0].payload,
            protocolRequest: protocolRequestForBatch(existingRows[0].payload),
          };
        }

        const sameBatchRows = (await tx`
          SELECT payload
          FROM robomata_rental_revenue_posting_batches
          WHERE id = ${batch.id}
          LIMIT 1;
        `) as Array<{ payload: RentalRevenuePostingBatch }>;
        assertMatchingBatchId(sameBatchRows[0]?.payload, batch);

        for (const entry of input.entries) {
          await tx`
            INSERT INTO robomata_rental_revenue_ledger_entries (
              id, platform_vehicle_id, posting_asset_id, payload, occurred_at, created_at
            )
            VALUES (
              ${entry.id},
              ${entry.platformVehicleId},
              ${entry.postingAssetId},
              ${JSON.stringify(entry)}::jsonb,
              ${entry.occurredAt}::timestamptz,
              ${entry.createdAt}::timestamptz
            )
            ON CONFLICT (id) DO NOTHING;
          `;
        }

        const insertedRows = (await tx`
          INSERT INTO robomata_rental_revenue_posting_batches (
            id, idempotency_key, posting_asset_id, status, payload, created_at, updated_at
          )
          VALUES (
            ${batch.id},
            ${batch.idempotencyKey},
            ${batch.postingAssetId},
            ${batch.status},
            ${JSON.stringify(batch)}::jsonb,
            ${batch.createdAt}::timestamptz,
            ${batch.createdAt}::timestamptz
          )
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING payload;
        `) as Array<{ payload: RentalRevenuePostingBatch }>;
        const storedBatch = insertedRows[0]?.payload ?? batch;
        return { batch: storedBatch, protocolRequest: protocolRequestForBatch(storedBatch) };
      });
    },
    async getPostingBatch(batchId) {
      await ensurePostgresTables();
      const rows = (await sql`
        SELECT payload
        FROM robomata_rental_revenue_posting_batches
        WHERE id = ${batchId}
        LIMIT 1;
      `) as Array<{ payload: RentalRevenuePostingBatch }>;
      return rows[0]?.payload ?? null;
    },
    async markPostingBatchPosted(batchId, protocolTxHash) {
      await ensurePostgresTables();
      return sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${advisoryLockKey(batchId)}));`;
        const currentRows = (await tx`
          SELECT payload
          FROM robomata_rental_revenue_posting_batches
          WHERE id = ${batchId}
          LIMIT 1;
        `) as Array<{ payload: RentalRevenuePostingBatch }>;
        const current = currentRows[0]?.payload;
        if (!current) return null;
        if (current.status === "posted") {
          if (current.protocolTxHash === protocolTxHash) return current;
          throw new Error(`Posting batch ${batchId} is already posted with a different protocol transaction.`);
        }
        const postedAt = new Date().toISOString();
        const batch: RentalRevenuePostingBatch = {
          ...current,
          status: "posted",
          postedAt,
          protocolTxHash,
        };
        const updatedRows = (await tx`
          UPDATE robomata_rental_revenue_posting_batches
          SET status = ${batch.status},
              payload = ${JSON.stringify(batch)}::jsonb,
              updated_at = ${postedAt}::timestamptz
          WHERE id = ${batchId}
            AND status != 'posted'
          RETURNING payload;
        `) as Array<{ payload: RentalRevenuePostingBatch }>;
        return updatedRows[0]?.payload ?? batch;
      });
    },
  };
}

export function getRentalRevenueStore(): RentalRevenueStore {
  if (!storeSingleton) {
    requireRentalRevenueStore();
    storeSingleton = hasPostgresConfig() ? createPostgresStore() : createFileStore();
  }
  return storeSingleton;
}
