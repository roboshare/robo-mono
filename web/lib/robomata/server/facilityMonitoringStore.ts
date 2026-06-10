import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "server-only";
import { isRobomataFacilityMonitoringEnabled } from "~~/lib/featureFlags";
import {
  type BorrowingBaseRun,
  type FacilityMonitoringProjection,
  type FacilityObservation,
  type FacilityObservationStatus,
  type PacketFreshnessStatus,
  type PacketManifest,
  type RobomataFacility,
  type SuiRootCommit,
  type SuiRootCommitStatus,
  type SuiRootPayload,
  type SuiRootVerificationStatus,
} from "~~/lib/robomata/facilityMonitoring";
import { buildFacilityMonitoringProjection } from "~~/lib/robomata/facilityMonitoringProjection";
import {
  buildBorrowingBaseRunRootPayload,
  buildPacketManifestRootPayload,
} from "~~/lib/robomata/server/facilityMonitoringRoots";
import { getRobomataPostgresSql } from "~~/lib/robomata/server/postgres";
import type { FacilitySubmission, SubmissionEvidence } from "~~/lib/robomata/submissions";

type FacilityMonitoringFileStore = {
  facilities: RobomataFacility[];
  observations: FacilityObservation[];
  runs: BorrowingBaseRun[];
  packetManifests: PacketManifest[];
  suiRootCommits: SuiRootCommit[];
};

type CreateReceivablesObservationInput = {
  filename: string;
  importedAt: string;
  receivableCount: number;
  submission: FacilitySubmission;
};

type FacilityMonitoringStore = {
  syncFacility: (submission: FacilitySubmission) => Promise<RobomataFacility>;
  syncEvidenceObservations: (submission: FacilitySubmission) => Promise<FacilityObservation[]>;
  createReceivablesImportObservation: (input: CreateReceivablesObservationInput) => Promise<FacilityObservation>;
  recordRunFromSubmission: (
    submission: FacilitySubmission,
  ) => Promise<{ packet?: PacketManifest; run?: BorrowingBaseRun }>;
  getProjectionForSubmission: (submission: FacilitySubmission) => Promise<FacilityMonitoringProjection>;
  updateSuiRootCommit: (
    id: string,
    input: {
      errorMessage?: string;
      status: SuiRootCommitStatus;
      txDigest?: string;
      verifiedAt?: string;
    },
  ) => Promise<SuiRootCommit | null>;
};

let ensuredPostgresTables = false;
let storeSingleton: FacilityMonitoringStore | null = null;
const fileStoreLocks = new Map<string, Promise<void>>();

function hasPostgresConfig() {
  return Boolean(process.env.POSTGRES_URL);
}

function canUseFileStore() {
  return process.env.NODE_ENV === "development";
}

function requireMonitoringStore() {
  if (!isRobomataFacilityMonitoringEnabled()) return;
  if (hasPostgresConfig() || canUseFileStore()) return;

  throw new Error("Robomata facility monitoring requires POSTGRES_URL outside local development.");
}

function fileStorePath(): string {
  return process.env.ROBOMATA_FACILITY_MONITORING_FILE || path.join(os.tmpdir(), "robomata-facility-monitoring.json");
}

function emptyFileStore(): FacilityMonitoringFileStore {
  return { facilities: [], observations: [], packetManifests: [], runs: [], suiRootCommits: [] };
}

async function readFileStore(filePath: string): Promise<FacilityMonitoringFileStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) return emptyFileStore();
    const parsed = JSON.parse(raw) as Partial<FacilityMonitoringFileStore>;
    return {
      facilities: parsed.facilities ?? [],
      observations: parsed.observations ?? [],
      runs: parsed.runs ?? [],
      packetManifests: parsed.packetManifests ?? [],
      suiRootCommits: parsed.suiRootCommits ?? [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFileStore();
    throw error;
  }
}

