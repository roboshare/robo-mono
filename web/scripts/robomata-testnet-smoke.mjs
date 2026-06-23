#!/usr/bin/env node
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webDir, "..");
const defaultEnvPath = path.join(repoRoot, "protocols/sui/fixtures/testnet-env.generated.sh");
const port = process.env.ROBOMATA_SMOKE_PORT ?? "3217";
const baseUrl = `http://127.0.0.1:${port}`;
const serverTimeoutMs = Number.parseInt(process.env.ROBOMATA_SMOKE_SERVER_TIMEOUT_MS ?? "90000", 10);
const requestTimeoutMs = Number.parseInt(process.env.ROBOMATA_SMOKE_REQUEST_TIMEOUT_MS ?? "180000", 10);
const smokeEvidencePlaintext = "smoke evidence\n";
const smokeProfile = process.env.ROBOMATA_SMOKE_PROFILE ?? "testnet";
const isLocalSmoke = smokeProfile === "local";

let serverProcess;
let tempDir;

function parseExportLine(line) {
  const match = line.match(/^export\s+([A-Z0-9_]+)=(.*)$/);
  if (!match) return null;

  const [, key, rawValue] = match;
  let value = rawValue.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }

  return [key, value];
}

async function loadGeneratedEnv() {
  const envPath = process.env.ROBOMATA_SUI_TESTNET_ENV_PATH ?? defaultEnvPath;
  try {
    const raw = await readFile(envPath, "utf8");
    return {
      envPath,
      values: Object.fromEntries(raw.split(/\r?\n/g).map(parseExportLine).filter(Boolean)),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { envPath, values: {} };
    }
    throw error;
  }
}

