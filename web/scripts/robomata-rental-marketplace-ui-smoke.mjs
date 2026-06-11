#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const port = process.env.ROBOMATA_RENTAL_UI_SMOKE_PORT ?? "3226";
const baseUrl = `http://127.0.0.1:${port}`;
const requestTimeoutMs = Number.parseInt(process.env.ROBOMATA_RENTAL_UI_SMOKE_REQUEST_TIMEOUT_MS ?? "120000", 10);
const serverTimeoutMs = Number.parseInt(process.env.ROBOMATA_RENTAL_UI_SMOKE_SERVER_TIMEOUT_MS ?? "120000", 10);

let serverProcess;
let tempDir;

async function assertPortAvailable() {
  const numericPort = Number.parseInt(port, 10);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
    throw new Error(`ROBOMATA_RENTAL_UI_SMOKE_PORT must be a valid port, got ${port}.`);
  }

  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", error => reject(error));
    probe.listen(numericPort, "127.0.0.1", () => probe.close(resolve));
  });
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`${url} failed ${response.status}: ${text}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json();
    if (!response.ok) throw new Error(`${url} failed ${response.status}: ${JSON.stringify(payload)}`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function expectJsonFailure(url, options, expectedStatus, expectedMessage) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json();
    if (response.status !== expectedStatus || !payload.error?.includes(expectedMessage)) {
      throw new Error(
        `${url} expected ${expectedStatus} including ${expectedMessage}, got ${response.status}: ${JSON.stringify(
          payload,
        )}`,
      );
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServer() {
  const deadline = Date.now() + serverTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const payload = await fetchJson(`${baseUrl}/api/robomata/rental-marketplace/listings?city=Austin`);
      if (payload.listings?.length) return;
    } catch {
      // Keep polling until Next.js is ready.
    }
    if (serverProcess?.exitCode !== null) {
      throw new Error(`Rental marketplace smoke server exited early with code ${serverProcess.exitCode}.`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for rental marketplace smoke server on ${baseUrl}.`);
}

