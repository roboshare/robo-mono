#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webDir, "..");

async function readRepoFile(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`${label} missing expected text: ${needle}`);
}

function assertNotIncludes(source, needle, label) {
  if (source.includes(needle)) throw new Error(`${label} unexpectedly includes: ${needle}`);
}

const [agents, planner, panel, packageJson, webPackageJson, doc] = await Promise.all([
  readRepoFile("web/lib/robomata/agents.ts"),
  readRepoFile("web/lib/robomata/server/agentPlanner.ts"),
  readRepoFile("web/components/robomata/AgentSupervisionPanel.tsx"),
  readRepoFile("package.json"),
  readRepoFile("web/package.json"),
  readRepoFile("docs/robomata-live-facility-monitoring.md"),
]);

for (const needle of [
  "RobomataAgentPlannerExecutionBoundary",
  "RobomataAgentPlannerRequiredApproval",
  "RobomataAgentPlannerRiskLevel",
  "RobomataAgentPlannerSuggestedTool",
  '"agent-supervision-plan-output-v2"',
]) {
  assertIncludes(agents, needle, "agent model");
}

for (const needle of [
  "plannerRiskRank",
  "plannerRequiredApprovals",
  "plannerSuggestedTools",
  "plannerExecutionBoundaryForAction",
  "defaultSuggestedToolForAction",
  "validateSuggestedToolForAction",
  "validateRequiredApprovals",
  "validateRiskLevel",
  "isActionWithinAppointment",
  "isActionAutoApproved",
  "withPlannerRecommendationDefaults",
  "plannerRecommendationSource",
  "plannerRequiredApprovals",
  "plannerRiskLevel",
  "plannerSuggestedTool",
  "plannerExecutionBoundary",
  "plannerToolIntentReason",
  "risk level understated deterministic severity",
  "required approvals must include operator",
  "none_auto_approved",
  "suggested an unsupported tool",
]) {
  assertIncludes(planner, needle, "agent planner");
}

for (const needle of [
  "Recommendation: source",
  "plannerRecommendationSource",
  "plannerRiskLevel",
  "plannerRequiredApprovals",
  "plannerSuggestedTool",
  "plannerExecutionBoundary",
  "plannerToolIntentReason",
]) {
  assertIncludes(panel, needle, "agent supervision panel");
}

for (const secret of [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "ROBOMATA_AGENT_TICK_SECRET",
  "ROBOMATA_SHARE_LINK_TOKEN_SECRET",
  "ROBOMATA_SUI_PRIVATE_KEY",
  "ROBOMATA_SUI_SPONSOR_PRIVATE_KEY",
]) {
  assertNotIncludes(panel, secret, "agent supervision panel");
}

assertIncludes(packageJson, "robomata:agent-planner-intents-smoke", "root package scripts");
assertIncludes(webPackageJson, "robomata:agent-planner-intents-smoke", "web package scripts");
assertIncludes(doc, "structured recommendation intent", "live monitoring docs");
assertIncludes(doc, "agent-supervision-plan-output-v2", "live monitoring docs");
assertIncludes(doc, "none_auto_approved", "live monitoring docs");
assertIncludes(doc, "does not approve, complete, execute, or mutate retained actions", "live monitoring docs");

console.log("Robomata agent planner intents smoke passed.");