function requiredEnv(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required for the Robomata testnet smoke.`);
  return value;
}

function suiSignerAddress(env) {
  const privateKey = requiredEnv(env, "ROBOMATA_SUI_PRIVATE_KEY");
  const decoded = decodeSuiPrivateKey(privateKey);

  switch (decoded.scheme) {
    case "ED25519":
      return Ed25519Keypair.fromSecretKey(decoded.secretKey).getPublicKey().toSuiAddress();
    case "Secp256k1":
      return Secp256k1Keypair.fromSecretKey(decoded.secretKey).getPublicKey().toSuiAddress();
    case "Secp256r1":
      return Secp256r1Keypair.fromSecretKey(decoded.secretKey).getPublicKey().toSuiAddress();
    default:
      throw new Error(`Unsupported Sui private key scheme: ${decoded.scheme}`);
  }
}

async function assertSmokePortAvailable() {
  if (!/^\d+$/.test(port)) {
    throw new Error(`ROBOMATA_SMOKE_PORT must be an integer port, got ${port}.`);
  }

  const numericPort = Number.parseInt(port, 10);
  if (numericPort <= 0 || numericPort > 65535) {
    throw new Error(`ROBOMATA_SMOKE_PORT must be an integer port, got ${port}.`);
  }

  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", error => {
      if (error?.code === "EADDRINUSE") {
        reject(new Error(`ROBOMATA_SMOKE_PORT ${port} is already in use.`));
        return;
      }
      reject(error);
    });
    probe.listen(numericPort, "127.0.0.1", () => {
      probe.close(resolve);
    });
  });
}

async function waitForServer() {
  const deadline = Date.now() + serverTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/partner/submissions`);
      if (response.ok) return;
    } catch {
      // Keep polling until the local dev server is ready.
    }

    if (serverProcess.exitCode !== null) {
      throw new Error(`Robomata smoke server exited early with code ${serverProcess.exitCode}.`);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for Robomata smoke server on ${baseUrl}.`);
}

async function startServer(env) {
  await assertSmokePortAvailable();
  serverProcess = spawn("yarn", ["start"], {
    cwd: repoRoot,
    detached: true,
    env,
    stdio: "ignore",
  });
  await waitForServer();
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  const pid = serverProcess.pid;
  if (!pid) return;
  const exited = new Promise(resolve => serverProcess.once("exit", resolve));
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    serverProcess.kill("SIGTERM");
  }
  const cleanExit = await Promise.race([
    exited.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 5000)),
  ]);
  if (cleanExit) return;

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    serverProcess.kill("SIGKILL");
  }
  await exited;
}

function authHeaderBuilder({ account, partnerAddress }) {
  return async function authHeaders(method, requestPath, extra = {}) {
    const timestamp = Date.now().toString();
    const signerAddress = account.address;
    const message = [
      "Robomata FacilitySubmission API access",
      `Method: ${method}`,
      `Path: ${requestPath}`,
      `Partner: ${partnerAddress.toLowerCase()}`,
      `Signer: ${signerAddress.toLowerCase()}`,
      `Timestamp: ${timestamp}`,
    ].join("\n");
    const signature = await account.signMessage({ message });

    return {
      ...extra,
      "x-robomata-auth-method": method,
      "x-robomata-auth-path": requestPath,
      "x-robomata-partner-address": partnerAddress,
      "x-robomata-signer-address": signerAddress,
      "x-robomata-auth-signature": signature,
      "x-robomata-auth-timestamp": timestamp,
    };
  };
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`${url} failed ${response.status}: ${JSON.stringify(payload)}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonExpectStatus(url, options, expectedStatus) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json();
    if (response.status !== expectedStatus) {
      throw new Error(
        `Expected ${url} to return ${expectedStatus}, got ${response.status}: ${JSON.stringify(payload)}`,
      );
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${url} failed ${response.status}: ${text}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyPublicRoutes() {
  const robomataHtml = await fetchText(`${baseUrl}/robomata`);
  if (!robomataHtml.includes("Make fleet receivables financeable before the lender asks twice.")) {
    throw new Error("Expected /robomata to render the public product headline.");
  }
  if (!robomataHtml.includes("/operator/submissions")) {
    throw new Error("Expected /robomata to include the operator submissions CTA.");
  }
  if (
    robomataHtml.includes("Keep Markets Live") ||
    robomataHtml.includes("Keep Partner Flows Live") ||
    robomataHtml.includes("First Customer")
  ) {
    throw new Error("Expected /robomata to exclude old demo/read-only projection copy.");
  }
  if (robomataHtml.includes("/api/robomata/submissions")) {
    throw new Error("Expected /robomata not to embed private submission API references.");
  }

  const submissionsHtml = await fetchText(`${baseUrl}/operator/submissions`);
  if (!submissionsHtml.includes("<html") || !submissionsHtml.includes("__next")) {
    throw new Error("Expected /operator/submissions to return the operator submissions app shell.");
  }

  return {
    publicRobomataRoute: "passed",
    operatorSubmissionsRoute: "passed",
  };
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fetchBytes(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`${url} failed ${response.status}: ${details}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyWalrusCiphertext({ evidence, plaintext }) {
  const aggregatorUrl = evidence.aggregatorUrl?.trim();
  if (!aggregatorUrl) {
    throw new Error("Expected Walrus aggregator URL on uploaded evidence.");
  }

  const ciphertextBytes = await fetchBytes(`${aggregatorUrl.replace(/\/$/, "")}/v1/blobs/${evidence.walrusBlobId}`);
  const fetchedDigest = `0x${sha256Hex(ciphertextBytes)}`;

  if (fetchedDigest !== evidence.ciphertextDigest) {
    throw new Error(
      `Fetched Walrus blob hash ${fetchedDigest} did not match ciphertext digest ${evidence.ciphertextDigest}.`,
    );
  }

  if (ciphertextBytes.includes(Buffer.from(plaintext))) {
    throw new Error("Fetched Walrus blob contains the plaintext evidence fixture.");
  }

  return {
    fetchedCiphertextBytes: ciphertextBytes.length,
    fetchedCiphertextDigest: fetchedDigest,
  };
}

async function createSubmission({ authHeaders }) {
  const requestPath = "/api/robomata/submissions";
  const payload = await fetchJson(`${baseUrl}${requestPath}`, {
    method: "POST",
    headers: await authHeaders("POST", requestPath, { "content-type": "application/json" }),
    body: JSON.stringify({
      operatorName: "SmokeFleet Logistics",
      facilityName: "SmokeFleet Testnet Facility",
      asOfDate: new Date().toISOString().slice(0, 10),
    }),
  });

  return payload.submission.id;
}

async function bindFacilityToSubmission({ storeFile, submissionId, facilityId, operatorAddress }) {
  const submissions = JSON.parse(await readFile(storeFile, "utf8"));
  const submission = submissions.find(candidate => candidate.id === submissionId);
  if (!submission) throw new Error(`Submission ${submissionId} was not found in the smoke file store.`);

  submission.evidenceCommit = {
    ...submission.evidenceCommit,
    facilityObjectId: facilityId,
    facilityOperatorAddress: operatorAddress,
  };
  await writeFile(storeFile, JSON.stringify(submissions, null, 2), "utf8");
}

async function postForm({ authHeaders, requestPath, form }) {
  return fetchJson(`${baseUrl}${requestPath}`, {
    method: "POST",
    headers: await authHeaders("POST", requestPath),
    body: form,
  });
}

async function postJson({ authHeaders, requestPath, body = {} }) {
  return fetchJson(`${baseUrl}${requestPath}`, {
    method: "POST",
    headers: await authHeaders("POST", requestPath, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

async function createShareLink({ authHeaders, submissionId, body = {} }) {
  const requestPath = `/api/robomata/submissions/${submissionId}/share-links`;
  return postJson({ authHeaders, requestPath, body });
}

async function revokeShareLink({ authHeaders, submissionId, shareLinkId }) {
  const requestPath = `/api/robomata/submissions/${submissionId}/share-links/${shareLinkId}`;
  return fetchJson(`${baseUrl}${requestPath}`, {
    method: "PATCH",
    headers: await authHeaders("PATCH", requestPath, { "content-type": "application/json" }),
    body: JSON.stringify({ status: "revoked" }),
  });
}

async function getShareLinks({ authHeaders, submissionId }) {
  const requestPath = `/api/robomata/submissions/${submissionId}/share-links`;
  return fetchJson(`${baseUrl}${requestPath}`, {
    method: "GET",
    headers: await authHeaders("GET", requestPath),
  });
}

async function getFacilityMonitoring({ authHeaders, submissionId }) {
  const requestPath = `/api/robomata/submissions/${submissionId}/facility-monitoring`;
  return fetchJson(`${baseUrl}${requestPath}`, {
    method: "GET",
    headers: await authHeaders("GET", requestPath),
  });
}

async function getFacilityMonitoringSuiRoots({ authHeaders, submissionId }) {
  const requestPath = `/api/robomata/submissions/${submissionId}/facility-monitoring/sui-roots`;
  return fetchJson(`${baseUrl}${requestPath}`, {
    method: "GET",
    headers: await authHeaders("GET", requestPath),
  });
}

async function getAgentPolicy({ authHeaders, submissionId }) {
  const requestPath = `/api/robomata/submissions/${submissionId}/agent-policy`;
  return fetchJson(`${baseUrl}${requestPath}`, {
    method: "GET",
    headers: await authHeaders("GET", requestPath),
  });
}

async function updateAgentPolicy({ authHeaders, submissionId, ...body }) {
  const requestPath = `/api/robomata/submissions/${submissionId}/agent-policy`;
  return fetchJson(`${baseUrl}${requestPath}`, {
    method: "PATCH",
    headers: await authHeaders("PATCH", requestPath, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

async function getAgentRuns({ authHeaders, submissionId }) {
  const requestPath = `/api/robomata/submissions/${submissionId}/agent-runs`;
  return fetchJson(`${baseUrl}${requestPath}`, {
    method: "GET",
    headers: await authHeaders("GET", requestPath),
  });
}

async function runAgent({ authHeaders, submissionId, body = {} }) {
  const requestPath = `/api/robomata/submissions/${submissionId}/agent-runs`;
  return fetchJson(`${baseUrl}${requestPath}`, {
    method: "POST",
    headers: await authHeaders("POST", requestPath, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

async function updateAgentAction({ actionId, authHeaders, decisionReason, status, submissionId }) {
  const requestPath = `/api/robomata/submissions/${submissionId}/agent-actions/${actionId}`;
  return fetchJson(`${baseUrl}${requestPath}`, {
    method: "PATCH",
    headers: await authHeaders("PATCH", requestPath, { "content-type": "application/json" }),
    body: JSON.stringify({ decisionReason, status }),
  });
}

async function tickAgents({ expectedStatus = 200, secret } = {}) {
  const requestPath = "/api/robomata/agents/tick";
  const headers = secret ? { "x-robomata-agent-tick-secret": secret } : undefined;
  return fetchJsonExpectStatus(
    `${baseUrl}${requestPath}`,
    {
      method: "POST",
      headers,
    },
    expectedStatus,
  );
}

async function verifyAgentSupervisionDisabled({ authHeaders, submissionId }) {
  const tickPayload = await tickAgents({ expectedStatus: 404, secret: "local-smoke-agent-secret" });
  if (tickPayload.error !== "Robomata agents are not enabled.") {
    throw new Error(`Expected disabled agent tick failure, got ${tickPayload.error}.`);
  }

  const policyPath = `/api/robomata/submissions/${submissionId}/agent-policy`;
  await fetchJsonExpectStatus(
    `${baseUrl}${policyPath}`,
    {
      method: "GET",
      headers: await authHeaders("GET", policyPath),
    },
    404,
  );

  const runsPath = `/api/robomata/submissions/${submissionId}/agent-runs`;
  await fetchJsonExpectStatus(
    `${baseUrl}${runsPath}`,
    {
      method: "GET",
      headers: await authHeaders("GET", runsPath),
    },
    404,
  );
  await fetchJsonExpectStatus(
    `${baseUrl}${runsPath}`,
    {
      method: "POST",
      headers: await authHeaders("POST", runsPath, { "content-type": "application/json" }),
      body: JSON.stringify({}),
    },
    404,
  );

  const actionPath = `/api/robomata/submissions/${submissionId}/agent-actions/agent_action_smoke_missing`;
  await fetchJsonExpectStatus(
    `${baseUrl}${actionPath}`,
    {
      method: "PATCH",
      headers: await authHeaders("PATCH", actionPath, { "content-type": "application/json" }),
      body: JSON.stringify({ status: "skipped" }),
    },
    404,
  );

  const workspaceHtml = await fetchText(`${baseUrl}/partner/submissions/${submissionId}`);
  if (workspaceHtml.includes("Agent supervision") || workspaceHtml.includes("Run check")) {
    throw new Error("Expected agent supervision UI to stay hidden while NEXT_PUBLIC_ROBOMATA_AGENTS_ENABLED is off.");
  }

  return {
    apiClosed: true,
    tickClosed: true,
    uiHidden: true,
  };
}

async function seedDanglingActiveAgentPolicy({ agentsFile, sourceSubmissionId }) {
  const raw = await readFile(agentsFile, "utf8");
  const agentStore = raw.trim() ? JSON.parse(raw) : { policies: [], runs: [], actions: [], events: [] };
  const sourcePolicy = agentStore.policies.find(policy => policy.submissionId === sourceSubmissionId);
  if (!sourcePolicy) {
    throw new Error(`Expected source agent policy for ${sourceSubmissionId} before seeding dangling policy.`);
  }

  const danglingPolicy = {
    ...sourcePolicy,
    id: "agent_policy_smoke_missing_submission",
    submissionId: "sub_seed_missing_agent_tick_submission",
    facilityId: "fac_seed_missing_agent_tick_submission",
    status: "active",
    updatedAt: new Date().toISOString(),
  };
  agentStore.policies = [
    danglingPolicy,
    ...agentStore.policies.filter(policy => policy.id !== danglingPolicy.id),
  ];
  await writeFile(agentsFile, JSON.stringify(agentStore, null, 2), "utf8");
  return danglingPolicy;
}

async function verifyAgentTickDeploymentPath({
  agentsFile,
  authHeaders,
  baseEnv,
  enabledEnv,
  sourceSubmissionId,
  storeFile,
  tickSecret,
}) {
  const disabledRefreshPayload = await tickAgents({ expectedStatus: 403, secret: tickSecret });
  if (disabledRefreshPayload.error !== "Robomata agent refresh is not enabled.") {
    throw new Error(`Expected disabled refresh failure, got ${disabledRefreshPayload.error}.`);
  }

  await stopServer();
  await startServer({
    ...enabledEnv,
    ROBOMATA_AGENT_REFRESH_ENABLED: "true",
    ROBOMATA_AGENT_TICK_SECRET: "",
  });
  const missingConfiguredSecret = await tickAgents({ expectedStatus: 500, secret: tickSecret });
  if (missingConfiguredSecret.error !== "ROBOMATA_AGENT_TICK_SECRET is not configured.") {
    throw new Error(`Expected missing configured tick secret failure, got ${missingConfiguredSecret.error}.`);
  }

  await stopServer();
  await startServer({
    ...enabledEnv,
    ROBOMATA_AGENT_REFRESH_ENABLED: "true",
    ROBOMATA_AGENT_TICK_SECRET: tickSecret,
  });
  const missingHeaderSecret = await tickAgents({ expectedStatus: 401 });
  if (missingHeaderSecret.error !== "Missing Robomata agent tick secret.") {
    throw new Error(`Expected missing tick header failure, got ${missingHeaderSecret.error}.`);
  }
  const wrongHeaderSecret = await tickAgents({ expectedStatus: 401, secret: "wrong-local-smoke-agent-secret" });
  if (wrongHeaderSecret.error !== "Invalid Robomata agent tick secret.") {
    throw new Error(`Expected wrong tick header failure, got ${wrongHeaderSecret.error}.`);
  }

  const emptyTick = await tickAgents({ secret: tickSecret });
  if (emptyTick.count !== 0 || emptyTick.results?.length !== 0) {
    throw new Error(`Expected zero active policies to produce an empty tick result, got ${JSON.stringify(emptyTick)}.`);
  }

  await updateAgentPolicy({
    authHeaders,
    autoApproveActionTypes: ["evidence_review", "packet_refresh", "sui_root_review"],
    status: "active",
    submissionId: sourceSubmissionId,
  });
  const danglingPolicy = await seedDanglingActiveAgentPolicy({ agentsFile, sourceSubmissionId });
  const submissionsBeforeTick = await readFile(storeFile, "utf8");
  const firstTick = await tickAgents({ secret: tickSecret });
  const submissionsAfterFirstTick = await readFile(storeFile, "utf8");
  const secondTick = await tickAgents({ secret: tickSecret });
  const submissionsAfterSecondTick = await readFile(storeFile, "utf8");

  if (submissionsBeforeTick !== submissionsAfterFirstTick || submissionsBeforeTick !== submissionsAfterSecondTick) {
    throw new Error("Expected repeated scheduled agent ticks not to mutate submissions.");
  }
  if (baseEnv.ROBOMATA_SUI_COMMIT_ENABLED !== "false") {
    throw new Error("Expected local scheduled tick smoke to keep Sui commit execution disabled.");
  }

  const firstStatuses = firstTick.results?.map(result => result.status).sort();
  if (JSON.stringify(firstStatuses) !== JSON.stringify(["completed", "failed"])) {
    throw new Error(`Expected mixed completed/failed tick results, got ${JSON.stringify(firstTick.results)}.`);
  }
  const completedResult = firstTick.results.find(result => result.status === "completed");
  const failedResult = firstTick.results.find(result => result.status === "failed");
  if (!completedResult?.runId || completedResult.actionCount < 1) {
    throw new Error(`Expected completed tick result with actions, got ${JSON.stringify(completedResult)}.`);
  }
  if (failedResult?.policyId !== danglingPolicy.id || failedResult.error !== "Submission not found.") {
    throw new Error(`Expected dangling policy to fail per-policy, got ${JSON.stringify(failedResult)}.`);
  }
  if (secondTick.count !== 2 || secondTick.results?.length !== 2) {
    throw new Error(`Expected repeated tick to process both active policies, got ${JSON.stringify(secondTick)}.`);
  }

  const persistedRuns = await getAgentRuns({ authHeaders, submissionId: sourceSubmissionId });
  const tickActions = persistedRuns.actions.filter(action => action.runId === completedResult.runId);
  if (!tickActions.length || tickActions.some(action => action.status !== "proposed")) {
    throw new Error("Expected scheduled tick actions to remain proposed even when policy auto-approve is configured.");
  }

  return {
    disabledAgentStatus: "Robomata agents are not enabled.",
    disabledRefreshStatus: disabledRefreshPayload.error,
    missingConfiguredSecretStatus: missingConfiguredSecret.error,
    missingHeaderSecretStatus: missingHeaderSecret.error,
    wrongHeaderSecretStatus: wrongHeaderSecret.error,
    zeroActivePolicyCount: emptyTick.count,
    firstTickCount: firstTick.count,
    firstTickStatuses: firstStatuses,
    repeatedTickCount: secondTick.count,
    scheduledActionsRemainProposed: true,
    submissionsUnchangedAfterRepeatedTicks: true,
    suiCommitExecutionDisabled: true,
  };
}

async function verifyFacilityMonitoringDisabled({ authHeaders, submissionId }) {
  const requestPath = `/api/robomata/submissions/${submissionId}/facility-monitoring`;
  await fetchJsonExpectStatus(
    `${baseUrl}${requestPath}`,
    {
      method: "GET",
      headers: await authHeaders("GET", requestPath),
    },
    404,
  );
  return "closed";
}

async function verifyFacilityMonitoringEnabled({
  authHeaders,
  expectedFacilityStatus,
  expectedObservationCount = 1,
  expectedObservationStatuses,
  expectedPacketManifestCount,
  expectedPacketFreshness,
  expectedRunHistoryCount,
  expectedSuiRootCommitCount,
  otherAuthHeaders,
  submissionId,
}) {
  const payload = await getFacilityMonitoring({ authHeaders, submissionId });
  const monitoring = payload.monitoring;
  if (!monitoring?.facility?.id || !monitoring.facility.id.startsWith("fac_")) {
    throw new Error("Expected facility monitoring projection to include a stable facility id.");
  }
  if (monitoring.facility.latestRunId !== monitoring.latestRun?.id) {
    throw new Error("Expected facility monitoring projection to link facility and latest run ids.");
  }
  if (monitoring.latestPacket?.runId !== monitoring.latestRun?.id) {
    throw new Error("Expected facility monitoring projection to pin the lender packet to the latest run.");
  }
  const expectedRuns = expectedRunHistoryCount ?? 1;
  if (monitoring.runHistory.length !== expectedRuns) {
    throw new Error(
      `Expected smoke monitoring projection to retain ${expectedRuns} runs, got ${monitoring.runHistory.length}.`,
    );
  }
  const expectedPackets = expectedPacketManifestCount ?? 1;
  if (monitoring.packetManifests.length !== expectedPackets) {
    throw new Error(
      `Expected smoke monitoring projection to retain ${expectedPackets} packet manifests, got ${monitoring.packetManifests.length}.`,
    );
  }
  if (expectedSuiRootCommitCount !== undefined && monitoring.suiRootCommits.length !== expectedSuiRootCommitCount) {
    throw new Error(
      `Expected smoke monitoring projection to retain ${expectedSuiRootCommitCount} Sui root commits, got ${monitoring.suiRootCommits.length}.`,
    );
  }
  const expectedFreshness = expectedPacketFreshness ?? "fresh";
  if (monitoring.freshnessStatus !== expectedFreshness) {
    throw new Error(
      `Expected smoke monitoring packet freshness to be ${expectedFreshness}, got ${monitoring.freshnessStatus}.`,
    );
  }
  if (monitoring.observations.length !== expectedObservationCount) {
    throw new Error(
      `Expected smoke monitoring projection to include ${expectedObservationCount} observations, got ${monitoring.observations.length}.`,
    );
  }
  if (monitoring.latestRun.inputObservationIds.length !== expectedObservationCount) {
    throw new Error(
      `Expected smoke monitoring run to include ${expectedObservationCount} observation inputs, got ${monitoring.latestRun.inputObservationIds.length}.`,
    );
  }
  const statuses = monitoring.observations.map(observation => observation.status).sort();
  if (expectedObservationStatuses) {
    const expectedStatuses = [...expectedObservationStatuses].sort();
    if (JSON.stringify(statuses) !== JSON.stringify(expectedStatuses)) {
      throw new Error(
        `Expected smoke monitoring observation statuses ${expectedStatuses.join(",")}, got ${statuses.join(",")}.`,
      );
    }
  }
  if (expectedFacilityStatus && monitoring.facility.status !== expectedFacilityStatus) {
    throw new Error(
      `Expected smoke monitoring facility status ${expectedFacilityStatus}, got ${monitoring.facility.status}.`,
    );
  }
  for (const observation of monitoring.observations) {
    if (observation.notes?.includes(smokeEvidencePlaintext) || observation.source.includes(smokeEvidencePlaintext)) {
      throw new Error("Expected monitoring projection not to expose raw evidence plaintext.");
    }
  }

  const requestPath = `/api/robomata/submissions/${submissionId}/facility-monitoring`;
  await fetchJsonExpectStatus(
    `${baseUrl}${requestPath}`,
    {
      method: "GET",
      headers: await otherAuthHeaders("GET", requestPath),
    },
    404,
  );
  if (expectedSuiRootCommitCount !== undefined) {
    const rootPayload = await getFacilityMonitoringSuiRoots({ authHeaders, submissionId });
    if (rootPayload.suiRootCommits?.length !== expectedSuiRootCommitCount) {
      throw new Error(
        `Expected Sui root endpoint to return ${expectedSuiRootCommitCount} roots, got ${rootPayload.suiRootCommits?.length}.`,
      );
    }
  }

  return {
    routeEnabled: true,
    facilityId: monitoring.facility.id,
    latestRunId: monitoring.latestRun.id,
    latestPacketId: monitoring.latestPacket.id,
    observationCount: monitoring.observations.length,
    observationStatuses: statuses,
    runInputObservationCount: monitoring.latestRun.inputObservationIds.length,
    runHistoryCount: monitoring.runHistory.length,
    packetManifestCount: monitoring.packetManifests.length,
    suiRootCommitCount: monitoring.suiRootCommits.length,
    suiRootStatus: monitoring.suiRootStatus,
    freshnessStatus: monitoring.freshnessStatus,
    facilityStatus: monitoring.facility.status,
    unauthorizedPartnerHidden: true,
  };
}

async function verifyAgentSupervisionLifecycle({ authHeaders, otherAuthHeaders, submissionId }) {
  const expectedActionTypes = ["evidence_review", "packet_refresh", "sui_root_review"];
  const policyPayload = await getAgentPolicy({ authHeaders, submissionId });
  if (policyPayload.policy?.status !== "paused") {
    throw new Error(`Expected default agent policy to be paused, got ${policyPayload.policy?.status}.`);
  }

  const runsPath = `/api/robomata/submissions/${submissionId}/agent-runs`;
  await fetchJsonExpectStatus(
    `${baseUrl}${runsPath}`,
    {
      method: "POST",
      headers: await authHeaders("POST", runsPath, { "content-type": "application/json" }),
      body: JSON.stringify({}),
    },
    409,
  );

  const policyPath = `/api/robomata/submissions/${submissionId}/agent-policy`;
  await fetchJsonExpectStatus(
    `${baseUrl}${policyPath}`,
    {
      method: "GET",
      headers: await otherAuthHeaders("GET", policyPath),
    },
    404,
  );
  await fetchJsonExpectStatus(
    `${baseUrl}${runsPath}`,
    {
      method: "GET",
      headers: await otherAuthHeaders("GET", runsPath),
    },
    404,
  );

  const activePolicyPayload = await updateAgentPolicy({ authHeaders, submissionId, status: "active" });
  if (activePolicyPayload.policy?.status !== "active") {
    throw new Error(`Expected activated agent policy, got ${activePolicyPayload.policy?.status}.`);
  }

  const runPayload = await runAgent({ authHeaders, submissionId });
  if (runPayload.run?.status !== "completed") {
    throw new Error(`Expected completed agent run, got ${runPayload.run?.status}.`);
  }
  if (!Array.isArray(runPayload.actions) || runPayload.actions.length < expectedActionTypes.length) {
    throw new Error(`Expected at least ${expectedActionTypes.length} proposed agent actions.`);
  }

  const actionTypes = runPayload.actions.map(action => action.type).sort();
  for (const expectedType of expectedActionTypes) {
    if (!actionTypes.includes(expectedType)) {
      throw new Error(`Expected agent run to propose ${expectedType}; got ${actionTypes.join(",")}.`);
    }
  }

  const [approveTarget, rejectTarget, skipTarget] = expectedActionTypes.map(expectedType => {
    const action = runPayload.actions.find(candidate => candidate.type === expectedType);
    if (!action) throw new Error(`Missing ${expectedType} action in agent run.`);
    return action;
  });

  const approvedPayload = await updateAgentAction({
    actionId: approveTarget.id,
    authHeaders,
    decisionReason: "Local smoke approval before completion.",
    status: "approved",
    submissionId,
  });
  const rejectedPayload = await updateAgentAction({
    actionId: rejectTarget.id,
    authHeaders,
    decisionReason: "Local smoke rejection path.",
    status: "rejected",
    submissionId,
  });
  const skippedPayload = await updateAgentAction({
    actionId: skipTarget.id,
    authHeaders,
    decisionReason: "Local smoke skip path.",
    status: "skipped",
    submissionId,
  });
  const completedPayload = await updateAgentAction({
    actionId: approveTarget.id,
    authHeaders,
    decisionReason: "Local smoke completion path.",
    status: "completed",
    submissionId,
  });

  const actionPath = `/api/robomata/submissions/${submissionId}/agent-actions/${approveTarget.id}`;
  await fetchJsonExpectStatus(
    `${baseUrl}${actionPath}`,
    {
      method: "PATCH",
      headers: await otherAuthHeaders("PATCH", actionPath, { "content-type": "application/json" }),
      body: JSON.stringify({ status: "skipped" }),
    },
    404,
  );

  const persistedPayload = await getAgentRuns({ authHeaders, submissionId });
  const persistedStatuses = Object.fromEntries(
    persistedPayload.actions.map(action => [action.id, action.status]),
  );
  const expectedStatuses = {
    [approveTarget.id]: "completed",
    [rejectTarget.id]: "rejected",
    [skipTarget.id]: "skipped",
  };
  for (const [actionId, expectedStatus] of Object.entries(expectedStatuses)) {
    if (persistedStatuses[actionId] !== expectedStatus) {
      throw new Error(`Expected persisted agent action ${actionId} to be ${expectedStatus}.`);
    }
  }

  const pausedPolicyPayload = await updateAgentPolicy({ authHeaders, submissionId, status: "paused" });
  if (pausedPolicyPayload.policy?.status !== "paused") {
    throw new Error(`Expected paused agent policy, got ${pausedPolicyPayload.policy?.status}.`);
  }
  await fetchJsonExpectStatus(
    `${baseUrl}${runsPath}`,
    {
      method: "POST",
      headers: await authHeaders("POST", runsPath, { "content-type": "application/json" }),
      body: JSON.stringify({}),
    },
    409,
  );

  return {
    policyDefaultStatus: policyPayload.policy.status,
    policyFinalStatus: pausedPolicyPayload.policy.status,
    pausedRunConflict: true,
    runId: runPayload.run.id,
    actionCount: runPayload.actions.length,
    actionTypes,
    persistedActionStatuses: {
      approvedThenCompleted: completedPayload.action.status,
      rejected: rejectedPayload.action.status,
      skipped: skippedPayload.action.status,
      approvedIntermediate: approvedPayload.action.status,
    },
    unauthorizedPartnerHidden: true,
  };
}

async function seedPriorMonitoringRun({ monitoringFile, submissionId }) {
  const monitoringStore = JSON.parse(await readFile(monitoringFile, "utf8"));
  const facilityId = `fac_${submissionId.replace(/^sub_/, "")}`;
  const latestRun = monitoringStore.runs.find(run => run.facilityId === facilityId);
  const latestPacket = latestRun
    ? monitoringStore.packetManifests.find(packet => packet.runId === latestRun.id)
    : undefined;
  if (!latestRun || !latestPacket) {
    throw new Error("Expected durable monitoring run and packet before seeding prior run history.");
  }

  const createdAt = new Date(Date.parse(latestRun.createdAt) - 86_400_000).toISOString();
  const priorRunId = `run_${submissionId}_previous`;
  const priorPacketId = `packet_${submissionId}_previous`;
  const priorRun = {
    ...latestRun,
    id: priorRunId,
    runNumber: Math.max(1, (latestRun.runNumber ?? 1) - 1),
    status: "stale",
    packetId: priorPacketId,
    rootDigest: `${latestRun.rootDigest}:previous`,
    createdAt,
    lockedAt: createdAt,
    committedAt: undefined,
  };
  const priorPacket = {
    ...latestPacket,
    id: priorPacketId,
    runId: priorRunId,
    runDigest: priorRun.rootDigest || priorRun.inputDigest,
    freshnessStatus: "superseded",
    generatedAt: createdAt,
  };

  monitoringStore.runs.unshift(priorRun);
  monitoringStore.packetManifests.unshift(priorPacket);
  await writeFile(monitoringFile, JSON.stringify(monitoringStore, null, 2), "utf8");
  return { priorPacketId, priorRunId };
}

async function seedMonitoringFreshnessFixtures({ baseSubmissionId, monitoringFile, partnerAddress, storeFile }) {
  const submissions = JSON.parse(await readFile(storeFile, "utf8"));
  const baseSubmission = submissions.find(submission => submission.id === baseSubmissionId);
  if (!baseSubmission?.computation) {
    throw new Error(`Base monitoring submission ${baseSubmissionId} was not found or has no computation.`);
  }

  const monitoringStore = JSON.parse(await readFile(monitoringFile, "utf8"));
  const baseFacilityId =
    baseSubmission.facilityMonitoring?.facilityId ?? `fac_${baseSubmissionId.replace(/^sub_/, "")}`;
  const baseRun = monitoringStore.runs.find(run => run.facilityId === baseFacilityId);
  const basePacket = baseRun ? monitoringStore.packetManifests.find(packet => packet.runId === baseRun.id) : undefined;
  if (!baseRun || !basePacket) {
    throw new Error("Expected base durable monitoring run and packet before seeding freshness fixtures.");
  }

  const fixtureCases = [
    {
      key: "stale_observation",
      expectedFacilityStatus: "packet_stale",
      expectedFreshness: "stale",
      observations: [
        {
          kind: "insurance",
          status: "stale",
          source: "Seeded insurance policy monitor",
        },
      ],
    },
    {
      key: "expired_observation",
      expectedFacilityStatus: "needs_review",
      expectedFreshness: "invalid",
      observations: [
        {
          expiresAt: "2026-01-01T00:00:00.000Z",
          kind: "insurance",
          status: "expired",
          source: "Seeded expired insurance policy monitor",
        },
      ],
    },
    {
      key: "superseded_observation",
      expectedFacilityStatus: "packet_stale",
      expectedFreshness: "stale",
      observations: [
        {
          id: "old",
          kind: "maintenance",
          observedAtOffsetMs: -60_000,
          status: "superseded",
          source: "Seeded superseded maintenance monitor",
        },
        {
          id: "replacement",
          kind: "maintenance",
          status: "fresh",
          supersedesObservationId: "old",
          source: "Seeded replacement maintenance monitor",
        },
      ],
    },
    {
      key: "stale_packet",
      expectedFacilityStatus: "packet_stale",
      expectedFreshness: "stale",
      packetFreshnessStatus: "stale",
      observations: [
        {
          kind: "receivables_aging",
          status: "fresh",
          source: "Seeded fresh receivables monitor",
        },
      ],
    },
    {
      key: "superseded_packet",
      expectedFacilityStatus: "packet_stale",
      expectedFreshness: "superseded",
      packetFreshnessStatus: "superseded",
      observations: [
        {
          kind: "receivables_aging",
          status: "fresh",
          source: "Seeded fresh receivables monitor for superseded packet",
        },
      ],
    },
    {
      key: "refresh_available",
      expectedFacilityStatus: "needs_review",
      expectedFreshness: "refresh_available",
      observations: [
        {
          kind: "utilization",
          status: "warning",
          source: "Seeded utilization monitor warning",
        },
      ],
    },
  ];

  const seededSubmissionIds = [];
  for (const fixtureCase of fixtureCases) {
    const submissionId = `sub_seed_${fixtureCase.key}`;
    const facilityId = `fac_seed_${fixtureCase.key}`;
    const runId = `run_${submissionId}`;
    const packetId = `packet_${submissionId}`;
    const createdAt = new Date(Date.parse(baseRun.createdAt) + seededSubmissionIds.length * 1_000).toISOString();
    const seededSubmission = {
      ...baseSubmission,
      id: submissionId,
      evidence: [],
      facilityName: `${baseSubmission.facilityName} ${fixtureCase.key}`,
      facilityMonitoring: {
        facilityId,
        latestPacketId: packetId,
        latestRunId: runId,
        packetFreshnessStatus: fixtureCase.packetFreshnessStatus ?? fixtureCase.expectedFreshness,
        status: fixtureCase.expectedFacilityStatus,
      },
      evidenceCommit: {
        ...baseSubmission.evidenceCommit,
        facilityObjectId: `0xseed${fixtureCase.key.replace(/_/g, "")}`,
        facilityOperatorAddress: partnerAddress,
      },
      createdAt,
      updatedAt: createdAt,
    };
    seededSubmissionIds.push({
      expectedFacilityStatus: fixtureCase.expectedFacilityStatus,
      expectedFreshness: fixtureCase.expectedFreshness,
      expectedObservationStatuses: fixtureCase.observations.map(observation => observation.status),
      submissionId,
    });
    submissions.unshift(seededSubmission);

    const seededObservations = fixtureCase.observations.map((observation, index) => {
      const observationId = `obs_${submissionId}_${observation.id ?? index + 1}`;
      const observedAt = new Date(Date.parse(createdAt) + (observation.observedAtOffsetMs ?? 0)).toISOString();
      const supersedesObservationId =
        observation.supersedesObservationId === "old" ? `obs_${submissionId}_old` : observation.supersedesObservationId;
      return {
        id: observationId,
        facilityId,
        kind: observation.kind,
        source: observation.source,
        observedAt,
        expiresAt: observation.expiresAt,
        supersedesObservationId,
        status: observation.status,
        confidence: "operator_attested",
        linkedAssetIds: [],
        linkedReceivableIds: seededSubmission.receivables.map(receivable => receivable.id),
        digest: `seed:${fixtureCase.key}:${observationId}`,
        storageRef: `seed://${fixtureCase.key}/${observationId}`,
        notes: `Seeded ${observation.status} ${observation.kind} observation.`,
      };
    });
    const seededRun = {
      ...baseRun,
      id: runId,
      facilityId,
      inputObservationIds: seededObservations.map(observation => observation.id),
      packetId,
      createdAt,
      lockedAt: createdAt,
    };
    const seededPacket = {
      ...basePacket,
      id: packetId,
      facilityId,
      runId,
      evidenceObservationIds: seededRun.inputObservationIds,
      freshnessStatus: fixtureCase.packetFreshnessStatus ?? "fresh",
      generatedAt: createdAt,
    };

    monitoringStore.facilities.unshift({
      id: facilityId,
      partnerAddress,
      operatorName: seededSubmission.operatorName,
      facilityName: seededSubmission.facilityName,
      status: fixtureCase.expectedFacilityStatus,
      latestRunId: runId,
      latestPacketId: packetId,
      suiFacilityObjectId: seededSubmission.evidenceCommit.facilityObjectId,
      facilityOperatorAddress: seededSubmission.evidenceCommit.facilityOperatorAddress,
      createdAt,
      updatedAt: createdAt,
    });
    monitoringStore.observations.unshift(...seededObservations);
    monitoringStore.runs.unshift(seededRun);
    monitoringStore.packetManifests.unshift(seededPacket);
  }

  await writeFile(storeFile, JSON.stringify(submissions, null, 2), "utf8");
  await writeFile(monitoringFile, JSON.stringify(monitoringStore, null, 2), "utf8");
  return seededSubmissionIds;
}

