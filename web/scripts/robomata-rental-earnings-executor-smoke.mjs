#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webDir, "..");
const port = process.env.ROBOMATA_RENTAL_EARNINGS_EXECUTOR_SMOKE_PORT ?? "3231";
const baseUrl = `http://127.0.0.1:${port}`;
const requestTimeoutMs = Number.parseInt(
  process.env.ROBOMATA_RENTAL_EARNINGS_EXECUTOR_SMOKE_REQUEST_TIMEOUT_MS ?? "45000",
  10,
);
const serverTimeoutMs = Number.parseInt(
  process.env.ROBOMATA_RENTAL_EARNINGS_EXECUTOR_SMOKE_SERVER_TIMEOUT_MS ?? "90000",
  10,
);
const chainId = "31337";

let serverProcess;
let tempDir;

function nowIso(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString();
}

function createAccount() {
  return privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
}

async function assertPortAvailable() {
  const numericPort = Number.parseInt(port, 10);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
    throw new Error(`ROBOMATA_RENTAL_EARNINGS_EXECUTOR_SMOKE_PORT must be a valid port, got ${port}.`);
  }
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(numericPort, "127.0.0.1", () => probe.close(resolve));
  });
}

async function fetchJsonResponse(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    const payload = text.trim() ? JSON.parse(text) : {};
    return { payload, response };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServer() {
  const deadline = Date.now() + serverTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Keep polling until the local dev server is ready.
    }
    if (serverProcess?.exitCode !== null) {
      throw new Error(`Rental earnings executor smoke server exited early with code ${serverProcess.exitCode}.`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for rental earnings executor smoke server on ${baseUrl}.`);
}

async function startServer(env) {
  await assertPortAvailable();
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
      `Chain: ${chainId}`,
      `Partner: ${partnerAddress.toLowerCase()}`,
      `Signer: ${signerAddress.toLowerCase()}`,
      `Timestamp: ${timestamp}`,
    ].join("\n");
    const signature = await account.signMessage({ message });
    return {
      ...extra,
      "x-robomata-chain-id": chainId,
      "x-robomata-auth-method": method,
      "x-robomata-auth-path": requestPath,
      "x-robomata-partner-address": partnerAddress,
      "x-robomata-signer-address": signerAddress,
      "x-robomata-auth-signature": signature,
      "x-robomata-auth-timestamp": timestamp,
    };
  };
}

async function requestJson({ authHeaders, body, expectedStatus = 200, method = "GET", requestPath }) {
  const headers = authHeaders
    ? await authHeaders(method, requestPath, { ...(body ? { "content-type": "application/json" } : {}) })
    : { ...(body ? { "content-type": "application/json" } : {}) };
  const { payload, response } = await fetchJsonResponse(`${baseUrl}${requestPath}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status !== expectedStatus) {
    throw new Error(`${requestPath} expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function ledgerEntry({ amountCents, facilityAssetId, id, platformVehicleId, postingAssetId, postingAssetKind, vehicleAssetId }) {
  return {
    amountCents,
    createdAt: nowIso(),
    currency: "USD",
    facilityAssetId,
    id,
    kind: "recognized_revenue",
    occurredAt: nowIso(),
    platformVehicleId,
    postingAssetId,
    postingAssetKind,
    source: { bookingId: `booking-${id}` },
    ...(vehicleAssetId ? { vehicleAssetId } : {}),
  };
}

async function main() {
  tempDir = await mkdtemp(path.join(tmpdir(), "robomata-rental-earnings-executor-"));
  const account = createAccount();
  const partnerAddress = account.address;
  const authHeaders = authHeaderBuilder({ account, partnerAddress });
  const env = {
    ...process.env,
    NODE_ENV: "development",
    PORT: port,
    POSTGRES_PRISMA_URL: "",
    POSTGRES_URL: "",
    POSTGRES_URL_NON_POOLING: "",
    ROBOMATA_AUTHORIZED_PARTNER_ADDRESSES: partnerAddress,
    ROBOMATA_RENTAL_INVENTORY_ENABLED: "true",
    ROBOMATA_RENTAL_INVENTORY_FACILITY_OWNERS_JSON: JSON.stringify({ "101": partnerAddress }),
    ROBOMATA_RENTAL_REVENUE_FILE: path.join(tempDir, "revenue.json"),
    ROBOMATA_RENTAL_REVENUE_POSTING_ENABLED: "true",
    ROBOMATA_WORKFLOW_MUTATIONS_ENABLED: "true",
  };

  await startServer(env);

  const postingPath = "/api/robomata/rental-revenue/posting-batches";
  const facilityPayload = await requestJson({
    authHeaders,
    method: "POST",
    requestPath: postingPath,
    expectedStatus: 201,
    body: {
      entries: [
        ledgerEntry({
          amountCents: 12345,
          facilityAssetId: "101",
          id: "rle_executor_facility",
          platformVehicleId: "platform-executor-1",
          postingAssetId: "101",
          postingAssetKind: "facility",
        }),
      ],
      periodEnd: nowIso(1),
      periodStart: nowIso(-1),
      target: { facilityAssetId: "101", postingAssetId: "101", postingAssetKind: "facility" },
    },
  });
  const facilityCall = facilityPayload.protocolRequest?.protocolCall;
  if (
    facilityCall?.contractName !== "EarningsManager" ||
    facilityCall.args.assetId !== "101" ||
    facilityCall.args.totalRevenue !== "123450000" ||
    !facilityCall.calldata?.startsWith("0x")
  ) {
    throw new Error(`Expected executable facility protocol call, got ${JSON.stringify(facilityPayload)}`);
  }

  const batchId = facilityPayload.batch.id;
  await requestJson({
    authHeaders,
    method: "POST",
    requestPath: `${postingPath}/${batchId}/mark-posted`,
    expectedStatus: 400,
    body: { protocolTxHash: `0x${"1".repeat(64)}` },
  });
  const postedPayload = await requestJson({
    authHeaders,
    method: "POST",
    requestPath: `${postingPath}/${batchId}/mark-posted`,
    body: {
      chainId: 31337,
      confirmationMode: "operator_confirmed",
      protocolTxHash: `0x${"1".repeat(64)}`,
    },
  });
  if (
    postedPayload.batch?.status !== "posted" ||
    postedPayload.batch.protocolTxChainId !== 31337 ||
    postedPayload.batch.protocolTxConfirmationMode !== "operator_confirmed"
  ) {
    throw new Error(`Expected explicit posted confirmation metadata, got ${JSON.stringify(postedPayload)}`);
  }
  await requestJson({
    authHeaders,
    method: "POST",
    requestPath: `${postingPath}/${batchId}/mark-posted`,
    body: {
      chainId: 31337,
      confirmationMode: "operator_confirmed",
      protocolTxHash: `0x${"1".repeat(64)}`,
    },
  });
  await requestJson({
    authHeaders,
    method: "POST",
    requestPath: `${postingPath}/${batchId}/mark-posted`,
    expectedStatus: 400,
    body: {
      chainId: 31337,
      confirmationMode: "operator_confirmed",
      protocolTxHash: `0x${"2".repeat(64)}`,
    },
  });

  const vehiclePayload = await requestJson({
    authHeaders,
    method: "POST",
    requestPath: postingPath,
    expectedStatus: 201,
    body: {
      entries: [
        ledgerEntry({
          amountCents: 2500,
          facilityAssetId: "101",
          id: "rle_executor_vehicle",
          platformVehicleId: "platform-executor-2",
          postingAssetId: "202",
          postingAssetKind: "vehicle",
          vehicleAssetId: "202",
        }),
      ],
      periodEnd: nowIso(3),
      periodStart: nowIso(-1),
      target: {
        facilityAssetId: "101",
        postingAssetId: "202",
        postingAssetKind: "vehicle",
        vehicleAssetId: "202",
      },
    },
  });
  if (vehiclePayload.protocolRequest?.protocolCall?.args.assetId !== "202") {
    throw new Error(`Expected executable vehicle protocol call, got ${JSON.stringify(vehiclePayload)}`);
  }
  const failedPayload = await requestJson({
    authHeaders,
    method: "POST",
    requestPath: `${postingPath}/${vehiclePayload.batch.id}/mark-failed`,
    body: { errorMessage: "Simulated executor revert: AssetNotActive" },
  });
  if (
    failedPayload.batch?.status !== "failed" ||
    failedPayload.batch.protocolTxHash ||
    !failedPayload.batch.errorMessage?.includes("AssetNotActive")
  ) {
    throw new Error(`Expected failed batch without posted tx metadata, got ${JSON.stringify(failedPayload)}`);
  }

  console.log(
    JSON.stringify(
      {
        batchId,
        facilityAssetId: "101",
        status: "passed",
        vehicleBatchId: vehiclePayload.batch.id,
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
  if (tempDir) await rm(tempDir, { force: true, recursive: true });
}
