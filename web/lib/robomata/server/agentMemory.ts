import { createHash } from "node:crypto";
import "server-only";
import { isRobomataAgentMemoryEnabled } from "~~/lib/featureFlags";
import type { RobomataAgentAction, RobomataAgentPolicy, RobomataAgentRun } from "~~/lib/robomata/agents";
import type { FacilityMonitoringProjection } from "~~/lib/robomata/facilityMonitoring";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";

export type RobomataAgentMemoryStatus =
  | "disabled"
  | "configured_without_account"
  | "configured_without_delegate_key"
  | "recall_failed"
  | "recall_succeeded"
  | "remember_failed"
  | "remember_submitted"
  | "sdk_unavailable";

export type RobomataAgentMemoryContext = {
  digests: string[];
  memories: Array<{
    blobId?: string;
    distance?: number;
    digest: string;
    text: string;
  }>;
  namespace?: string;
  provider: "memwal";
  queryDigest?: string;
  recalledCount: number;
  status: RobomataAgentMemoryStatus;
};

export type RobomataAgentMemoryWriteResult = {
  jobId?: string;
  namespace?: string;
  provider: "memwal";
  status: RobomataAgentMemoryStatus;
};

type MemWalClient = {
  recall?: (params: { limit?: number; namespace?: string; query: string }) => Promise<{
    results?: Array<{ blob_id?: unknown; blobId?: unknown; distance?: unknown; text?: unknown }>;
  }>;
  remember?: (text: string, namespace?: string) => Promise<{ job_id?: unknown; jobId?: unknown; status?: unknown }>;
};

type MemWalModule = {
  MemWal?: {
    create?: (config: { accountId: string; key: string; namespace?: string; serverUrl?: string }) => MemWalClient;
  };
};

const agentMemoryEnabledEnv = "ROBOMATA_AGENT_MEMORY_ENABLED";
const memWalAccountIdEnv = "MEMWAL_ACCOUNT_ID";
const memWalDelegateKeyEnv = "MEMWAL_DELEGATE_KEY";
const memWalServerUrlEnv = "MEMWAL_SERVER_URL";
const memoryTextLimit = 420;
const recallLimit = 5;

function digest(value: string): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function boundedText(value: string, limit = memoryTextLimit): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function memoryNamespace(submission: Pick<FacilitySubmission, "facilityMonitoring" | "id">): string {
  const configured = process.env.ROBOMATA_MEMWAL_NAMESPACE?.trim();
  if (configured) return configured;

  const prefix = process.env.ROBOMATA_MEMWAL_NAMESPACE_PREFIX?.trim() || "robomata-agent";
  const facilityId = submission.facilityMonitoring?.facilityId ?? submission.id;
  return `${prefix}:${facilityId}`;
}

function configuredAccountId(): string | undefined {
  return process.env[memWalAccountIdEnv]?.trim() || process.env.ROBOMATA_MEMWAL_ACCOUNT_ID?.trim() || undefined;
}

function configuredDelegateKey(): string | undefined {
  return process.env[memWalDelegateKeyEnv]?.trim() || process.env.ROBOMATA_MEMWAL_DELEGATE_KEY?.trim() || undefined;
}

function configuredServerUrl(): string | undefined {
  return process.env[memWalServerUrlEnv]?.trim() || process.env.ROBOMATA_MEMWAL_SERVER_URL?.trim() || undefined;
}

async function importMemWal(): Promise<MemWalModule | null> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<MemWalModule>;
    return await dynamicImport("@mysten-incubation/memwal");
  } catch {
    return null;
  }
}

async function createMemWalClient(namespace: string): Promise<{
  client?: MemWalClient;
  status?: RobomataAgentMemoryStatus;
}> {
  void agentMemoryEnabledEnv;
  if (!isRobomataAgentMemoryEnabled()) return { status: "disabled" };

  const accountId = configuredAccountId();
  if (!accountId) return { status: "configured_without_account" };

  const key = configuredDelegateKey();
  if (!key) return { status: "configured_without_delegate_key" };

  const memWalModule = await importMemWal();
  const client = memWalModule?.MemWal?.create?.({
    accountId,
    key,
    namespace,
    serverUrl: configuredServerUrl(),
  });
  if (!client) return { status: "sdk_unavailable" };

  return { client };
}

