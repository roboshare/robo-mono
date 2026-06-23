#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const port = process.env.ROBOMATA_RENTAL_VERIFICATION_SMOKE_PORT ?? "3228";
const baseUrl = `http://127.0.0.1:${port}`;
const requestTimeoutMs = Number.parseInt(process.env.ROBOMATA_RENTAL_VERIFICATION_SMOKE_REQUEST_TIMEOUT_MS ?? "120000", 10);
const serverTimeoutMs = Number.parseInt(process.env.ROBOMATA_RENTAL_VERIFICATION_SMOKE_SERVER_TIMEOUT_MS ?? "120000", 10);
const verificationSecret = "verification-smoke-secret";
const paymentSecret = "payment-smoke-secret";
const identityProvider = "persona-smoke";
const driverLicenseProvider = "license-smoke";
const sanctionsProvider = "sanctions-smoke";
const partnerAccount = privateKeyToAccount("0x59c6995e998f97a5a0044966f094538b2920b4214d56109c94e3e5095b25b8a5");
const platformVehicleId = "pv_verification_smoke";
const facilityAssetId = "facility-verification-smoke-asset";

let serverProcess;
let tempDir;

async function assertPortAvailable() {
  const numericPort = Number.parseInt(port, 10);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
    throw new Error(`ROBOMATA_RENTAL_VERIFICATION_SMOKE_PORT must be a valid port, got ${port}.`);
  }

  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", error => reject(error));
    probe.listen(numericPort, "127.0.0.1", () => probe.close(resolve));
  });
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
      const payload = await fetchJson(`${baseUrl}/api/robomata/rental-renters/verification-policy`);
      if (payload.verificationProviders?.requireProviderConfig) return;
    } catch {
      // Keep polling until Next.js is ready.
    }
    if (serverProcess?.exitCode !== null) {
      throw new Error(`Rental verification smoke server exited early with code ${serverProcess.exitCode}.`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for rental verification smoke server on ${baseUrl}.`);
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
            facilityAssetId,
            facilityName: "Verification Smoke Fleet",
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
              publicDescription: "Verification smoke-test electric SUV.",
              rules: {
                mileageLimitPerDay: 200,
                petsAllowed: false,
                smokingAllowed: false,
              },
              status: "complete",
              updatedAt: now,
              validationErrors: [],
            },
            inventoryManifestDigest: "0x2222222222222222222222222222222222222222222222222222222222222222",
            operationalStatus: "listed",
            operatorName: "Verification Smoke Fleet",
            platformVehicleId,
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

async function updateVerification({ body, renterId }) {
  return fetchJson(`${baseUrl}/api/robomata/rental-renters/${renterId}/verification`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${verificationSecret}`,
      "content-type": "application/json",
    },
    method: "PATCH",
  });
}

