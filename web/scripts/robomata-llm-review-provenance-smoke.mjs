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

const [agentProviders, lenderPacket, reviewBoundaryPanel, submissionAdapters, featureFlags, liveMonitoringDoc] =
  await Promise.all([
    readRepoFile("web/lib/robomata/agentProviders.ts"),
    readRepoFile("web/lib/robomata/lenderPacket.ts"),
    readRepoFile("web/components/robomata/ReviewBoundaryPanel.tsx"),
    readRepoFile("web/lib/robomata/submissionAdapters.ts"),
    readRepoFile("web/lib/featureFlags.ts"),
    readRepoFile("docs/robomata-live-facility-monitoring.md"),
  ]);

assertIncludes(agentProviders, "ROBOMATA_AGENT_REVIEW_PROMPT_VERSION", "agent providers");
assertIncludes(agentProviders, "ROBOMATA_AGENT_REVIEW_OUTPUT_SCHEMA_VERSION", "agent providers");
assertIncludes(agentProviders, "inputDigest", "agent providers");
assertIncludes(agentProviders, "outputDigest", "agent providers");
assertIncludes(agentProviders, "sourceDataDigest", "agent providers");
assertIncludes(agentProviders, "providerInputDigest", "agent providers");
assertIncludes(agentProviders, "openAiProviderInput", "agent providers");
assertIncludes(agentProviders, "inputDigestSource: providerInput", "agent providers");
assertIncludes(agentProviders, "reviewInputId", "agent providers");
assertIncludes(agentProviders, "policyArtifactId", "agent providers");
assertIncludes(agentProviders, "policyArtifactVersion", "agent providers");
assertIncludes(agentProviders, "sha256Hex", "agent providers");
assertIncludes(agentProviders, "store: false", "agent providers");
assertIncludes(agentProviders, "AgentReviewSchemaInvalidError", "agent providers");
assertIncludes(agentProviders, 'parsed.exceptionReview.some(item => typeof item !== "string")', "agent providers");
assertIncludes(agentProviders, 'parsed.nextActions.some(item => typeof item !== "string")', "agent providers");
assertIncludes(agentProviders, '"schema_invalid_fallback"', "agent providers");
assertIncludes(agentProviders, '"configured_without_key"', "agent providers");
assertIncludes(agentProviders, '"configured_without_model"', "agent providers");
assertIncludes(agentProviders, '"live_error_fallback"', "agent providers");
assertIncludes(agentProviders, "ROBOMATA_LLM_REVIEW_ENABLED", "agent providers");
assertIncludes(featureFlags, "ROBOMATA_LLM_REVIEW_ENABLED", "feature flags");

assertIncludes(submissionAdapters, "policyArtifactId: policyArtifact.id", "submission adapters");
assertIncludes(submissionAdapters, "policyArtifactVersion: policyArtifact.version", "submission adapters");

for (const key of [
  "generatedAt",
  "inputDigest",
  "outputDigest",
  "outputSchemaVersion",
  "policyArtifactId",
  "policyArtifactVersion",
  "providerInputDigest",
  "promptVersion",
  "reviewInputId",
  "sourceDataDigest",
]) {
  assertIncludes(lenderPacket, key, "lender packet review boundary");
  assertIncludes(reviewBoundaryPanel, key, "review boundary panel");
}

assertIncludes(reviewBoundaryPanel, "shortDigest", "review boundary panel");
assertNotIncludes(reviewBoundaryPanel, "OPENAI_API_KEY", "review boundary panel");
assertNotIncludes(reviewBoundaryPanel, "ANTHROPIC_API_KEY", "review boundary panel");
assertNotIncludes(reviewBoundaryPanel, "GOOGLE_GENERATIVE_AI_API_KEY", "review boundary panel");

assertIncludes(liveMonitoringDoc, "store: false", "live monitoring docs");
assertIncludes(liveMonitoringDoc, "fall back to deterministic review output", "live monitoring docs");

console.log("Robomata LLM review provenance smoke passed.");
