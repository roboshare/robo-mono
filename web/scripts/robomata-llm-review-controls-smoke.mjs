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

const [agentProviders, lenderPacket, reviewBoundaryPanel, lenderPacketView, submissionWorkspace, packageJson, webPackageJson, doc] =
  await Promise.all([
    readRepoFile("web/lib/robomata/agentProviders.ts"),
    readRepoFile("web/lib/robomata/lenderPacket.ts"),
    readRepoFile("web/components/robomata/ReviewBoundaryPanel.tsx"),
    readRepoFile("web/components/robomata/LenderPacketView.tsx"),
    readRepoFile("web/components/robomata/SubmissionWorkspace.tsx"),
    readRepoFile("package.json"),
    readRepoFile("web/package.json"),
    readRepoFile("docs/robomata-live-facility-monitoring.md"),
  ]);

for (const needle of [
  "AgentReviewInputControls",
  "reviewInputControls",
  "allowedFields",
  "excludedMaterial",
  "rawEvidenceIncluded: false",
  "secretMaterialIncluded: false",
  "openAiExceptionRowLimit",
  "providerInputMaxTextLength",
  "boundedProviderText",
  "openAiProviderInput",
  "providerInputControls",
  "providerInputDigest",
  "sourceDataDigest",
]) {
  assertIncludes(agentProviders, needle, "agent providers");
}

for (const needle of [
  '"raw evidence bodies"',
  '"raw provider payloads"',
  '"API keys and secret env names"',
  '"Sui private keys"',
  '"Seal plaintext or ciphertext"',
  '"Walrus ciphertext"',
  '"share-link tokens"',
]) {
  assertIncludes(agentProviders, needle, "agent providers excluded material");
}

for (const status of [
  '"configured_without_feature_flag"',
  '"configured_without_key"',
  '"configured_without_model"',
  '"live_error_fallback"',
  '"schema_invalid_fallback"',
  '"live_completed"',
]) {
  assertIncludes(agentProviders, status, "agent provider status coverage");
}

for (const needle of [
  "diligenceQuestions",
  'parsed.diligenceQuestions.some(item => typeof item !== "string")',
  "schema_invalid_fallback",
]) {
  assertIncludes(agentProviders, needle, "structured review output");
  assertIncludes(lenderPacket, needle === "schema_invalid_fallback" ? "diligenceQuestions" : "diligenceQuestions", "lender packet");
}

for (const needle of [
  "providerInputControls",
  "providerInputDigest",
  "sourceDataDigest",
]) {
  assertIncludes(lenderPacket, needle, "lender packet boundary");
  assertIncludes(reviewBoundaryPanel, needle, "review boundary panel");
}

for (const needle of [
  "rawEvidenceIncluded",
  "secretMaterialIncluded",
]) {
  assertIncludes(reviewBoundaryPanel, needle, "review boundary panel");
}

assertIncludes(lenderPacketView, "Diligence questions", "lender packet view");
assertIncludes(submissionWorkspace, "Diligence questions", "submission workspace");

for (const secret of [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "ROBOMATA_AGENT_TICK_SECRET",
  "ROBOMATA_SHARE_LINK_TOKEN_SECRET",
  "ROBOMATA_SUI_PRIVATE_KEY",
  "ROBOMATA_SUI_SPONSOR_PRIVATE_KEY",
]) {
  assertNotIncludes(reviewBoundaryPanel, secret, "review boundary panel");
  assertNotIncludes(lenderPacketView, secret, "lender packet view");
  assertNotIncludes(submissionWorkspace, secret, "submission workspace");
}

assertIncludes(packageJson, "robomata:llm-review-controls-smoke", "root package scripts");
assertIncludes(webPackageJson, "robomata:llm-review-controls-smoke", "web package scripts");
assertIncludes(doc, "Provider API keys alone are not enough", "live monitoring docs");
assertIncludes(doc, "source-data digest", "live monitoring docs");

console.log("Robomata LLM review controls smoke passed.");
