import { sql } from "@vercel/postgres";
import { desc, eq } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/vercel-postgres";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "server-only";
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
};

let ensuredPostgresTable = false;

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
  return Boolean(process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING);
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
      const submission = createSubmissionShell(input);
      const submissions = await readFileStore(filePath);
      submissions.unshift(submission);
      await writeAll(submissions);
      return submission;
    },
    async save(submission) {
      const submissions = await readFileStore(filePath);
      const nextSubmission = touchSubmission(submission);
      const next = submissions.filter(candidate => candidate.id !== nextSubmission.id);
      next.unshift(nextSubmission);
      await writeAll(next);
      return nextSubmission;
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
        ? await query.where(eq(submissionsTable.partnerAddress, partnerAddress))
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
  };
}

let storeSingleton: SubmissionStore | null = null;

export function getSubmissionStore(): SubmissionStore {
  if (!storeSingleton) {
    storeSingleton = hasPostgresConfig() ? createPostgresStore() : createFileStore();
  }
  return storeSingleton;
}
