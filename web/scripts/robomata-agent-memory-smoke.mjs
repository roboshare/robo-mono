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

const [flags, memory, planner, runner, store, envExample, rootPackageJson, webPackageJson, doc] = await Promise.all([
  readRepoFile("web/lib/featureFlags.ts"),
  readRepoFile("web/lib/robomata/server/agentMemory.ts"),
  readRepoFile("web/lib/robomata/server/agentPlanner.ts"),
  readRepoFile("web/lib/robomata/server/agentRunner.ts"),
  readRepoFile("web/lib/robomata/server/agentStore.ts"),
  readRepoFile("web/.env.example"),
  readRepoFile("package.json"),
  readRepoFile("web/package.json"),
  readRepoFile("docs/robomata-live-facility-monitoring.md"),
]);

assertIncludes(flags, "isRobomataAgentMemoryEnabled", "feature flags");

for (const needle of [
  "ROBOMATA_AGENT_MEMORY_ENABLED",
  "MEMWAL_ACCOUNT_ID",
  "MEMWAL_DELEGATE_KEY",
  "MEMWAL_SERVER_URL",
  "@mysten-incubation/memwal",
  "recallRobomataAgentMemory",
  "rememberRobomataAgentRunMemory",
  "configured_without_account",
  "configured_without_delegate_key",
  "sdk_unavailable",
  "remember_submitted",
]) {
  assertIncludes(memory, needle, "agent memory adapter");
}

for (const forbidden of ["Seal plaintext", "share-link tokens", "Sui private keys", "wallet signatures"]) {
  assertNotIncludes(memory, forbidden, "agent memory adapter");
}

for (const needle of [
  "memoryContext?: RobomataAgentMemoryContext",
  "recalledMemory",
  "memoryRecallStatus",
  "memoryRecallCount",
  "memwalNamespace",
  "\"MemWal delegate keys\"",
]) {
  assertIncludes(planner, needle, "agent planner memory context");
}

for (const needle of [
  "recallRobomataAgentMemory",
  "rememberRobomataAgentRunMemory",
  "memoryWriteStatus",
  "memoryWriteJobId",
]) {
  assertIncludes(runner, needle, "agent runner memory lifecycle");
}

for (const needle of ["memoryProvider", "memoryRecallCount", "memoryRecallStatus", "memwalNamespace"]) {
  assertIncludes(store, needle, "agent store memory provenance");
}

for (const needle of [
  "ROBOMATA_AGENT_MEMORY_ENABLED",
  "MEMWAL_ACCOUNT_ID",
  "MEMWAL_DELEGATE_KEY",
  "ROBOMATA_MEMWAL_NAMESPACE_PREFIX",
]) {
  assertIncludes(envExample, needle, ".env.example");
}

assertIncludes(rootPackageJson, "robomata:agent-memory-smoke", "root package scripts");
assertIncludes(webPackageJson, "robomata:agent-memory-smoke", "web package scripts");
assertIncludes(webPackageJson, "@mysten-incubation/memwal", "web package dependencies");
assertIncludes(doc, "Walrus Memory / MemWal Adapter", "live monitoring docs");

console.log("Robomata agent memory smoke passed.");
