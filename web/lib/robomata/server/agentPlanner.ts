import { createHash } from "node:crypto";
import "server-only";
import {
  isRobomataAgentAdvisoryExecutionEnabled,
  isRobomataAgentExecutionEnabled,
  isRobomataAgentPlannerEnabled,
} from "~~/lib/featureFlags";
import type {
  RobomataAgentAction,
  RobomataAgentActionDraft,
  RobomataAgentActionSeverity,
  RobomataAgentActionType,
  RobomataAgentPlannerBoundary,
  RobomataAgentPlannerExecutionBoundary,
  RobomataAgentPlannerInputControls,
  RobomataAgentPlannerMode,
  RobomataAgentPlannerProvider,
  RobomataAgentPlannerRequiredApproval,
  RobomataAgentPlannerRiskLevel,
  RobomataAgentPlannerStatus,
  RobomataAgentPlannerSuggestedTool,
  RobomataAgentPolicy,
} from "~~/lib/robomata/agents";
import { ROBOMATA_AGENT_ACTION_TYPES } from "~~/lib/robomata/agents";
import type { FacilityMonitoringProjection } from "~~/lib/robomata/facilityMonitoring";
import {
  GOOGLE_GEMINI_API_KEY_ENV,
  generateGoogleGeminiContent,
  isGoogleGeminiRateLimitError,
  jsonTextFromProviderOutput,
} from "~~/lib/robomata/googleGemini";
import type { RobomataFacilityPolicyArtifact } from "~~/lib/robomata/policyRules";
import type { RobomataAgentMemoryContext } from "~~/lib/robomata/server/agentMemory";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";

export const ROBOMATA_AGENT_PLANNER_PROMPT_VERSION = "agent-supervision-planner-v1";
export const ROBOMATA_AGENT_PLANNER_OUTPUT_SCHEMA_VERSION = "agent-supervision-plan-output-v2";
export const ROBOMATA_AGENT_PLANNER_MAX_CANDIDATE_ACTIONS = 8;
export const ROBOMATA_AGENT_PLANNER_MAX_RECENT_ACTIONS = 12;
export const ROBOMATA_AGENT_PLANNER_MAX_RECENT_RUNS = 5;
export const ROBOMATA_AGENT_PLANNER_MAX_TEXT_LENGTH = 260;

const supportedPlannerProviders: RobomataAgentPlannerProvider[] = ["rules", "openai", "anthropic", "google"];
const openAiPlannerTimeoutMs = 8_000;
const googleGeminiPlannerTimeoutMs = 8_000;
const plannerRiskRank: Record<RobomataAgentPlannerRiskLevel, number> = { low: 1, medium: 2, high: 3 };
const plannerRequiredApprovals: Exclude<RobomataAgentPlannerRequiredApproval, "none_auto_approved">[] = ["operator"];
const plannerSuggestedTools: RobomataAgentPlannerSuggestedTool[] = ["none", "robomata.agent.advisory_audit.v1"];

const providerKeyEnv: Record<Exclude<RobomataAgentPlannerProvider, "rules">, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: GOOGLE_GEMINI_API_KEY_ENV,
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
          riskLevel: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Must not understate the deterministic candidate severity.",
          },
          requiredApprovals: {
            type: "array",
            items: {
              type: "string",
              enum: plannerRequiredApprovals,
            },
            description:
              "Use [] only for action types explicitly auto-approved by the appointment; otherwise use operator.",
          },
          suggestedTool: {
            type: "string",
            enum: plannerSuggestedTools,
            description:
              "Use none unless the supplied allowed tool surface permits the advisory audit adapter for this action type.",
          },
          toolIntentReason: {
            type: "string",
            description: "Why this suggested tool remains proposal-only or audit-only.",
          },
        },
        required: [
          "type",
          "title",
          "message",
          "reason",
          "riskLevel",
          "requiredApprovals",
          "suggestedTool",
          "toolIntentReason",
        ],
      },
    },
  },
  required: ["actions"],
} as const;

