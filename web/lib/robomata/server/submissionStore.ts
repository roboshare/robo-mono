import { sql } from "@vercel/postgres";
import { and, desc, sql as drizzleSql, eq } from "drizzle-orm";
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
  createAuditEvent,
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
  beginEvidenceCommit: (id: string, rootDigest: string, commitStartedAt: string) => Promise<FacilitySubmission | null>;
  completeEvidenceCommit: (
    id: string,
    rootDigest: string,
    input: CompleteEvidenceCommitInput,
  ) => Promise<FacilitySubmission | null>;
  failEvidenceCommit: (id: string, rootDigest: string, errorMessage: string) => Promise<FacilitySubmission | null>;
};

type CompleteEvidenceCommitInput = {
  txDigest?: string;
  committedAt: string;
  facilityObjectId: string;
  facilityOperatorAddress: string;
  commitAuthority?: "server" | "operator";
  operatorWalletAddress?: string;
};

let ensuredPostgresTable = false;
const fileStoreLocks = new Map<string, Promise<void>>();
const expectedUpdatedAtSymbol = Symbol("robomataExpectedUpdatedAt");

type LoadedSubmission = FacilitySubmission & {
  [expectedUpdatedAtSymbol]?: string;
};

function markLoadedSubmission(submission: FacilitySubmission): FacilitySubmission {
  Object.defineProperty(submission, expectedUpdatedAtSymbol, {
    configurable: true,
    enumerable: false,
    value: submission.updatedAt,
  });
  return submission;
}

function expectedUpdatedAt(submission: FacilitySubmission): string {
  return (submission as LoadedSubmission)[expectedUpdatedAtSymbol] ?? submission.updatedAt;
}

function canBeginEvidenceCommit(submission: FacilitySubmission, rootDigest: string): boolean {
  return (
    ["ready", "failed"].includes(submission.evidenceCommit.status) &&
    submission.evidenceCommit.rootDigest === rootDigest
  );
}

function canFinishEvidenceCommit(submission: FacilitySubmission, rootDigest: string): boolean {
  return (
    ["ready", "failed", "committing"].includes(submission.evidenceCommit.status) &&
    submission.evidenceCommit.rootDigest === rootDigest
  );
}

function applyBeginEvidenceCommit(
  submission: FacilitySubmission,
  rootDigest: string,
  commitStartedAt: string,
): FacilitySubmission | null {
  if (!canBeginEvidenceCommit(submission, rootDigest)) return null;

  submission.evidenceCommit = {
    ...submission.evidenceCommit,
    status: "committing",
    commitStartedAt,
    errorMessage: undefined,
  };
  return touchSubmission(submission);
}

function applyCompleteEvidenceCommit(
  submission: FacilitySubmission,
  rootDigest: string,
  input: CompleteEvidenceCommitInput,
): FacilitySubmission | null {
  if (!canFinishEvidenceCommit(submission, rootDigest)) return null;

  submission.evidenceCommit = {
    ...submission.evidenceCommit,
    status: "committed",
    txDigest: input.txDigest,
    committedAt: input.committedAt,
    commitMode: input.commitAuthority === "operator" ? "operator_configured" : "configured",
    commitAuthority: input.commitAuthority,
    facilityObjectId: input.facilityObjectId,
    facilityOperatorAddress: input.facilityOperatorAddress,
    operatorWalletAddress: input.operatorWalletAddress,
    errorMessage: undefined,
  };
  submission.auditEvents.unshift(
    createAuditEvent("sui_commit_completed", `Committed evidence root for ${submission.facilityName}.`, {
      txDigest: input.txDigest ?? null,
      commitAuthority: input.commitAuthority ?? "server",
    }),
  );
  return touchSubmission(submission);
}