async function runShareLinkFlow({ authHeaders, expectMonitoring = false, submissionId, facilityName }) {
  const activePayload = await createShareLink({
    authHeaders,
    submissionId,
    body: { recipientLabel: "Smoke lender credit team" },
  });
  if (!activePayload.shareLink?.id || !activePayload.token || !activePayload.url || !activePayload.apiUrl) {
    throw new Error("Expected share-link create response to include shareLink, token, url, and apiUrl.");
  }
  if (!activePayload.url.includes(`/lender/packet/${activePayload.token}`)) {
    throw new Error(`Expected share-link url to target the lender packet page, got ${activePayload.url}.`);
  }
  if (expectMonitoring) {
    if (!activePayload.shareLink.metadata?.runId || !activePayload.shareLink.metadata?.packetManifestId) {
      throw new Error("Expected monitoring-enabled share link to include run and packet manifest metadata.");
    }
  } else if (activePayload.shareLink.metadata?.runId || activePayload.shareLink.metadata?.packetManifestId) {
    throw new Error("Expected legacy share link not to include monitoring run metadata.");
  }

  const packetPayload = await fetchJson(activePayload.apiUrl);
  if (packetPayload.packet?.submission?.facilityName !== facilityName) {
    throw new Error("Expected protected share API to return the lender packet for the smoke submission.");
  }
  if (expectMonitoring) {
    if (packetPayload.packet?.monitoring?.runId !== activePayload.shareLink.metadata.runId) {
      throw new Error("Expected protected share API to return the run-pinned monitoring packet.");
    }
    if (packetPayload.packet?.monitoring?.packetFreshnessStatus !== "fresh") {
      throw new Error("Expected monitoring share packet freshness to be fresh.");
    }
  } else if (packetPayload.packet?.monitoring) {
    throw new Error("Expected legacy protected share API response not to include monitoring details.");
  }

  const lenderPacketHtml = await fetchText(activePayload.url);
  if (!lenderPacketHtml.includes("Lender packet") || !lenderPacketHtml.includes(facilityName)) {
    throw new Error("Expected lender packet page HTML to render the packet heading and facility name.");
  }

  const shareLinksAfterAccess = await getShareLinks({ authHeaders, submissionId });
  const accessedLink = shareLinksAfterAccess.shareLinks?.find(link => link.id === activePayload.shareLink.id);
  if (!accessedLink || accessedLink.accessCount < 2 || !accessedLink.lastAccessedAt) {
    throw new Error("Expected share-link access count and last-access metadata after API and page views.");
  }

  const revokePayload = await revokeShareLink({
    authHeaders,
    submissionId,
    shareLinkId: activePayload.shareLink.id,
  });
  if (revokePayload.shareLink?.status !== "revoked") {
    throw new Error("Expected share-link revocation to persist revoked status.");
  }
  await fetchJsonExpectStatus(activePayload.apiUrl, undefined, 410);

  const expiringPayload = await createShareLink({
    authHeaders,
    submissionId,
    body: {
      recipientLabel: "Smoke expiring lender link",
      expiresAt: new Date(Date.now() + 2_500).toISOString(),
    },
  });
  await new Promise(resolve => setTimeout(resolve, 3_000));
  await fetchJsonExpectStatus(expiringPayload.apiUrl, undefined, 410);
  const shareLinksAfterExpiry = await getShareLinks({ authHeaders, submissionId });
  const expiredLink = shareLinksAfterExpiry.shareLinks?.find(link => link.id === expiringPayload.shareLink.id);
  if (expiredLink?.status !== "expired") {
    throw new Error("Expected expired share link to be listed with expired status.");
  }

  return {
    activeShareLinkId: activePayload.shareLink.id,
    activeShareLinkStatus: revokePayload.shareLink.status,
    activeShareLinkAccessCount: accessedLink.accessCount,
    expiredShareLinkId: expiringPayload.shareLink.id,
    expiredShareLinkStatus: expiredLink.status,
    monitoringPacketManifestId: activePayload.shareLink.metadata?.packetManifestId,
    monitoringRunId: activePayload.shareLink.metadata?.runId,
    lenderPacketPageRendered: true,
  };
}

