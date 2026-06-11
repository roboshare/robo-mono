#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const port = process.env.ROBOMATA_RENTAL_INVESTOR_SMOKE_PORT ?? "3231";
const baseUrl = `http://127.0.0.1:${port}`;
const requestTimeoutMs = Number.parseInt(process.env.ROBOMATA_RENTAL_INVESTOR_SMOKE_REQUEST_TIMEOUT_MS ?? "120000", 10);
const serverTimeoutMs = Number.parseInt(process.env.ROBOMATA_RENTAL_INVESTOR_SMOKE_SERVER_TIMEOUT_MS ?? "240000", 10);

let serverProcess;

async function assertPortAvailable() {
  const numericPort = Number.parseInt(port, 10);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
    throw new Error(`ROBOMATA_RENTAL_INVESTOR_SMOKE_PORT must be a valid port, got ${port}.`);
  }

  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", error => reject(error));
    probe.listen(numericPort, "127.0.0.1", () => probe.close(resolve));
  });
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, options) {
  const response = await fetchWithTimeout(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(`${url} failed ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitForServer() {
  const deadline = Date.now() + serverTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(`${baseUrl}/markets/rental-performance`);
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      // Keep polling until Next.js is ready.
    }
    if (serverProcess?.exitCode !== null) {
      throw new Error(`Rental investor smoke server exited early with code ${serverProcess.exitCode}.`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for rental investor smoke server on ${baseUrl}.`);
}

async function startServer() {
  await assertPortAvailable();
  serverProcess = spawn("yarn", ["workspace", "web", "dev", "-p", port], {
    detached: true,
    env: {
      ...process.env,
      NEXT_PUBLIC_ROBOMATA_RENTAL_INVESTOR_REPORTING_ENABLED: "true",
      PORT: port,
      ROBOMATA_RENTAL_INVESTOR_REPORTING_ENABLED: "true",
    },
    stdio: "ignore",
  });
  await waitForServer();
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  const pid = serverProcess.pid;
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

async function main() {
  await startServer();
  const periodStart = "2026-06-01T00:00:00.000Z";
  const periodEnd = "2026-06-30T23:59:59.000Z";
  const payload = await fetchJson(`${baseUrl}/api/robomata/rental-investor/dashboard`, {
    body: JSON.stringify({
      attribution: {
        facilityAssetId: "facility-investor-smoke",
        platformVehicleIds: ["pv-investor-smoke-1", "pv-investor-smoke-2"],
      },
      computedAt: "2026-06-11T12:00:00.000Z",
      freshness: "fresh",
      ledgerEntries: [
        {
          id: "rle-investor-smoke-1",
          amountCents: 7000,
          createdAt: "2026-06-10T12:00:00.000Z",
          currency: "USD",
          facilityAssetId: "facility-investor-smoke",
          kind: "recognized_revenue",
          occurredAt: "2026-06-10T12:00:00.000Z",
          platformVehicleId: "pv-investor-smoke-1",
          postingAssetId: "facility-investor-smoke",
          postingAssetKind: "facility",
          source: { bookingId: "rb-investor-smoke-1" },
        },
        {
          id: "rle-investor-smoke-2",
          amountCents: 5000,
          createdAt: "2026-06-10T12:00:00.000Z",
          currency: "USD",
          facilityAssetId: "facility-investor-smoke",
          kind: "recognized_revenue",
          occurredAt: "2026-06-10T12:00:00.000Z",
          platformVehicleId: "pv-investor-smoke-2",
          postingAssetId: "facility-investor-smoke",
          postingAssetKind: "facility",
          source: { bookingId: "rb-investor-smoke-2" },
        },
      ],
      metrics: {
        availableVehicleDays: 60,
        bookedDays: 30,
        cancellationCount: 1,
        disputeCount: 1,
        distributionPostedAt: "2026-06-11T12:00:00.000Z",
        downtimeDays: 4,
        grossBookingValueCents: 15000,
        periodEnd,
        periodStart,
        platformVehicleIds: ["pv-investor-smoke-1", "pv-investor-smoke-2"],
        recognizedRevenueCents: 12000,
        revenueRecognizedAt: "2026-06-10T12:00:00.000Z",
      },
      postingBatches: [
        {
          id: "rpb-investor-smoke",
          attestation: {
            attestationId: "rra-investor-smoke",
            batchId: "rpb-investor-smoke",
            createdAt: "2026-06-11T12:00:00.000Z",
            createdBy: "0x0000000000000000000000000000000000000001",
            currency: "USD",
            ledgerEntryCount: 1,
            ledgerEntryIds: ["rle-investor-smoke-1"],
            ledgerEntriesDigest: "0x4444444444444444444444444444444444444444444444444444444444444444",
            periodEnd,
            periodStart,
            platformBoundary: "Aggregate facility and permitted vehicle KPI data only.",
            postingAssetId: "facility-investor-smoke",
            postingAssetKind: "facility",
            protocolBoundary: "Protocol receives finalized distribution amount and attestation reference.",
            rolloutMode: "metadata_only",
            schema: "robomata.rental_revenue_attestation",
            sourceSystem: "robomata-rental-platform",
            totalRecognizedRevenueCents: 7000,
            version: "v1",
          },
          createdAt: "2026-06-11T12:00:00.000Z",
          currency: "USD",
          entryIds: ["rle-investor-smoke-1"],
          facilityAssetId: "facility-investor-smoke",
          idempotencyKey: "rpb-investor-smoke",
          periodEnd,
          periodStart,
          postedAt: "2026-06-11T13:00:00.000Z",
          postingAssetId: "facility-investor-smoke",
          postingAssetKind: "facility",
          protocolTxHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
          status: "posted",
          totalRecognizedRevenueCents: 7000,
        },
      ],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  const dashboard = payload.dashboard;
  if (!dashboard) throw new Error(`Expected dashboard payload, got ${JSON.stringify(payload)}`);
  if (dashboard.summary.utilizationRateBps !== 5000) {
    throw new Error(`Expected 50% utilization, got ${dashboard.summary.utilizationRateBps}`);
  }
  if (dashboard.varianceReport.varianceCents !== 5000) {
    throw new Error(`Expected posting variance of 5000 cents, got ${dashboard.varianceReport.varianceCents}`);
  }
  if (dashboard.varianceReport.vehicleDrilldowns.length !== 2) {
    throw new Error("Expected two vehicle variance drilldowns.");
  }
  if (dashboard.varianceReport.attestations[0]?.attestationId !== "rra-investor-smoke") {
    throw new Error("Expected posting batch attestation to be surfaced.");
  }

  console.log(
    JSON.stringify(
      {
        attestationId: dashboard.varianceReport.attestations[0].attestationId,
        facilityAssetId: dashboard.facilityAssetId,
        status: "passed",
        varianceCents: dashboard.varianceReport.varianceCents,
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
}