async function writeFileStore(filePath: string, fileStore: FacilityMonitoringFileStore) {
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

function facilityIdForSubmission(submission: FacilitySubmission): string {
  return submission.facilityMonitoring?.facilityId ?? `fac_${submission.id.replace(/^sub_/, "")}`;
}

function buildFacility(submission: FacilitySubmission): RobomataFacility {
  const projected = buildFacilityMonitoringProjection(submission);
  return projected.facility;
}

function evidenceObservationId(evidence: SubmissionEvidence): string {
  return `obs_${evidence.id}`;
}

function buildEvidenceObservations(submission: FacilitySubmission): FacilityObservation[] {
  return buildFacilityMonitoringProjection(submission).observations;
}

function createReceivablesObservation(input: CreateReceivablesObservationInput): FacilityObservation {
  const facilityId = facilityIdForSubmission(input.submission);
  return {
    id: `obs_${input.submission.id}_receivables_${randomUUID()}`,
    facilityId,
    kind: "receivables_aging",
    source: `CSV import: ${input.filename}`,
    observedAt: input.importedAt,
    status: "fresh",
    confidence: "operator_attested",
    linkedAssetIds: [],
    linkedReceivableIds: input.submission.receivables.map(receivable => receivable.id),
    digest: `receivables:${input.submission.id}:${input.importedAt}:${input.receivableCount}`,
    notes: `${input.receivableCount} receivables imported.`,
  };
}

function buildRunAndPacket(
  submission: FacilitySubmission,
  observations: FacilityObservation[],
): { packet?: PacketManifest; run?: BorrowingBaseRun } {
  const projection = buildFacilityMonitoringProjection(submission);
  if (!projection.latestRun || !submission.computation) return {};

  const inputObservationIds = observations.map(observation => observation.id);
  const runWithoutMonitoringRoot: BorrowingBaseRun = {
    ...projection.latestRun,
    inputObservationIds,
  };
  const runRoot = buildBorrowingBaseRunRootPayload(runWithoutMonitoringRoot);
  const run: BorrowingBaseRun = {
    ...runWithoutMonitoringRoot,
    rootDigest: runRoot.rootDigest,
  };
  const packet = projection.latestPacket
    ? {
        ...projection.latestPacket,
        evidenceObservationIds: inputObservationIds,
        runDigest: run.rootDigest,
      }
    : undefined;
  const packetRoot = packet ? buildPacketManifestRootPayload(packet) : undefined;
  const rootedPacket =
    packet && packetRoot
      ? {
          ...packet,
          publicMetadata: {
            ...packet.publicMetadata,
            monitoringRootVersion: runRoot.version,
            packetRootDigest: packetRoot.rootDigest,
            runRootDigest: runRoot.rootDigest,
          },
        }
      : undefined;
  return { packet: rootedPacket, run };
}

function observationSort(left: FacilityObservation, right: FacilityObservation) {
  return right.observedAt.localeCompare(left.observedAt);
}

function runSort(left: BorrowingBaseRun, right: BorrowingBaseRun) {
  return right.createdAt.localeCompare(left.createdAt);
}

function runHistoryForFacility(runs: BorrowingBaseRun[], facilityId: string): BorrowingBaseRun[] {
  return runs.filter(run => run.facilityId === facilityId).sort(runSort);
}

function packetManifestsForFacility(packetManifests: PacketManifest[], facilityId: string): PacketManifest[] {
  return packetManifests
    .filter(packet => packet.facilityId === facilityId)
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

function latestPacketForRun(packetManifests: PacketManifest[], runId: string | undefined): PacketManifest | undefined {
  if (!runId) return undefined;
  return packetManifests
    .filter(packet => packet.runId === runId)
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
}

function rootCommitSort(left: SuiRootCommit, right: SuiRootCommit) {
  return right.createdAt.localeCompare(left.createdAt);
}

function suiRootCommitsForFacility(suiRootCommits: SuiRootCommit[], facilityId: string): SuiRootCommit[] {
  return suiRootCommits.filter(root => root.facilityId === facilityId).sort(rootCommitSort);
}

function labelForSuiRoot(payload: SuiRootPayload) {
  const sourceId = payload.packetManifestId ?? payload.runId ?? "evidence_batch";
  return `monitoring:${payload.version}:${payload.kind}:${sourceId}`;
}

function buildSuiRootCommit(payload: SuiRootPayload, createdAt: string): SuiRootCommit {
  return {
    id: `suiroot_${payload.kind}_${payload.packetManifestId ?? payload.runId ?? payload.facilityId}_${payload.rootDigest
      .replace(/^0x/, "")
      .slice(0, 12)}`,
    facilityId: payload.facilityId,
    kind: payload.kind,
    version: payload.version,
    label: labelForSuiRoot(payload),
    payload,
    inputDigest: payload.inputDigest,
    rootDigest: payload.rootDigest,
    status: "pending",
    createdAt,
    updatedAt: createdAt,
  };
}

function buildSuiRootCommitsForRun(run: BorrowingBaseRun, packet: PacketManifest | undefined): SuiRootCommit[] {
  const runRoot = buildBorrowingBaseRunRootPayload(run);
  const packetRoot = packet ? buildPacketManifestRootPayload(packet) : undefined;
  return [
    buildSuiRootCommit(runRoot, run.lockedAt ?? run.createdAt),
    ...(packet && packetRoot ? [buildSuiRootCommit(packetRoot, packet.generatedAt)] : []),
  ];
}

function projectionSuiRootStatus(
  fallback: FacilityMonitoringProjection,
  rootCommits: SuiRootCommit[],
): SuiRootVerificationStatus {
  const latestRoot = rootCommits[0];
  if (!latestRoot) return fallback.suiRootStatus;
  if (latestRoot.status === "pending") return "pending";
  if (latestRoot.status === "committing") return "committing";
  if (latestRoot.status === "committed") return "committed";
  if (latestRoot.status === "verified") return "verified";
  if (latestRoot.status === "mismatch") return "mismatch";
  if (latestRoot.status === "retryable") return "retryable";
  return "failed";
}

function deriveObservationStatus(observation: FacilityObservation, packetGeneratedAt: string | undefined) {
  if (!packetGeneratedAt || observation.status !== "fresh") return observation.status;
  return observation.observedAt > packetGeneratedAt ? "fresh" : observation.status;
}

function derivePacketFreshness(
  observations: FacilityObservation[],
  packet: PacketManifest | undefined,
): PacketFreshnessStatus {
  if (!packet) return "invalid";
  const newerObservations = observations.filter(observation => observation.observedAt > packet.generatedAt);
  if (newerObservations.some(observation => observation.status === "expired" || observation.status === "exception")) {
    return "invalid";
  }
  if (newerObservations.length > 0) return "stale";
  if (observations.some(observation => observation.status === "expired" || observation.status === "exception")) {
    return "invalid";
  }
  if (observations.some(observation => observation.status === "stale" || observation.status === "superseded")) {
    return "stale";
  }
  if (observations.some(observation => observation.status === "pending" || observation.status === "warning")) {
    return "refresh_available";
  }
  return packet.freshnessStatus;
}

function buildStoredProjection(input: {
  fallback: FacilityMonitoringProjection;
  facility: RobomataFacility;
  observations: FacilityObservation[];
  packetManifests: PacketManifest[];
  runHistory: BorrowingBaseRun[];
  suiRootCommits: SuiRootCommit[];
}): FacilityMonitoringProjection {
  const sortedObservations = (input.observations.length ? input.observations : input.fallback.observations).sort(
    observationSort,
  );
  const runHistory = input.runHistory.length ? input.runHistory : input.fallback.runHistory;
  const latestRun = runHistory[0] ?? input.fallback.latestRun;
  const storedLatestPacket = latestPacketForRun(input.packetManifests, latestRun?.id);
  const packetManifests = input.packetManifests.length ? input.packetManifests : input.fallback.packetManifests;
  const suiRootCommits = input.suiRootCommits.length ? input.suiRootCommits : input.fallback.suiRootCommits;
  const latestSuiRootCommit = suiRootCommits[0] ?? input.fallback.latestSuiRootCommit;
  const freshnessStatus = derivePacketFreshness(sortedObservations, storedLatestPacket ?? input.fallback.latestPacket);
  const latestPacket = storedLatestPacket
    ? { ...storedLatestPacket, freshnessStatus }
    : input.fallback.latestPacket
      ? { ...input.fallback.latestPacket, freshnessStatus }
      : undefined;
  const nextPacketManifests = latestPacket
    ? [latestPacket, ...packetManifests.filter(packet => packet.id !== latestPacket.id)]
    : packetManifests;
  const facilityStatus =
    freshnessStatus === "fresh"
      ? "packet_fresh"
      : freshnessStatus === "stale" || freshnessStatus === "superseded"
        ? "packet_stale"
        : freshnessStatus === "invalid" || freshnessStatus === "refresh_available"
          ? "needs_review"
          : input.facility.status;
  return {
    ...input.fallback,
    facility: {
      ...input.facility,
      latestRunId: latestRun?.id,
      latestPacketId: latestPacket?.id,
      status: facilityStatus,
    },
    latestRun,
    latestPacket,
    latestSuiRootCommit,
    runHistory,
    packetManifests: nextPacketManifests,
    suiRootCommits,
    observations: sortedObservations.map(observation => ({
      ...observation,
      status: deriveObservationStatus(observation, latestPacket?.generatedAt) as FacilityObservationStatus,
    })),
    freshnessStatus,
    suiRootStatus: projectionSuiRootStatus(input.fallback, suiRootCommits),
  };
}

async function ensurePostgresTables() {
  if (ensuredPostgresTables) return;

  const sql = getRobomataPostgresSql();
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_facilities (
      id text PRIMARY KEY,
      partner_address text NOT NULL,
      operator_name text NOT NULL,
      facility_name text NOT NULL,
      status text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_facilities_partner_idx
      ON robomata_facilities (partner_address);
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_facility_observations (
      id text PRIMARY KEY,
      facility_id text NOT NULL,
      kind text NOT NULL,
      status text NOT NULL,
      observed_at timestamptz NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_facility_observations_facility_idx
      ON robomata_facility_observations (facility_id, observed_at DESC);
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_borrowing_base_runs (
      id text PRIMARY KEY,
      facility_id text NOT NULL,
      status text NOT NULL,
      as_of_date text NOT NULL,
      root_digest text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      locked_at timestamptz
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_borrowing_base_runs_facility_idx
      ON robomata_borrowing_base_runs (facility_id, created_at DESC);
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_packet_manifests (
      id text PRIMARY KEY,
      facility_id text NOT NULL,
      run_id text NOT NULL,
      freshness_status text NOT NULL,
      payload jsonb NOT NULL,
      generated_at timestamptz NOT NULL
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_packet_manifests_run_idx
      ON robomata_packet_manifests (run_id, generated_at DESC);
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_sui_root_commits (
      id text PRIMARY KEY,
      facility_id text NOT NULL,
      kind text NOT NULL,
      label text NOT NULL,
      root_digest text NOT NULL,
      status text NOT NULL,
      tx_digest text,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      verified_at timestamptz
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_sui_root_commits_facility_idx
      ON robomata_sui_root_commits (facility_id, created_at DESC);
  `;

  ensuredPostgresTables = true;
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  return [item, ...items.filter(candidate => candidate.id !== item.id)];
}

function createFileStore(): FacilityMonitoringStore {
  const filePath = fileStorePath();

  return {
    async syncFacility(submission) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const facility = buildFacility(submission);
        fileStore.facilities = upsertById(fileStore.facilities, facility);
        await writeFileStore(filePath, fileStore);
        return facility;
      });
    },
    async syncEvidenceObservations(submission) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const facility = buildFacility(submission);
        const observations = buildEvidenceObservations(submission);
        fileStore.facilities = upsertById(fileStore.facilities, facility);
        for (const observation of observations) {
          fileStore.observations = upsertById(fileStore.observations, observation);
        }
        await writeFileStore(filePath, fileStore);
        return observations;
      });
    },
    async createReceivablesImportObservation(input) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const facility = buildFacility(input.submission);
        const observation = createReceivablesObservation(input);
        fileStore.facilities = upsertById(fileStore.facilities, facility);
        fileStore.observations = upsertById(fileStore.observations, observation);
        await writeFileStore(filePath, fileStore);
        return observation;
      });
    },
    async recordRunFromSubmission(submission) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const facility = buildFacility(submission);
        const evidenceObservations = buildEvidenceObservations(submission);
        fileStore.facilities = upsertById(fileStore.facilities, facility);
        for (const observation of evidenceObservations) {
          fileStore.observations = upsertById(fileStore.observations, observation);
        }
        const observations = fileStore.observations.filter(observation => observation.facilityId === facility.id);
        const { packet, run } = buildRunAndPacket(submission, observations);
        if (run) fileStore.runs = upsertById(fileStore.runs, run);
        if (packet) fileStore.packetManifests = upsertById(fileStore.packetManifests, packet);
        if (run) {
          for (const rootCommit of buildSuiRootCommitsForRun(run, packet)) {
            fileStore.suiRootCommits = upsertById(fileStore.suiRootCommits, rootCommit);
          }
        }
        await writeFileStore(filePath, fileStore);
        return { packet, run };
      });
    },
    async getProjectionForSubmission(submission) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const fallback = buildFacilityMonitoringProjection(submission);
        const facility = buildFacility(submission);
        const evidenceObservations = buildEvidenceObservations(submission);
        fileStore.facilities = upsertById(fileStore.facilities, facility);
        for (const observation of evidenceObservations) {
          fileStore.observations = upsertById(fileStore.observations, observation);
        }
        await writeFileStore(filePath, fileStore);

        const observations = fileStore.observations.filter(observation => observation.facilityId === facility.id);
        const useStoredArtifacts = Boolean(submission.computation);
        const runHistory = useStoredArtifacts ? runHistoryForFacility(fileStore.runs, facility.id) : [];
        const packetManifests = useStoredArtifacts
          ? packetManifestsForFacility(fileStore.packetManifests, facility.id)
          : [];
        const suiRootCommits = useStoredArtifacts
          ? suiRootCommitsForFacility(fileStore.suiRootCommits, facility.id)
          : [];
        return buildStoredProjection({ fallback, facility, observations, packetManifests, runHistory, suiRootCommits });
      });
    },
    async updateSuiRootCommit(id, input) {
      return withFileStoreWriteLock(filePath, async () => {
        const updatedAt = new Date().toISOString();
        const fileStore = await readFileStore(filePath);
        let updatedRoot: SuiRootCommit | null = null;
        fileStore.suiRootCommits = fileStore.suiRootCommits.map(root => {
          if (root.id !== id) return root;
          updatedRoot = {
            ...root,
            errorMessage: input.errorMessage,
            status: input.status,
            txDigest: input.txDigest ?? root.txDigest,
            updatedAt,
            verifiedAt: input.verifiedAt ?? root.verifiedAt,
          };
          return updatedRoot;
        });
        if (!updatedRoot) return null;
        await writeFileStore(filePath, fileStore);
        return updatedRoot;
      });
    },
  };
}

function createPostgresStore(): FacilityMonitoringStore {
  const sql = getRobomataPostgresSql();

  return {
    async syncFacility(submission) {
      await ensurePostgresTables();
      const facility = buildFacility(submission);
      await sql`
        INSERT INTO robomata_facilities (
          id, partner_address, operator_name, facility_name, status, payload, created_at, updated_at
        )
        VALUES (
          ${facility.id},
          ${facility.partnerAddress},
          ${facility.operatorName},
          ${facility.facilityName},
          ${facility.status},
          ${JSON.stringify(facility)}::jsonb,
          ${facility.createdAt}::timestamptz,
          ${facility.updatedAt}::timestamptz
        )
        ON CONFLICT (id) DO UPDATE
        SET
          partner_address = EXCLUDED.partner_address,
          operator_name = EXCLUDED.operator_name,
          facility_name = EXCLUDED.facility_name,
          status = EXCLUDED.status,
          payload = EXCLUDED.payload,
          updated_at = EXCLUDED.updated_at;
      `;
      return facility;
    },
    async syncEvidenceObservations(submission) {
      await ensurePostgresTables();
      await this.syncFacility(submission);
      const observations = buildEvidenceObservations(submission);
      for (const observation of observations) {
        await sql`
          INSERT INTO robomata_facility_observations (id, facility_id, kind, status, observed_at, payload)
          VALUES (
            ${observation.id},
            ${observation.facilityId},
            ${observation.kind},
            ${observation.status},
            ${observation.observedAt}::timestamptz,
            ${JSON.stringify(observation)}::jsonb
          )
          ON CONFLICT (id) DO UPDATE
          SET
            status = EXCLUDED.status,
            payload = EXCLUDED.payload,
            observed_at = EXCLUDED.observed_at;
        `;
      }
      return observations;
    },
    async createReceivablesImportObservation(input) {
      await ensurePostgresTables();
      await this.syncFacility(input.submission);
      const observation = createReceivablesObservation(input);
      await sql`
        INSERT INTO robomata_facility_observations (id, facility_id, kind, status, observed_at, payload)
        VALUES (
          ${observation.id},
          ${observation.facilityId},
          ${observation.kind},
          ${observation.status},
          ${observation.observedAt}::timestamptz,
          ${JSON.stringify(observation)}::jsonb
        )
        ON CONFLICT (id) DO UPDATE
        SET
          status = EXCLUDED.status,
          payload = EXCLUDED.payload,
          observed_at = EXCLUDED.observed_at;
      `;
      return observation;
    },
    async recordRunFromSubmission(submission) {
      await ensurePostgresTables();
      await this.syncFacility(submission);
      await this.syncEvidenceObservations(submission);
      const facilityId = facilityIdForSubmission(submission);
      const observations = (await sql`
        SELECT payload
        FROM robomata_facility_observations
        WHERE facility_id = ${facilityId}
        ORDER BY observed_at DESC;
      `) as Array<{ payload: FacilityObservation }>;
      const { packet, run } = buildRunAndPacket(
        submission,
        observations.map(row => row.payload),
      );
      if (run) {
        const rootCommits = buildSuiRootCommitsForRun(run, packet);
        await sql`
          INSERT INTO robomata_borrowing_base_runs (
            id, facility_id, status, as_of_date, root_digest, payload, created_at, locked_at
          )
          VALUES (
            ${run.id},
            ${run.facilityId},
            ${run.status},
            ${run.asOfDate},
            ${run.rootDigest},
            ${JSON.stringify(run)}::jsonb,
            ${run.createdAt}::timestamptz,
            ${run.lockedAt ?? null}::timestamptz
          )
          ON CONFLICT (id) DO UPDATE
          SET
            status = EXCLUDED.status,
            root_digest = EXCLUDED.root_digest,
            payload = EXCLUDED.payload,
            locked_at = EXCLUDED.locked_at;
        `;
        for (const rootCommit of rootCommits) {
          await sql`
            INSERT INTO robomata_sui_root_commits (
              id, facility_id, kind, label, root_digest, status, tx_digest, payload, created_at, updated_at, verified_at
            )
            VALUES (
              ${rootCommit.id},
              ${rootCommit.facilityId},
              ${rootCommit.kind},
              ${rootCommit.label},
              ${rootCommit.rootDigest},
              ${rootCommit.status},
              ${rootCommit.txDigest ?? null},
              ${JSON.stringify(rootCommit)}::jsonb,
              ${rootCommit.createdAt}::timestamptz,
              ${rootCommit.updatedAt}::timestamptz,
              ${rootCommit.verifiedAt ?? null}::timestamptz
            )
            ON CONFLICT (id) DO NOTHING;
          `;
        }
      }
      if (packet) {
        await sql`
          INSERT INTO robomata_packet_manifests (id, facility_id, run_id, freshness_status, payload, generated_at)
          VALUES (
            ${packet.id},
            ${packet.facilityId},
            ${packet.runId},
            ${packet.freshnessStatus},
            ${JSON.stringify(packet)}::jsonb,
            ${packet.generatedAt}::timestamptz
          )
          ON CONFLICT (id) DO UPDATE
          SET
            freshness_status = EXCLUDED.freshness_status,
            payload = EXCLUDED.payload,
            generated_at = EXCLUDED.generated_at;
        `;
      }
      return { packet, run };
    },
    async getProjectionForSubmission(submission) {
      await ensurePostgresTables();
      await this.syncFacility(submission);
      await this.syncEvidenceObservations(submission);
      const fallback = buildFacilityMonitoringProjection(submission);
      const facilityRows = (await sql`
        SELECT payload
        FROM robomata_facilities
        WHERE id = ${fallback.facility.id}
        LIMIT 1;
      `) as Array<{ payload: RobomataFacility }>;
      const facility = facilityRows[0]?.payload ?? fallback.facility;
      const observationRows = (await sql`
        SELECT payload
        FROM robomata_facility_observations
        WHERE facility_id = ${facility.id}
        ORDER BY observed_at DESC;
      `) as Array<{ payload: FacilityObservation }>;
      const runRows = (await sql`
        SELECT payload
        FROM robomata_borrowing_base_runs
        WHERE facility_id = ${facility.id}
        ORDER BY created_at DESC
      `) as Array<{ payload: BorrowingBaseRun }>;
      const packetRows = (await sql`
        SELECT payload
        FROM robomata_packet_manifests
        WHERE facility_id = ${facility.id}
        ORDER BY generated_at DESC;
      `) as Array<{ payload: PacketManifest }>;
      const rootRows = (await sql`
        SELECT payload
        FROM robomata_sui_root_commits
        WHERE facility_id = ${facility.id}
        ORDER BY created_at DESC;
      `) as Array<{ payload: SuiRootCommit }>;
      const useStoredArtifacts = Boolean(submission.computation);

      return buildStoredProjection({
        fallback,
        facility,
        observations: observationRows.map(row => row.payload),
        packetManifests: useStoredArtifacts ? packetRows.map(row => row.payload) : [],
        runHistory: useStoredArtifacts ? runRows.map(row => row.payload) : [],
        suiRootCommits: useStoredArtifacts ? rootRows.map(row => row.payload) : [],
      });
    },
    async updateSuiRootCommit(id, input) {
      await ensurePostgresTables();
      const updatedAt = new Date().toISOString();
      const rows = (await sql`
        SELECT payload
        FROM robomata_sui_root_commits
        WHERE id = ${id}
        LIMIT 1;
      `) as Array<{ payload: SuiRootCommit }>;
      const current = rows[0]?.payload;
      if (!current) return null;
      const updatedRoot: SuiRootCommit = {
        ...current,
        errorMessage: input.errorMessage,
        status: input.status,
        txDigest: input.txDigest ?? current.txDigest,
        updatedAt,
        verifiedAt: input.verifiedAt ?? current.verifiedAt,
      };
      await sql`
        UPDATE robomata_sui_root_commits
        SET
          status = ${updatedRoot.status},
          tx_digest = ${updatedRoot.txDigest ?? null},
          payload = ${JSON.stringify(updatedRoot)}::jsonb,
          updated_at = ${updatedRoot.updatedAt}::timestamptz,
          verified_at = ${updatedRoot.verifiedAt ?? null}::timestamptz
        WHERE id = ${id};
      `;
      return updatedRoot;
    },
  };
}

export function getFacilityMonitoringStore(): FacilityMonitoringStore {
  if (!storeSingleton) {
    requireMonitoringStore();
    storeSingleton = hasPostgresConfig() ? createPostgresStore() : createFileStore();
  }

  return storeSingleton;
}

export function getEvidenceObservationIdForMonitoring(evidence: SubmissionEvidence): string {
  return evidenceObservationId(evidence);
}
