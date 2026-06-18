import { createHash } from "node:crypto";
import "server-only";
import { isRobomataAgentPlannerEnabled } from "~~/lib/featureFlags";
import type {
  RobomataAgentAction,
  RobomataAgentActionDraft,
  RobomataAgentActionType,
  RobomataAgentPlannerBoundary,
  RobomataAgentPlannerInputControls,
  RobomataAgentPlannerMode,
  RobomataAgentPlannerProvider,
  RobomataAgentPlannerStatus,
  RobomataAgentPolicy,
} from "~~/lib/robomata/agents";
import { ROBOMATA_AGENT_ACTION_TYPES } from "~~/lib/robomata/agents";
import type { FacilityMonitoringProjection } from "~~/lib/robomata/facilityMonitoring";
import type { RobomataFacilityPolicyArtifact } from "~~/lib/robomata/policyRules";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";

export const ROBOMATA_AGENT_PLANNER_PROMPT_VERSION = "agent-supervision-planner-v1";
export const ROBOMATA_AGENT_PLANNER_OUTPUT_SCHEMA_VERSION = "agent-supervision-plan-output-v1";
export const ROBOMATA_AGENT_PLANNER_MAX_CANDIDATE_ACTIONS = 8;
export const ROBOMATA_AGENT_PLANNER_MAX_RECENT_ACTIONS = 12;
export const ROBOMATA_AGENT_PLANNER_MAX_RECENT_RUNS = 5;
export const ROBOMATA_AGENT_PLANNER_MAX_TEXT_LENGTH = 260;

const supportedPlannerProviders: RobomataAgentPlannerProvider[] = ["rules", "openai", "anthropic", "google"];
const openAiPlannerTimeoutMs = 8_000;

const providerKeyEnv: Record<Exclude<RobomataAgentPlannerProvider, "rules">, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openai: "OPENAI_API_KEY",
};

function normalizePlannerProvider(value: string | undefined): RobomataAgentPlannerProvider {
  if (supportedPlannerProviders.includes(value as RobomataAgentPlannerProvider)) {
    return value as RobomataAgentPlannerProvider;
  }
  return "rules";
}

