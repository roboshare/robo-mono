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

const [
  policyRules,
  borrowingBase,
  submissionAdapters,
  facilityMonitoringProjection,
  agentRunner,
  agentStore,
  agentSupervisionPanel,
] = await Promise.all([
  readRepoFile("web/lib/robomata/policyRules.ts"),
  readRepoFile("web/lib/robomata/borrowingBase.ts"),
  readRepoFile("web/lib/robomata/submissionAdapters.ts"),
  readRepoFile("web/lib/robomata/facilityMonitoringProjection.ts"),
  readRepoFile("web/lib/robomata/server/agentRunner.ts"),
  readRepoFile("web/lib/robomata/server/agentStore.ts"),
  readRepoFile("web/components/robomata/AgentSupervisionPanel.tsx"),
]);

// Policy constants are compatibility defaults for constructing the visible artifact, not runtime imports.
assertIncludes(policyRules, "Compatibility defaults used to construct the platform-default artifact", "policy rules");
assertIncludes(policyRules, "parameters: {", "policy artifact parameters");
assertIncludes(policyRules, "borrowingBase: ROBOMATA_DEFAULT_BORROWING_BASE_PARAMETERS", "policy artifact parameters");
assertIncludes(policyRules, "getRobomataBorrowingBasePolicyParameters", "borrowing-base policy helper");
assertIncludes(policyRules, "resolveRobomataBorrowingBasePolicyParameters", "borrowing-base policy resolver");
assertIncludes(policyRules, "borrowingBaseParameters.advanceRateBps", "borrowing-base policy evaluation");

for (const [label, source] of [
  ["borrowing base", borrowingBase],
  ["submission adapters", submissionAdapters],
]) {
  assertIncludes(source, "resolveRobomataBorrowingBasePolicyParameters", label);
  assertNotIncludes(source, "ROBOMATA_DEFAULT_ADVANCE_RATE_BPS", label);
  assertNotIncludes(source, "ROBOMATA_DEFAULT_CONCENTRATION_LIMIT_PCT", label);
  assertNotIncludes(source, "ROBOMATA_MAX_DAYS_PAST_DUE", label);
  assertNotIncludes(source, "ROBOMATA_MIN_UTILIZATION_PCT", label);
}

assertIncludes(submissionAdapters, "resolveRobomataFacilityPolicyArtifact", "submission adapters");
assertIncludes(submissionAdapters, "policyArtifact", "submission adapters");

// Monitoring and agent proposal paths must retain active artifact rule provenance.
assertIncludes(
  facilityMonitoringProjection,
  "buildEvidenceFreshnessPolicyEvaluation",
  "facility monitoring projection",
);
assertIncludes(facilityMonitoringProjection, "buildPacketFreshnessPolicyEvaluation", "facility monitoring projection");
assertIncludes(facilityMonitoringProjection, "buildSuiRootPolicyEvaluation", "facility monitoring projection");
assertIncludes(facilityMonitoringProjection, "suiRootVerificationStatus", "facility monitoring projection");
assertIncludes(agentRunner, "policyArtifact.ruleSets.agentSupervision.rules.find", "agent runner");
assertIncludes(agentRunner, "policyRuleLabel", "agent runner");
assertIncludes(agentRunner, "policyRuleSummary", "agent runner");
assertIncludes(agentStore, "policyRuleLabel", "agent store");
assertIncludes(agentStore, "policyRuleSummary", "agent store");
assertIncludes(agentSupervisionPanel, "policyRuleLabel", "agent supervision panel");
assertIncludes(agentSupervisionPanel, "policyRuleSummary", "agent supervision panel");

console.log("Robomata policy artifact lookup smoke passed.");