type OpenAiPlannerActionPayload = {
  message?: unknown;
  reason?: unknown;
  requiredApprovals?: unknown;
  riskLevel?: unknown;
  suggestedTool?: unknown;
  title?: unknown;
  toolIntentReason?: unknown;
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
  memoryContext?: RobomataAgentMemoryContext;
  submission: FacilitySubmission;
  suppressAutoApprove?: boolean;
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
      "bounded MemWal memory summaries and memory digests",
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
      "MemWal delegate keys",
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

function isPlannerRiskLevel(value: unknown): value is RobomataAgentPlannerRiskLevel {
  return value === "low" || value === "medium" || value === "high";
}

function isPlannerSuggestedTool(value: unknown): value is RobomataAgentPlannerSuggestedTool {
  return typeof value === "string" && plannerSuggestedTools.includes(value as RobomataAgentPlannerSuggestedTool);
}

function plannerExecutionBoundaryForAction(type: RobomataAgentActionType): RobomataAgentPlannerExecutionBoundary {
  return type === "evidence_review" || type === "sui_root_review" ? "audit_only_adapter_flagged" : "proposal_only";
}

function isActionWithinAppointment(policy: RobomataAgentPolicy, type: RobomataAgentActionType): boolean {
  return policy.allowedActionTypes.includes(type);
}

function isActionAutoApproved(
  policy: RobomataAgentPolicy,
  type: RobomataAgentActionType,
  suppressAutoApprove?: boolean,
): boolean {
  if (policy.status !== "active") return false;
  if (suppressAutoApprove) return false;
  return policy.autoApproveActionTypes.includes(type);
}

function isAdvisoryAuditToolEnabled(): boolean {
  return isRobomataAgentExecutionEnabled() && isRobomataAgentAdvisoryExecutionEnabled();
}

function canSuggestAdvisoryAuditTool(policy: RobomataAgentPolicy | undefined, type: RobomataAgentActionType): boolean {
  if (policy && policy.status !== "active") return false;
  if (policy && !isActionWithinAppointment(policy, type)) return false;
  if (!isAdvisoryAuditToolEnabled()) return false;
  return plannerExecutionBoundaryForAction(type) === "audit_only_adapter_flagged";
}

function defaultSuggestedToolForAction(
  type: RobomataAgentActionType,
  policy?: RobomataAgentPolicy,
): RobomataAgentPlannerSuggestedTool {
  return canSuggestAdvisoryAuditTool(policy, type) ? "robomata.agent.advisory_audit.v1" : "none";
}

function defaultExecutionBoundaryForAction(
  type: RobomataAgentActionType,
  policy?: RobomataAgentPolicy,
): RobomataAgentPlannerExecutionBoundary {
  return canSuggestAdvisoryAuditTool(policy, type) ? "audit_only_adapter_flagged" : "proposal_only";
}

function validateSuggestedToolForAction(
  type: RobomataAgentActionType,
  suggestedTool: RobomataAgentPlannerSuggestedTool,
  policy: RobomataAgentPolicy,
): void {
  if (suggestedTool === "none") return;
  if (defaultSuggestedToolForAction(type, policy) === suggestedTool) return;
  throw new OpenAiPlannerSchemaError("OpenAI planner suggested an unsupported tool for the action type.");
}

function validateRequiredApprovals(
  value: unknown,
  type: RobomataAgentActionType,
  policy: RobomataAgentPolicy,
  suppressAutoApprove?: boolean,
): RobomataAgentPlannerRequiredApproval {
  if (!Array.isArray(value)) {
    throw new OpenAiPlannerSchemaError("OpenAI planner required approvals must be an array.");
  }
  if (isActionAutoApproved(policy, type, suppressAutoApprove)) {
    if (value.length === 0) return "none_auto_approved";
    if (value.length === 1 && value[0] === "operator") return "operator";
    throw new OpenAiPlannerSchemaError("OpenAI planner auto-approved action required approvals are invalid.");
  }
  if (value.length !== 1 || value[0] !== "operator") {
    throw new OpenAiPlannerSchemaError("OpenAI planner required approvals must include operator.");
  }
  return "operator";
}

function validateRiskLevel(
  value: unknown,
  deterministicSeverity: RobomataAgentActionSeverity,
): RobomataAgentPlannerRiskLevel {
  if (!isPlannerRiskLevel(value)) throw new OpenAiPlannerSchemaError("OpenAI planner risk level is not supported.");
  if (plannerRiskRank[value] < plannerRiskRank[deterministicSeverity]) {
    throw new OpenAiPlannerSchemaError("OpenAI planner risk level understated deterministic severity.");
  }
  return value;
}

function defaultPlannerToolIntentReason(
  type: RobomataAgentActionType,
  policy: RobomataAgentPolicy,
  suppressAutoApprove?: boolean,
): string {
  if (!isActionWithinAppointment(policy, type)) {
    return "Appointment does not allow this action type; retain only as a skipped audit record.";
  }
  if (policy.autoApproveActionTypes.includes(type) && suppressAutoApprove) {
    return "Auto-approval is suppressed for this run; operator approval is required before the action can advance.";
  }
  if (isActionAutoApproved(policy, type, suppressAutoApprove)) {
    return "Appointment auto-approval covers this action type, but planner output still cannot execute or mutate state.";
  }
  if (defaultSuggestedToolForAction(type, policy) === "robomata.agent.advisory_audit.v1") {
    return "Advisory audit adapter only; operator approval remains required before any retained action changes state.";
  }
  if (plannerExecutionBoundaryForAction(type) === "audit_only_adapter_flagged" && !isAdvisoryAuditToolEnabled()) {
    return "Advisory execution flags are disabled; retain as a proposal for operator review.";
  }
  return "No executable tool is authorized for this action; retain as a proposal for operator review.";
}

function defaultPlannerRequiredApprovals(
  action: RobomataAgentActionDraft,
  policy: RobomataAgentPolicy,
  suppressAutoApprove?: boolean,
): RobomataAgentPlannerRequiredApproval {
  if (isActionAutoApproved(policy, action.type, suppressAutoApprove)) return "none_auto_approved";
  return "operator";
}

function withPlannerRecommendationDefaults(
  action: RobomataAgentActionDraft,
  policy: RobomataAgentPolicy,
  suppressAutoApprove?: boolean,
): RobomataAgentActionDraft {
  const riskLevel = isPlannerRiskLevel(action.metadata?.plannerRiskLevel)
    ? action.metadata.plannerRiskLevel
    : action.severity;
  const suggestedTool = isPlannerSuggestedTool(action.metadata?.plannerSuggestedTool)
    ? action.metadata.plannerSuggestedTool
    : defaultSuggestedToolForAction(action.type, policy);
  const suggestedToolAllowed =
    isActionWithinAppointment(policy, action.type) &&
    (suggestedTool === "none" || suggestedTool === defaultSuggestedToolForAction(action.type, policy));
  const executionBoundary = defaultExecutionBoundaryForAction(action.type, policy);
  return {
    ...action,
    metadata: {
      ...action.metadata,
      plannerExecutionBoundary: executionBoundary,
      plannerRecommendationSource: action.metadata?.proposalSource ?? "deterministic_rules",
      plannerRequiredApprovals: defaultPlannerRequiredApprovals(action, policy, suppressAutoApprove),
      plannerRiskLevel: riskLevel,
      plannerSuggestedTool: suggestedToolAllowed ? suggestedTool : "none",
      plannerSuggestedToolAllowed: suggestedToolAllowed,
      plannerToolIntentReason:
        typeof action.metadata?.plannerToolIntentReason === "string"
          ? boundedText(
              action.metadata.plannerToolIntentReason,
              defaultPlannerToolIntentReason(action.type, policy, suppressAutoApprove),
              180,
            )
          : defaultPlannerToolIntentReason(action.type, policy, suppressAutoApprove),
    },
  };
}

function buildAllowedToolSurface(policy: RobomataAgentPolicy, suppressAutoApprove?: boolean) {
  return ROBOMATA_AGENT_ACTION_TYPES.map(type => ({
    approvalRequired: !isActionAutoApproved(policy, type, suppressAutoApprove),
    autoApproved: isActionAutoApproved(policy, type, suppressAutoApprove),
    executionBoundary: defaultExecutionBoundaryForAction(type, policy),
    suggestedTool: defaultSuggestedToolForAction(type, policy),
    type,
    withinAppointment: isActionWithinAppointment(policy, type),
  }));
}

function buildPlannerProviderInput(input: PlanAgentActionsInput, generatedAt: string) {
  return {
    allowedToolSurface: buildAllowedToolSurface(input.policy, input.suppressAutoApprove),
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
      autoApprovalSuppressedForRun: Boolean(input.suppressAutoApprove),
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
    recalledMemory: input.memoryContext
      ? {
          digests: input.memoryContext.digests,
          namespace: input.memoryContext.namespace ?? null,
          provider: input.memoryContext.provider,
          recalledCount: input.memoryContext.recalledCount,
          status: input.memoryContext.status,
          summaries: input.memoryContext.memories.map(memory => ({
            blobId: memory.blobId ?? null,
            digest: memory.digest,
            distance: memory.distance ?? null,
            text: compactText(memory.text),
          })),
        }
      : null,
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
      suppressAutoApprove: Boolean(input.suppressAutoApprove),
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
    recalledMemory: input.memoryContext
      ? {
          digests: input.memoryContext.digests,
          provider: input.memoryContext.provider,
          recalledCount: input.memoryContext.recalledCount,
          status: input.memoryContext.status,
        }
      : null,
    submissionId: input.submission.id,
  };
}

function plannerOutputDigestSource(actions: RobomataAgentActionDraft[]) {
  return {
    actions: actions.map(action => ({
      message: action.message,
      plannerExecutionBoundary: action.metadata?.plannerExecutionBoundary ?? null,
      plannerRecommendationSource: action.metadata?.plannerRecommendationSource ?? null,
      plannerRequiredApprovals: action.metadata?.plannerRequiredApprovals ?? null,
      plannerRiskLevel: action.metadata?.plannerRiskLevel ?? null,
      plannerSuggestedTool: action.metadata?.plannerSuggestedTool ?? null,
      plannerSuggestedToolAllowed: action.metadata?.plannerSuggestedToolAllowed ?? null,
      plannerToolIntentReason: action.metadata?.plannerToolIntentReason ?? null,
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
  policy: RobomataAgentPolicy;
  providerInput: PlannerProviderInput;
  sourceDataDigest: string;
  suppressAutoApprove?: boolean;
}): PlanAgentActionsResult {
  const actionsWithRecommendationDefaults = input.actions.map(action =>
    withPlannerRecommendationDefaults(action, input.policy, input.suppressAutoApprove),
  );
  const plannerInputDigest = digest(input.providerInput);
  const plannerOutputDigest = digest(plannerOutputDigestSource(actionsWithRecommendationDefaults));
  const plannerBoundary: RobomataAgentPlannerBoundary = {
    ...input.baseBoundary,
    allowedToolCount: input.providerInput.allowedToolSurface.length,
    candidateActionCount: input.providerInput.candidateActions.length,
    generatedAt: input.generatedAt,
    inputControls: input.controls,
    memoryProvider: input.providerInput.recalledMemory?.provider,
    memoryRecallCount: input.providerInput.recalledMemory?.recalledCount,
    memoryRecallStatus: input.providerInput.recalledMemory?.status,
    memwalNamespace: input.providerInput.recalledMemory?.namespace ?? undefined,
    outputSchemaVersion: ROBOMATA_AGENT_PLANNER_OUTPUT_SCHEMA_VERSION,
    plannerInputDigest,
    plannerOutputDigest,
    promptVersion: ROBOMATA_AGENT_PLANNER_PROMPT_VERSION,
    recentActionCount: input.providerInput.recentActionHistory.length,
    recentRunCount: input.providerInput.recentRunHistory.length,
    sourceDataDigest: input.sourceDataDigest,
  };

  return {
    actions: actionsWithRecommendationDefaults.map(action => ({
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

function parseOpenAiPlannerPayload(
  text: string,
  candidateActions: RobomataAgentActionDraft[],
  policy: RobomataAgentPolicy,
  suppressAutoApprove?: boolean,
): OpenAiPlannerPayload {
  const parsed = JSON.parse(text) as Partial<OpenAiPlannerPayload>;
  const candidatesByType = new Map(candidateActions.map(action => [action.type, action]));
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
      typeof action.reason !== "string" ||
      typeof action.toolIntentReason !== "string"
    ) {
      throw new OpenAiPlannerSchemaError("OpenAI planner response action fields must be strings.");
    }
    if (!ROBOMATA_AGENT_ACTION_TYPES.includes(action.type as RobomataAgentActionType)) {
      throw new OpenAiPlannerSchemaError("OpenAI planner response action type is not supported.");
    }
    const candidate = candidatesByType.get(action.type as RobomataAgentActionType);
    if (!candidate) {
      throw new OpenAiPlannerSchemaError("OpenAI planner response action type was not a deterministic candidate.");
    }
    const riskLevel = validateRiskLevel(action.riskLevel, candidate.severity);
    const suggestedTool = action.suggestedTool;
    if (!isPlannerSuggestedTool(suggestedTool)) {
      throw new OpenAiPlannerSchemaError("OpenAI planner suggested tool is not supported.");
    }
    const requiredApproval = validateRequiredApprovals(
      action.requiredApprovals,
      candidate.type,
      policy,
      suppressAutoApprove,
    );
    validateSuggestedToolForAction(candidate.type, suggestedTool, policy);
    action.riskLevel = riskLevel;
    action.requiredApprovals = requiredApproval === "none_auto_approved" ? [] : ["operator"];
    action.suggestedTool = suggestedTool;
  }
  return {
    actions: parsed.actions,
  };
}

function openAiPlannerPrompt(providerInput: PlannerProviderInput): string {
  return JSON.stringify({
    instruction:
      "Refine operator-facing copy and structured recommendation intent for the supplied supervised-agent candidate actions. Do not add action types, remove required candidates, understate deterministic risk, approve actions, execute actions, or change credit truth. Required approvals must be [] only for explicitly auto-approved action types and otherwise operator-only. Suggested tools must match the allowed tool surface and remain proposal-only or audit-only.",
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
  policy: RobomataAgentPolicy,
  suppressAutoApprove?: boolean,
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
        plannerExecutionBoundary: plannerExecutionBoundaryForAction(candidate.type),
        plannerRecommendationSource: "llm_refined_rules",
        plannerRequiredApprovals:
          Array.isArray(planned.requiredApprovals) && planned.requiredApprovals.length === 0
            ? "none_auto_approved"
            : "operator",
        plannerRiskLevel: planned.riskLevel as RobomataAgentPlannerRiskLevel,
        plannerSuggestedTool: planned.suggestedTool as RobomataAgentPlannerSuggestedTool,
        plannerSuggestedToolAllowed: isActionWithinAppointment(policy, candidate.type),
        plannerToolIntentReason: boundedText(
          planned.toolIntentReason,
          defaultPlannerToolIntentReason(candidate.type, policy, suppressAutoApprove),
          180,
        ),
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

  if (provider === "openai" || provider === "google") return boundary(provider, "live_completed", "llm_live", model);

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

      const payload = parseOpenAiPlannerPayload(
        jsonTextFromProviderOutput(outputText),
        input.candidateActions,
        input.policy,
        input.suppressAutoApprove,
      );

      return {
        actions: applyOpenAiPlannerPayload(input.candidateActions, payload, input.policy, input.suppressAutoApprove),
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

async function planWithGoogle(
  input: PlanAgentActionsInput,
  plannerBoundary: RobomataAgentPlannerBoundary,
  providerInput: PlannerProviderInput,
): Promise<PlanAgentActionsResult> {
  const apiKey = process.env[GOOGLE_GEMINI_API_KEY_ENV]?.trim();
  if (!apiKey || !plannerBoundary.model) {
    return {
      actions: input.candidateActions,
      plannerBoundary: boundary("google", "configured_without_key", "deterministic_fallback", plannerBoundary.model),
    };
  }

  try {
    const outputText = await generateGoogleGeminiContent({
      apiKey,
      model: plannerBoundary.model,
      responseSchema: openAiPlannerSchema,
      systemInstruction:
        "You are a supervised private-credit operations planner. Return only schema-compliant JSON. Never invent action types or execution status.",
      timeoutMs: googleGeminiPlannerTimeoutMs,
      userPrompt: openAiPlannerPrompt(providerInput),
    });

    const payload = parseOpenAiPlannerPayload(
      jsonTextFromProviderOutput(outputText),
      input.candidateActions,
      input.policy,
      input.suppressAutoApprove,
    );

    return {
      actions: applyOpenAiPlannerPayload(input.candidateActions, payload, input.policy, input.suppressAutoApprove),
      plannerBoundary,
    };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof OpenAiPlannerSchemaError) {
      return {
        actions: input.candidateActions,
        plannerBoundary: boundary("google", "schema_invalid_fallback", "deterministic_fallback", plannerBoundary.model),
      };
    }
    return {
      actions: input.candidateActions,
      plannerBoundary: boundary(
        "google",
        isGoogleGeminiRateLimitError(error) ? "rate_limited_fallback" : "live_error_fallback",
        "deterministic_fallback",
        plannerBoundary.model,
      ),
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
    policy: input.policy,
    suppressAutoApprove: input.suppressAutoApprove,
    ...context,
  });
}

async function withLivePlannerProvenance(
  input: PlanAgentActionsInput,
  baseBoundary: RobomataAgentPlannerBoundary,
): Promise<PlanAgentActionsResult> {
  const context = normalizedPlannerContext(input);
  const planned =
    baseBoundary.provider === "google"
      ? await planWithGoogle(input, baseBoundary, context.providerInput)
      : await planWithOpenAi(input, baseBoundary, context.providerInput);
  return withPlannerProvenance({
    actions: planned.actions,
    baseBoundary: planned.plannerBoundary,
    policy: input.policy,
    suppressAutoApprove: input.suppressAutoApprove,
    ...context,
  });
}

export async function planRobomataAgentActions(input: PlanAgentActionsInput): Promise<PlanAgentActionsResult> {
  const plannerBoundary = resolveRobomataAgentPlannerBoundary();

  if (!input.candidateActions.length) {
    return withDeterministicPlannerProvenance(input, plannerBoundary);
  }

  if (
    (plannerBoundary.provider === "openai" || plannerBoundary.provider === "google") &&
    plannerBoundary.mode === "llm_live"
  ) {
    return withLivePlannerProvenance(input, plannerBoundary);
  }

  return withDeterministicPlannerProvenance(input, plannerBoundary);
}

export function plannerBoundarySummary(boundaryValue: RobomataAgentPlannerBoundary): string {
  if (boundaryValue.provider === "rules") return "Action proposals used deterministic supervision rules.";
  if (boundaryValue.status === "live_completed") {
    return `${boundaryValue.provider} planner completed against deterministic candidate actions; policy rules still defined the action set.`;
  }
  if (boundaryValue.status === "live_error_fallback") {
    return `${boundaryValue.provider} planner failed, so action proposals used deterministic fallback rules.`;
  }
  if (boundaryValue.status === "rate_limited_fallback") {
    return `${boundaryValue.provider} planner was rate-limited, so action proposals used deterministic fallback rules.`;
  }
  if (boundaryValue.status === "schema_invalid_fallback") {
    return `${boundaryValue.provider} planner returned schema-invalid output, so action proposals used deterministic fallback rules.`;
  }
  if (boundaryValue.mode === "llm_stubbed") {
    return `${boundaryValue.provider} planner is configured, but live action planning is stubbed until planner controls are approved.`;
  }
  return `${boundaryValue.provider} planner is not active, so action proposals used deterministic fallback rules.`;
}