async function runSubmissionFlow({ authHeaders, includeShareLinks = true, submissionId, requireTestnetEvidence }) {
  const csv = [
    "id,obligor,vehicles,outstanding,dpd,utilization,insured,title,lockbox",
    "AR-SMOKE-1,North Smoke Logistics,10,100000,5,91,true,true,true",
    "AR-SMOKE-2,South Smoke Services,8,90000,12,88,true,true,true",
    "AR-SMOKE-3,West Smoke Repair,6,80000,18,84,true,true,true",
  ].join("\n");

  let form = new FormData();
  form.set("file", new File([csv], "smoke-receivables.csv", { type: "text/csv" }));
  await postForm({
    authHeaders,
    requestPath: `/api/robomata/submissions/${submissionId}/receivables/import`,
    form,
  });

  form = new FormData();
  form.set("label", "Smoke receivables aging");
  form.set("source", "Automated ROB-134 smoke test");
  form.set("scope", "Receivables");
  form.set("status", "verified");
  form.set("sealPolicyId", "seal://policy/lender-auditor-read");
  form.set("file", new File([smokeEvidencePlaintext], "smoke-evidence.txt", { type: "text/plain" }));
  const evidencePayload = await postForm({
    authHeaders,
    requestPath: `/api/robomata/submissions/${submissionId}/evidence`,
    form,
  });

  const computePayload = await postJson({
    authHeaders,
    requestPath: `/api/robomata/submissions/${submissionId}/compute`,
  });
  const exceptionCount = computePayload.submission.computation.borrowingBase.exceptionCount;
  if (exceptionCount !== 0) {
    throw new Error(`Expected zero smoke exceptions, got ${exceptionCount}.`);
  }

  const evidence = evidencePayload.evidence;
  let commit = { status: "skipped", txDigest: undefined };
  let walrusProof = { fetchedCiphertextBytes: undefined, fetchedCiphertextDigest: undefined };

  if (requireTestnetEvidence) {
    const commitPayload = await postJson({
      authHeaders,
      requestPath: `/api/robomata/submissions/${submissionId}/commit-evidence`,
    });

    commit = commitPayload.submission.evidenceCommit;
    if (evidence.storageBackend !== "walrus") {
      throw new Error(`Expected storageBackend=walrus, got ${evidence.storageBackend}.`);
    }
    if (evidence.encryptionBackend !== "seal") {
      throw new Error(`Expected encryptionBackend=seal, got ${evidence.encryptionBackend}.`);
    }
    if (!evidence.walrusBlobId || !evidence.ciphertextDigest) {
      throw new Error("Expected Walrus blob metadata and ciphertext digest on uploaded evidence.");
    }
    if (commit.status !== "committed" || !commit.txDigest) {
      throw new Error(`Expected committed Sui evidence state, got ${commit.status}.`);
    }

    walrusProof = await verifyWalrusCiphertext({
      evidence,
      plaintext: smokeEvidencePlaintext,
    });
  } else {
    if (evidence.storageBackend !== "walrus-mock") {
      throw new Error(`Expected local smoke storageBackend=walrus-mock, got ${evidence.storageBackend}.`);
    }
    if (evidence.encryptionBackend !== "none") {
      throw new Error(`Expected local smoke encryptionBackend=none, got ${evidence.encryptionBackend}.`);
    }
  }
  const shareLinkProof = includeShareLinks
    ? await runShareLinkFlow({
        authHeaders,
        submissionId,
        facilityName: computePayload.submission.facilityName,
      })
    : undefined;

  return {
    submissionId,
    facilityName: computePayload.submission.facilityName,
    storageBackend: evidence.storageBackend,
    encryptionBackend: evidence.encryptionBackend,
    walrusBlobId: evidence.walrusBlobId,
    ciphertextDigest: evidence.ciphertextDigest,
    fetchedCiphertextBytes: walrusProof.fetchedCiphertextBytes,
    fetchedCiphertextDigest: walrusProof.fetchedCiphertextDigest,
    plaintextDigest: evidence.plaintextDigest,
    sealIdentity: evidence.sealIdentity,
    commitStatus: commit.status,
    txDigest: commit.txDigest,
    ...(shareLinkProof ? { shareLinks: shareLinkProof } : {}),
  };
}