async function startServer(env) {
  await assertPortAvailable();
  serverProcess = spawn("yarn", ["workspace", "web", "dev", "-p", port], {
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

async function seedInventory(filePath) {
  const now = new Date().toISOString();
  await writeFile(
    filePath,
    JSON.stringify(
      {
        ingestionRuns: [],
        manifestRefs: [],
        manifests: [],
        syncCheckpoints: [],
        vehicles: [
          {
            display: {
              bodyType: "suv",
              fuelType: "electric",
              imageUris: [],
              make: "Rivian",
              model: "R1S",
              seats: 7,
              transmission: "automatic",
              year: 2026,
            },
            facilityAssetId: "facility-smoke-asset",
            facilityName: "Smoke Fleet Austin",
            hostControls: {
              availability: {
                instantBookEnabled: true,
                timezone: "America/Chicago",
              },
              blackoutRanges: [],
              bookingReview: {
                autoAcceptEnabled: true,
              },
              maintenanceHolds: [],
              pricing: {
                currency: "USD",
                dailyRateCents: 9900,
                minimumTripDays: 2,
                weeklyDiscountBps: 500,
              },
              updatedAt: now,
            },
            hostSetup: {
              checklist: {
                availability: true,
                description: true,
                photos: true,
                pickup_dropoff: true,
                pricing: true,
                rules: true,
              },
              completedAt: now,
              photoUris: [],
              pickupDropoff: {
                city: "Austin",
                country: "US",
                deliveryAvailable: true,
                region: "TX",
              },
              publicDescription: "Smoke-test electric SUV with facility-backed financing.",
              rules: {
                mileageLimitPerDay: 200,
                petsAllowed: false,
                smokingAllowed: false,
              },
              status: "complete",
              updatedAt: now,
              validationErrors: [],
            },
            inventoryManifestDigest: "0x1111111111111111111111111111111111111111111111111111111111111111",
            operationalStatus: "listed",
            operatorName: "Smoke Fleet",
            platformVehicleId: "pv_smoke_rivian",
            updatedAt: now,
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function main() {
  tempDir = await mkdtemp(path.join(tmpdir(), "robomata-rental-ui-smoke-"));
  const inventoryFile = path.join(tempDir, "inventory.json");
  await seedInventory(inventoryFile);

  const env = {
    ...process.env,
    NEXT_PUBLIC_ROBOMATA_RENTAL_MARKETPLACE_ENABLED: "true",
    POSTGRES_URL: "",
    PORT: port,
    ROBOMATA_RENTAL_BOOKINGS_ENABLED: "true",
    ROBOMATA_RENTAL_BOOKINGS_FILE: path.join(tempDir, "bookings.json"),
    ROBOMATA_RENTAL_INVENTORY_ENABLED: "true",
    ROBOMATA_RENTAL_INVENTORY_FILE: inventoryFile,
    ROBOMATA_RENTAL_PAYMENTS_ENABLED: "true",
    ROBOMATA_RENTER_ACCOUNTS_ENABLED: "true",
    ROBOMATA_RENTER_ACCOUNTS_FILE: path.join(tempDir, "renters.json"),
    ROBOMATA_WORKFLOW_MUTATIONS_ENABLED: "true",
  };

  await startServer(env);

  const rentalsHtml = await fetchText(`${baseUrl}/rentals`);
  if (!rentalsHtml.includes("__next")) {
    throw new Error("Expected /rentals to return the Next.js app shell.");
  }

  const listingsPayload = await fetchJson(`${baseUrl}/api/robomata/rental-marketplace/listings?city=Austin&evOnly=true`);
  const listing = listingsPayload.listings?.[0];
  if (listing?.platformVehicleId !== "pv_smoke_rivian") {
    throw new Error(`Expected smoke listing pv_smoke_rivian, got ${JSON.stringify(listingsPayload)}`);
  }

  const dateFrom = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
  const dateTo = new Date(Date.now() + 10 * 24 * 60 * 60 * 1_000).toISOString();
  const paymentPlanPayload = await fetchJson(`${baseUrl}/api/robomata/rental-marketplace/payment-plan`, {
    body: JSON.stringify({ dateFrom, dateTo, platformVehicleId: listing.platformVehicleId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!paymentPlanPayload.paymentPlan?.totalDueAtAuthorizationCents) {
    throw new Error(`Expected payment plan total, got ${JSON.stringify(paymentPlanPayload)}`);
  }

  const renterPayload = await fetchJson(`${baseUrl}/api/robomata/rental-renters`, {
    body: JSON.stringify({ displayName: "Smoke Renter", email: "renter@example.test" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!renterPayload.renter?.id) throw new Error(`Expected renter id, got ${JSON.stringify(renterPayload)}`);

  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-renters`,
    {
      body: JSON.stringify({ displayName: "No Contact Renter" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    400,
    "Renter profile requires at least email or phone.",
  );

  const reusedRenterPayload = await fetchJson(`${baseUrl}/api/robomata/rental-renters`, {
    body: JSON.stringify({ displayName: "Smoke Renter Again", email: "RENTER@example.test" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (reusedRenterPayload.renter?.id !== renterPayload.renter.id) {
    throw new Error(
      `Expected returning renter to reuse ${renterPayload.renter.id}, got ${JSON.stringify(reusedRenterPayload)}`,
    );
  }

  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-bookings/checkout`,
    {
      body: JSON.stringify({
        dateFrom: new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString(),
        dateTo: new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString(),
        platformVehicleId: listing.platformVehicleId,
        renterId: renterPayload.renter.id,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    400,
    "dateFrom cannot be in the past.",
  );

  const checkoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom,
      dateTo,
      platformVehicleId: listing.platformVehicleId,
      renterId: renterPayload.renter.id,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!checkoutPayload.booking?.id || checkoutPayload.booking.facilityAssetId !== "facility-smoke-asset") {
    throw new Error(`Expected facility-backed booking, got ${JSON.stringify(checkoutPayload)}`);
  }

  console.log(
    JSON.stringify(
      {
        bookingId: checkoutPayload.booking.id,
        listingCount: listingsPayload.listings.length,
        paymentAuthorizationCents: paymentPlanPayload.paymentPlan.totalDueAtAuthorizationCents,
        reusedRenterId: reusedRenterPayload.renter.id,
        status: "passed",
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