async function overrideVerification({ body, renterId }) {
  return fetchJson(`${baseUrl}/api/robomata/rental-renters/${renterId}/verification/override`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${verificationSecret}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
}

function assertBlocking(payload, expectedKind) {
  if (!payload.checkoutEligibility?.blockingChecks?.includes(expectedKind)) {
    throw new Error(`Expected ${expectedKind} to block checkout, got ${JSON.stringify(payload.checkoutEligibility)}`);
  }
}

async function main() {
  tempDir = await mkdtemp(path.join(tmpdir(), "robomata-rental-verification-smoke-"));
  const inventoryFile = path.join(tempDir, "inventory.json");
  await seedInventory(inventoryFile);

  const env = {
    ...process.env,
    NEXT_PUBLIC_ROBOMATA_RENTAL_MARKETPLACE_ENABLED: "true",
    PORT: port,
    POSTGRES_PRISMA_URL: "",
    POSTGRES_URL: "",
    POSTGRES_URL_NON_POOLING: "",
    ROBOMATA_AUTHORIZED_PARTNER_ADDRESSES: partnerAccount.address,
    ROBOMATA_RENTAL_BOOKINGS_ENABLED: "true",
    ROBOMATA_RENTAL_BOOKINGS_FILE: path.join(tempDir, "bookings.json"),
    ROBOMATA_RENTAL_INVENTORY_ENABLED: "true",
    ROBOMATA_RENTAL_INVENTORY_FACILITY_OWNERS_JSON: JSON.stringify({ [facilityAssetId]: partnerAccount.address }),
    ROBOMATA_RENTAL_INVENTORY_FILE: inventoryFile,
    ROBOMATA_RENTAL_PAYMENT_CONFIRMATION_SECRET: paymentSecret,
    ROBOMATA_RENTAL_PAYMENTS_ENABLED: "true",
    ROBOMATA_RENTER_ACCOUNTS_ENABLED: "true",
    ROBOMATA_RENTER_ACCOUNTS_FILE: path.join(tempDir, "renters.json"),
    ROBOMATA_RENTER_DRIVER_LICENSE_PROVIDER: driverLicenseProvider,
    ROBOMATA_RENTER_IDENTITY_PROVIDER: identityProvider,
    ROBOMATA_RENTER_SANCTIONS_PROVIDER: sanctionsProvider,
    ROBOMATA_RENTER_VERIFICATION_REQUIRE_PROVIDER_CONFIG: "true",
    ROBOMATA_RENTER_VERIFICATION_SECRET: verificationSecret,
    ROBOMATA_WORKFLOW_MUTATIONS_ENABLED: "true",
  };

  await startServer(env);

  const providerPolicy = await fetchJson(`${baseUrl}/api/robomata/rental-renters/verification-policy`);
  if (providerPolicy.verificationProviders?.providers?.identity !== identityProvider) {
    throw new Error(`Expected configured identity provider metadata, got ${JSON.stringify(providerPolicy)}`);
  }

  const renterPayload = await fetchJson(`${baseUrl}/api/robomata/rental-renters`, {
    body: JSON.stringify({ displayName: "Verification Smoke Renter", email: "verification-renter@example.test" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const renterId = renterPayload.renter?.id;
  if (!renterId) throw new Error(`Expected renter id, got ${JSON.stringify(renterPayload)}`);

  const dateFrom = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
  const dateTo = new Date(Date.now() + 10 * 24 * 60 * 60 * 1_000).toISOString();
  const checkoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({ dateFrom, dateTo, platformVehicleId, renterId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const bookingId = checkoutPayload.booking?.id;
  if (!bookingId || checkoutPayload.booking.state !== "pending_renter_verification") {
    throw new Error(`Expected verification-gated booking, got ${JSON.stringify(checkoutPayload)}`);
  }

  const confirmPath = `/api/robomata/rental-bookings/${bookingId}/confirm`;
  const buildAuthHeaders = authHeaderBuilder({ account: partnerAccount, partnerAddress: partnerAccount.address });
  const confirmBlocked = await expectJsonFailure(
    `${baseUrl}${confirmPath}`,
    {
      body: JSON.stringify({ paymentProviderReference: { provider: "stripe", providerPaymentIntentId: "pi_smoke" } }),
      headers: await buildAuthHeaders("POST", confirmPath, {
        "content-type": "application/json",
        "x-robomata-payment-confirmation": paymentSecret,
      }),
      method: "POST",
    },
    409,
    "Renter verification still blocks booking confirmation.",
  );
  assertBlocking(confirmBlocked, "identity");

  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-renters/${renterId}/verification`,
    {
      body: JSON.stringify({
        kind: "identity",
        provider: "unconfigured-provider",
        providerReferenceId: "wrong-provider-ref",
        status: "approved",
      }),
      headers: {
        authorization: `Bearer ${verificationSecret}`,
        "content-type": "application/json",
      },
      method: "PATCH",
    },
    400,
    "is not configured for identity",
  );

  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-renters/${renterId}/verification`,
    {
      body: JSON.stringify({
        kind: "sanctions",
        provider: sanctionsProvider,
        providerReferenceId: "raw-payload-ref",
        rawSanctionsPayload: { hit: true },
        status: "failed",
      }),
      headers: {
        authorization: `Bearer ${verificationSecret}`,
        "content-type": "application/json",
      },
      method: "PATCH",
    },
    400,
    "prohibited rental persistence field",
  );

  const manualReviewPayload = await updateVerification({
    body: {
      actor: { displayName: identityProvider, id: identityProvider, type: "provider" },
      kind: "identity",
      provider: identityProvider,
      providerReferenceId: "idv_manual_review_ref",
      reason: "Provider requires document review.",
      status: "manual_review",
    },
    renterId,
  });
  assertBlocking(manualReviewPayload, "identity");

  await overrideVerification({
    body: {
      kind: "identity",
      reason: "Ops reviewed provider record idv_manual_review_ref.",
      reviewedBy: "verification-smoke-admin",
      status: "approved",
    },
    renterId,
  });

  const failedLicensePayload = await updateVerification({
    body: {
      kind: "driver_license",
      provider: driverLicenseProvider,
      providerReferenceId: "license_failed_ref",
      reason: "License image was unreadable.",
      status: "failed",
    },
    renterId,
  });
  assertBlocking(failedLicensePayload, "driver_license");

  const expiredLicensePayload = await updateVerification({
    body: {
      kind: "driver_license",
      provider: driverLicenseProvider,
      providerReferenceId: "license_expired_ref",
      reason: "License expired before trip start.",
      status: "expired",
    },
    renterId,
  });
  assertBlocking(expiredLicensePayload, "driver_license");

  const approvedButExpiredSanctionsPayload = await updateVerification({
    body: {
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
      kind: "sanctions",
      provider: sanctionsProvider,
      providerReferenceId: "sanctions_stale_ref",
      status: "approved",
    },
    renterId,
  });
  assertBlocking(approvedButExpiredSanctionsPayload, "sanctions");

  const futureExpiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000).toISOString();
  await updateVerification({
    body: {
      expiresAt: futureExpiry,
      kind: "driver_license",
      provider: driverLicenseProvider,
      providerReferenceId: "license_approved_ref",
      status: "approved",
    },
    renterId,
  });
  const finalVerificationPayload = await updateVerification({
    body: {
      expiresAt: futureExpiry,
      kind: "sanctions",
      provider: sanctionsProvider,
      providerReferenceId: "sanctions_approved_ref",
      status: "approved",
    },
    renterId,
  });
  if (!finalVerificationPayload.checkoutEligibility?.eligible) {
    throw new Error(`Expected renter to become checkout eligible, got ${JSON.stringify(finalVerificationPayload)}`);
  }

  const confirmedPayload = await fetchJson(`${baseUrl}${confirmPath}`, {
    body: JSON.stringify({
      paymentProviderReference: { provider: "stripe", providerPaymentIntentId: "pi_smoke_authorized" },
    }),
    headers: await buildAuthHeaders("POST", confirmPath, {
      "content-type": "application/json",
      "x-robomata-payment-confirmation": paymentSecret,
    }),
    method: "POST",
  });
  if (confirmedPayload.booking?.state !== "confirmed") {
    throw new Error(`Expected verified booking confirmation, got ${JSON.stringify(confirmedPayload)}`);
  }

  console.log(
    JSON.stringify(
      {
        auditEvents: finalVerificationPayload.renter.verificationAuditLog.length,
        bookingId,
        driverLicenseProvider,
        identityProvider,
        renterId,
        sanctionsProvider,
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