async function main() {
  if (smokeProfile !== "testnet" && smokeProfile !== "local") {
    throw new Error(`Unsupported ROBOMATA_SMOKE_PROFILE=${smokeProfile}. Use "testnet" or "local".`);
  }

  const { envPath, values } = await loadGeneratedEnv();
  const mergedEnv = { ...values, ...process.env };
  const privateKey = `0x${randomBytes(32).toString("hex")}`;
  const account = privateKeyToAccount(privateKey);
  const partnerAddress = account.address;
  const otherAccount = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
  const otherPartnerAddress = otherAccount.address;
  if (!isLocalSmoke) requiredEnv(mergedEnv, "ROBOMATA_SUI_NETWORK");
  const activeSuiSignerAddress = isLocalSmoke ? undefined : suiSignerAddress(mergedEnv);
  tempDir = await mkdtemp(path.join(tmpdir(), "robomata-smoke-"));
  const storeFile = path.join(tempDir, "submissions.json");
  const shareLinksFile = path.join(tempDir, "share-links.json");
  const monitoringFile = path.join(tempDir, "facility-monitoring.json");
  const agentsFile = path.join(tempDir, "agents.json");
  await writeFile(storeFile, "", "utf8");

  const baseEnv = {
    ...mergedEnv,
    POSTGRES_URL: "",
    POSTGRES_URL_NON_POOLING: "",
    DATABASE_URL: "",
    PORT: port,
    NEXT_PUBLIC_ENABLE_ROBOMATA_WORKFLOW: "true",
    ROBOMATA_WORKFLOW_ENABLED: "true",
    ROBOMATA_WORKFLOW_MUTATIONS_ENABLED: "true",
    ROBOMATA_AUTHORIZED_PARTNER_ADDRESSES: `${partnerAddress},${otherPartnerAddress}`,
    ROBOMATA_SUBMISSIONS_FILE: storeFile,
    ROBOMATA_SHARE_LINKS_FILE: shareLinksFile,
    ROBOMATA_FACILITY_MONITORING_FILE: monitoringFile,
    ROBOMATA_AGENTS_FILE: agentsFile,
    ROBOMATA_FACILITY_MONITORING_ENABLED: "",
    NEXT_PUBLIC_ROBOMATA_FACILITY_MONITORING_ENABLED: "",
    ROBOMATA_FACILITY_MONITORING_REFRESH_ENABLED: "",
    ROBOMATA_AGENTS_ENABLED: "",
    NEXT_PUBLIC_ROBOMATA_AGENTS_ENABLED: "",
    ROBOMATA_AGENT_MUTATIONS_ENABLED: "",
    ROBOMATA_AGENT_REFRESH_ENABLED: "",
    ROBOMATA_AGENT_TICK_SECRET: "local-smoke-agent-secret",
    ROBOMATA_LENDER_MONITORING_SHARE_ENABLED: "",
    NEXT_PUBLIC_ROBOMATA_LENDER_MONITORING_SHARE_ENABLED: "",
    ROBOMATA_SHARE_LINKS_ENABLED: "true",
    NEXT_PUBLIC_ROBOMATA_SHARE_LINKS_ENABLED: "true",
    ROBOMATA_WALRUS_UPLOADS_ENABLED: isLocalSmoke ? "false" : "true",
    ROBOMATA_REQUIRE_REAL_EVIDENCE_STORAGE: isLocalSmoke ? "false" : "true",
    WALRUS_PUBLISHER_URL: mergedEnv.WALRUS_PUBLISHER_URL ?? "https://publisher.walrus-testnet.walrus.space",
    WALRUS_AGGREGATOR_URL: mergedEnv.WALRUS_AGGREGATOR_URL ?? "https://aggregator.walrus-testnet.walrus.space",
    ROBOMATA_SUI_COMMIT_ENABLED: isLocalSmoke ? "false" : "true",
    ...(activeSuiSignerAddress ? { ROBOMATA_SUI_SIGNER_ADDRESS: activeSuiSignerAddress } : {}),
  };

  const authHeaders = authHeaderBuilder({ account, partnerAddress });
  const otherAuthHeaders = authHeaderBuilder({ account: otherAccount, partnerAddress: otherPartnerAddress });
  await startServer(baseEnv);
  const publicRoutes = await verifyPublicRoutes();
  const submissionId = await createSubmission({ authHeaders });
  if (!isLocalSmoke) {
    const facilityId = requiredEnv(baseEnv, "ROBOMATA_SUI_FACILITY_ID");
    await bindFacilityToSubmission({
      storeFile,
      submissionId,
      facilityId,
      operatorAddress: activeSuiSignerAddress,
    });
  }
  const result = await runSubmissionFlow({ authHeaders, submissionId, requireTestnetEvidence: !isLocalSmoke });
  const monitoringFlagOff = await verifyFacilityMonitoringDisabled({ authHeaders, submissionId });
  const agentFlagOff = await verifyAgentSupervisionDisabled({ authHeaders, submissionId });

  await stopServer();
  const enabledAgentEnv = {
    ...baseEnv,
    ROBOMATA_FACILITY_MONITORING_ENABLED: "true",
    ROBOMATA_LENDER_MONITORING_SHARE_ENABLED: "true",
    ROBOMATA_AGENTS_ENABLED: "true",
    ROBOMATA_AGENT_MUTATIONS_ENABLED: "true",
    NEXT_PUBLIC_ROBOMATA_FACILITY_MONITORING_ENABLED: "true",
    NEXT_PUBLIC_ROBOMATA_LENDER_MONITORING_SHARE_ENABLED: "true",
    NEXT_PUBLIC_ROBOMATA_AGENTS_ENABLED: "true",
  };
  await startServer(enabledAgentEnv);
  const monitoring = await verifyFacilityMonitoringEnabled({ authHeaders, otherAuthHeaders, submissionId });
  let durableMonitoring;
  if (isLocalSmoke) {
    const monitoredSubmissionId = await createSubmission({ authHeaders });
    const monitoredResult = await runSubmissionFlow({
      authHeaders,
      includeShareLinks: false,
      submissionId: monitoredSubmissionId,
      requireTestnetEvidence: false,
    });
    durableMonitoring = await verifyFacilityMonitoringEnabled({
      authHeaders,
      expectedObservationCount: 2,
      expectedSuiRootCommitCount: 2,
      otherAuthHeaders,
      submissionId: monitoredSubmissionId,
    });
    durableMonitoring.seededPriorRun = await seedPriorMonitoringRun({
      monitoringFile,
      submissionId: monitoredSubmissionId,
    });
    durableMonitoring = {
      ...durableMonitoring,
      ...(await verifyFacilityMonitoringEnabled({
        authHeaders,
        expectedObservationCount: 2,
        expectedPacketManifestCount: 2,
        expectedRunHistoryCount: 2,
        expectedSuiRootCommitCount: 2,
        otherAuthHeaders,
        submissionId: monitoredSubmissionId,
      })),
      seededPriorRun: durableMonitoring.seededPriorRun,
    };
    durableMonitoring.monitoringShareLinks = await runShareLinkFlow({
      authHeaders,
      expectMonitoring: true,
      facilityName: monitoredResult.facilityName,
      submissionId: monitoredSubmissionId,
    });
    const seededMonitoringCases = await seedMonitoringFreshnessFixtures({
      baseSubmissionId: monitoredSubmissionId,
      monitoringFile,
      partnerAddress,
      storeFile,
    });
    durableMonitoring.seededFreshnessCases = [];
    let expiredObservationSubmissionId;
    for (const seededCase of seededMonitoringCases) {
      if (seededCase.submissionId === "sub_seed_expired_observation") {
        expiredObservationSubmissionId = seededCase.submissionId;
      }
      durableMonitoring.seededFreshnessCases.push(
        await verifyFacilityMonitoringEnabled({
          authHeaders,
          expectedFacilityStatus: seededCase.expectedFacilityStatus,
          expectedObservationCount: seededCase.expectedObservationStatuses.length,
          expectedObservationStatuses: seededCase.expectedObservationStatuses,
          expectedPacketFreshness: seededCase.expectedFreshness,
          otherAuthHeaders,
          submissionId: seededCase.submissionId,
        }),
      );
    }
    if (!expiredObservationSubmissionId) {
      throw new Error("Expected local smoke freshness fixtures to include sub_seed_expired_observation.");
    }
    durableMonitoring.agentSupervision = await verifyAgentSupervisionLifecycle({
      authHeaders,
      otherAuthHeaders,
      submissionId: expiredObservationSubmissionId,
    });
    durableMonitoring.agentTick = await verifyAgentTickDeploymentPath({
      agentsFile,
      authHeaders,
      baseEnv,
      enabledEnv: enabledAgentEnv,
      sourceSubmissionId: expiredObservationSubmissionId,
      storeFile,
      tickSecret: baseEnv.ROBOMATA_AGENT_TICK_SECRET,
    });
  }

  console.log(
    JSON.stringify(
      {
        smokeProfile,
        publicRoutes,
        facilityMonitoring: {
          flagOff: monitoringFlagOff,
          ...monitoring,
          ...(durableMonitoring ? { durableLocalStore: durableMonitoring } : {}),
        },
        agentSupervision: {
          flagOff: agentFlagOff,
          ...(durableMonitoring?.agentSupervision ? { durableLocalStore: durableMonitoring.agentSupervision } : {}),
          ...(durableMonitoring?.agentTick ? { scheduledTick: durableMonitoring.agentTick } : {}),
        },
        ...result,
        ...(isLocalSmoke ? {} : { envPath }),
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} finally {
  await stopServer();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
}