function applyFailEvidenceCommit(
  submission: FacilitySubmission,
  rootDigest: string,
  errorMessage: string,
): FacilitySubmission | null {
  if (!canFinishEvidenceCommit(submission, rootDigest)) return null;

  submission.evidenceCommit = {
    ...submission.evidenceCommit,
    status: "failed",
    errorMessage,
  };
  return touchSubmission(submission);
}

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
    if (!raw.trim()) return [];
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
        .map(markLoadedSubmission)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    async get(id) {
      const submissions = await readFileStore(filePath);
      const submission = submissions.find(candidate => candidate.id === id);
      return submission ? markLoadedSubmission(submission) : null;
    },
    async getLatest() {
      const submissions = await readFileStore(filePath);
      const submission = submissions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      return submission ? markLoadedSubmission(submission) : null;
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
        const current = submissions.find(candidate => candidate.id === submission.id);
        if (current && current.updatedAt !== expectedUpdatedAt(submission)) {
          throw new Error("Submission changed while this update was in progress. Reload and try again.");
        }

        const nextSubmission = touchSubmission(submission);
        const next = submissions.filter(candidate => candidate.id !== nextSubmission.id);
        next.unshift(nextSubmission);
        await writeAll(next);
        return markLoadedSubmission(nextSubmission);
      });
    },
    async beginEvidenceCommit(id, rootDigest, commitStartedAt) {
      return withWriteLock(async () => {
        const submissions = await readFileStore(filePath);
        const submission = submissions.find(candidate => candidate.id === id);
        if (!submission) return null;
        const nextSubmission = applyBeginEvidenceCommit(submission, rootDigest, commitStartedAt);
        if (!nextSubmission) return null;
        const next = submissions.filter(candidate => candidate.id !== nextSubmission.id);
        next.unshift(nextSubmission);
        await writeAll(next);
        return markLoadedSubmission(nextSubmission);
      });
    },
    async completeEvidenceCommit(id, rootDigest, input) {
      return withWriteLock(async () => {
        const submissions = await readFileStore(filePath);
        const submission = submissions.find(candidate => candidate.id === id);
        if (!submission) return null;
        const nextSubmission = applyCompleteEvidenceCommit(submission, rootDigest, input);
        if (!nextSubmission) return null;
        const next = submissions.filter(candidate => candidate.id !== nextSubmission.id);
        next.unshift(nextSubmission);
        await writeAll(next);
        return markLoadedSubmission(nextSubmission);
      });
    },
    async failEvidenceCommit(id, rootDigest, errorMessage) {
      return withWriteLock(async () => {
        const submissions = await readFileStore(filePath);
        const submission = submissions.find(candidate => candidate.id === id);
        if (!submission) return null;
        const nextSubmission = applyFailEvidenceCommit(submission, rootDigest, errorMessage);
        if (!nextSubmission) return null;
        const next = submissions.filter(candidate => candidate.id !== nextSubmission.id);
        next.unshift(nextSubmission);
        await writeAll(next);
        return markLoadedSubmission(nextSubmission);
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
      return rows.map(row => markLoadedSubmission(row.payload));
    },
    async get(id) {
      await ensurePostgresTable();
      const [row] = await db.select().from(submissionsTable).where(eq(submissionsTable.id, id));
      return row ? markLoadedSubmission(row.payload) : null;
    },
    async getLatest() {
      await ensurePostgresTable();
      const [row] = await db.select().from(submissionsTable).orderBy(desc(submissionsTable.updatedAt)).limit(1);
      return row ? markLoadedSubmission(row.payload) : null;
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
      const previousUpdatedAt = new Date(expectedUpdatedAt(submission));
      const nextSubmission = touchSubmission(submission);
      const rows = await db
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
        .where(and(eq(submissionsTable.id, nextSubmission.id), eq(submissionsTable.updatedAt, previousUpdatedAt)))
        .returning({ id: submissionsTable.id });

      if (rows.length === 0) {
        throw new Error("Submission changed while this update was in progress. Reload and try again.");
      }

      return nextSubmission;
    },
    async beginEvidenceCommit(id, rootDigest, commitStartedAt) {
      await ensurePostgresTable();
      const current = await this.get(id);
      if (!current) return null;
      const nextSubmission = applyBeginEvidenceCommit(current, rootDigest, commitStartedAt);
      if (!nextSubmission) return null;
      const result = await sql<{ payload: FacilitySubmission }>`
        UPDATE robomata_facility_submissions
        SET
          status = ${nextSubmission.status},
          payload = ${JSON.stringify(nextSubmission)}::jsonb,
          updated_at = ${nextSubmission.updatedAt}::timestamptz
        WHERE
          id = ${id}
          AND payload->'evidenceCommit'->>'status' IN ('ready', 'failed')
          AND payload->'evidenceCommit'->>'rootDigest' = ${rootDigest}
        RETURNING payload;
      `;

      const row = result.rows[0];
      if (!row) return null;
      return markLoadedSubmission(row.payload);
    },
    async completeEvidenceCommit(id, rootDigest, input) {
      await ensurePostgresTable();
      const current = await this.get(id);
      if (!current) return null;
      const nextSubmission = applyCompleteEvidenceCommit(current, rootDigest, input);
      if (!nextSubmission) return null;
      const result = await sql<{ payload: FacilitySubmission }>`
        UPDATE robomata_facility_submissions
        SET
          status = ${nextSubmission.status},
          payload = ${JSON.stringify(nextSubmission)}::jsonb,
          updated_at = ${nextSubmission.updatedAt}::timestamptz
        WHERE
          id = ${id}
          AND payload->'evidenceCommit'->>'status' IN ('ready', 'failed', 'committing')
          AND payload->'evidenceCommit'->>'rootDigest' = ${rootDigest}
        RETURNING payload;
      `;

      const row = result.rows[0];
      return row ? markLoadedSubmission(row.payload) : null;
    },
    async failEvidenceCommit(id, rootDigest, errorMessage) {
      await ensurePostgresTable();
      const current = await this.get(id);
      if (!current) return null;
      const nextSubmission = applyFailEvidenceCommit(current, rootDigest, errorMessage);
      if (!nextSubmission) return null;
      const result = await sql<{ payload: FacilitySubmission }>`
        UPDATE robomata_facility_submissions
        SET
          status = ${nextSubmission.status},
          payload = ${JSON.stringify(nextSubmission)}::jsonb,
          updated_at = ${nextSubmission.updatedAt}::timestamptz
        WHERE
          id = ${id}
          AND payload->'evidenceCommit'->>'status' = 'committing'
          AND payload->'evidenceCommit'->>'rootDigest' = ${rootDigest}
        RETURNING payload;
      `;

      const row = result.rows[0];
      return row ? markLoadedSubmission(row.payload) : null;
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
