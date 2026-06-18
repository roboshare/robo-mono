import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "server-only";
import { isRobomataAgentsEnabled } from "~~/lib/featureFlags";
import {
  type RobomataAgentAction,
  type RobomataAgentActionDraft,
  type RobomataAgentActionStatus,
  type RobomataAgentAppointer,
  type RobomataAgentAppointmentAuthorizationSurface,
  type RobomataAgentEvent,
  type RobomataAgentEventType,
  type RobomataAgentPlannerBoundary,
  type RobomataAgentPolicy,
  type RobomataAgentPolicyStatus,
  type RobomataAgentRun,
  buildAgentActionAuthorization,
  createDefaultAgentPolicy,
  defaultAllowedAgentActionTypes,
  getRobomataAgentActionPermissionDenial,
  normalizeAgentActionTypes,
} from "~~/lib/robomata/agents";
import type { FacilityMonitoringProjection } from "~~/lib/robomata/facilityMonitoring";
import {
  RobomataAgentPermissionDeniedError,
  assertRobomataAgentActionPermission,
} from "~~/lib/robomata/server/agentPermissions";
import { getRobomataPostgresSql } from "~~/lib/robomata/server/postgres";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";

export type UpdateAgentPolicyInput = {
  submission: FacilitySubmission;
  status?: RobomataAgentPolicyStatus;
  allowedActionTypes?: unknown;
  autoApproveActionTypes?: unknown;
  appointedAgentName?: unknown;
  appointedBy?: RobomataAgentAppointer;
  appointerAddress?: string;
  appointmentAuthorizationId?: string;
  appointmentAuthorizationSurface?: RobomataAgentAppointmentAuthorizationSurface;
  revocationAuthorizationSurface?: RobomataAgentPolicy["revocationAuthorizationSurface"];
  revocationReason?: unknown;
  revokedBy?: string;
};

export type RecordAgentRunInput = {
  policy: RobomataAgentPolicy;
  projection: FacilityMonitoringProjection;
  status: RobomataAgentRun["status"];
  startedAt: string;
  completedAt: string;
  summary: string;
  actionDrafts: RobomataAgentActionDraft[];
  plannerBoundary: RobomataAgentPlannerBoundary;
  errorMessage?: string;
  suppressAutoApprove?: boolean;
};

export type UpdateAgentActionInput = {
  actionId: string;
  submissionId: string;
  partnerAddress: string;
  status: Extract<RobomataAgentActionStatus, "approved" | "rejected" | "completed" | "skipped">;
  decisionReason?: string;
};

export type RobomataAgentStore = {
  getPolicy: (submissionId: string, partnerAddress: string) => Promise<RobomataAgentPolicy | null>;
  getOrCreateDefaultPolicy: (submission: FacilitySubmission) => Promise<RobomataAgentPolicy>;
  updatePolicy: (input: UpdateAgentPolicyInput) => Promise<RobomataAgentPolicy>;
  listRuns: (submissionId: string, partnerAddress: string) => Promise<RobomataAgentRun[]>;
  listActions: (submissionId: string, partnerAddress: string) => Promise<RobomataAgentAction[]>;
  listRunnablePolicies: () => Promise<RobomataAgentPolicy[]>;
  recordRun: (input: RecordAgentRunInput) => Promise<{ actions: RobomataAgentAction[]; run: RobomataAgentRun }>;
  updateAction: (input: UpdateAgentActionInput) => Promise<RobomataAgentAction | null>;
};

export class RobomataAgentPolicyRevokedMutationError extends Error {
  constructor(message = "Robomata agent policy has been revoked for this submission.") {
    super(message);
    this.name = "RobomataAgentPolicyRevokedMutationError";
  }
}

type AgentFileStore = {
  policies: RobomataAgentPolicy[];
  runs: RobomataAgentRun[];
  actions: RobomataAgentAction[];
  events: RobomataAgentEvent[];
};

const fileStoreLocks = new Map<string, Promise<void>>();
let ensuredPostgresTables = false;
let storeSingleton: RobomataAgentStore | null = null;

function nowIsoString(): string {
  return new Date().toISOString();
}

function createRunId(): string {
  return `agent_run_${randomUUID()}`;
}

