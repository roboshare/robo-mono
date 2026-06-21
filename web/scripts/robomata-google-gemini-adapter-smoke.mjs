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

const [gemini, agentProviders, agentPlanner, reviewPanel, supervisionPanel, packageJson, webPackageJson, doc] =
  await Promise.all([
    readRepoFile("web/lib/robomata/googleGemini.ts"),
    readRepoFile("web/lib/robomata/agentProviders.ts"),
    readRepoFile("web/lib/robomata/server/agentPlanner.ts"),
    readRepoFile("web/components/robomata/ReviewBoundaryPanel.tsx"),
    readRepoFile("web/components/robomata/AgentSupervisionPanel.tsx"),
    readRepoFile("package.json"),
    readRepoFile("web/package.json"),
    readRepoFile("docs/robomata-live-facility-monitoring.md"),
  ]);

for (const needle of [
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "https://generativelanguage.googleapis.com/v1beta/models",
  ":generateContent",
  "x-goog-api-key",
  "responseMimeType",
  "application/json",
  "GoogleGeminiApiError",
  "isGoogleGeminiRateLimitError",
  "jsonTextFromProviderOutput",
]) {
  assertIncludes(gemini, needle, "Google Gemini helper");
}

for (const needle of [
  'if (name === "google") return reviewWithGoogle(result, mockReview)',
  'reviewBoundaryInput("google", "live_completed", "llm_live", model)',
  'reviewBoundaryInput("google", "schema_invalid_fallback", "deterministic_fallback", model)',
  'reviewBoundaryInput("google", providerStatus, "deterministic_fallback", model)',
  '"live_error_fallback"',
  '"rate_limited_fallback"',
  "googleProviderInput",
  "generateGoogleGeminiContent",
  "isGoogleGeminiRateLimitError(error)",
  "providerInputControls: providerInput.userPrompt.inputControls",
]) {
  assertIncludes(agentProviders, needle, "agent providers");
}

for (const needle of [
  'provider === "openai" || provider === "google"',
  "planWithGoogle",
  'boundary("google", "schema_invalid_fallback", "deterministic_fallback", plannerBoundary.model)',
  '"live_error_fallback"',
  '"rate_limited_fallback"',
  "generateGoogleGeminiContent",
  "isGoogleGeminiRateLimitError(error)",
  "jsonTextFromProviderOutput(outputText)",
]) {
  assertIncludes(agentPlanner, needle, "agent planner");
}

assertNotIncludes(agentProviders, "Live google execution is intentionally stubbed", "agent providers");
assertNotIncludes(agentPlanner, "google planner is configured, but live action planning is stubbed", "agent planner");

for (const surface of [
  [reviewPanel, "review boundary panel"],
  [supervisionPanel, "agent supervision panel"],
]) {
  assertIncludes(surface[0], "Provider", surface[1]);
  assertNotIncludes(surface[0], "GOOGLE_GENERATIVE_AI_API_KEY", surface[1]);
  assertNotIncludes(surface[0], "GEMINI_API_KEY", surface[1]);
}

assertIncludes(packageJson, "robomata:google-gemini-adapter-smoke", "root package scripts");
assertIncludes(webPackageJson, "robomata:google-gemini-adapter-smoke", "web package scripts");
assertIncludes(doc, "ROBOMATA_AGENT_PROVIDER=google", "live monitoring docs");
assertIncludes(doc, "ROBOMATA_AGENT_PLANNER_PROVIDER=google", "live monitoring docs");
assertIncludes(doc, "GOOGLE_GENERATIVE_AI_API_KEY=<secret>", "live monitoring docs");
assertIncludes(doc, "not selectable by operators or lenders in the UI", "live monitoring docs");
assertNotIncludes(doc, "GEMINI_API_KEY", "live monitoring docs");

console.log("Robomata Google Gemini adapter smoke passed.");
