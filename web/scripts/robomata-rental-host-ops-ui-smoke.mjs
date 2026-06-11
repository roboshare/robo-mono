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
const port = process.env.ROBOMATA_RENTAL_HOST_OPS_UI_SMOKE_PORT ?? "3224";
const baseUrl = `http://127.0.0.1:${port}`;
const serverTimeoutMs = Number.parseInt(process.env.ROBOMATA_RENTAL_HOST_OPS_UI_SMOKE_TIMEOUT_MS ?? "90000", 10);
const requestTimeoutMs = Number.parseInt(process.env.ROBOMATA_RENTAL_HOST_OPS_UI_REQUEST_TIMEOUT_MS ?? "45000", 10);
const chainId = "31337";
const paymentConfirmationSecret = "host-ops-smoke-secret";
const digest = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
    throw new Error(`ROBOMATA_RENTAL_HOST_OPS_UI_SMOKE_PORT must be a valid port, got ${port}.`);
  }

  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", error => {
      if (error?.code === "EADDRINUSE") {
        reject(new Error(`ROBOMATA_RENTAL_HOST_OPS_UI_SMOKE_PORT ${port} is already in use.`));
        return;
      }
      reject(error);
    });
    probe.listen(numericPort, "127.0.0.1", () => {
      probe.close(resolve);
    });
  });
}