function recallQuery(input: {
  policy: RobomataAgentPolicy;
  projection: FacilityMonitoringProjection;
  submission: FacilitySubmission;
}): string {
  return boundedText(
    [
      "Recall prior Robomata supervised agent memory for this facility.",
      `submission=${input.submission.id}`,
      `facility=${input.projection.facility.id}`,
      `policy=${input.policy.id}`,
      `facilityStatus=${input.projection.facility.status}`,
      `packetFreshness=${input.projection.freshnessStatus}`,
      `suiRootStatus=${input.projection.suiRootStatus}`,
      `tokenizationStatus=${input.submission.tokenization.status}`,
    ].join(" "),
    700,
  );
}

export async function recallRobomataAgentMemory(input: {
  policy: RobomataAgentPolicy;
  projection: FacilityMonitoringProjection;
  submission: FacilitySubmission;
}): Promise<RobomataAgentMemoryContext> {
  const namespace = memoryNamespace(input.submission);
  const { client, status } = await createMemWalClient(namespace);
  if (!client?.recall) {
    return {
      digests: [],
      memories: [],
      namespace,
      provider: "memwal",
      recalledCount: 0,
      status: status ?? "sdk_unavailable",
    };
  }

  const query = recallQuery(input);
  try {
    const result = await client.recall({ limit: recallLimit, namespace, query });
    const memories = (result.results ?? [])
      .map(memory => {
        const text = typeof memory.text === "string" ? boundedText(memory.text) : "";
        if (!text) return null;
        return {
          blobId:
            typeof memory.blob_id === "string"
              ? memory.blob_id
              : typeof memory.blobId === "string"
                ? memory.blobId
                : undefined,
          distance: typeof memory.distance === "number" ? memory.distance : undefined,
          digest: digest(text),
          text,
        };
      })
      .filter((memory): memory is NonNullable<typeof memory> => Boolean(memory));

    return {
      digests: memories.map(memory => memory.digest),
      memories,
      namespace,
      provider: "memwal",
      queryDigest: digest(query),
      recalledCount: memories.length,
      status: "recall_succeeded",
    };
  } catch {
    return {
      digests: [],
      memories: [],
      namespace,
      provider: "memwal",
      queryDigest: digest(query),
      recalledCount: 0,
      status: "recall_failed",
    };
  }
}

function memoryTextForRun(input: {
  actions: RobomataAgentAction[];
  projection: FacilityMonitoringProjection;
  run: RobomataAgentRun;
  submission: FacilitySubmission;
}): string {
  const actionSummary = input.actions.length
    ? input.actions.map(action => `${action.type}:${action.status}:${action.severity}`).join(", ")
    : "none";

  return boundedText(
    [
      "Robomata supervised agent run memory.",
      `submission=${input.submission.id}`,
      `facility=${input.run.facilityId}`,
      `run=${input.run.id}`,
      `completedAt=${input.run.completedAt}`,
      `summary=${input.run.summary}`,
      `facilityStatus=${input.projection.facility.status}`,
      `packetFreshness=${input.projection.freshnessStatus}`,
      `suiRootStatus=${input.projection.suiRootStatus}`,
      `tokenizationStatus=${input.submission.tokenization.status}`,
      `actions=${actionSummary}`,
      `plannerProvider=${input.run.plannerBoundary?.provider ?? "unknown"}`,
      `plannerStatus=${input.run.plannerBoundary?.status ?? "unknown"}`,
      `sourceDataDigest=${input.run.plannerBoundary?.sourceDataDigest ?? "none"}`,
    ].join(" "),
    1_200,
  );
}

export async function rememberRobomataAgentRunMemory(input: {
  actions: RobomataAgentAction[];
  projection: FacilityMonitoringProjection;
  run: RobomataAgentRun;
  submission: FacilitySubmission;
}): Promise<RobomataAgentMemoryWriteResult> {
  const namespace = memoryNamespace(input.submission);
  const { client, status } = await createMemWalClient(namespace);
  if (!client?.remember) return { namespace, provider: "memwal", status: status ?? "sdk_unavailable" };

  try {
    const result = await client.remember(memoryTextForRun(input), namespace);
    return {
      jobId:
        typeof result.job_id === "string" ? result.job_id : typeof result.jobId === "string" ? result.jobId : undefined,
      namespace,
      provider: "memwal",
      status: "remember_submitted",
    };
  } catch {
    return { namespace, provider: "memwal", status: "remember_failed" };
  }
}
