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

const [agents, planner, runner, store, panel, packageJson, webPackageJson, doc] = await Promise.all([
  readRepoFile("web/lib/robomata/agents.ts"),
  readRepoFile("web/lib/robomata/server/agentPlanner.ts"),
  readRepoFile("web/lib/robomata/server/agentRunner.ts"),
  readRepoFile("web/lib/robomata/server/agentStore.ts"),
  readRepoFile("web/components/robomata/AgentSupervisionPanel.tsx"),
  readRepoFile("package.json"),
  readRepoFile("web/package.json"),
  readRepoFile("docs/robomata-live-facility-monitoring.md"),
]);

for (const needle of [
  "RobomataAgentPlannerInputControls",
  "plannerInputDigest",
  "plannerOutputDigest",
  "sourceDataDigest",
  "promptVersion",
  "outputSchemaVersion",
  '"agent-supervision-planner-v1"',
  '"agent-supervision-plan-output-v1"',
  '"schema_invalid_fallback"',
]) {
  assertIncludes(agents, needle, "agent model");
}

for (const needle of [
  "ROBOMATA_AGENT_PLANNER_PROMPT_VERSION",
  "ROBOMATA_AGENT_PLANNER_OUTPUT_SCHEMA_VERSION",
  "ROBOMATA_AGENT_PLANNER_MAX_RECENT_ACTIONS",
  "ROBOMATA_AGENT_PLANNER_MAX_RECENT_RUNS",
  "plannerInputControls",
  "buildPlannerProviderInput",
  "sourceDataDigestSource",
  "recentActionHistory",
  "executionStatus",
  "decidedAt",
  "plannerOutputDigestSource",
  "withPlannerProvenance",
  "recentRunHistory",
  "recentActionHistory",
  "allowedToolSurface",
  "rawEvidenceIncluded: false",
  "secretMaterialIncluded: false",
  "OpenAiPlannerSchemaError",
  "store: false",
  "schema_invalid_fallback",
]) {
  assertIncludes(planner, needle, "agent planner");
}

for (const needle of [
  '"raw evidence bodies"',
  '"raw provider payloads"',
  '"API keys and secret env names"',
  '"Sui private keys"',
  '"Seal plaintext or ciphertext"',
  '"Walrus ciphertext"',
  '"share-link tokens"',
  '"wallet signatures"',
]) {
  assertIncludes(planner, needle, "agent planner excluded material");
}

for (const needle of [
  "policyArtifact",
  "recentActions",
  "recentRuns",
  "ROBOMATA_AGENT_PLANNER_MAX_RECENT_ACTIONS",
  "ROBOMATA_AGENT_PLANNER_MAX_RECENT_RUNS",
  "store.listRuns(input.submission.id, input.submission.partnerAddress, ROBOMATA_AGENT_PLANNER_MAX_RECENT_RUNS)",
  "store.listActions(input.submission.id, input.submission.partnerAddress, ROBOMATA_AGENT_PLANNER_MAX_RECENT_ACTIONS)",
]) {
  assertIncludes(runner, needle, "agent runner");
}

for (const needle of ["normalizeListLimit", "LIMIT ${normalizedLimit}", "runs.slice(0, normalizedLimit)", "actions.slice(0, normalizedLimit)"]) {
  assertIncludes(store, needle, "agent store limited history reads");
}

for (const needle of [
  "plannerInputDigest",
  "plannerOutputDigest",
  "plannerPromptVersion",
  "plannerSourceDataDigest",
  "plannerOutputSchemaVersion",
]) {
  assertIncludes(store, needle, "agent store");
}

for (const needle of [
  "plannerInputDigest",
  "plannerOutputDigest",
  "promptVersion",
  "sourceDataDigest",
  "outputSchemaVersion",
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

assertIncludes(packageJson, "robomata:agent-planner-provenance-smoke", "root package scripts");
assertIncludes(webPackageJson, "robomata:agent-planner-provenance-smoke", "web package scripts");
assertIncludes(doc, "Agent Supervision Planner Boundary", "live monitoring docs");
assertIncludes(doc, "bounded planner input digest", "live monitoring docs");
assertIncludes(doc, "raw prompts or provider responses", "live monitoring docs");

console.log("Robomata agent planner provenance smoke passed.");