async function fetchJsonResponse(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    const payload = text.trim() ? JSON.parse(text) : {};
    return { payload, response, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServer() {
  const deadline = Date.now() + serverTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/operator/rentals`);
      if (response.ok) return;
    } catch {
      // Keep polling until the local dev server is ready.
    }

    if (serverProcess.exitCode !== null) {
      throw new Error(`Rental host ops smoke server exited early with code ${serverProcess.exitCode}.`);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for rental host ops smoke server on ${baseUrl}.`);
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

async function requestJson({ authHeaders, authPath, body, headers = {}, method = "GET", requestPath }) {
  const signedPath = authPath ?? requestPath.split("?")[0];
  const requestHeaders = authHeaders
    ? await authHeaders(method, signedPath, { ...headers, ...(body ? { "content-type": "application/json" } : {}) })
    : { ...headers, ...(body ? { "content-type": "application/json" } : {}) };
  const { payload, response } = await fetchJsonResponse(`${baseUrl}${requestPath}`, {
    method,
    headers: requestHeaders,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    throw new Error(`${requestPath} failed ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function verifyRouteShell() {
  const response = await fetch(`${baseUrl}/operator/rentals`);
  if (!response.ok) throw new Error(`/operator/rentals failed ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (!contentType.includes("text/html") || !body.includes("<!DOCTYPE html>") || !body.includes("/_next/static/")) {
    throw new Error(`/operator/rentals did not return a Next.js app shell: ${body.slice(0, 500)}`);
  }
}

async function main() {
  tempDir = await mkdtemp(path.join(tmpdir(), "robomata-rental-host-ops-"));
  const account = createAccount();
  const partnerAddress = account.address;
  const authHeaders = authHeaderBuilder({ account, partnerAddress });
  const facilityAssetId = "facility-host-ops-smoke";
  const platformVehicleId = "platform-host-ops-smoke-1";
  const env = {
    ...process.env,
    NODE_ENV: "development",
    PORT: port,
    NEXT_PUBLIC_ROBOMATA_RENTAL_HOST_OPS_ENABLED: "true",
    ROBOMATA_AUTHORIZED_PARTNER_ADDRESSES: partnerAddress,
    ROBOMATA_RENTAL_INVENTORY_ENABLED: "true",
    ROBOMATA_RENTAL_PAYMENTS_ENABLED: "true",
    ROBOMATA_RENTER_ACCOUNTS_ENABLED: "true",
    ROBOMATA_RENTAL_BOOKINGS_ENABLED: "true",
    ROBOMATA_WORKFLOW_MUTATIONS_ENABLED: "true",
    ROBOMATA_RENTAL_PAYMENT_CONFIRMATION_SECRET: paymentConfirmationSecret,
    DATABASE_URL: "",
    POSTGRES_PRISMA_URL: "",
    POSTGRES_URL: "",
    POSTGRES_URL_NON_POOLING: "",
    ROBOMATA_RENTAL_INVENTORY_FILE: path.join(tempDir, "inventory.json"),
    ROBOMATA_RENTER_ACCOUNTS_FILE: path.join(tempDir, "renters.json"),
    ROBOMATA_RENTAL_BOOKINGS_FILE: path.join(tempDir, "bookings.json"),
    ROBOMATA_RENTAL_TRIPS_FILE: path.join(tempDir, "trips.json"),
    ROBOMATA_RENTAL_SUPPORT_FILE: path.join(tempDir, "support.json"),
    ROBOMATA_RENTAL_CLAIMS_FILE: path.join(tempDir, "claims.json"),
  };

  await startServer(env);
  await verifyRouteShell();

  const manifest = {
    version: "rental.facility_inventory.v1",
    manifestId: "manifest-host-ops-smoke",
    facilityAssetId,
    facilityCommitment: digest,
    operatorName: "Host Ops Smoke Operator",
    facilityName: "Host Ops Smoke Facility",
    asOfDate: nowIso().slice(0, 10),
    generatedAt: nowIso(),
    source: { system: "partner-upload", sourceId: partnerAddress.toLowerCase() },
    vehicles: [
      {
        platformVehicleId,
        facilityAssetId,
        display: {
          make: "Tesla",
          model: "Model 3",
          year: 2025,
          trim: "Long Range",
          bodyType: "sedan",
          seats: 5,
          fuelType: "electric",
          transmission: "automatic",
          imageUris: ["https://example.com/model-3.jpg"],
        },
        status: "eligible",
      },
    ],
  };

  await requestJson({
    authHeaders,
    method: "POST",
    requestPath: "/api/robomata/rental-inventory/manifests",
    body: { manifest },
  });

  const setupResponse = await requestJson({
    authHeaders,
    method: "PATCH",
    requestPath: `/api/robomata/rental-inventory/vehicles/${platformVehicleId}/setup`,
    body: {
      setup: {
        photoUris: ["https://example.com/model-3.jpg"],
        publicDescription: "Clean EV rental for city and airport trips.",
        pickupDropoff: {
          addressLabel: "100 Fleet Yard",
          city: "Austin",
          region: "TX",
          country: "US",
        },
        pricing: {
          currency: "USD",
          dailyRateCents: 12900,
          minimumTripDays: 1,
        },
        availability: {
          timezone: "America/Chicago",
          instantBookEnabled: true,
          advanceNoticeHours: 6,
        },
        rules: {
          mileageLimitPerDay: 250,
          additionalRules: "No smoking.",
        },
      },
    },
  });
  if (setupResponse.vehicle?.hostSetup?.status !== "complete") {
    throw new Error(`Expected complete setup, got ${setupResponse.vehicle?.hostSetup?.status}`);
  }

  const controlsResponse = await requestJson({
    authHeaders,
    method: "PATCH",
    requestPath: `/api/robomata/rental-inventory/vehicles/${platformVehicleId}/controls`,
    body: {
      pricing: { currency: "USD", dailyRateCents: 13500, minimumTripDays: 2 },
      availability: { timezone: "America/Chicago", instantBookEnabled: false, advanceNoticeHours: 12 },
      blackoutRanges: [
        {
          id: "blackout-smoke",
          startsAt: nowIso(60),
          endsAt: nowIso(62),
          reason: "Owner use",
          createdAt: nowIso(),
        },
      ],
      maintenanceHolds: [
        {
          id: "maintenance-smoke",
          startsAt: nowIso(70),
          endsAt: nowIso(71),
          expectedReturnToServiceAt: nowIso(71),
          reason: "Tire rotation",
          createdAt: nowIso(),
        },
      ],
      bookingReview: {
        autoAcceptEnabled: false,
        requireManualApproval: true,
        maxTripDays: 14,
        minimumNoticeHours: 12,
      },
      operationalStatus: "listed",
    },
  });
  if (controlsResponse.vehicle?.operationalStatus !== "listed") {
    throw new Error(`Expected listed vehicle, got ${controlsResponse.vehicle?.operationalStatus}`);
  }

  const vehiclesResponse = await requestJson({
    authHeaders,
    requestPath: `/api/robomata/rental-inventory/vehicles?platformVehicleId=${platformVehicleId}`,
  });
  if (vehiclesResponse.vehicles?.length !== 1) {
    throw new Error(`Expected one visible vehicle, got ${vehiclesResponse.vehicles?.length}`);
  }

  const renterResponse = await requestJson({
    method: "POST",
    requestPath: "/api/robomata/rental-renters",
    body: { displayName: "Host Ops Smoke Renter", email: "host-ops-smoke@example.com" },
  });
  const renterId = renterResponse.renter?.id;
  if (!renterId) throw new Error("Renter creation did not return an id.");

  for (const kind of ["identity", "driver_license", "sanctions"]) {
    await requestJson({
      method: "POST",
      requestPath: `/api/robomata/rental-renters/${renterId}/verification/override`,
      body: {
        kind,
        status: "approved",
        reason: "Host ops smoke verified renter",
        reviewedBy: "host-ops-smoke",
        expiresAt: nowIso(365),
      },
    });
  }

  const checkoutResponse = await requestJson({
    method: "POST",
    requestPath: "/api/robomata/rental-bookings/checkout",
    body: {
      renterId,
      platformVehicleId,
      dateFrom: nowIso(14),
      dateTo: nowIso(16),
    },
  });
  const bookingId = checkoutResponse.booking?.id;
  if (!bookingId) throw new Error("Checkout did not create a booking.");

  const confirmResponse = await requestJson({
    authHeaders,
    method: "POST",
    requestPath: `/api/robomata/rental-bookings/${bookingId}/confirm`,
    headers: { "x-robomata-payment-confirmation": paymentConfirmationSecret },
    body: {
      paymentProviderReference: {
        provider: "stripe",
        authorizationId: "pi_host_ops_smoke",
        status: "authorized",
        authorizedAt: nowIso(),
      },
    },
  });
  if (confirmResponse.booking?.state !== "host_review") {
    throw new Error(`Expected host_review booking under manual approval, got ${confirmResponse.booking?.state}`);
  }

  const approveResponse = await requestJson({
    authHeaders,
    method: "POST",
    requestPath: `/api/robomata/rental-bookings/${bookingId}/approve`,
    body: {},
  });
  if (approveResponse.booking?.state !== "confirmed") {
    throw new Error(`Expected confirmed booking after host approval, got ${approveResponse.booking?.state}`);
  }

  const autoAcceptControlsResponse = await requestJson({
    authHeaders,
    method: "PATCH",
    requestPath: `/api/robomata/rental-inventory/vehicles/${platformVehicleId}/controls`,
    body: {
      bookingReview: {
        autoAcceptEnabled: true,
        requireManualApproval: false,
        maxTripDays: 14,
        minimumNoticeHours: 12,
      },
      operationalStatus: "listed",
    },
  });
  if (autoAcceptControlsResponse.vehicle?.hostControls?.bookingReview.requireManualApproval !== false) {
    throw new Error("Expected manual approval to be disabled for auto-accept smoke booking.");
  }

  const autoCheckoutResponse = await requestJson({
    method: "POST",
    requestPath: "/api/robomata/rental-bookings/checkout",
    body: {
      renterId,
      platformVehicleId,
      dateFrom: nowIso(20),
      dateTo: nowIso(22),
    },
  });
  const autoBookingId = autoCheckoutResponse.booking?.id;
  if (!autoBookingId) throw new Error("Auto-accept checkout did not create a booking.");

  const autoConfirmResponse = await requestJson({
    authHeaders,
    method: "POST",
    requestPath: `/api/robomata/rental-bookings/${autoBookingId}/confirm`,
    headers: { "x-robomata-payment-confirmation": paymentConfirmationSecret },
    body: {
      paymentProviderReference: {
        provider: "stripe",
        authorizationId: "pi_host_ops_smoke_auto",
        status: "authorized",
        authorizedAt: nowIso(),
      },
    },
  });
  if (autoConfirmResponse.booking?.state !== "confirmed") {
    throw new Error(`Expected confirmed auto-accept booking, got ${autoConfirmResponse.booking?.state}`);
  }

  const checkInResponse = await requestJson({
    authHeaders,
    method: "POST",
    requestPath: `/api/robomata/rental-bookings/${autoBookingId}/check-in`,
    body: {
      actor: partnerAddress,
      condition: "clean",
      photoUris: ["https://example.com/check-in.jpg"],
      odometerMiles: 1800,
      chargePercent: 88,
      notes: "Clean pickup.",
    },
  });
  if (checkInResponse.booking?.state !== "in_trip") {
    throw new Error(`Expected in_trip after check-in, got ${checkInResponse.booking?.state}`);
  }

  const checkOutResponse = await requestJson({
    authHeaders,
    method: "POST",
    requestPath: `/api/robomata/rental-bookings/${autoBookingId}/check-out`,
    body: {
      actor: partnerAddress,
      condition: "minor_wear",
      photoUris: ["https://example.com/check-out.jpg"],
      odometerMiles: 1950,
      chargePercent: 52,
      notes: "Returned with minor wear.",
    },
  });
  if (checkOutResponse.booking?.state !== "completed") {
    throw new Error(`Expected completed after check-out, got ${checkOutResponse.booking?.state}`);
  }

  const incidentResponse = await requestJson({
    authHeaders,
    method: "POST",
    requestPath: `/api/robomata/rental-bookings/${autoBookingId}/incidents`,
    body: {
      actor: { id: partnerAddress, role: "ops" },
      kind: "vehicle_condition",
      status: "resolved",
      notes: "Minor interior cleanup logged.",
      supportCaseId: "SUP-HOST-OPS-SMOKE",
    },
  });
  if (!incidentResponse.incident?.id) throw new Error("Incident response did not include an incident id.");

  const claimResponse = await requestJson({
    authHeaders,
    method: "POST",
    requestPath: `/api/robomata/rental-bookings/${autoBookingId}/claims`,
    body: {
      openedBy: { id: partnerAddress, role: "ops" },
      kind: "damage",
      severity: "low",
      payoutHoldAmountCents: 2500,
      payoutHoldReason: "Minor wheel scuff review",
      releaseConditions: ["Ops review complete"],
      supportCaseId: "SUP-HOST-OPS-SMOKE",
    },
  });
  if (!claimResponse.claim?.id) throw new Error("Claim response did not include a claim id.");

  const takedownResponse = await requestJson({
    authHeaders,
    method: "POST",
    requestPath: `/api/robomata/rental-inventory/vehicles/${platformVehicleId}/safety-takedown`,
    body: {
      reason: "Smoke safety suspension",
      supportCaseId: "SUP-HOST-OPS-SMOKE",
    },
  });
  if (takedownResponse.vehicle?.operationalStatus !== "suspended") {
    throw new Error(`Expected suspended after safety takedown, got ${takedownResponse.vehicle?.operationalStatus}`);
  }
  if (takedownResponse.vehicle?.hostControls?.safetyTakedown?.supportCaseId !== "SUP-HOST-OPS-SMOKE") {
    throw new Error("Expected safety takedown support case to persist on host controls.");
  }

  console.log(
    JSON.stringify(
      {
        bookingId: autoBookingId,
        manualApprovalBookingId: bookingId,
        claimId: claimResponse.claim.id,
        incidentId: incidentResponse.incident.id,
        platformVehicleId,
        status: "passed",
        vehicleStatus: takedownResponse.vehicle.operationalStatus,
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