function createActionId(): string {
  return `agent_action_${randomUUID()}`;
}

function createEventId(): string {
  return `agent_event_${randomUUID()}`;
}

function normalizePartnerAddress(value: string): string {
  return value.trim().toLowerCase();
}

function hasPostgresConfig() {
  return Boolean(process.env.POSTGRES_URL);
}

function canUseFileStore() {
  return process.env.NODE_ENV === "development";
}

function requireDurableStoreForEnabledAgents() {
  if (!isRobomataAgentsEnabled()) return;
  if (hasPostgresConfig() || canUseFileStore()) return;

  throw new Error("Robomata agents require POSTGRES_URL outside local development.");
}

function fileStorePath(): string {
  return process.env.ROBOMATA_AGENTS_FILE || path.join(os.tmpdir(), "robomata-agents.json");
}

async function readFileStore(filePath: string): Promise<AgentFileStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) return { policies: [], runs: [], actions: [], events: [] };
    const parsed = JSON.parse(raw) as Partial<AgentFileStore>;
    return {
      policies: parsed.policies ?? [],
      runs: parsed.runs ?? [],
      actions: parsed.actions ?? [],
      events: parsed.events ?? [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { policies: [], runs: [], actions: [], events: [] };
    }
    throw error;
  }
}

async function writeFileStore(filePath: string, fileStore: AgentFileStore) {
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

function findPolicy(
  policies: RobomataAgentPolicy[],
  submissionId: string,
  partnerAddress: string,
): RobomataAgentPolicy | undefined {
  const normalizedPartnerAddress = normalizePartnerAddress(partnerAddress);
  return policies.find(
    policy =>
      policy.submissionId === submissionId &&
      normalizePartnerAddress(policy.partnerAddress) === normalizedPartnerAddress,
  );
}

function createAgentEvent(
  type: RobomataAgentEventType,
  input: {
    policy: RobomataAgentPolicy;
    actionId?: string;
    runId?: string;
    message: string;
    metadata?: RobomataAgentEvent["metadata"];
  },
): RobomataAgentEvent {
  return {
    id: createEventId(),
    type,
    policyId: input.policy.id,
    submissionId: input.policy.submissionId,
    actionId: input.actionId,
    runId: input.runId,
    createdAt: nowIsoString(),
    message: input.message,
    metadata: input.metadata,
  };
}

function buildUpdatedPolicy(input: UpdateAgentPolicyInput, existing?: RobomataAgentPolicy): RobomataAgentPolicy {
  const now = nowIsoString();
  const base = existing ?? createDefaultAgentPolicy(input.submission, now);
  const status = input.status ?? base.status;
  const revocationReason =
    typeof input.revocationReason === "string" && input.revocationReason.trim()
      ? input.revocationReason.trim().slice(0, 240)
      : undefined;
  const appointedAgentName =
    typeof input.appointedAgentName === "string" && input.appointedAgentName.trim()
      ? input.appointedAgentName.trim().slice(0, 80)
      : (base.appointedAgentName ?? "Robomata supervised facility agent");
  const isNewAppointment =
    input.appointedBy !== undefined ||
    input.appointerAddress !== undefined ||
    input.appointmentAuthorizationId !== undefined ||
    input.appointmentAuthorizationSurface !== undefined;
  const allowedActionTypes =
    input.allowedActionTypes === undefined
      ? base.allowedActionTypes
      : normalizeAgentActionTypes(input.allowedActionTypes);
  const autoApproveActionTypes =
    input.autoApproveActionTypes === undefined
      ? base.autoApproveActionTypes
      : normalizeAgentActionTypes(input.autoApproveActionTypes);

  return {
    ...base,
    facilityId: input.submission.facilityMonitoring?.facilityId ?? base.facilityId,
    partnerAddress: input.submission.partnerAddress,
    appointedAgentName,
    appointedBy: input.appointedBy ?? base.appointedBy ?? "operator",
    appointerAddress: input.appointerAddress ?? base.appointerAddress ?? input.submission.partnerAddress,
    appointmentAuthorizationId:
      input.appointmentAuthorizationId ?? base.appointmentAuthorizationId ?? input.submission.partnerAddress,
    appointmentAuthorizationSurface:
      input.appointmentAuthorizationSurface ?? base.appointmentAuthorizationSurface ?? "operator_submission_access",
    appointedAt: isNewAppointment ? now : (base.appointedAt ?? now),
    status,
    allowedActionTypes,
    autoApproveActionTypes: autoApproveActionTypes.filter(type => allowedActionTypes.includes(type)),
    updatedAt: now,
    pausedAt: status === "paused" ? (base.pausedAt ?? now) : undefined,
    revocationAuthorizationSurface:
      status === "revoked" ? (input.revocationAuthorizationSurface ?? base.revocationAuthorizationSurface) : undefined,
    revocationReason: status === "revoked" ? (revocationReason ?? base.revocationReason) : undefined,
    revokedAt: status === "revoked" ? (base.revokedAt ?? now) : undefined,
    revokedBy: status === "revoked" ? (input.revokedBy ?? base.revokedBy) : undefined,
  };
}

function buildRun(input: RecordAgentRunInput): RobomataAgentRun {
  return {
    id: createRunId(),
    policyId: input.policy.id,
    submissionId: input.policy.submissionId,
    facilityId: input.projection.facility.id,
    partnerAddress: input.policy.partnerAddress,
    status: input.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    actionCount: input.actionDrafts.length,
    summary: input.summary,
    plannerBoundary: input.plannerBoundary,
    projectionStatus: input.projection.facility.status,
    freshnessStatus: input.projection.freshnessStatus,
    suiRootStatus: input.projection.suiRootStatus,
    errorMessage: input.errorMessage,
  };
}

function buildActions(input: RecordAgentRunInput, run: RobomataAgentRun): RobomataAgentAction[] {
  const authorization = buildAgentActionAuthorization(input.policy);

  return input.actionDrafts.map(draft => {
    const proposalDenialReason = getRobomataAgentActionPermissionDenial({
      actionType: draft.type,
      operation: "propose",
      policy: input.policy,
    });
    const autoApproveDenialReason = getRobomataAgentActionPermissionDenial({
      actionType: draft.type,
      operation: "auto_approve",
      policy: input.policy,
    });
    const canAutoApprove = !input.suppressAutoApprove && !autoApproveDenialReason;
    const status: RobomataAgentActionStatus = proposalDenialReason
      ? "skipped"
      : canAutoApprove
        ? "approved"
        : "proposed";
    const permissionDenialReason = proposalDenialReason ?? undefined;

    return {
      ...draft,
      authorization,
      decidedAt: status === "skipped" ? input.completedAt : undefined,
      decisionReason: permissionDenialReason,
      metadata: {
        ...draft.metadata,
        plannerMode: input.plannerBoundary.mode,
        plannerProvider: input.plannerBoundary.provider,
        plannerStatus: input.plannerBoundary.status,
        ...(permissionDenialReason ? { permissionDeniedReason: permissionDenialReason } : {}),
        proposalSource: draft.metadata?.proposalSource ?? "deterministic_rules",
      },
      id: createActionId(),
      runId: run.id,
      policyId: input.policy.id,
      submissionId: input.policy.submissionId,
      facilityId: run.facilityId,
      partnerAddress: input.policy.partnerAddress,
      status,
      proposedAt: input.completedAt,
    };
  });
}

function upsertPolicy(policies: RobomataAgentPolicy[], policy: RobomataAgentPolicy): RobomataAgentPolicy[] {
  return [policy, ...policies.filter(candidate => candidate.id !== policy.id)];
}

function shouldBlockActionUnderRevokedPolicy(status: UpdateAgentActionInput["status"]) {
  return status === "approved" || status === "completed";
}

function policyMutationRevokedError() {
  return new RobomataAgentPolicyRevokedMutationError("Revoked agent policies cannot be mutated.");
}

function actionMutationRevokedError() {
  return new RobomataAgentPolicyRevokedMutationError("Revoked agent policies cannot approve or complete actions.");
}

function runRecordRevokedError() {
  return new RobomataAgentPolicyRevokedMutationError(
    "Robomata agent policy was revoked before this run could be recorded.",
  );
}

function actionPermissionDeniedError(reason: string) {
  return new RobomataAgentPermissionDeniedError(reason);
}

function skippedActionMutationError() {
  return actionPermissionDeniedError("Skipped audit actions cannot be changed into executable work.");
}

function actionEventTypeForStatus(status: RobomataAgentActionStatus): RobomataAgentEventType {
  return status === "skipped" ? "action_skipped" : "action_proposed";
}

function authorizationForActionPermission(action: RobomataAgentAction, policy: RobomataAgentPolicy) {
  return action.authorization ?? buildAgentActionAuthorization(policy);
}

function withLegacyActionAuthorization(
  action: RobomataAgentAction,
  policy: RobomataAgentPolicy | undefined,
): RobomataAgentAction {
  if (action.authorization || !policy) return action;

  return {
    ...action,
    authorization: buildAgentActionAuthorization(policy),
    metadata: {
      ...action.metadata,
      authorizationBackfilled: true,
    },
  };
}

async function ensurePostgresTables() {
  if (ensuredPostgresTables) return;

  const sql = getRobomataPostgresSql();
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_agent_policies (
      id text PRIMARY KEY,
      submission_id text NOT NULL,
      facility_id text NOT NULL,
      partner_address text NOT NULL,
      status text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      paused_at timestamptz,
      last_run_at timestamptz
    );
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS robomata_agent_policies_submission_partner_idx
      ON robomata_agent_policies (submission_id, lower(partner_address));
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_agent_policies_status_idx
      ON robomata_agent_policies (status, updated_at DESC);
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_agent_runs (
      id text PRIMARY KEY,
      policy_id text NOT NULL,
      submission_id text NOT NULL,
      facility_id text NOT NULL,
      partner_address text NOT NULL,
      status text NOT NULL,
      payload jsonb NOT NULL,
      started_at timestamptz NOT NULL,
      completed_at timestamptz NOT NULL
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_agent_runs_submission_idx
      ON robomata_agent_runs (submission_id, completed_at DESC);
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_agent_actions (
      id text PRIMARY KEY,
      run_id text NOT NULL,
      policy_id text NOT NULL,
      submission_id text NOT NULL,
      facility_id text NOT NULL,
      partner_address text NOT NULL,
      type text NOT NULL,
      status text NOT NULL,
      severity text NOT NULL,
      payload jsonb NOT NULL,
      proposed_at timestamptz NOT NULL,
      decided_at timestamptz
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_agent_actions_submission_idx
      ON robomata_agent_actions (submission_id, proposed_at DESC);
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_agent_actions_status_idx
      ON robomata_agent_actions (status, proposed_at DESC);
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_agent_events (
      id text PRIMARY KEY,
      policy_id text NOT NULL,
      submission_id text NOT NULL,
      action_id text,
      run_id text,
      type text NOT NULL,
      message text NOT NULL,
      metadata jsonb,
      created_at timestamptz NOT NULL
    );
  `;

  ensuredPostgresTables = true;
}

function createFileStore(): RobomataAgentStore {
  const filePath = fileStorePath();

  return {
    async getPolicy(submissionId, partnerAddress) {
      const fileStore = await readFileStore(filePath);
      return findPolicy(fileStore.policies, submissionId, partnerAddress) ?? null;
    },
    async getOrCreateDefaultPolicy(submission) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const existing = findPolicy(fileStore.policies, submission.id, submission.partnerAddress);
        if (existing) return existing;

        const policy = createDefaultAgentPolicy(submission, nowIsoString());
        fileStore.policies = upsertPolicy(fileStore.policies, policy);
        fileStore.events.unshift(
          createAgentEvent("policy_created", {
            policy,
            message: "Created default paused Robomata agent policy.",
          }),
        );
        await writeFileStore(filePath, fileStore);
        return policy;
      });
    },
    async updatePolicy(input) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const existing = findPolicy(fileStore.policies, input.submission.id, input.submission.partnerAddress);
        if (existing?.status === "revoked") {
          throw policyMutationRevokedError();
        }
        const policy = buildUpdatedPolicy(input, existing);
        fileStore.policies = upsertPolicy(fileStore.policies, policy);
        fileStore.events.unshift(
          createAgentEvent(
            policy.status === "revoked" ? "policy_revoked" : existing ? "policy_updated" : "policy_created",
            {
              policy,
              message: `Robomata agent policy ${existing ? "updated" : "created"}.`,
              metadata: {
                appointedBy: policy.appointedBy ?? null,
                appointmentAuthorizationSurface: policy.appointmentAuthorizationSurface ?? null,
                status: policy.status,
              },
            },
          ),
        );
        await writeFileStore(filePath, fileStore);
        return policy;
      });
    },
    async listRuns(submissionId, partnerAddress) {
      const normalizedPartnerAddress = normalizePartnerAddress(partnerAddress);
      const fileStore = await readFileStore(filePath);
      return fileStore.runs
        .filter(
          run =>
            run.submissionId === submissionId &&
            normalizePartnerAddress(run.partnerAddress) === normalizedPartnerAddress,
        )
        .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
    },
    async listActions(submissionId, partnerAddress) {
      const normalizedPartnerAddress = normalizePartnerAddress(partnerAddress);
      const fileStore = await readFileStore(filePath);
      const policy = findPolicy(fileStore.policies, submissionId, partnerAddress);
      return fileStore.actions
        .filter(
          action =>
            action.submissionId === submissionId &&
            normalizePartnerAddress(action.partnerAddress) === normalizedPartnerAddress,
        )
        .map(action => withLegacyActionAuthorization(action, policy))
        .sort((left, right) => right.proposedAt.localeCompare(left.proposedAt));
    },
    async listRunnablePolicies() {
      const fileStore = await readFileStore(filePath);
      return fileStore.policies.filter(policy => policy.status === "active");
    },
    async recordRun(input) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const currentPolicy = findPolicy(fileStore.policies, input.policy.submissionId, input.policy.partnerAddress);
        if (currentPolicy?.status === "revoked") {
          throw runRecordRevokedError();
        }
        const run = buildRun(input);
        const actions = buildActions(input, run);
        const policy = {
          ...input.policy,
          facilityId: run.facilityId,
          lastRunAt: run.completedAt,
          updatedAt: run.completedAt,
        };
        fileStore.policies = upsertPolicy(fileStore.policies, policy);
        fileStore.runs.unshift(run);
        fileStore.actions.unshift(...actions);
        fileStore.events.unshift(
          createAgentEvent(input.status === "failed" ? "run_failed" : "run_completed", {
            policy,
            runId: run.id,
            message: run.summary,
            metadata: { actionCount: run.actionCount },
          }),
          ...actions.map(action =>
            createAgentEvent(actionEventTypeForStatus(action.status), {
              policy,
              actionId: action.id,
              runId: run.id,
              message: action.title,
              metadata: {
                ...(action.metadata?.permissionDeniedReason
                  ? { permissionDeniedReason: action.metadata.permissionDeniedReason }
                  : {}),
                severity: action.severity,
                status: action.status,
                type: action.type,
              },
            }),
          ),
        );
        await writeFileStore(filePath, fileStore);
        return { actions, run };
      });
    },
    async updateAction(input) {
      return withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        const normalizedPartnerAddress = normalizePartnerAddress(input.partnerAddress);
        const actionIndex = fileStore.actions.findIndex(
          action =>
            action.id === input.actionId &&
            action.submissionId === input.submissionId &&
            normalizePartnerAddress(action.partnerAddress) === normalizedPartnerAddress,
        );
        if (actionIndex < 0) return null;
        const policy = fileStore.policies.find(policy => policy.id === fileStore.actions[actionIndex]?.policyId);
        if (fileStore.actions[actionIndex]?.status === "skipped" && input.status !== "skipped") {
          throw skippedActionMutationError();
        }
        if (policy?.status === "revoked" && shouldBlockActionUnderRevokedPolicy(input.status)) {
          throw actionMutationRevokedError();
        }
        if (policy && shouldBlockActionUnderRevokedPolicy(input.status)) {
          assertRobomataAgentActionPermission({
            actionAuthorization: authorizationForActionPermission(fileStore.actions[actionIndex], policy),
            actionType: fileStore.actions[actionIndex].type,
            operation: input.status === "approved" ? "approve" : "complete",
            policy,
          });
        }
        const updatedAction: RobomataAgentAction = {
          ...withLegacyActionAuthorization(fileStore.actions[actionIndex], policy),
          status: input.status,
          decidedAt: nowIsoString(),
          decisionReason: input.decisionReason?.trim() || undefined,
        };
        fileStore.actions[actionIndex] = updatedAction;
        if (policy) {
          fileStore.events.unshift(
            createAgentEvent(`action_${input.status}` as RobomataAgentEventType, {
              policy,
              actionId: updatedAction.id,
              runId: updatedAction.runId,
              message: `Agent action ${input.status}.`,
              metadata: { type: updatedAction.type },
            }),
          );
        }
        await writeFileStore(filePath, fileStore);
        return updatedAction;
      });
    },
  };
}

function createPostgresStore(): RobomataAgentStore {
  const sql = getRobomataPostgresSql();

  return {
    async getPolicy(submissionId, partnerAddress) {
      await ensurePostgresTables();
      const rows = (await sql`
        SELECT payload
        FROM robomata_agent_policies
        WHERE submission_id = ${submissionId} AND lower(partner_address) = ${normalizePartnerAddress(partnerAddress)}
        LIMIT 1;
      `) as Array<{ payload: RobomataAgentPolicy }>;
      return rows[0]?.payload ?? null;
    },
    async getOrCreateDefaultPolicy(submission) {
      await ensurePostgresTables();
      const existing = await this.getPolicy(submission.id, submission.partnerAddress);
      if (existing) return existing;
      return this.updatePolicy({
        submission,
        allowedActionTypes: defaultAllowedAgentActionTypes(),
        autoApproveActionTypes: [],
        status: "paused",
      });
    },
    async updatePolicy(input) {
      await ensurePostgresTables();
      return sql.begin(async tx => {
        await tx`
          SELECT pg_advisory_xact_lock(
            hashtext(${`${input.submission.id}:${normalizePartnerAddress(input.submission.partnerAddress)}`})
          );
        `;
        const existingRows = (await tx`
          SELECT payload
          FROM robomata_agent_policies
          WHERE
            submission_id = ${input.submission.id}
            AND lower(partner_address) = ${normalizePartnerAddress(input.submission.partnerAddress)}
          LIMIT 1
          FOR UPDATE;
        `) as Array<{ payload: RobomataAgentPolicy }>;
        const existing = existingRows[0]?.payload;
        if (existing?.status === "revoked") {
          throw policyMutationRevokedError();
        }
        const policy = buildUpdatedPolicy(input, existing ?? undefined);
        await tx`
          INSERT INTO robomata_agent_policies (
            id, submission_id, facility_id, partner_address, status, payload, created_at, updated_at, paused_at, last_run_at
          )
          VALUES (
            ${policy.id},
            ${policy.submissionId},
            ${policy.facilityId},
            ${policy.partnerAddress},
            ${policy.status},
            ${JSON.stringify(policy)}::jsonb,
            ${policy.createdAt}::timestamptz,
            ${policy.updatedAt}::timestamptz,
            ${policy.pausedAt ?? null}::timestamptz,
            ${policy.lastRunAt ?? null}::timestamptz
          )
          ON CONFLICT (id) DO UPDATE
          SET
            facility_id = EXCLUDED.facility_id,
            partner_address = EXCLUDED.partner_address,
            status = EXCLUDED.status,
            payload = EXCLUDED.payload,
            updated_at = EXCLUDED.updated_at,
            paused_at = EXCLUDED.paused_at,
            last_run_at = EXCLUDED.last_run_at;
        `;
        await tx`
          INSERT INTO robomata_agent_events (id, policy_id, submission_id, type, message, metadata, created_at)
          VALUES (
            ${createEventId()},
            ${policy.id},
            ${policy.submissionId},
            ${policy.status === "revoked" ? "policy_revoked" : existing ? "policy_updated" : "policy_created"},
            ${policy.status === "revoked" ? "Robomata agent policy revoked." : `Robomata agent policy ${existing ? "updated" : "created"}.`},
            ${JSON.stringify({
              appointedBy: policy.appointedBy ?? null,
              appointmentAuthorizationSurface: policy.appointmentAuthorizationSurface ?? null,
              status: policy.status,
            })}::jsonb,
            ${nowIsoString()}::timestamptz
          );
        `;
        return policy;
      });
    },
    async listRuns(submissionId, partnerAddress) {
      await ensurePostgresTables();
      const rows = (await sql`
        SELECT payload
        FROM robomata_agent_runs
        WHERE submission_id = ${submissionId} AND lower(partner_address) = ${normalizePartnerAddress(partnerAddress)}
        ORDER BY completed_at DESC;
      `) as Array<{ payload: RobomataAgentRun }>;
      return rows.map(row => row.payload);
    },
    async listActions(submissionId, partnerAddress) {
      await ensurePostgresTables();
      const rows = (await sql`
        SELECT payload
        FROM robomata_agent_actions
        WHERE submission_id = ${submissionId} AND lower(partner_address) = ${normalizePartnerAddress(partnerAddress)}
        ORDER BY proposed_at DESC;
      `) as Array<{ payload: RobomataAgentAction }>;
      const policy = await this.getPolicy(submissionId, partnerAddress);
      return rows.map(row => withLegacyActionAuthorization(row.payload, policy ?? undefined));
    },
    async listRunnablePolicies() {
      await ensurePostgresTables();
      const rows = (await sql`
        SELECT payload
        FROM robomata_agent_policies
        WHERE status = 'active'
        ORDER BY updated_at DESC;
      `) as Array<{ payload: RobomataAgentPolicy }>;
      return rows.map(row => row.payload);
    },
    async recordRun(input) {
      await ensurePostgresTables();
      return sql.begin(async tx => {
        const currentPolicyRows = (await tx`
          SELECT payload
          FROM robomata_agent_policies
          WHERE id = ${input.policy.id}
          LIMIT 1
          FOR UPDATE;
        `) as Array<{ payload: RobomataAgentPolicy }>;
        const currentPolicy = currentPolicyRows[0]?.payload;
        if (currentPolicy?.status === "revoked") {
          throw runRecordRevokedError();
        }
        const run = buildRun(input);
        const actions = buildActions(input, run);
        const policy = {
          ...input.policy,
          facilityId: run.facilityId,
          lastRunAt: run.completedAt,
          updatedAt: run.completedAt,
        };
        const updatedPolicyRows = (await tx`
          UPDATE robomata_agent_policies
          SET
            facility_id = ${policy.facilityId},
            payload = ${JSON.stringify(policy)}::jsonb,
            updated_at = ${policy.updatedAt}::timestamptz,
            last_run_at = ${policy.lastRunAt}::timestamptz
          WHERE id = ${policy.id} AND status <> 'revoked'
          RETURNING id;
        `) as Array<{ id: string }>;
        if (!updatedPolicyRows.length) {
          throw runRecordRevokedError();
        }
        await tx`
          INSERT INTO robomata_agent_runs (
            id, policy_id, submission_id, facility_id, partner_address, status, payload, started_at, completed_at
          )
          VALUES (
            ${run.id},
            ${run.policyId},
            ${run.submissionId},
            ${run.facilityId},
            ${run.partnerAddress},
            ${run.status},
            ${JSON.stringify(run)}::jsonb,
            ${run.startedAt}::timestamptz,
            ${run.completedAt}::timestamptz
          );
        `;
        for (const action of actions) {
          await tx`
            INSERT INTO robomata_agent_actions (
              id, run_id, policy_id, submission_id, facility_id, partner_address, type, status, severity, payload, proposed_at, decided_at
            )
            VALUES (
              ${action.id},
              ${action.runId},
              ${action.policyId},
              ${action.submissionId},
              ${action.facilityId},
              ${action.partnerAddress},
              ${action.type},
              ${action.status},
              ${action.severity},
              ${JSON.stringify(action)}::jsonb,
              ${action.proposedAt}::timestamptz,
              ${action.decidedAt ?? null}::timestamptz
            );
          `;
        }
        await tx`
          INSERT INTO robomata_agent_events (id, policy_id, submission_id, run_id, type, message, metadata, created_at)
          VALUES (
            ${createEventId()},
            ${policy.id},
            ${policy.submissionId},
            ${run.id},
            ${input.status === "failed" ? "run_failed" : "run_completed"},
            ${run.summary},
            ${JSON.stringify({ actionCount: run.actionCount })}::jsonb,
            ${nowIsoString()}::timestamptz
          );
        `;
        for (const action of actions) {
          await tx`
            INSERT INTO robomata_agent_events (
              id, policy_id, submission_id, action_id, run_id, type, message, metadata, created_at
            )
            VALUES (
              ${createEventId()},
              ${policy.id},
              ${policy.submissionId},
              ${action.id},
              ${run.id},
              ${actionEventTypeForStatus(action.status)},
              ${action.title},
              ${JSON.stringify({
                ...(action.metadata?.permissionDeniedReason
                  ? { permissionDeniedReason: action.metadata.permissionDeniedReason }
                  : {}),
                severity: action.severity,
                status: action.status,
                type: action.type,
              })}::jsonb,
              ${nowIsoString()}::timestamptz
            );
          `;
        }
        return { actions, run };
      });
    },
    async updateAction(input) {
      await ensurePostgresTables();
      return sql.begin(async tx => {
        const rows = (await tx`
          SELECT payload
          FROM robomata_agent_actions
          WHERE
            id = ${input.actionId}
            AND submission_id = ${input.submissionId}
            AND lower(partner_address) = ${normalizePartnerAddress(input.partnerAddress)}
          LIMIT 1
          FOR UPDATE;
        `) as Array<{ payload: RobomataAgentAction }>;
        const current = rows[0]?.payload;
        if (!current) return null;
        let currentPolicy: RobomataAgentPolicy | undefined;
        if (current.status === "skipped" && input.status !== "skipped") {
          throw skippedActionMutationError();
        }
        if (shouldBlockActionUnderRevokedPolicy(input.status)) {
          const policyRows = (await tx`
            SELECT payload
            FROM robomata_agent_policies
            WHERE id = ${current.policyId}
            LIMIT 1
            FOR UPDATE;
          `) as Array<{ payload: RobomataAgentPolicy }>;
          if (policyRows[0]?.payload.status === "revoked") {
            throw actionMutationRevokedError();
          }
          const policy = policyRows[0]?.payload;
          if (!policy) {
            throw actionPermissionDeniedError("Current agent appointment could not be loaded for this action.");
          }
          currentPolicy = policy;
          assertRobomataAgentActionPermission({
            actionAuthorization: authorizationForActionPermission(current, policy),
            actionType: current.type,
            operation: input.status === "approved" ? "approve" : "complete",
            policy,
          });
        }
        const decidedAt = nowIsoString();
        const policyRows = current.authorization
          ? []
          : currentPolicy
            ? [{ payload: currentPolicy }]
            : ((await tx`
                SELECT payload
                FROM robomata_agent_policies
                WHERE id = ${current.policyId}
                LIMIT 1;
              `) as Array<{ payload: RobomataAgentPolicy }>);
        const hydratedCurrent = withLegacyActionAuthorization(current, policyRows[0]?.payload);
        const updatedAction: RobomataAgentAction = {
          ...hydratedCurrent,
          status: input.status,
          decidedAt,
          decisionReason: input.decisionReason?.trim() || undefined,
        };
        await tx`
          UPDATE robomata_agent_actions
          SET
            status = ${updatedAction.status},
            payload = ${JSON.stringify(updatedAction)}::jsonb,
            decided_at = ${decidedAt}::timestamptz
          WHERE id = ${input.actionId};
        `;
        await tx`
          INSERT INTO robomata_agent_events (
            id, policy_id, submission_id, action_id, run_id, type, message, metadata, created_at
          )
          VALUES (
            ${createEventId()},
            ${updatedAction.policyId},
            ${updatedAction.submissionId},
            ${updatedAction.id},
            ${updatedAction.runId},
            ${`action_${input.status}`},
            ${`Agent action ${input.status}.`},
            ${JSON.stringify({ type: updatedAction.type })}::jsonb,
            ${nowIsoString()}::timestamptz
          );
        `;
        return updatedAction;
      });
    },
  };
}

export function getRobomataAgentStore(): RobomataAgentStore {
  if (!storeSingleton) {
    requireDurableStoreForEnabledAgents();
    storeSingleton = hasPostgresConfig() ? createPostgresStore() : createFileStore();
  }

  return storeSingleton;
}
