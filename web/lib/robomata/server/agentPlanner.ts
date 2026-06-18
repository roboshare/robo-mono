import "server-only";
import { isRobomataAgentPlannerEnabled } from "~~/lib/featureFlags";
import type {
  RobomataAgentPlannerBoundary,
  RobomataAgentPlannerMode,
  RobomataAgentPlannerProvider,
  RobomataAgentPlannerStatus,
} from "~~/lib/robomata/agents";

const supportedPlannerProviders: RobomataAgentPlannerProvider[] = ["rules", "openai", "anthropic", "google"];

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

  return boundary(provider, "stubbed_pending_controls", "llm_stubbed", model);
}

export function plannerBoundarySummary(boundaryValue: RobomataAgentPlannerBoundary): string {
  if (boundaryValue.provider === "rules") return "Action proposals used deterministic supervision rules.";
  if (boundaryValue.mode === "llm_stubbed") {
    return `${boundaryValue.provider} planner is configured, but live action planning is stubbed until planner controls are approved.`;
  }
  return `${boundaryValue.provider} planner is not active, so action proposals used deterministic fallback rules.`;
}
