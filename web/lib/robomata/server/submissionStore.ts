import { sql } from "@vercel/postgres";
import { desc, sql as drizzleSql, eq } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/vercel-postgres";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "server-only";
import { isRobomataWorkflowMutationEnabled, isRobomataWorkflowServerEnabled } from "~~/lib/featureFlags";
import {
  type CreateSubmissionInput,
  type FacilitySubmission,
  createSubmissionShell,
  touchSubmission,
} from "~~/lib/robomata/submissions";

const submissionsTable = pgTable("robomata_facility_submissions", {
  id: text("id").primaryKey(),
  partnerAddress: text("partner_address").notNull(),
  operatorName: text("operator_name").notNull(),
  facilityName: text("facility_name").notNull(),
  asOfDate: text("as_of_date").notNull(),
  status: text("status").notNull(),
  payload: jsonb("payload").$type<FacilitySubmission>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

type SubmissionStore = {
  list: (partnerAddress?: string) => Promise<FacilitySubmission[]>;
  get: (id: string) => Promise<FacilitySubmission | null>;
  getLatest: () => Promise<FacilitySubmission | null>;
  create: (input: CreateSubmissionInput) => Promise<FacilitySubmission>;
  save: (submission: FacilitySubmission) => Promise<FacilitySubmission>;
  beginEvidenceCommit: (id: string, rootDigest: string) => Promise<FacilitySubmission | null>;
};

let ensuredPostgresTable = false;
const fileStoreLocks = new Map<string, Promise<void>>();

async function ensurePostgresTable() {
  if (ensuredPostgresTable) return;

  await sql`
    CREATE TABLE IF NOT EXISTS robomata_facility_submissions (
      id text PRIMARY KEY,
      partner_address text NOT NULL,
      operator_name text NOT NULL,
      facility_name text NOT NULL,
      as_of_date text NOT NULL,
      status text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `;

  ensuredPostgresTable = true;
}

function hasPostgresConfig() {
  return Boolean(process.env.POSTGRES_URL);
}

function hasExplicitFileStoreConfig() {
  return Boolean(process.env.ROBOMATA_SUBMISSIONS_FILE);
}

function canUseEphemeralFileStore() {
  return process.env.NODE_ENV === "development";
}

function canUseFileStore() {
  return canUseEphemeralFileStore();
}

function requireDurableStoreForEnabledWorkflow() {
  if (!isRobomataWorkflowServerEnabled() && !isRobomataWorkflowMutationEnabled()) return;
  if (hasPostgresConfig() || canUseFileStore()) return;

  throw new Error("Robomata workflow requires POSTGRES_URL outside local development.");
}

async function readFileStore(filePath: string): Promise<FacilitySubmission[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as FacilitySubmission[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function fileStorePath(): string {
  return process.env.ROBOMATA_SUBMISSIONS_FILE || path.join(os.tmpdir(), "robomata-submissions.json");
}

function createFileStore(): SubmissionStore {
  const filePath = fileStorePath();

  const writeAll = async (submissions: FacilitySubmission[]) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(submissions, null, 2), "utf8");
  };

  const withWriteLock = async <T>(operation: () => Promise<T>): Promise<T> => {
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
  };

  return {
    async list(partnerAddress) {
      const submissions = await readFileStore(filePath);
      return submissions
        .filter(
          submission => !partnerAddress || submission.partnerAddress.toLowerCase() === partnerAddress.toLowerCase(),
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    async get(id) {
      const submissions = await readFileStore(filePath);
      return submissions.find(submission => submission.id === id) ?? null;
    },
    async getLatest() {
      const submissions = await readFileStore(filePath);
      return submissions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
    },
    async create(input) {
      return withWriteLock(async () => {
        const submission = createSubmissionShell(input);
        const submissions = await readFileStore(filePath);
        submissions.unshift(submission);
        await writeAll(submissions);
        return submission;
      });
    },
    async save(submission) {
      return withWriteLock(async () => {
        const submissions = await readFileStore(filePath);
        const nextSubmission = touchSubmission(submission);
        const next = submissions.filter(candidate => candidate.id !== nextSubmission.id);
        next.unshift(nextSubmission);
        await writeAll(next);
        return nextSubmission;
      });
    },
    async beginEvidenceCommit(id, rootDigest) {
      return withWriteLock(async () => {
        const submissions = await readFileStore(filePath);
        const submission = submissions.find(candidate => candidate.id === id);
        if (!submission) return null;
        if (submission.evidenceCommit.status !== "ready" || submission.evidenceCommit.rootDigest !== rootDigest) {
          return null;
        }

        submission.evidenceCommit = {
          ...submission.evidenceCommit,
          status: "committing",
          errorMessage: undefined,
        };
        const nextSubmission = touchSubmission(submission);
        const next = submissions.filter(candidate => candidate.id !== nextSubmission.id);
        next.unshift(nextSubmission);
        await writeAll(next);
        return nextSubmission;
      });
    },
  };
}

function createPostgresStore(): SubmissionStore {
  const db = drizzle(sql);

  return {
    async list(partnerAddress) {
      await ensurePostgresTable();
      const query = db.select().from(submissionsTable).orderBy(desc(submissionsTable.updatedAt));
      const rows = partnerAddress
        ? await query.where(drizzleSql`lower(${submissionsTable.partnerAddress}) = ${partnerAddress.toLowerCase()}`)
        : await query;
      return rows.map(row => row.payload);
    },
    async get(id) {
      await ensurePostgresTable();
      const [row] = await db.select().from(submissionsTable).where(eq(submissionsTable.id, id));
      return row?.payload ?? null;
    },
    async getLatest() {
      await ensurePostgresTable();
      const [row] = await db.select().from(submissionsTable).orderBy(desc(submissionsTable.updatedAt)).limit(1);
      return row?.payload ?? null;
    },
    async create(input) {
      await ensurePostgresTable();
      const submission = createSubmissionShell(input);
      await db.insert(submissionsTable).values({
        id: submission.id,
        partnerAddress: submission.partnerAddress,
        operatorName: submission.operatorName,
        facilityName: submission.facilityName,
        asOfDate: submission.asOfDate,
        status: submission.status,
        payload: submission,
        createdAt: new Date(submission.createdAt),
        updatedAt: new Date(submission.updatedAt),
      });
      return submission;
    },
    async save(submission) {
      await ensurePostgresTable();
      const nextSubmission = touchSubmission(submission);
      await db
        .update(submissionsTable)
        .set({
          partnerAddress: nextSubmission.partnerAddress,
          operatorName: nextSubmission.operatorName,
          facilityName: nextSubmission.facilityName,
          asOfDate: nextSubmission.asOfDate,
          status: nextSubmission.status,
          payload: nextSubmission,
          updatedAt: new Date(nextSubmission.updatedAt),
        })
        .where(eq(submissionsTable.id, nextSubmission.id));
      return nextSubmission;
    },
    async beginEvidenceCommit(id, rootDigest) {
      await ensurePostgresTable();
      const result = await sql<{ payload: FacilitySubmission }>`
        UPDATE robomata_facility_submissions
        SET
          payload = jsonb_set(payload, '{evidenceCommit,status}', '"committing"'::jsonb, false),
          updated_at = now()
        WHERE
          id = ${id}
          AND payload->'evidenceCommit'->>'status' = 'ready'
          AND payload->'evidenceCommit'->>'rootDigest' = ${rootDigest}
        RETURNING payload;
      `;

      return result.rows[0]?.payload ?? null;
    },
  };
}

let storeSingleton: SubmissionStore | null = null;

export function getSubmissionStore(): SubmissionStore {
  if (!storeSingleton) {
    requireDurableStoreForEnabledWorkflow();
    if (!hasPostgresConfig() && hasExplicitFileStoreConfig() && !canUseFileStore()) {
      throw new Error("ROBOMATA_SUBMISSIONS_FILE is only supported for local development.");
    }
    storeSingleton = hasPostgresConfig() ? createPostgresStore() : createFileStore();
  }
  return storeSingleton;
}
