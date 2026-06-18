import "server-only";
import { isRobomataAgentPlannerEnabled } from "~~/lib/featureFlags";
import type {
  RobomataAgentActionDraft,
  RobomataAgentActionType,
  RobomataAgentPlannerBoundary,
  RobomataAgentPlannerMode,
  RobomataAgentPlannerProvider,
  RobomataAgentPlannerStatus,
  RobomataAgentPolicy,
} from "~~/lib/robomata/agents";
import { ROBOMATA_AGENT_ACTION_TYPES } from "~~/lib/robomata/agents";
import type { FacilityMonitoringProjection } from "~~/lib/robomata/facilityMonitoring";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";

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
  policy: RobomataAgentPolicy;
  projection: FacilityMonitoringProjection;
  submission: FacilitySubmission;
};

type PlanAgentActionsResult = {
  actions: RobomataAgentActionDraft[];
  plannerBoundary: RobomataAgentPlannerBoundary;
};

function boundedText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, maxLength);
}

function outputTextFromOpenAiResponse(body: OpenAiResponseBody): string | undefined {
  if (body.output_text?.trim()) return body.output_text;

  return body.output
    ?.flatMap(item => item.content ?? [])
    .map(content => content.text)
    .find((text): text is string => Boolean(text?.trim()));
}

function parseOpenAiPlannerPayload(text: string): OpenAiPlannerPayload {
  const parsed = JSON.parse(text) as Partial<OpenAiPlannerPayload>;
  return {
    actions: Array.isArray(parsed.actions) ? parsed.actions : [],
  };
}

function openAiPlannerPrompt(input: PlanAgentActionsInput): string {
  return JSON.stringify({
    instruction:
      "Refine operator-facing copy for the supplied supervised-agent candidate actions. Do not add action types, remove required candidates, approve actions, execute actions, or change credit truth.",
    policy: {
      allowedActionTypes: input.policy.allowedActionTypes,
      appointedAgentName: input.policy.appointedAgentName,
      appointedBy: input.policy.appointedBy,
      autoApproveActionTypes: input.policy.autoApproveActionTypes,
      status: input.policy.status,
    },
    facility: {
      freshnessStatus: input.projection.freshnessStatus,
      observationCount: input.projection.observations.length,
      status: input.projection.facility.status,
      suiRootStatus: input.projection.suiRootStatus,
    },
    submission: {
      evidenceCount: input.submission.evidence.length,
      receivableCount: input.submission.receivables.length,
      tokenizationStatus: input.submission.tokenization.status,
    },
    candidateActions: input.candidateActions.map(action => ({
      message: action.message,
      reason: action.reason,
      severity: action.severity,
      title: action.title,
      type: action.type,
    })),
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
              content: openAiPlannerPrompt(input),
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

      return {
        actions: applyOpenAiPlannerPayload(input.candidateActions, parseOpenAiPlannerPayload(outputText)),
        plannerBoundary,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    void error;
    return {
      actions: input.candidateActions,
      plannerBoundary: boundary("openai", "live_error_fallback", "deterministic_fallback", plannerBoundary.model),
    };
  }
}

export async function planRobomataAgentActions(input: PlanAgentActionsInput): Promise<PlanAgentActionsResult> {
  const plannerBoundary = resolveRobomataAgentPlannerBoundary();

  if (!input.candidateActions.length) {
    return { actions: input.candidateActions, plannerBoundary };
  }

  if (plannerBoundary.provider === "openai" && plannerBoundary.mode === "llm_live") {
    return planWithOpenAi(input, plannerBoundary);
  }

  return { actions: input.candidateActions, plannerBoundary };
}

export function plannerBoundarySummary(boundaryValue: RobomataAgentPlannerBoundary): string {
  if (boundaryValue.provider === "rules") return "Action proposals used deterministic supervision rules.";
  if (boundaryValue.status === "live_completed") {
    return "OpenAI planner completed against deterministic candidate actions; policy rules still defined the action set.";
  }
  if (boundaryValue.status === "live_error_fallback") {
    return "OpenAI planner failed, so action proposals used deterministic fallback rules.";
  }
  if (boundaryValue.mode === "llm_stubbed") {
    return `${boundaryValue.provider} planner is configured, but live action planning is stubbed until planner controls are approved.`;
  }
  return `${boundaryValue.provider} planner is not active, so action proposals used deterministic fallback rules.`;
}