function boundary(
  provider: RobomataAgentPlannerProvider,
  status: RobomataAgentPlannerStatus,
  mode: RobomataAgentPlannerMode,
  model?: string,
): RobomataAgentPlannerBoundary {
  return {
    provider,
    status,
    mode,
    model,
    sourceOfTruth: "agent_policy_rules",
    version: "agent-supervision-v1",
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return `0x${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

const openAiPlannerSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: {
            type: "string",
            enum: ROBOMATA_AGENT_ACTION_TYPES,
            description: "Must match one supplied deterministic candidate action type.",
          },
          title: {
            type: "string",
            description: "Operator-facing action title.",
          },
          message: {
            type: "string",
            description: "Operator-facing action explanation.",
          },
          reason: {
            type: "string",
            description: "Why the supervised agent proposed this action.",
          },
        },
        required: ["type", "title", "message", "reason"],
      },
    },
  },
  required: ["actions"],
} as const;

type OpenAiPlannerActionPayload = {
  message?: unknown;
  reason?: unknown;
  title?: unknown;
  type?: unknown;
};

type OpenAiPlannerPayload = {
  actions?: OpenAiPlannerActionPayload[];
};

class OpenAiPlannerSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAiPlannerSchemaError";
  }
}

type OpenAiResponseOutputContent = {
  text?: string;
};

type OpenAiResponseOutputItem = {
  content?: OpenAiResponseOutputContent[];
};

type OpenAiResponseBody = {
  error?: {
    message?: string;
  };
  output?: OpenAiResponseOutputItem[];
  output_text?: string;
};

type PlanAgentActionsInput = {
  candidateActions: RobomataAgentActionDraft[];
  policyArtifact: RobomataFacilityPolicyArtifact;
  policy: RobomataAgentPolicy;
  projection: FacilityMonitoringProjection;
  recentActions: RobomataAgentAction[];
  recentRuns: Array<{
    actionCount: number;
    completedAt: string;
    freshnessStatus: string;
    id: string;
    plannerBoundary?: RobomataAgentPlannerBoundary;
    status: string;
    suiRootStatus: string;
    summary: string;
  }>;
  submission: FacilitySubmission;
};

type PlanAgentActionsResult = {
  actions: RobomataAgentActionDraft[];
  plannerBoundary: RobomataAgentPlannerBoundary;
};

type PlannerProviderInput = ReturnType<typeof buildPlannerProviderInput>;

function plannerInputControls(generatedAt: string): RobomataAgentPlannerInputControls {
  return {
    allowedFields: [
      "policy artifact id, name, and version",
      "policy appointment metadata and allowed action types",
      "facility projection status, freshness status, Sui root status, and observation status counts",
      "latest run and packet ids/statuses",
      "deterministic candidate action type, severity, title, message, reason, and policy metadata",
      "recent agent run summaries and statuses",
      "recent retained action statuses and planner provenance",
      "allowed supervised action/tool surface",
    ],
    excludedMaterial: [
      "raw evidence bodies",
      "raw provider payloads",
      "API keys and secret env names",
      "Sui private keys",
      "Seal plaintext or ciphertext",
      "Walrus ciphertext",
      "share-link tokens",
      "wallet signatures",
      "unbounded prompts or model responses",
    ],
    generatedAt,
    maxCandidateActions: ROBOMATA_AGENT_PLANNER_MAX_CANDIDATE_ACTIONS,
    maxRecentActions: ROBOMATA_AGENT_PLANNER_MAX_RECENT_ACTIONS,
    maxRecentRuns: ROBOMATA_AGENT_PLANNER_MAX_RECENT_RUNS,
    maxTextLength: ROBOMATA_AGENT_PLANNER_MAX_TEXT_LENGTH,
    rawEvidenceIncluded: false,
    secretMaterialIncluded: false,
  };
}

function boundedText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, maxLength);
}

function compactText(value: string | undefined, fallback = "n/a"): string {
  return boundedText(value, fallback, ROBOMATA_AGENT_PLANNER_MAX_TEXT_LENGTH);
}

function statusCounts(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, status) => {
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
}

function buildAllowedToolSurface(policy: RobomataAgentPolicy) {
  return ROBOMATA_AGENT_ACTION_TYPES.map(type => ({
    approvalRequired: !policy.autoApproveActionTypes.includes(type),
    autoApproved: policy.autoApproveActionTypes.includes(type),
    executionBoundary:
      type === "evidence_review" || type === "sui_root_review" ? "audit_only_adapter_flagged" : "proposal_only",
    type,
    withinAppointment: policy.allowedActionTypes.includes(type),
  }));
}

function buildPlannerProviderInput(input: PlanAgentActionsInput, generatedAt: string) {
  return {
    allowedToolSurface: buildAllowedToolSurface(input.policy),
    candidateActions: input.candidateActions.slice(0, ROBOMATA_AGENT_PLANNER_MAX_CANDIDATE_ACTIONS).map(action => ({
      message: compactText(action.message),
      policyArtifactId: action.metadata?.policyArtifactId ?? input.policyArtifact.id,
      policyArtifactVersion: action.metadata?.policyArtifactVersion ?? input.policyArtifact.version,
      policyRuleId: action.metadata?.policyRuleId ?? action.type,
      policyRuleLabel: action.metadata?.policyRuleLabel ?? action.title,
      policyRuleSummary: action.metadata?.policyRuleSummary ?? action.reason,
      reason: compactText(action.reason),
      severity: action.severity,
      title: compactText(action.title),
      type: action.type,
    })),
    facilityProjection: {
      facilityId: input.projection.facility.id,
      facilityStatus: input.projection.facility.status,
      freshnessStatus: input.projection.freshnessStatus,
      latestPacketId: input.projection.latestPacket?.id ?? null,
      latestRunId: input.projection.latestRun?.id ?? null,
      observationCount: input.projection.observations.length,
      observationStatuses: statusCounts(input.projection.observations.map(observation => observation.status)),
      suiRootStatus: input.projection.suiRootStatus,
    },
    generatedAt,
    policyAppointment: {
      allowedActionTypes: input.policy.allowedActionTypes,
      appointedAgentName: compactText(input.policy.appointedAgentName, "Robomata supervised facility agent"),
      appointedBy: input.policy.appointedBy ?? null,
      appointmentAuthorizationSurface: input.policy.appointmentAuthorizationSurface ?? null,
      autoApproveActionTypes: input.policy.autoApproveActionTypes,
      policyId: input.policy.id,
      status: input.policy.status,
    },
    policyArtifact: {
      id: input.policyArtifact.id,
      name: input.policyArtifact.name,
      version: input.policyArtifact.version,
    },
    recentActionHistory: input.recentActions.slice(0, ROBOMATA_AGENT_PLANNER_MAX_RECENT_ACTIONS).map(action => ({
      id: action.id,
      plannerProvider: action.metadata?.plannerProvider ?? null,
      proposalSource: action.metadata?.proposalSource ?? "deterministic_rules",
      proposedAt: action.proposedAt,
      severity: action.severity,
      status: action.status,
      title: compactText(action.title),
      type: action.type,
    })),
    recentRunHistory: input.recentRuns.slice(0, ROBOMATA_AGENT_PLANNER_MAX_RECENT_RUNS).map(run => ({
      actionCount: run.actionCount,
      completedAt: run.completedAt,
      freshnessStatus: run.freshnessStatus,
      id: run.id,
      plannerMode: run.plannerBoundary?.mode ?? "deterministic_rules",
      plannerProvider: run.plannerBoundary?.provider ?? "rules",
      status: run.status,
      suiRootStatus: run.suiRootStatus,
      summary: compactText(run.summary),
    })),
    submission: {
      evidenceCount: input.submission.evidence.length,
      receivableCount: input.submission.receivables.length,
      submissionId: input.submission.id,
      tokenizationStatus: input.submission.tokenization.status,
    },
  };
}

function sourceDataDigestSource(input: PlanAgentActionsInput) {
  return {
    candidateActions: input.candidateActions.map(action => ({
      metadata: action.metadata ?? null,
      message: action.message,
      reason: action.reason,
      severity: action.severity,
      title: action.title,
      type: action.type,
    })),
    facilityProjection: {
      facilityId: input.projection.facility.id,
      freshnessStatus: input.projection.freshnessStatus,
      latestPacketId: input.projection.latestPacket?.id ?? null,
      latestRunId: input.projection.latestRun?.id ?? null,
      observationIds: input.projection.observations.map(observation => observation.id).sort(),
      observationStatuses: statusCounts(input.projection.observations.map(observation => observation.status)),
      status: input.projection.facility.status,
      suiRootStatus: input.projection.suiRootStatus,
    },
    policy: {
      allowedActionTypes: input.policy.allowedActionTypes,
      appointedBy: input.policy.appointedBy ?? null,
      autoApproveActionTypes: input.policy.autoApproveActionTypes,
      id: input.policy.id,
      status: input.policy.status,
    },
    policyArtifact: {
      id: input.policyArtifact.id,
      version: input.policyArtifact.version,
    },
    recentActionHistory: input.recentActions.slice(0, ROBOMATA_AGENT_PLANNER_MAX_RECENT_ACTIONS).map(action => ({
      decidedAt: action.decidedAt ?? null,
      executionStatus: action.metadata?.executionStatus ?? null,
      id: action.id,
      plannerProvider: action.metadata?.plannerProvider ?? null,
      proposalSource: action.metadata?.proposalSource ?? "deterministic_rules",
      proposedAt: action.proposedAt,
      severity: action.severity,
      status: action.status,
      type: action.type,
    })),
    recentRunHistory: input.recentRuns.slice(0, ROBOMATA_AGENT_PLANNER_MAX_RECENT_RUNS).map(run => ({
      actionCount: run.actionCount,
      completedAt: run.completedAt,
      freshnessStatus: run.freshnessStatus,
      id: run.id,
      plannerMode: run.plannerBoundary?.mode ?? null,
      plannerProvider: run.plannerBoundary?.provider ?? null,
      status: run.status,
      suiRootStatus: run.suiRootStatus,
    })),
    submissionId: input.submission.id,
  };
}

function plannerOutputDigestSource(actions: RobomataAgentActionDraft[]) {
  return {
    actions: actions.map(action => ({
      message: action.message,
      proposalSource: action.metadata?.proposalSource ?? "deterministic_rules",
      reason: action.reason,
      severity: action.severity,
      title: action.title,
      type: action.type,
    })),
    outputSchemaVersion: ROBOMATA_AGENT_PLANNER_OUTPUT_SCHEMA_VERSION,
  };
}

function withPlannerProvenance(input: {
  actions: RobomataAgentActionDraft[];
  baseBoundary: RobomataAgentPlannerBoundary;
  controls: RobomataAgentPlannerInputControls;
  generatedAt: string;
  providerInput: PlannerProviderInput;
  sourceDataDigest: string;
}): PlanAgentActionsResult {
  const plannerInputDigest = digest(input.providerInput);
  const plannerOutputDigest = digest(plannerOutputDigestSource(input.actions));
  const plannerBoundary: RobomataAgentPlannerBoundary = {
    ...input.baseBoundary,
    allowedToolCount: input.providerInput.allowedToolSurface.length,
    candidateActionCount: input.providerInput.candidateActions.length,
    generatedAt: input.generatedAt,
    inputControls: input.controls,
    outputSchemaVersion: ROBOMATA_AGENT_PLANNER_OUTPUT_SCHEMA_VERSION,
    plannerInputDigest,
    plannerOutputDigest,
    promptVersion: ROBOMATA_AGENT_PLANNER_PROMPT_VERSION,
    recentActionCount: input.providerInput.recentActionHistory.length,
    recentRunCount: input.providerInput.recentRunHistory.length,
    sourceDataDigest: input.sourceDataDigest,
  };

  return {
    actions: input.actions.map(action => ({
      ...action,
      metadata: {
        ...action.metadata,
        plannerInputDigest,
        plannerOutputDigest,
        plannerPromptVersion: ROBOMATA_AGENT_PLANNER_PROMPT_VERSION,
        plannerSourceDataDigest: input.sourceDataDigest,
      },
    })),
    plannerBoundary,
  };
}

function outputTextFromOpenAiResponse(body: OpenAiResponseBody): string | undefined {
  if (body.output_text?.trim()) return body.output_text;

  return body.output
    ?.flatMap(item => item.content ?? [])
    .map(content => content.text)
    .find((text): text is string => Boolean(text?.trim()));
}

function parseOpenAiPlannerPayload(text: string, candidateActions: RobomataAgentActionDraft[]): OpenAiPlannerPayload {
  const parsed = JSON.parse(text) as Partial<OpenAiPlannerPayload>;
  const candidateTypes = new Set(candidateActions.map(action => action.type));
  if (!Array.isArray(parsed.actions)) {
    throw new OpenAiPlannerSchemaError("OpenAI planner response actions must be an array.");
  }
  for (const action of parsed.actions) {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new OpenAiPlannerSchemaError("OpenAI planner response actions must be objects.");
    }
    if (
      typeof action.type !== "string" ||
      typeof action.title !== "string" ||
      typeof action.message !== "string" ||
      typeof action.reason !== "string"
    ) {
      throw new OpenAiPlannerSchemaError("OpenAI planner response action fields must be strings.");
    }
    if (!ROBOMATA_AGENT_ACTION_TYPES.includes(action.type as RobomataAgentActionType)) {
      throw new OpenAiPlannerSchemaError("OpenAI planner response action type is not supported.");
    }
    if (!candidateTypes.has(action.type as RobomataAgentActionType)) {
      throw new OpenAiPlannerSchemaError("OpenAI planner response action type was not a deterministic candidate.");
    }
  }
  return {
    actions: parsed.actions,
  };
}

function openAiPlannerPrompt(providerInput: PlannerProviderInput): string {
  return JSON.stringify({
    instruction:
      "Refine operator-facing copy for the supplied supervised-agent candidate actions. Do not add action types, remove required candidates, approve actions, execute actions, or change credit truth.",
    inputControls: {
      rawEvidenceIncluded: false,
      secretMaterialIncluded: false,
    },
    ...providerInput,
  });
}

function applyOpenAiPlannerPayload(
  candidateActions: RobomataAgentActionDraft[],
  payload: OpenAiPlannerPayload,
): RobomataAgentActionDraft[] {
  const candidatesByType = new Map(candidateActions.map(action => [action.type, action]));
  const plannedByType = new Map<RobomataAgentActionType, OpenAiPlannerActionPayload>();

  for (const action of payload.actions ?? []) {
    if (typeof action.type !== "string") continue;
    if (!candidatesByType.has(action.type as RobomataAgentActionType)) continue;
    plannedByType.set(action.type as RobomataAgentActionType, action);
  }

  return candidateActions.map(candidate => {
    const planned = plannedByType.get(candidate.type);
    if (!planned) return candidate;

    return {
      ...candidate,
      title: boundedText(planned.title, candidate.title, 120),
      message: boundedText(planned.message, candidate.message, 260),
      reason: boundedText(planned.reason, candidate.reason, 260),
      metadata: {
        ...candidate.metadata,
        llmPlannerApplied: true,
        proposalSource: "llm_refined_rules",
      },
    };
  });
}

export function resolveRobomataAgentPlannerBoundary(): RobomataAgentPlannerBoundary {
  const provider = normalizePlannerProvider(process.env.ROBOMATA_AGENT_PLANNER_PROVIDER);
  const model = process.env.ROBOMATA_AGENT_PLANNER_MODEL?.trim() || undefined;

  if (provider === "rules") return boundary("rules", "rules_engine", "deterministic_rules");

  if (!isRobomataAgentPlannerEnabled()) {
    return boundary(provider, "configured_without_feature_flag", "deterministic_fallback", model);
  }

  const apiKeyEnv = providerKeyEnv[provider];
  if (!process.env[apiKeyEnv]?.trim()) {
    return boundary(provider, "configured_without_key", "deterministic_fallback", model);
  }
  if (!model) return boundary(provider, "configured_without_model", "deterministic_fallback");

  if (provider === "openai") return boundary(provider, "live_completed", "llm_live", model);

  return boundary(provider, "stubbed_pending_controls", "llm_stubbed", model);
}

async function planWithOpenAi(
  input: PlanAgentActionsInput,
  plannerBoundary: RobomataAgentPlannerBoundary,
  providerInput: PlannerProviderInput,
): Promise<PlanAgentActionsResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || !plannerBoundary.model) {
    return {
      actions: input.candidateActions,
      plannerBoundary: boundary("openai", "configured_without_key", "deterministic_fallback", plannerBoundary.model),
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), openAiPlannerTimeoutMs);
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        body: JSON.stringify({
          input: [
            {
              role: "system",
              content:
                "You are a supervised private-credit operations planner. Return only schema-compliant JSON. Never invent action types or execution status.",
            },
            {
              role: "user",
              content: openAiPlannerPrompt(providerInput),
            },
          ],
          model: plannerBoundary.model,
          store: false,
          text: {
            format: {
              type: "json_schema",
              name: "robomata_agent_supervision_plan",
              schema: openAiPlannerSchema,
              strict: true,
            },
          },
        }),
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as OpenAiResponseBody;
      if (!response.ok) throw new Error(body.error?.message ?? `OpenAI planner failed with ${response.status}.`);

      const outputText = outputTextFromOpenAiResponse(body);
      if (!outputText) throw new Error("OpenAI planner response did not include output text.");

      const payload = parseOpenAiPlannerPayload(outputText, input.candidateActions);

      return {
        actions: applyOpenAiPlannerPayload(input.candidateActions, payload),
        plannerBoundary,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof OpenAiPlannerSchemaError) {
      return {
        actions: input.candidateActions,
        plannerBoundary: boundary("openai", "schema_invalid_fallback", "deterministic_fallback", plannerBoundary.model),
      };
    }
    return {
      actions: input.candidateActions,
      plannerBoundary: boundary("openai", "live_error_fallback", "deterministic_fallback", plannerBoundary.model),
    };
  }
}

function normalizedPlannerContext(input: PlanAgentActionsInput) {
  const generatedAt = new Date().toISOString();
  const controls = plannerInputControls(generatedAt);
  const providerInput = buildPlannerProviderInput(input, generatedAt);
  const sourceDataDigest = digest(sourceDataDigestSource(input));
  return { controls, generatedAt, providerInput, sourceDataDigest };
}

function withDeterministicPlannerProvenance(
  input: PlanAgentActionsInput,
  baseBoundary: RobomataAgentPlannerBoundary,
): PlanAgentActionsResult {
  const context = normalizedPlannerContext(input);
  return withPlannerProvenance({
    actions: input.candidateActions,
    baseBoundary,
    ...context,
  });
}

async function withLivePlannerProvenance(
  input: PlanAgentActionsInput,
  baseBoundary: RobomataAgentPlannerBoundary,
): Promise<PlanAgentActionsResult> {
  const context = normalizedPlannerContext(input);
  const planned = await planWithOpenAi(input, baseBoundary, context.providerInput);
  return withPlannerProvenance({
    actions: planned.actions,
    baseBoundary: planned.plannerBoundary,
    ...context,
  });
}

export async function planRobomataAgentActions(input: PlanAgentActionsInput): Promise<PlanAgentActionsResult> {
  const plannerBoundary = resolveRobomataAgentPlannerBoundary();

  if (!input.candidateActions.length) {
    return withDeterministicPlannerProvenance(input, plannerBoundary);
  }

  if (plannerBoundary.provider === "openai" && plannerBoundary.mode === "llm_live") {
    return withLivePlannerProvenance(input, plannerBoundary);
  }

  return withDeterministicPlannerProvenance(input, plannerBoundary);
}

export function plannerBoundarySummary(boundaryValue: RobomataAgentPlannerBoundary): string {
  if (boundaryValue.provider === "rules") return "Action proposals used deterministic supervision rules.";
  if (boundaryValue.status === "live_completed") {
    return "OpenAI planner completed against deterministic candidate actions; policy rules still defined the action set.";
  }
  if (boundaryValue.status === "live_error_fallback") {
    return "OpenAI planner failed, so action proposals used deterministic fallback rules.";
  }
  if (boundaryValue.status === "schema_invalid_fallback") {
    return "OpenAI planner returned schema-invalid output, so action proposals used deterministic fallback rules.";
  }
  if (boundaryValue.mode === "llm_stubbed") {
    return `${boundaryValue.provider} planner is configured, but live action planning is stubbed until planner controls are approved.`;
  }
  return `${boundaryValue.provider} planner is not active, so action proposals used deterministic fallback rules.`;
}
