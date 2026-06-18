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

const [featureFlags, executionAdapter, actionRoute, agentStore, panel, liveMonitoringDoc, mvpDoc] = await Promise.all([
  readRepoFile("web/lib/featureFlags.ts"),
  readRepoFile("web/lib/robomata/server/agentExecution.ts"),
  readRepoFile("web/app/api/robomata/submissions/[submissionId]/agent-actions/[actionId]/route.ts"),
  readRepoFile("web/lib/robomata/server/agentStore.ts"),
  readRepoFile("web/components/robomata/AgentSupervisionPanel.tsx"),
  readRepoFile("docs/robomata-live-facility-monitoring.md"),
  readRepoFile("docs/robomata-overflow-mvp.md"),
]);

assertIncludes(featureFlags, "ROBOMATA_AGENT_EXECUTION_ENABLED", "feature flags");
assertIncludes(featureFlags, "NEXT_PUBLIC_ROBOMATA_AGENT_EXECUTION_ENABLED", "feature flags");
assertIncludes(featureFlags, "ROBOMATA_AGENT_ADVISORY_EXECUTION_ENABLED", "feature flags");

assertIncludes(executionAdapter, '["evidence_review", "sui_root_review"]', "execution adapter");
assertNotIncludes(executionAdapter, '"borrowing_base_recompute"', "execution adapter executable set");
assertNotIncludes(executionAdapter, '"packet_refresh"', "execution adapter executable set");
assertNotIncludes(executionAdapter, '"tokenization_readiness"', "execution adapter executable set");
assertIncludes(executionAdapter, "No submission, packet, Sui, EVM, or evidence state was mutated", "execution adapter");
assertIncludes(executionAdapter, "inputDigest", "execution adapter");
assertIncludes(executionAdapter, "outputDigest", "execution adapter");

assertIncludes(actionRoute, "shouldExecute", "agent action route");
assertIncludes(actionRoute, "recordActionExecutionAudit", "agent action route");
assertIncludes(agentStore, "action_execution_failed", "agent store");
assertIncludes(agentStore, "executionAuditMetadata", "agent store");
assertIncludes(panel, "Execute audit", "agent supervision panel");

assertIncludes(liveMonitoringDoc, "ROBOMATA_AGENT_ADVISORY_EXECUTION_ENABLED=true", "live monitoring docs");
assertIncludes(liveMonitoringDoc, "remain proposal-only", "live monitoring docs");
assertIncludes(mvpDoc, "audit-only execution", "MVP docs");

console.log("Robomata agent execution boundary smoke passed.");
