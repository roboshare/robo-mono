#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { privateKeyToAccount } from "viem/accounts";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webDir, "..");
const defaultEnvPath = path.join(repoRoot, "protocols/sui/fixtures/testnet-env.generated.sh");
const port = process.env.ROBOMATA_SMOKE_PORT ?? "3217";
const baseUrl = `http://127.0.0.1:${port}`;
const serverTimeoutMs = Number.parseInt(process.env.ROBOMATA_SMOKE_SERVER_TIMEOUT_MS ?? "90000", 10);
const requestTimeoutMs = Number.parseInt(process.env.ROBOMATA_SMOKE_REQUEST_TIMEOUT_MS ?? "180000", 10);

let serverProcess;
let tempDir;

function parseExportLine(line) {
  const match = line.match(/^export\s+([A-Z0-9_]+)=(.*)$/);
  if (!match) return null;

  const [, key, rawValue] = match;
  let value = rawValue.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
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

async function activeSuiAddress(env) {
  const { stdout } = await execFileAsync("sui", [
    "client",
    "--client.config",
    requiredEnv(env, "ROBOMATA_SUI_CLIENT_CONFIG"),
    "active-address",
  ]);
  return stdout.trim();
}

async function activeSuiEnv(env) {
  const { stdout } = await execFileAsync("sui", [
    "client",
    "--client.config",
    requiredEnv(env, "ROBOMATA_SUI_CLIENT_CONFIG"),
    "active-env",
  ]);
  return stdout.trim();
}

async function assertSuiNetwork(env) {
  const expectedNetwork = requiredEnv(env, "ROBOMATA_SUI_NETWORK");
  const activeNetwork = await activeSuiEnv(env);
  if (activeNetwork !== expectedNetwork) {
    throw new Error(
      `ROBOMATA_SUI_CLIENT_CONFIG active env is ${activeNetwork}, expected ${expectedNetwork}.`,
    );
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

async function runSubmissionFlow({ authHeaders, submissionId }) {
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
  form.set("file", new File(["smoke evidence\n"], "smoke-evidence.txt", { type: "text/plain" }));
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

  const commitPayload = await postJson({
    authHeaders,
    requestPath: `/api/robomata/submissions/${submissionId}/commit-evidence`,
  });

  const evidence = evidencePayload.evidence;
  const commit = commitPayload.submission.evidenceCommit;
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

  return {
    submissionId,
    storageBackend: evidence.storageBackend,
    encryptionBackend: evidence.encryptionBackend,
    hasWalrusBlobId: Boolean(evidence.walrusBlobId),
    hasCiphertextDigest: Boolean(evidence.ciphertextDigest),
    sealIdentity: evidence.sealIdentity,
    commitStatus: commit.status,
    txDigest: commit.txDigest,
  };
}

async function main() {
  const { envPath, values } = await loadGeneratedEnv();
  const mergedEnv = { ...values, ...process.env };
  const privateKey = `0x${randomBytes(32).toString("hex")}`;
  const account = privateKeyToAccount(privateKey);
  const partnerAddress = account.address;
  await assertSuiNetwork(mergedEnv);
  const suiSignerAddress = await activeSuiAddress(mergedEnv);
  tempDir = await mkdtemp(path.join(tmpdir(), "robomata-smoke-"));
  const storeFile = path.join(tempDir, "submissions.json");
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
    ROBOMATA_AUTHORIZED_PARTNER_ADDRESSES: partnerAddress,
    ROBOMATA_SUBMISSIONS_FILE: storeFile,
    ROBOMATA_WALRUS_UPLOADS_ENABLED: "true",
    ROBOMATA_REQUIRE_REAL_EVIDENCE_STORAGE: "true",
    WALRUS_PUBLISHER_URL:
      mergedEnv.WALRUS_PUBLISHER_URL ?? "https://publisher.walrus-testnet.walrus.space",
    WALRUS_AGGREGATOR_URL:
      mergedEnv.WALRUS_AGGREGATOR_URL ?? "https://aggregator.walrus-testnet.walrus.space",
    ROBOMATA_SUI_COMMIT_ENABLED: "true",
    ROBOMATA_SUI_SIGNER_ADDRESS: suiSignerAddress,
  };

  const authHeaders = authHeaderBuilder({ account, partnerAddress });
  await startServer(baseEnv);
  const submissionId = await createSubmission({ authHeaders });
  const facilityId = requiredEnv(baseEnv, "ROBOMATA_SUI_FACILITY_ID");
  await bindFacilityToSubmission({
    storeFile,
    submissionId,
    facilityId,
    operatorAddress: suiSignerAddress,
  });
  const result = await runSubmissionFlow({ authHeaders, submissionId });

  console.log(
    JSON.stringify(
      {
        ...result,
        envPath,
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
