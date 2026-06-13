#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const port = process.env.ROBOMATA_RENTAL_STRIPE_SMOKE_PORT ?? "3229";
const baseUrl = `http://127.0.0.1:${port}`;
const requestTimeoutMs = Number.parseInt(process.env.ROBOMATA_RENTAL_STRIPE_SMOKE_REQUEST_TIMEOUT_MS ?? "120000", 10);
const serverTimeoutMs = Number.parseInt(process.env.ROBOMATA_RENTAL_STRIPE_SMOKE_SERVER_TIMEOUT_MS ?? "120000", 10);
const paymentConfirmationSecret = "stripe-smoke-payment-secret";
const stripeWebhookSecret = "whsec_stripe_smoke";
const partnerAccount = privateKeyToAccount("0x59c6995e998f97a5a0044966f094538b2920b4214d56109c94e3e5095b25b8a5");
const platformVehicleId = "pv_stripe_smoke";
const longTripPlatformVehicleId = "pv_stripe_smoke_long_trip";
const bridgePlatformVehicleId = "pv_stripe_smoke_bridge";
const facilityAssetId = "facility-stripe-smoke-asset";
const otherFacilityAssetId = "facility-stripe-smoke-other";

let serverProcess;
let serverOutput = "";
let tempDir;

async function assertPortAvailable() {
  const numericPort = Number.parseInt(port, 10);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
    throw new Error(`ROBOMATA_RENTAL_STRIPE_SMOKE_PORT must be a valid port, got ${port}.`);
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
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `${url} returned non-JSON ${response.status}: ${text.slice(0, 500)}\nServer output:\n${serverOutput.slice(-4000)}`,
        { cause: error },
      );
    }
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
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `${url} returned non-JSON ${response.status}: ${text.slice(0, 500)}\nServer output:\n${serverOutput.slice(-4000)}`,
        { cause: error },
      );
    }
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

function stripeSignatureHeader(payload, timestamp = Math.floor(Date.now() / 1000), extraSignatures = []) {
  const signature = createHmac("sha256", stripeWebhookSecret).update(`${timestamp}.${payload}`).digest("hex");
  return [`t=${timestamp}`, `v1=${signature}`, ...extraSignatures.map(extra => `v1=${extra}`)].join(",");
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
      throw new Error(`Rental Stripe smoke server exited early with code ${serverProcess.exitCode}.`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for rental Stripe smoke server on ${baseUrl}.`);
}

async function startServer(env) {
  await assertPortAvailable();
  serverProcess = spawn("yarn", ["workspace", "web", "dev", "-p", port], {
    cwd: repoRoot,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collectOutput = chunk => {
    serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20000);
  };
  serverProcess.stdout?.on("data", collectOutput);
  serverProcess.stderr?.on("data", collectOutput);
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
            facilityName: "Stripe Smoke Fleet",
            hostControls: {
              availability: { instantBookEnabled: true, timezone: "America/Chicago" },
              blackoutRanges: [],
              bookingReview: { autoAcceptEnabled: true },
              maintenanceHolds: [],
              pricing: { currency: "USD", dailyRateCents: 9900, minimumTripDays: 2 },
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
              pickupDropoff: { city: "Austin", country: "US", region: "TX" },
              publicDescription: "Stripe smoke-test electric SUV.",
              rules: { mileageLimitPerDay: 200, petsAllowed: false, smokingAllowed: false },
              status: "complete",
              updatedAt: now,
              validationErrors: [],
            },
            inventoryManifestDigest: "0x3333333333333333333333333333333333333333333333333333333333333333",
            operationalStatus: "listed",
            operatorName: "Stripe Smoke Fleet",
            platformVehicleId,
            updatedAt: now,
          },
          {
            display: {
              bodyType: "sedan",
              fuelType: "hybrid",
              imageUris: [],
              make: "Toyota",
              model: "Camry",
              seats: 5,
              transmission: "automatic",
              year: 2026,
            },
            facilityAssetId,
            facilityName: "Stripe Smoke Fleet",
            hostControls: {
              availability: { instantBookEnabled: true, timezone: "America/Chicago" },
              blackoutRanges: [],
              bookingReview: { autoAcceptEnabled: true },
              maintenanceHolds: [],
              pricing: { currency: "USD", dailyRateCents: 7900, minimumTripDays: 2 },
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
              pickupDropoff: { city: "Austin", country: "US", region: "TX" },
              publicDescription: "Stripe smoke-test long-trip sedan.",
              rules: { mileageLimitPerDay: 200, petsAllowed: false, smokingAllowed: false },
              status: "complete",
              updatedAt: now,
              validationErrors: [],
            },
            inventoryManifestDigest: "0x4444444444444444444444444444444444444444444444444444444444444444",
            operationalStatus: "listed",
            operatorName: "Stripe Smoke Fleet",
            platformVehicleId: longTripPlatformVehicleId,
            updatedAt: now,
          },
          {
            display: {
              bodyType: "wagon",
              fuelType: "electric",
              imageUris: [],
              make: "Hyundai",
              model: "Ioniq 5",
              seats: 5,
              transmission: "automatic",
              year: 2026,
            },
            facilityAssetId,
            facilityName: "Stripe Smoke Fleet",
            hostControls: {
              availability: { instantBookEnabled: true, timezone: "America/Chicago" },
              blackoutRanges: [],
              bookingReview: { autoAcceptEnabled: true },
              maintenanceHolds: [],
              pricing: { currency: "USD", dailyRateCents: 6900, minimumTripDays: 2 },
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
              pickupDropoff: { city: "Austin", country: "US", region: "TX" },
              publicDescription: "Stripe smoke-test Bridge EV.",
              rules: { mileageLimitPerDay: 200, petsAllowed: false, smokingAllowed: false },
              status: "complete",
              updatedAt: now,
              validationErrors: [],
            },
            inventoryManifestDigest: "0x5555555555555555555555555555555555555555555555555555555555555555",
            operationalStatus: "listed",
            operatorName: "Stripe Smoke Fleet",
            platformVehicleId: bridgePlatformVehicleId,
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

async function approveRenterVerification(renterId) {
  for (const kind of ["identity", "driver_license", "sanctions"]) {
    await fetchJson(`${baseUrl}/api/robomata/rental-renters/${renterId}/verification`, {
      body: JSON.stringify({
        kind,
        provider: "stripe-smoke-verifier",
        providerReferenceId: `${kind}-ref`,
        status: "approved",
      }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
  }
}

async function updateStoredBooking(filePath, bookingId, update) {
  const fileStore = JSON.parse(await readFile(filePath, "utf8"));
  fileStore.bookings = fileStore.bookings.map(booking => (booking.id === bookingId ? update(booking) : booking));
  await writeFile(filePath, JSON.stringify(fileStore, null, 2), "utf8");
}

async function updateStoredPayment(filePath, paymentIntentId, update) {
  const fileStore = JSON.parse(await readFile(filePath, "utf8"));
  fileStore.payments = fileStore.payments.map(payment =>
    payment.providerReference?.paymentIntentId === paymentIntentId ? update(payment) : payment,
  );
  await writeFile(filePath, JSON.stringify(fileStore, null, 2), "utf8");
}

async function readStoredPayment(filePath, providerReferenceId) {
  const fileStore = JSON.parse(await readFile(filePath, "utf8"));
  return fileStore.payments.find(
    payment =>
      payment.providerReference?.paymentIntentId === providerReferenceId ||
      payment.providerReference?.transferId === providerReferenceId,
  );
}

async function main() {
  tempDir = await mkdtemp(path.join(tmpdir(), "robomata-rental-stripe-smoke-"));
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
    ROBOMATA_RENTAL_INVENTORY_FACILITY_OWNERS_JSON: JSON.stringify({
      [facilityAssetId]: partnerAccount.address,
      [otherFacilityAssetId]: partnerAccount.address,
    }),
    ROBOMATA_RENTAL_INVENTORY_FILE: inventoryFile,
    ROBOMATA_RENTAL_PAYMENT_CONFIRMATION_SECRET: paymentConfirmationSecret,
    ROBOMATA_RENTAL_PAYMENTS_ENABLED: "true",
    ROBOMATA_RENTAL_PAYMENTS_FILE: path.join(tempDir, "payments.json"),
    ROBOMATA_RENTAL_BRIDGE_CUSTOMER_ID: "bridge-smoke-customer",
    ROBOMATA_RENTAL_BRIDGE_DESTINATION_ADDRESS: "0xbridgeSmokeTreasury",
    ROBOMATA_RENTAL_BRIDGE_ENABLED: "true",
    ROBOMATA_RENTAL_BRIDGE_MOCK: "true",
    ROBOMATA_RENTAL_REVENUE_FILE: path.join(tempDir, "revenue.json"),
    ROBOMATA_RENTAL_REVENUE_POSTING_ENABLED: "true",
    ROBOMATA_RENTAL_STRIPE_MOCK: "true",
    ROBOMATA_RENTAL_STRIPE_MOCK_RECONCILE_STATUS: "succeeded",
    ROBOMATA_RENTER_ACCOUNTS_ENABLED: "true",
    ROBOMATA_RENTER_ACCOUNTS_FILE: path.join(tempDir, "renters.json"),
    ROBOMATA_WORKFLOW_MUTATIONS_ENABLED: "true",
    STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
    STRIPE_WEBHOOK_TOLERANCE_SECONDS: "not-a-number",
  };

  await startServer(env);

  const renterPayload = await fetchJson(`${baseUrl}/api/robomata/rental-renters`, {
    body: JSON.stringify({ displayName: "Stripe Smoke Renter", email: "stripe-renter@example.test" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const renterId = renterPayload.renter?.id;
  if (!renterId) throw new Error(`Expected renter id, got ${JSON.stringify(renterPayload)}`);
  await approveRenterVerification(renterId);
  const authHeaders = authHeaderBuilder({ account: partnerAccount, partnerAddress: partnerAccount.address });

  const checkoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + 4 * 24 * 60 * 60 * 1_000).toISOString(),
      platformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const bookingId = checkoutPayload.booking?.id;
  const checkoutAccessToken = checkoutPayload.checkoutAccessToken;
  if (!bookingId || checkoutPayload.booking.state !== "pending_payment_authorization") {
    throw new Error(`Expected payment-gated booking, got ${JSON.stringify(checkoutPayload)}`);
  }
  if (!checkoutAccessToken) throw new Error(`Expected checkout access token, got ${JSON.stringify(checkoutPayload)}`);

  const unreconciledCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (4 * 24 + 6) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (4 * 24 + 18) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const unreconciledBookingId = unreconciledCheckoutPayload.booking?.id;
  if (!unreconciledBookingId || unreconciledCheckoutPayload.booking.state !== "pending_payment_authorization") {
    throw new Error(`Expected second payment-gated booking, got ${JSON.stringify(unreconciledCheckoutPayload)}`);
  }

  const reconciliationRecoveryCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (4 * 24 + 20) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (4 * 24 + 23) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const reconciliationRecoveryBookingId = reconciliationRecoveryCheckoutPayload.booking?.id;
  const reconciliationRecoveryCheckoutAccessToken = reconciliationRecoveryCheckoutPayload.checkoutAccessToken;
  if (
    !reconciliationRecoveryBookingId ||
    reconciliationRecoveryCheckoutPayload.booking.state !== "pending_payment_authorization" ||
    !reconciliationRecoveryCheckoutAccessToken
  ) {
    throw new Error(
      `Expected reconciliation recovery booking, got ${JSON.stringify(reconciliationRecoveryCheckoutPayload)}`,
    );
  }

  const longTripCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + 6 * 24 * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + 9 * 24 * 60 * 60 * 1_000).toISOString(),
      platformVehicleId: longTripPlatformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const longTripBookingId = longTripCheckoutPayload.booking?.id;
  const longTripCheckoutAccessToken = longTripCheckoutPayload.checkoutAccessToken;
  if (
    !longTripBookingId ||
    longTripCheckoutPayload.booking.state !== "pending_payment_authorization" ||
    !longTripCheckoutAccessToken
  ) {
    throw new Error(`Expected long-trip payment-gated booking, got ${JSON.stringify(longTripCheckoutPayload)}`);
  }

  const longLeadCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + 32 * 24 * 60 * 60 * 1_000).toISOString(),
      platformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const longLeadBookingId = longLeadCheckoutPayload.booking?.id;
  const longLeadCheckoutAccessToken = longLeadCheckoutPayload.checkoutAccessToken;
  if (
    !longLeadBookingId ||
    longLeadCheckoutPayload.booking.state !== "pending_payment_authorization" ||
    !longLeadCheckoutAccessToken
  ) {
    throw new Error(`Expected long-lead payment-gated booking, got ${JSON.stringify(longLeadCheckoutPayload)}`);
  }

  const staleNoIntentCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (2 * 24 + 6) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (2 * 24 + 18) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId: longTripPlatformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const staleNoIntentBookingId = staleNoIntentCheckoutPayload.booking?.id;
  const staleNoIntentCheckoutAccessToken = staleNoIntentCheckoutPayload.checkoutAccessToken;
  if (!staleNoIntentBookingId || !staleNoIntentCheckoutAccessToken) {
    throw new Error(`Expected stale no-intent guard booking, got ${JSON.stringify(staleNoIntentCheckoutPayload)}`);
  }
  await updateStoredBooking(env.ROBOMATA_RENTAL_BOOKINGS_FILE, staleNoIntentBookingId, booking => ({
    ...booking,
    dateFrom: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
    dateTo: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
  }));
  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-payments/payment-intents`,
    {
      body: JSON.stringify({
        bookingId: staleNoIntentBookingId,
        checkoutAccessToken: staleNoIntentCheckoutAccessToken,
        renterId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    409,
    "Booking dates are no longer valid for payment authorization",
  );

  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-payments/payment-intents`,
    {
      body: JSON.stringify({ bookingId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    400,
    "renterId must be provided",
  );

  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-payments/payment-intents`,
    {
      body: JSON.stringify({
        bookingId: longLeadBookingId,
        checkoutAccessToken: longLeadCheckoutAccessToken,
        renterId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    409,
    "outside Stripe manual-capture authorization window",
  );

  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-payments/payment-intents`,
    {
      body: JSON.stringify({
        bookingId: longTripBookingId,
        checkoutAccessToken: longTripCheckoutAccessToken,
        renterId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    409,
    "outside Stripe manual-capture authorization window",
  );

  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-payments/reconcile`,
    {
      body: JSON.stringify({ bookingId, paymentIntentId: "pi_mock_rb_wrong" }),
      headers: {
        "content-type": "application/json",
        "x-robomata-payment-confirmation": paymentConfirmationSecret,
      },
      method: "POST",
    },
    409,
    "metadata does not match",
  );

  const orphanMismatchedWebhookBody = JSON.stringify({
    id: "evt_payment_orphan_mismatch_smoke",
    created: Math.floor(Date.now() / 1000),
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: "pi_mock_orphan_mismatch",
        amount: checkoutPayload.booking.paymentPlan.totalDueAtAuthorizationCents,
        amount_capturable: 0,
        amount_received: checkoutPayload.booking.paymentPlan.totalDueAtAuthorizationCents,
        capture_method: "manual",
        currency: "usd",
        latest_charge: "ch_stripe_smoke_orphan_mismatch",
        metadata: { bookingId, facilityAssetId: otherFacilityAssetId, platformVehicleId },
        status: "succeeded",
      },
    },
  });
  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-payments/stripe/webhook`,
    {
      body: orphanMismatchedWebhookBody,
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSignatureHeader(orphanMismatchedWebhookBody),
      },
      method: "POST",
    },
    400,
    "metadata does not match",
  );

  const paymentIntentPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/payment-intents`, {
    body: JSON.stringify({ bookingId, checkoutAccessToken, renterId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  let paymentIntentId = paymentIntentPayload.payment?.providerReference?.paymentIntentId;
  if (!paymentIntentId || !paymentIntentPayload.clientSecret) {
    throw new Error(`Expected mock PaymentIntent and client secret, got ${JSON.stringify(paymentIntentPayload)}`);
  }

  const missedWebhookCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (3 * 24 + 6) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (3 * 24 + 18) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId: longTripPlatformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const missedWebhookBookingId = missedWebhookCheckoutPayload.booking?.id;
  const missedWebhookCheckoutAccessToken = missedWebhookCheckoutPayload.checkoutAccessToken;
  if (!missedWebhookBookingId || !missedWebhookCheckoutAccessToken) {
    throw new Error(`Expected missed-webhook recovery booking, got ${JSON.stringify(missedWebhookCheckoutPayload)}`);
  }
  const missedWebhookIntentPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/payment-intents`, {
    body: JSON.stringify({
      bookingId: missedWebhookBookingId,
      checkoutAccessToken: missedWebhookCheckoutAccessToken,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const missedWebhookPaymentIntentId = missedWebhookIntentPayload.payment?.providerReference?.paymentIntentId;
  if (!missedWebhookPaymentIntentId) {
    throw new Error(`Expected missed-webhook PaymentIntent, got ${JSON.stringify(missedWebhookIntentPayload)}`);
  }
  await updateStoredPayment(env.ROBOMATA_RENTAL_PAYMENTS_FILE, missedWebhookPaymentIntentId, payment => ({
    ...payment,
    capturedAmountCents: 0,
    postingBlocked: true,
    postingBlockReason: "Smoke simulated missed provider webhook.",
    status: "requires_payment_method",
  }));
  const missedWebhookReusePayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/payment-intents`, {
    body: JSON.stringify({
      bookingId: missedWebhookBookingId,
      checkoutAccessToken: missedWebhookCheckoutAccessToken,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (
    missedWebhookReusePayload.payment?.providerReference?.paymentIntentId !== missedWebhookPaymentIntentId ||
    missedWebhookReusePayload.payment.status !== "captured" ||
    missedWebhookReusePayload.payment.postingBlocked
  ) {
    throw new Error(
      `Expected reused successful PaymentIntent to refresh local payment, got ${JSON.stringify(
        missedWebhookReusePayload,
      )}`,
    );
  }
  const missedWebhookBookingPayload = await fetchJson(
    `${baseUrl}/api/robomata/rental-bookings/${missedWebhookBookingId}`,
    {
      headers: await authHeaders("GET", `/api/robomata/rental-bookings/${missedWebhookBookingId}`),
      method: "GET",
    },
  );
  if (
    missedWebhookBookingPayload.booking?.state !== "confirmed" ||
    missedWebhookBookingPayload.booking.paymentProviderReference?.paymentIntentId !== missedWebhookPaymentIntentId
  ) {
    throw new Error(
      `Expected reused successful PaymentIntent to confirm booking, got ${JSON.stringify(
        missedWebhookBookingPayload,
      )}`,
    );
  }

  const cachedAuthorizedCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (3 * 24 + 20) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (3 * 24 + 22) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId: longTripPlatformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const cachedAuthorizedBookingId = cachedAuthorizedCheckoutPayload.booking?.id;
  const cachedAuthorizedCheckoutAccessToken = cachedAuthorizedCheckoutPayload.checkoutAccessToken;
  if (!cachedAuthorizedBookingId || !cachedAuthorizedCheckoutAccessToken) {
    throw new Error(`Expected cached-authorized booking, got ${JSON.stringify(cachedAuthorizedCheckoutPayload)}`);
  }
  const cachedAuthorizedIntentPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/payment-intents`, {
    body: JSON.stringify({
      bookingId: cachedAuthorizedBookingId,
      checkoutAccessToken: cachedAuthorizedCheckoutAccessToken,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const cachedAuthorizedPaymentIntentId = cachedAuthorizedIntentPayload.payment?.providerReference?.paymentIntentId;
  if (!cachedAuthorizedPaymentIntentId) {
    throw new Error(`Expected cached-authorized PaymentIntent, got ${JSON.stringify(cachedAuthorizedIntentPayload)}`);
  }
  await updateStoredPayment(env.ROBOMATA_RENTAL_PAYMENTS_FILE, cachedAuthorizedPaymentIntentId, payment => ({
    ...payment,
    postingBlocked: true,
    postingBlockReason: "Smoke cached authorization not yet advanced.",
    status: "requires_capture",
  }));
  const cachedAuthorizedReusePayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/payment-intents`, {
    body: JSON.stringify({
      bookingId: cachedAuthorizedBookingId,
      checkoutAccessToken: cachedAuthorizedCheckoutAccessToken,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (
    cachedAuthorizedReusePayload.payment?.providerReference?.paymentIntentId !== cachedAuthorizedPaymentIntentId ||
    cachedAuthorizedReusePayload.payment.status !== "requires_capture" ||
    !cachedAuthorizedReusePayload.clientSecret
  ) {
    throw new Error(
      `Expected cached successful PaymentIntent to be reused with a client secret, got ${JSON.stringify(
        cachedAuthorizedReusePayload,
      )}`,
    );
  }
  const cachedAuthorizedBookingPayload = await fetchJson(
    `${baseUrl}/api/robomata/rental-bookings/${cachedAuthorizedBookingId}`,
    {
      headers: await authHeaders("GET", `/api/robomata/rental-bookings/${cachedAuthorizedBookingId}`),
      method: "GET",
    },
  );
  if (
    cachedAuthorizedBookingPayload.booking?.state !== "confirmed" ||
    cachedAuthorizedBookingPayload.booking.paymentProviderReference?.paymentIntentId !== cachedAuthorizedPaymentIntentId
  ) {
    throw new Error(
      `Expected cached successful PaymentIntent to advance booking, got ${JSON.stringify(
        cachedAuthorizedBookingPayload,
      )}`,
    );
  }

  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-payments/payment-intents`,
    {
      body: JSON.stringify({ bookingId, checkoutAccessToken: "wrong-checkout-token", renterId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    403,
    "Invalid checkout authorization token",
  );

  const canceledWebhookBody = JSON.stringify({
    id: "evt_payment_canceled_smoke",
    created: Math.floor(Date.now() / 1000),
    type: "payment_intent.canceled",
    data: {
      object: {
        id: paymentIntentId,
        amount: paymentIntentPayload.payment.authorizedAmountCents,
        amount_capturable: 0,
        amount_received: 0,
        capture_method: "manual",
        currency: "usd",
        latest_charge: "ch_stripe_smoke_cancelled",
        metadata: { bookingId },
        status: "canceled",
      },
    },
  });
  const canceledPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: canceledWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(canceledWebhookBody),
    },
    method: "POST",
  });
  if (canceledPayload.payment?.status !== "cancelled" || !canceledPayload.payment.postingBlocked) {
    throw new Error(`Expected canceled PaymentIntent to be blocked, got ${JSON.stringify(canceledPayload)}`);
  }

  const staleCapturableAfterCancelWebhookBody = JSON.stringify({
    id: "evt_payment_capturable_after_cancel_smoke",
    created: Math.floor(Date.now() / 1000) - 30,
    type: "payment_intent.amount_capturable_updated",
    data: {
      object: {
        id: paymentIntentId,
        amount: paymentIntentPayload.payment.authorizedAmountCents,
        amount_capturable: paymentIntentPayload.payment.authorizedAmountCents,
        amount_received: 0,
        capture_method: "manual",
        currency: "usd",
        latest_charge: "ch_stripe_smoke_cancelled",
        metadata: { bookingId },
        status: "requires_capture",
      },
    },
  });
  const staleCapturableAfterCancelPayload = await fetchJson(
    `${baseUrl}/api/robomata/rental-payments/stripe/webhook`,
    {
      body: staleCapturableAfterCancelWebhookBody,
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSignatureHeader(staleCapturableAfterCancelWebhookBody),
      },
      method: "POST",
    },
  );
  if (
    staleCapturableAfterCancelPayload.payment?.status !== "cancelled" ||
    !staleCapturableAfterCancelPayload.payment.postingBlocked
  ) {
    throw new Error(
      `Expected stale capturable webhook after cancel to preserve cancelled status, got ${JSON.stringify(
        staleCapturableAfterCancelPayload,
      )}`,
    );
  }

  const replacementPaymentIntentPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/payment-intents`, {
    body: JSON.stringify({ bookingId, checkoutAccessToken, renterId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const replacementPaymentIntentId = replacementPaymentIntentPayload.payment?.providerReference?.paymentIntentId;
  if (!replacementPaymentIntentId || replacementPaymentIntentId === paymentIntentId) {
    throw new Error(
      `Expected canceled PaymentIntent to be replaced, got ${JSON.stringify(replacementPaymentIntentPayload)}`,
    );
  }
  const canceledPaymentIntentId = paymentIntentId;
  paymentIntentId = replacementPaymentIntentId;

  const delayedCanceledWebhookBody = JSON.stringify({
    id: "evt_payment_canceled_delayed_smoke",
    created: Math.floor(Date.now() / 1000),
    type: "payment_intent.canceled",
    data: {
      object: {
        id: canceledPaymentIntentId,
        amount: paymentIntentPayload.payment.authorizedAmountCents,
        amount_capturable: 0,
        amount_received: 0,
        capture_method: "manual",
        currency: "usd",
        latest_charge: "ch_stripe_smoke_cancelled_stale",
        metadata: { bookingId },
        status: "canceled",
      },
    },
  });
  await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: delayedCanceledWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(delayedCanceledWebhookBody),
    },
    method: "POST",
  });
  const staleCanceledReusePayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/payment-intents`, {
    body: JSON.stringify({ bookingId, checkoutAccessToken, renterId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (staleCanceledReusePayload.payment?.providerReference?.paymentIntentId !== replacementPaymentIntentId) {
    throw new Error(
      `Expected stale canceled intent to reuse active replacement, got ${JSON.stringify(staleCanceledReusePayload)}`,
    );
  }

  const routeCancelCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (4 * 24 + 3) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (4 * 24 + 5) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId: longTripPlatformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const routeCancelBookingId = routeCancelCheckoutPayload.booking?.id;
  const routeCancelCheckoutAccessToken = routeCancelCheckoutPayload.checkoutAccessToken;
  if (!routeCancelBookingId || !routeCancelCheckoutAccessToken) {
    throw new Error(`Expected route-cancel booking, got ${JSON.stringify(routeCancelCheckoutPayload)}`);
  }
  const routeCancelPaymentIntentPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/payment-intents`, {
    body: JSON.stringify({ bookingId: routeCancelBookingId, checkoutAccessToken: routeCancelCheckoutAccessToken, renterId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const routeCancelPaymentIntentId = routeCancelPaymentIntentPayload.payment?.providerReference?.paymentIntentId;
  if (!routeCancelPaymentIntentId) {
    throw new Error(`Expected route-cancel PaymentIntent, got ${JSON.stringify(routeCancelPaymentIntentPayload)}`);
  }
  const routeCancelPath = `/api/robomata/rental-bookings/${routeCancelBookingId}/cancel`;
  const routeCancelPayload = await fetchJson(`${baseUrl}${routeCancelPath}`, {
    body: JSON.stringify({
      actor: { id: "stripe-smoke-host", role: "host" },
      reason: "host_cancelled",
    }),
    headers: await authHeaders("POST", routeCancelPath, { "content-type": "application/json" }),
    method: "POST",
  });
  if (
    routeCancelPayload.booking?.state !== "cancelled" ||
    routeCancelPayload.payments?.[0]?.providerReference?.paymentIntentId !== routeCancelPaymentIntentId ||
    routeCancelPayload.payments?.[0]?.status !== "cancelled"
  ) {
    throw new Error(`Expected booking cancel route to cancel Stripe hold, got ${JSON.stringify(routeCancelPayload)}`);
  }
  const storedCancelledPayment = await readStoredPayment(env.ROBOMATA_RENTAL_PAYMENTS_FILE, routeCancelPaymentIntentId);
  if (storedCancelledPayment?.status !== "cancelled" || !storedCancelledPayment.postingBlocked) {
    throw new Error(`Expected stored route-cancel payment to be cancelled, got ${JSON.stringify(storedCancelledPayment)}`);
  }
  const routeCancelRetryPayload = await fetchJson(`${baseUrl}${routeCancelPath}`, {
    body: JSON.stringify({
      actor: { id: "stripe-smoke-host", role: "host" },
      reason: "host_cancelled",
    }),
    headers: await authHeaders("POST", routeCancelPath, { "content-type": "application/json" }),
    method: "POST",
  });
  if (routeCancelRetryPayload.booking?.state !== "cancelled" || !Array.isArray(routeCancelRetryPayload.payments)) {
    throw new Error(`Expected cancelled booking route retry to remain idempotent, got ${JSON.stringify(routeCancelRetryPayload)}`);
  }

  const bridgeCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (5 * 24 + 1) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (5 * 24 + 4) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId: bridgePlatformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const bridgeBookingId = bridgeCheckoutPayload.booking?.id;
  const bridgeCheckoutAccessToken = bridgeCheckoutPayload.checkoutAccessToken;
  if (!bridgeBookingId || !bridgeCheckoutAccessToken) {
    throw new Error(`Expected Bridge booking, got ${JSON.stringify(bridgeCheckoutPayload)}`);
  }
  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-payments/bridge/transfers`,
    {
      body: JSON.stringify({
        bookingId: bridgeBookingId,
        checkoutAccessToken: bridgeCheckoutAccessToken,
        renterId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    400,
    "fromAddress",
  );
  const bridgeTransferPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/transfers`, {
    body: JSON.stringify({
      bookingId: bridgeBookingId,
      checkoutAccessToken: bridgeCheckoutAccessToken,
      fromAddress: "0xbridgeSmokeRenter",
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const bridgeTransferId = bridgeTransferPayload.payment?.providerReference?.transferId;
  if (
    !bridgeTransferId ||
    bridgeTransferPayload.payment.providerReference.paymentIntentId ||
    bridgeTransferPayload.payment.status !== "awaiting_funds"
  ) {
    throw new Error(`Expected Bridge transfer without Stripe PaymentIntent id, got ${JSON.stringify(bridgeTransferPayload)}`);
  }
  const activeBridgeRetryPayload = await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-payments/bridge/transfers`,
    {
      body: JSON.stringify({
        bookingId: bridgeBookingId,
        checkoutAccessToken: bridgeCheckoutAccessToken,
        fromAddress: "0xbridgeSmokeRenter",
        renterId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    409,
    "active Bridge transfer",
  );
  if (
    JSON.stringify(activeBridgeRetryPayload.sourceDepositInstructions) !==
    JSON.stringify(bridgeTransferPayload.transfer.source_deposit_instructions)
  ) {
    throw new Error(
      `Expected active Bridge retry to return original deposit instructions, got ${JSON.stringify(
        activeBridgeRetryPayload,
      )}`,
    );
  }
  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-payments/payment-intents`,
    {
      body: JSON.stringify({ bookingId: bridgeBookingId, checkoutAccessToken: bridgeCheckoutAccessToken, renterId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    409,
    "in-flight Bridge transfer",
  );
  const unrelatedBridgeWebhookPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/webhook`, {
    body: JSON.stringify({
      event_category: "transfer",
      event_created_at: new Date().toISOString(),
      event_id: "evt_bridge_unrelated_smoke",
      event_object: {
        amount: "12.34",
        currency: "usd",
        destination: bridgeTransferPayload.transfer.destination,
        id: "bt_mock_unrelated_smoke",
        on_behalf_of: bridgeTransferPayload.transfer.on_behalf_of,
        source: bridgeTransferPayload.transfer.source,
        state: "payment_processed",
        updated_at: new Date().toISOString(),
      },
      event_type: "updated",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (unrelatedBridgeWebhookPayload.ignored !== true) {
    throw new Error(`Expected unrelated Bridge webhook to be ignored, got ${JSON.stringify(unrelatedBridgeWebhookPayload)}`);
  }
  const processedBridgeWebhookBody = JSON.stringify({
    event_category: "transfer",
    event_created_at: new Date().toISOString(),
    event_id: "evt_bridge_processed_smoke",
    event_object: {
      ...bridgeTransferPayload.transfer,
      receipt: {
        destination_tx_hash: "0xbridgeDestinationReceiptSmoke",
        final_amount: bridgeTransferPayload.transfer.amount,
        source_tx_hash: "0xbridgeSourceReceiptSmoke",
      },
      state: "payment_processed",
      updated_at: new Date().toISOString(),
    },
    event_type: "updated",
  });
  const processedBridgePayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/webhook`, {
    body: processedBridgeWebhookBody,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (
    processedBridgePayload.payment?.status !== "captured" ||
    processedBridgePayload.payment.providerReference.destinationTxHash !== "0xbridgeDestinationReceiptSmoke"
  ) {
    throw new Error(`Expected processed Bridge webhook to capture with receipt hash, got ${JSON.stringify(processedBridgePayload)}`);
  }
  const duplicateProcessedBridgePayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/webhook`, {
    body: processedBridgeWebhookBody,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (
    duplicateProcessedBridgePayload.payment?.status !== "captured" ||
    duplicateProcessedBridgePayload.payment.postingBlocked
  ) {
    throw new Error(
      `Expected duplicate processed Bridge webhook to remain unblocked, got ${JSON.stringify(
        duplicateProcessedBridgePayload,
      )}`,
    );
  }
  const storedBridgePayment = await readStoredPayment(env.ROBOMATA_RENTAL_PAYMENTS_FILE, bridgeTransferId);
  if (
    storedBridgePayment?.providerReference?.destinationTxHash !== "0xbridgeDestinationReceiptSmoke" ||
    storedBridgePayment.providerReference.paymentIntentId
  ) {
    throw new Error(`Expected stored Bridge payment to keep transfer id separate, got ${JSON.stringify(storedBridgePayment)}`);
  }
  const bridgeBookingPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/${bridgeBookingId}`, {
    headers: await authHeaders("GET", `/api/robomata/rental-bookings/${bridgeBookingId}`),
    method: "GET",
  });
  if (
    bridgeBookingPayload.booking?.state !== "confirmed" ||
    bridgeBookingPayload.booking.paymentProviderReference?.transferId !== bridgeTransferId
  ) {
    throw new Error(`Expected processed Bridge transfer to confirm booking, got ${JSON.stringify(bridgeBookingPayload)}`);
  }
  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-bookings/${bridgeBookingId}/cancel`,
    {
      body: JSON.stringify({
        actor: { id: "bridge-smoke-host", role: "host" },
        reason: "host_cancelled",
      }),
      headers: await authHeaders("POST", `/api/robomata/rental-bookings/${bridgeBookingId}/cancel`, {
        "content-type": "application/json",
      }),
      method: "POST",
    },
    409,
    "in-flight Bridge transfer",
  );
  const refundInFlightBridgeWebhookBody = JSON.stringify({
    event_category: "transfer",
    event_created_at: new Date().toISOString(),
    event_id: "evt_bridge_refund_in_flight_smoke",
    event_object: {
      ...bridgeTransferPayload.transfer,
      receipt: {
        destination_tx_hash: "0xbridgeDestinationReceiptSmoke",
        final_amount: bridgeTransferPayload.transfer.amount,
        source_tx_hash: "0xbridgeSourceReceiptSmoke",
      },
      state: "refund_in_flight",
      updated_at: new Date().toISOString(),
    },
    event_type: "updated",
  });
  const refundInFlightBridgePayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/webhook`, {
    body: refundInFlightBridgeWebhookBody,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (
    refundInFlightBridgePayload.payment?.status !== "processing" ||
    !refundInFlightBridgePayload.payment.postingBlocked ||
    refundInFlightBridgePayload.payment.refundedAmountCents !== 0
  ) {
    throw new Error(
      `Expected refund-in-flight Bridge transfer to remain blocked, got ${JSON.stringify(refundInFlightBridgePayload)}`,
    );
  }
  const returnedBridgeWebhookBody = JSON.stringify({
    event_category: "transfer",
    event_created_at: new Date().toISOString(),
    event_id: "evt_bridge_returned_smoke",
    event_object: {
      ...bridgeTransferPayload.transfer,
      receipt: {
        destination_tx_hash: "0xbridgeDestinationReceiptSmoke",
        final_amount: bridgeTransferPayload.transfer.amount,
        source_tx_hash: "0xbridgeSourceReceiptSmoke",
      },
      state: "returned",
      updated_at: new Date().toISOString(),
    },
    event_type: "updated",
  });
  const returnedBridgePayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/webhook`, {
    body: returnedBridgeWebhookBody,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (
    returnedBridgePayload.payment?.status !== "processing" ||
    !returnedBridgePayload.payment.postingBlocked ||
    returnedBridgePayload.payment.refundedAmountCents !== 0
  ) {
    throw new Error(`Expected returned Bridge transfer to remain blocked, got ${JSON.stringify(returnedBridgePayload)}`);
  }
  const staleProcessedBridgePayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/webhook`, {
    body: processedBridgeWebhookBody,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (staleProcessedBridgePayload.payment?.status !== "processing" || !staleProcessedBridgePayload.payment.postingBlocked) {
    throw new Error(
      `Expected stale processed Bridge transfer to preserve return block, got ${JSON.stringify(staleProcessedBridgePayload)}`,
    );
  }
  const refundedBridgePayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/webhook`, {
    body: JSON.stringify({
      event_category: "transfer",
      event_created_at: new Date().toISOString(),
      event_id: "evt_bridge_refunded_smoke",
      event_object: {
        ...bridgeTransferPayload.transfer,
        receipt: {
          destination_tx_hash: "0xbridgeDestinationReceiptSmoke",
          final_amount: bridgeTransferPayload.transfer.amount,
          source_tx_hash: "0xbridgeSourceReceiptSmoke",
        },
        state: "refunded",
        updated_at: new Date().toISOString(),
      },
      event_type: "updated",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (refundedBridgePayload.payment?.status !== "refunded" || refundedBridgePayload.payment.postingBlocked) {
    throw new Error(`Expected refunded Bridge transfer to close the return, got ${JSON.stringify(refundedBridgePayload)}`);
  }
  const staleFundsReceivedAfterRefundPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/webhook`, {
    body: JSON.stringify({
      event_category: "transfer",
      event_created_at: new Date().toISOString(),
      event_id: "evt_bridge_funds_received_after_refund_smoke",
      event_object: {
        ...bridgeTransferPayload.transfer,
        state: "funds_received",
        updated_at: new Date().toISOString(),
      },
      event_type: "updated",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (
    staleFundsReceivedAfterRefundPayload.payment?.status !== "refunded" ||
    staleFundsReceivedAfterRefundPayload.payment.postingBlocked
  ) {
    throw new Error(
      `Expected stale Bridge webhook to preserve refunded state, got ${JSON.stringify(
        staleFundsReceivedAfterRefundPayload,
      )}`,
    );
  }

  const abandonedBridgeCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (5 * 24 + 4.1) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (5 * 24 + 4.5) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId: bridgePlatformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const abandonedBridgeBookingId = abandonedBridgeCheckoutPayload.booking?.id;
  const abandonedBridgeToken = abandonedBridgeCheckoutPayload.checkoutAccessToken;
  if (!abandonedBridgeBookingId || !abandonedBridgeToken) {
    throw new Error(`Expected abandoned Bridge booking, got ${JSON.stringify(abandonedBridgeCheckoutPayload)}`);
  }
  await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/transfers`, {
    body: JSON.stringify({
      bookingId: abandonedBridgeBookingId,
      checkoutAccessToken: abandonedBridgeToken,
      fromAddress: "0xbridgeSmokeRenter",
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const abandonedBridgeCancellationPayload = await fetchJson(
    `${baseUrl}/api/robomata/rental-bookings/${abandonedBridgeBookingId}/cancel`,
    {
      body: JSON.stringify({
        actor: { id: "bridge-smoke-host", role: "host" },
        reason: "host_cancelled",
      }),
      headers: await authHeaders("POST", `/api/robomata/rental-bookings/${abandonedBridgeBookingId}/cancel`, {
        "content-type": "application/json",
      }),
      method: "POST",
    },
  );
  if (
    abandonedBridgeCancellationPayload.booking?.state !== "cancelled" ||
    abandonedBridgeCancellationPayload.payments?.[0]?.status !== "cancelled"
  ) {
    throw new Error(
      `Expected abandoned awaiting-funds Bridge transfer to be cancelled with booking, got ${JSON.stringify(
        abandonedBridgeCancellationPayload,
      )}`,
    );
  }

  const bridgeBlockedCancelCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (5 * 24 + 5) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (5 * 24 + 8) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId: bridgePlatformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const bridgeBlockedCancelBookingId = bridgeBlockedCancelCheckoutPayload.booking?.id;
  const bridgeBlockedCancelToken = bridgeBlockedCancelCheckoutPayload.checkoutAccessToken;
  if (!bridgeBlockedCancelBookingId || !bridgeBlockedCancelToken) {
    throw new Error(`Expected Bridge cancellation-block booking, got ${JSON.stringify(bridgeBlockedCancelCheckoutPayload)}`);
  }
  const bridgeBlockedCancelTransferPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/transfers`, {
    body: JSON.stringify({
      bookingId: bridgeBlockedCancelBookingId,
      checkoutAccessToken: bridgeBlockedCancelToken,
      fromAddress: "0xbridgeSmokeRenter",
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/webhook`, {
    body: JSON.stringify({
      event_category: "transfer",
      event_created_at: new Date().toISOString(),
      event_id: "evt_bridge_funds_received_cancel_block_smoke",
      event_object: {
        ...bridgeBlockedCancelTransferPayload.transfer,
        state: "funds_received",
        updated_at: new Date().toISOString(),
      },
      event_type: "updated",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-bookings/${bridgeBlockedCancelBookingId}/cancel`,
    {
      body: JSON.stringify({
        actor: { id: "bridge-smoke-host", role: "host" },
        reason: "host_cancelled",
      }),
      headers: await authHeaders("POST", `/api/robomata/rental-bookings/${bridgeBlockedCancelBookingId}/cancel`, {
        "content-type": "application/json",
      }),
      method: "POST",
    },
    409,
    "in-flight Bridge transfer",
  );

  const replacementBridgeCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (5 * 24 + 9) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (5 * 24 + 12) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId: bridgePlatformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const replacementBridgeBookingId = replacementBridgeCheckoutPayload.booking?.id;
  const replacementBridgeToken = replacementBridgeCheckoutPayload.checkoutAccessToken;
  if (!replacementBridgeBookingId || !replacementBridgeToken) {
    throw new Error(`Expected Bridge replacement booking, got ${JSON.stringify(replacementBridgeCheckoutPayload)}`);
  }
  const firstReplacementBridgeTransferPayload = await fetchJson(
    `${baseUrl}/api/robomata/rental-payments/bridge/transfers`,
    {
      body: JSON.stringify({
        bookingId: replacementBridgeBookingId,
        checkoutAccessToken: replacementBridgeToken,
        fromAddress: "0xbridgeSmokeRenter",
        renterId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/webhook`, {
    body: JSON.stringify({
      event_category: "transfer",
      event_created_at: new Date().toISOString(),
      event_id: "evt_bridge_cancelled_replacement_smoke",
      event_object: {
        ...firstReplacementBridgeTransferPayload.transfer,
        state: "canceled",
        updated_at: new Date().toISOString(),
      },
      event_type: "updated",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const secondReplacementBridgeTransferPayload = await fetchJson(
    `${baseUrl}/api/robomata/rental-payments/bridge/transfers`,
    {
      body: JSON.stringify({
        bookingId: replacementBridgeBookingId,
        checkoutAccessToken: replacementBridgeToken,
        fromAddress: "0xbridgeSmokeRenter",
        renterId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  if (
    secondReplacementBridgeTransferPayload.payment?.providerReference?.transferId ===
    firstReplacementBridgeTransferPayload.payment?.providerReference?.transferId
  ) {
    throw new Error(
      `Expected Bridge replacement transfer to use a fresh idempotency key, got ${JSON.stringify(
        secondReplacementBridgeTransferPayload,
      )}`,
    );
  }

  const lateBridgeCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (5 * 24 + 13) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (5 * 24 + 16) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId: bridgePlatformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const lateBridgeBookingId = lateBridgeCheckoutPayload.booking?.id;
  const lateBridgeToken = lateBridgeCheckoutPayload.checkoutAccessToken;
  if (!lateBridgeBookingId || !lateBridgeToken) {
    throw new Error(`Expected late Bridge booking, got ${JSON.stringify(lateBridgeCheckoutPayload)}`);
  }
  const lateBridgeTransferPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/transfers`, {
    body: JSON.stringify({
      bookingId: lateBridgeBookingId,
      checkoutAccessToken: lateBridgeToken,
      fromAddress: "0xbridgeSmokeRenter",
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  await updateStoredBooking(env.ROBOMATA_RENTAL_BOOKINGS_FILE, lateBridgeBookingId, booking => ({
    ...booking,
    dateFrom: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
    dateTo: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
  }));
  const lateBridgeSettlementPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/webhook`, {
    body: JSON.stringify({
      event_category: "transfer",
      event_created_at: new Date().toISOString(),
      event_id: "evt_bridge_late_processed_smoke",
      event_object: {
        ...lateBridgeTransferPayload.transfer,
        receipt: {
          destination_tx_hash: "0xbridgeLateDestinationReceiptSmoke",
          final_amount: lateBridgeTransferPayload.transfer.amount,
          source_tx_hash: "0xbridgeLateSourceReceiptSmoke",
        },
        state: "payment_processed",
        updated_at: new Date().toISOString(),
      },
      event_type: "updated",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (
    lateBridgeSettlementPayload.payment?.status !== "captured" ||
    !lateBridgeSettlementPayload.payment.postingBlocked
  ) {
    throw new Error(`Expected late Bridge settlement to be captured but posting-blocked, got ${JSON.stringify(lateBridgeSettlementPayload)}`);
  }
  const staleLateBridgeCreatedPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/webhook`, {
    body: JSON.stringify({
      event_category: "transfer",
      event_created_at: new Date().toISOString(),
      event_id: "evt_bridge_late_stale_created_smoke",
      event_object: {
        ...lateBridgeTransferPayload.transfer,
        state: "awaiting_funds",
        updated_at: new Date().toISOString(),
      },
      event_type: "updated",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (
    staleLateBridgeCreatedPayload.payment?.status !== "captured" ||
    !staleLateBridgeCreatedPayload.payment.postingBlocked
  ) {
    throw new Error(
      `Expected stale late Bridge webhook to preserve posting block, got ${JSON.stringify(
        staleLateBridgeCreatedPayload,
      )}`,
    );
  }

  const underfundedBridgeCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (5 * 24 + 16.25) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (5 * 24 + 16.75) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId: bridgePlatformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const underfundedBridgeBookingId = underfundedBridgeCheckoutPayload.booking?.id;
  const underfundedBridgeToken = underfundedBridgeCheckoutPayload.checkoutAccessToken;
  if (!underfundedBridgeBookingId || !underfundedBridgeToken) {
    throw new Error(`Expected underfunded Bridge booking, got ${JSON.stringify(underfundedBridgeCheckoutPayload)}`);
  }
  const underfundedBridgeTransferPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/transfers`, {
    body: JSON.stringify({
      bookingId: underfundedBridgeBookingId,
      checkoutAccessToken: underfundedBridgeToken,
      fromAddress: "0xbridgeSmokeRenter",
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const underfundedFinalAmount = (
    Number(underfundedBridgeTransferPayload.transfer.amount) - 0.01
  ).toFixed(2);
  const underfundedBridgeSettlementPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/webhook`, {
    body: JSON.stringify({
      event_category: "transfer",
      event_created_at: new Date().toISOString(),
      event_id: "evt_bridge_underfunded_processed_smoke",
      event_object: {
        ...underfundedBridgeTransferPayload.transfer,
        receipt: {
          destination_tx_hash: "0xbridgeUnderfundedDestinationReceiptSmoke",
          final_amount: underfundedFinalAmount,
          source_tx_hash: "0xbridgeUnderfundedSourceReceiptSmoke",
        },
        state: "payment_processed",
        updated_at: new Date().toISOString(),
      },
      event_type: "updated",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (
    underfundedBridgeSettlementPayload.payment?.status !== "captured" ||
    !underfundedBridgeSettlementPayload.payment.postingBlocked
  ) {
    throw new Error(
      `Expected underfunded Bridge settlement to be captured but posting-blocked, got ${JSON.stringify(
        underfundedBridgeSettlementPayload,
      )}`,
    );
  }
  const underfundedBridgeBookingPayload = await fetchJson(
    `${baseUrl}/api/robomata/rental-bookings/${underfundedBridgeBookingId}`,
    {
      headers: await authHeaders("GET", `/api/robomata/rental-bookings/${underfundedBridgeBookingId}`),
      method: "GET",
    },
  );
  if (underfundedBridgeBookingPayload.booking?.state !== "pending_payment_authorization") {
    throw new Error(
      `Expected underfunded Bridge settlement to leave booking pending, got ${JSON.stringify(
        underfundedBridgeBookingPayload,
      )}`,
    );
  }

  const failedStripeBeforeBridgeCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (5 * 24 + 17) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (5 * 24 + 20) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId: bridgePlatformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const failedStripeBeforeBridgeBookingId = failedStripeBeforeBridgeCheckoutPayload.booking?.id;
  const failedStripeBeforeBridgeToken = failedStripeBeforeBridgeCheckoutPayload.checkoutAccessToken;
  if (!failedStripeBeforeBridgeBookingId || !failedStripeBeforeBridgeToken) {
    throw new Error(`Expected failed-Stripe-before-Bridge booking, got ${JSON.stringify(failedStripeBeforeBridgeCheckoutPayload)}`);
  }
  const failedStripeInitialIntentPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/payment-intents`, {
    body: JSON.stringify({
      bookingId: failedStripeBeforeBridgeBookingId,
      checkoutAccessToken: failedStripeBeforeBridgeToken,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const failedStripeInitialIntentId = failedStripeInitialIntentPayload.payment?.providerReference?.paymentIntentId;
  if (!failedStripeInitialIntentId) {
    throw new Error(`Expected failed Stripe initial intent, got ${JSON.stringify(failedStripeInitialIntentPayload)}`);
  }
  await updateStoredPayment(env.ROBOMATA_RENTAL_PAYMENTS_FILE, failedStripeInitialIntentId, payment => ({
    ...payment,
    status: "requires_payment_method",
  }));
  const failedStripeBeforeBridgeWebhookBody = JSON.stringify({
    id: "evt_failed_stripe_before_bridge_smoke",
    created: Math.floor(Date.now() / 1000),
    type: "payment_intent.payment_failed",
    data: {
      object: {
        id: failedStripeInitialIntentId,
        amount: failedStripeInitialIntentPayload.payment.authorizedAmountCents,
        currency: "usd",
        last_payment_error: { message: "Card declined before Bridge fallback." },
        metadata: { bookingId: failedStripeBeforeBridgeBookingId },
        status: "requires_payment_method",
      },
    },
  });
  await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: failedStripeBeforeBridgeWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(failedStripeBeforeBridgeWebhookBody),
    },
    method: "POST",
  });
  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-payments/bridge/transfers`,
    {
      body: JSON.stringify({
        bookingId: failedStripeBeforeBridgeBookingId,
        checkoutAccessToken: failedStripeBeforeBridgeToken,
        fromAddress: "0xbridgeSmokeRenter",
        renterId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    409,
    "active Stripe PaymentIntent",
  );
  const failedStripeRetryIntentPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/payment-intents`, {
    body: JSON.stringify({
      bookingId: failedStripeBeforeBridgeBookingId,
      checkoutAccessToken: failedStripeBeforeBridgeToken,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (failedStripeRetryIntentPayload.payment?.providerReference?.paymentIntentId !== failedStripeInitialIntentId) {
    throw new Error(
      `Expected failed Stripe retry to reuse the original intent, got ${JSON.stringify(failedStripeRetryIntentPayload)}`,
    );
  }

  const failedBridgeCardFallbackCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (5 * 24 + 21) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (6 * 24) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId: bridgePlatformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const failedBridgeCardFallbackBookingId = failedBridgeCardFallbackCheckoutPayload.booking?.id;
  const failedBridgeCardFallbackToken = failedBridgeCardFallbackCheckoutPayload.checkoutAccessToken;
  if (!failedBridgeCardFallbackBookingId || !failedBridgeCardFallbackToken) {
    throw new Error(`Expected failed Bridge card fallback booking, got ${JSON.stringify(failedBridgeCardFallbackCheckoutPayload)}`);
  }
  const failedBridgeCardFallbackTransferPayload = await fetchJson(
    `${baseUrl}/api/robomata/rental-payments/bridge/transfers`,
    {
      body: JSON.stringify({
        bookingId: failedBridgeCardFallbackBookingId,
        checkoutAccessToken: failedBridgeCardFallbackToken,
        fromAddress: "0xbridgeSmokeRenter",
        renterId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  const failedBridgeWebhookBody = JSON.stringify({
    event_category: "transfer",
    event_created_at: new Date().toISOString(),
    event_id: "evt_bridge_undeliverable_card_block_smoke",
    event_object: {
      ...failedBridgeCardFallbackTransferPayload.transfer,
      state: "undeliverable",
      updated_at: new Date().toISOString(),
    },
    event_type: "updated",
  });
  const failedBridgePayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/webhook`, {
    body: failedBridgeWebhookBody,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (failedBridgePayload.payment?.status !== "failed" || !failedBridgePayload.payment.postingBlocked) {
    throw new Error(`Expected failed Bridge transfer to block posting, got ${JSON.stringify(failedBridgePayload)}`);
  }
  const staleProcessedAfterFailedBridgePayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/bridge/webhook`, {
    body: JSON.stringify({
      event_category: "transfer",
      event_created_at: new Date().toISOString(),
      event_id: "evt_bridge_stale_processed_after_failed_smoke",
      event_object: {
        ...failedBridgeCardFallbackTransferPayload.transfer,
        receipt: {
          destination_tx_hash: "0xbridgeFailedDestinationReceiptSmoke",
          final_amount: failedBridgeCardFallbackTransferPayload.transfer.amount,
          source_tx_hash: "0xbridgeFailedSourceReceiptSmoke",
        },
        state: "payment_processed",
        updated_at: new Date().toISOString(),
      },
      event_type: "updated",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (
    staleProcessedAfterFailedBridgePayload.payment?.status !== "failed" ||
    !staleProcessedAfterFailedBridgePayload.payment.postingBlocked
  ) {
    throw new Error(
      `Expected stale processed Bridge webhook to preserve failed block, got ${JSON.stringify(
        staleProcessedAfterFailedBridgePayload,
      )}`,
    );
  }
  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-payments/bridge/transfers`,
    {
      body: JSON.stringify({
        bookingId: failedBridgeCardFallbackBookingId,
        checkoutAccessToken: failedBridgeCardFallbackToken,
        fromAddress: "0xbridgeSmokeRenter",
        renterId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    409,
    "active Bridge transfer",
  );
  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-payments/payment-intents`,
    {
      body: JSON.stringify({
        bookingId: failedBridgeCardFallbackBookingId,
        checkoutAccessToken: failedBridgeCardFallbackToken,
        renterId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    409,
    "Bridge transfer",
  );

  const underpaidBridgeCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (6 * 24 + 18) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (6 * 24 + 21) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId: bridgePlatformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const underpaidBridgeBooking = underpaidBridgeCheckoutPayload.booking;
  if (!underpaidBridgeBooking?.id) {
    throw new Error(`Expected underpaid Bridge booking, got ${JSON.stringify(underpaidBridgeCheckoutPayload)}`);
  }
  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-payments/bridge/webhook`,
    {
      body: JSON.stringify({
        event_category: "transfer",
        event_created_at: new Date().toISOString(),
        event_id: "evt_bridge_underpaid_smoke",
        event_object: {
          amount: "1.00",
          client_reference_id: underpaidBridgeBooking.id,
          created_at: new Date().toISOString(),
          currency: "usd",
          destination: {
            currency: "usdc",
            payment_rail: "base",
            to_address: "0xbridgeSmokeTreasury",
          },
          id: `bt_smoke_underpaid_${underpaidBridgeBooking.id}`,
          on_behalf_of: "bridge-smoke-customer",
          source: {
            currency: "usdc",
            from_address: "0xbridgeSmokeRenter",
            payment_rail: "base",
          },
          state: "payment_processed",
          updated_at: new Date().toISOString(),
        },
        event_type: "updated",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    400,
    "does not match the rental booking",
  );

  const stripeFirstBridgeCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (6 * 24 + 22) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (6 * 24 + 23) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId: bridgePlatformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const stripeFirstBridgeBookingId = stripeFirstBridgeCheckoutPayload.booking?.id;
  const stripeFirstBridgeToken = stripeFirstBridgeCheckoutPayload.checkoutAccessToken;
  if (!stripeFirstBridgeBookingId || !stripeFirstBridgeToken) {
    throw new Error(`Expected Stripe-first Bridge guard booking, got ${JSON.stringify(stripeFirstBridgeCheckoutPayload)}`);
  }
  await fetchJson(`${baseUrl}/api/robomata/rental-payments/payment-intents`, {
    body: JSON.stringify({
      bookingId: stripeFirstBridgeBookingId,
      checkoutAccessToken: stripeFirstBridgeToken,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-payments/bridge/transfers`,
    {
      body: JSON.stringify({
        bookingId: stripeFirstBridgeBookingId,
        checkoutAccessToken: stripeFirstBridgeToken,
        fromAddress: "0xbridgeSmokeRenter",
        renterId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    409,
    "active Stripe PaymentIntent",
  );

  const staleCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (5 * 24 + 6) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (5 * 24 + 18) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId: longTripPlatformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const staleBookingId = staleCheckoutPayload.booking?.id;
  const staleCheckoutAccessToken = staleCheckoutPayload.checkoutAccessToken;
  if (!staleBookingId || !staleCheckoutAccessToken) {
    throw new Error(`Expected stale-date guard booking, got ${JSON.stringify(staleCheckoutPayload)}`);
  }
  const stalePaymentIntentPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/payment-intents`, {
    body: JSON.stringify({ bookingId: staleBookingId, checkoutAccessToken: staleCheckoutAccessToken, renterId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const stalePaymentIntentId = stalePaymentIntentPayload.payment?.providerReference?.paymentIntentId;
  if (!stalePaymentIntentId) {
    throw new Error(`Expected stale-date guard PaymentIntent, got ${JSON.stringify(stalePaymentIntentPayload)}`);
  }
  await updateStoredBooking(env.ROBOMATA_RENTAL_BOOKINGS_FILE, staleBookingId, booking => ({
    ...booking,
    dateFrom: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
    dateTo: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
  }));
  const staleCapturableWebhookBody = JSON.stringify({
    id: "evt_payment_stale_booking_capturable_smoke",
    created: Math.floor(Date.now() / 1000),
    type: "payment_intent.amount_capturable_updated",
    data: {
      object: {
        id: stalePaymentIntentId,
        amount: stalePaymentIntentPayload.payment.authorizedAmountCents,
        amount_capturable: stalePaymentIntentPayload.payment.authorizedAmountCents,
        amount_received: 0,
        capture_method: "manual",
        currency: "usd",
        latest_charge: "ch_stripe_smoke_stale_booking",
        metadata: { bookingId: staleBookingId },
        status: "requires_capture",
      },
    },
  });
  await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: staleCapturableWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(staleCapturableWebhookBody),
    },
    method: "POST",
  });
  const staleBookingPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/${staleBookingId}`, {
    headers: await authHeaders("GET", `/api/robomata/rental-bookings/${staleBookingId}`),
    method: "GET",
  });
  if (staleBookingPayload.booking?.state !== "pending_payment_authorization") {
    throw new Error(`Expected stale booking to remain pending, got ${JSON.stringify(staleBookingPayload)}`);
  }

  const capturableWebhookBody = JSON.stringify({
    id: "evt_payment_capturable_smoke",
    created: Math.floor(Date.now() / 1000),
    type: "payment_intent.amount_capturable_updated",
    data: {
      object: {
        id: paymentIntentId,
        amount: paymentIntentPayload.payment.authorizedAmountCents,
        amount_capturable: paymentIntentPayload.payment.authorizedAmountCents,
        amount_received: 0,
        capture_method: "manual",
        currency: "usd",
        latest_charge: "ch_stripe_smoke_actual",
        metadata: { bookingId },
        status: "requires_capture",
      },
    },
  });
  const capturablePayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: capturableWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(capturableWebhookBody, Math.floor(Date.now() / 1000), [
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      ]),
    },
    method: "POST",
  });
  if (capturablePayload.payment?.providerReference?.chargeId !== "ch_stripe_smoke_actual") {
    throw new Error(`Expected real charge id from PaymentIntent webhook, got ${JSON.stringify(capturablePayload)}`);
  }
  const authorizedBookingPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/${bookingId}`, {
    headers: await authHeaders("GET", `/api/robomata/rental-bookings/${bookingId}`),
    method: "GET",
  });
  if (
    authorizedBookingPayload.booking?.state !== "confirmed" ||
    authorizedBookingPayload.booking.paymentProviderReference?.paymentIntentId !== paymentIntentId
  ) {
    throw new Error(`Expected authorization webhook to confirm booking, got ${JSON.stringify(authorizedBookingPayload)}`);
  }

  const staleCreatedWebhookBody = JSON.stringify({
    id: "evt_payment_created_after_authorization_smoke",
    created: Math.floor(Date.now() / 1000) - 30,
    type: "payment_intent.created",
    data: {
      object: {
        id: paymentIntentId,
        amount: paymentIntentPayload.payment.authorizedAmountCents,
        amount_capturable: 0,
        amount_received: 0,
        capture_method: "manual",
        currency: "usd",
        latest_charge: "ch_stripe_smoke_actual",
        metadata: { bookingId },
        status: "requires_payment_method",
      },
    },
  });
  const staleCreatedPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: staleCreatedWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(staleCreatedWebhookBody),
    },
    method: "POST",
  });
  if (staleCreatedPayload.payment?.status !== "requires_capture" || !staleCreatedPayload.payment.postingBlocked) {
    throw new Error(
      `Expected stale created webhook to preserve authorized status, got ${JSON.stringify(staleCreatedPayload)}`,
    );
  }

  const failedWebhookBody = JSON.stringify({
    id: "evt_payment_failed_smoke",
    created: Math.floor(Date.now() / 1000),
    type: "payment_intent.payment_failed",
    data: {
      object: {
        id: paymentIntentId,
        amount: paymentIntentPayload.payment.authorizedAmountCents,
        currency: "usd",
        last_payment_error: { message: "Card declined in smoke." },
        metadata: { bookingId },
        status: "requires_payment_method",
      },
    },
  });
  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-payments/stripe/webhook`,
    {
      body: failedWebhookBody,
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSignatureHeader(failedWebhookBody, Math.floor(Date.now() / 1000) - 600),
      },
      method: "POST",
    },
    400,
    "outside the allowed tolerance",
  );

  const failedWebhookPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: failedWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(failedWebhookBody),
    },
    method: "POST",
  });
  if (!failedWebhookPayload.payment?.postingBlocked) {
    throw new Error(`Expected failed payment to block posting, got ${JSON.stringify(failedWebhookPayload)}`);
  }

  const postingPath = "/api/robomata/rental-revenue/posting-batches";
  const passThroughCapCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (6 * 24 + 6) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (6 * 24 + 10) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const passThroughCapBookingId = passThroughCapCheckoutPayload.booking?.id;
  const passThroughCapCheckoutAccessToken = passThroughCapCheckoutPayload.checkoutAccessToken;
  if (!passThroughCapBookingId || !passThroughCapCheckoutAccessToken) {
    throw new Error(`Expected pass-through cap booking, got ${JSON.stringify(passThroughCapCheckoutPayload)}`);
  }
  const passThroughTaxCents = 125;
  const passThroughProtectionCents = 75;
  await updateStoredBooking(env.ROBOMATA_RENTAL_BOOKINGS_FILE, passThroughCapBookingId, booking => ({
    ...booking,
    paymentPlan: {
      ...booking.paymentPlan,
      rentalCharge: {
        ...booking.paymentPlan.rentalCharge,
        protectionPlanCents: passThroughProtectionCents,
        taxesCents: passThroughTaxCents,
      },
    },
  }));
  const passThroughCapIntentPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/payment-intents`, {
    body: JSON.stringify({
      bookingId: passThroughCapBookingId,
      checkoutAccessToken: passThroughCapCheckoutAccessToken,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const passThroughCapPaymentIntentId = passThroughCapIntentPayload.payment?.providerReference?.paymentIntentId;
  const passThroughCapAuthorizedAmount = passThroughCapIntentPayload.payment?.authorizedAmountCents;
  const passThroughCapEligibleAmount =
    passThroughCapIntentPayload.payment?.revenueEligibleAmountCents ??
    passThroughCapAuthorizedAmount - passThroughTaxCents - passThroughProtectionCents;
  if (
    !passThroughCapPaymentIntentId ||
    typeof passThroughCapAuthorizedAmount !== "number" ||
    typeof passThroughCapEligibleAmount !== "number" ||
    passThroughCapEligibleAmount >= passThroughCapAuthorizedAmount
  ) {
    throw new Error(`Expected pass-through capped PaymentIntent, got ${JSON.stringify(passThroughCapIntentPayload)}`);
  }
  const passThroughCaptureWebhookBody = JSON.stringify({
    id: "evt_payment_pass_through_capture_smoke",
    created: Math.floor(Date.now() / 1000),
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: passThroughCapPaymentIntentId,
        amount: passThroughCapAuthorizedAmount,
        amount_capturable: 0,
        amount_received: passThroughCapAuthorizedAmount,
        capture_method: "manual",
        currency: "usd",
        latest_charge: "ch_stripe_smoke_pass_through",
        metadata: { bookingId: passThroughCapBookingId },
        status: "succeeded",
      },
    },
  });
  await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: passThroughCaptureWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(passThroughCaptureWebhookBody),
    },
    method: "POST",
  });
  const passThroughPostingBody = {
    entries: [
      {
        id: "rle_stripe_smoke_pass_through_cap",
        amountCents: passThroughCapEligibleAmount + 1,
        createdAt: new Date().toISOString(),
        currency: "USD",
        facilityAssetId,
        kind: "recognized_revenue",
        occurredAt: new Date().toISOString(),
        platformVehicleId,
        postingAssetId: facilityAssetId,
        postingAssetKind: "facility",
        source: { bookingId: passThroughCapBookingId, paymentIntentId: passThroughCapPaymentIntentId },
      },
    ],
    periodEnd: new Date(Date.now() + 30 * 60 * 60 * 1_000).toISOString(),
    periodStart: new Date(Date.now() + 26 * 60 * 60 * 1_000).toISOString(),
    target: {
      facilityAssetId,
      postingAssetId: facilityAssetId,
      postingAssetKind: "facility",
    },
  };
  await expectJsonFailure(
    `${baseUrl}${postingPath}`,
    {
      body: JSON.stringify(passThroughPostingBody),
      headers: await authHeaders("POST", postingPath, { "content-type": "application/json" }),
      method: "POST",
    },
    409,
    "Payment-backed revenue exceeds captured payment amount.",
  );

  const postingBody = {
    entries: [
      {
        id: "rle_stripe_smoke",
        amountCents: 1000,
        createdAt: new Date().toISOString(),
        currency: "USD",
        facilityAssetId,
        kind: "recognized_revenue",
        occurredAt: new Date().toISOString(),
        platformVehicleId,
        postingAssetId: facilityAssetId,
        postingAssetKind: "facility",
        source: { bookingId, paymentIntentId },
      },
    ],
    periodEnd: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
    periodStart: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
    target: {
      facilityAssetId,
      postingAssetId: facilityAssetId,
      postingAssetKind: "facility",
    },
  };
  await expectJsonFailure(
    `${baseUrl}${postingPath}`,
    {
      body: JSON.stringify({
        ...postingBody,
        entries: [
          {
            ...postingBody.entries[0],
            id: "rle_stripe_smoke_missing_payment_reference",
            source: {},
          },
        ],
      }),
      headers: await authHeaders("POST", postingPath, { "content-type": "application/json" }),
      method: "POST",
    },
    400,
    "Payment-backed revenue entries must include source.bookingId or source.paymentIntentId.",
  );
  await expectJsonFailure(
    `${baseUrl}${postingPath}`,
    {
      body: JSON.stringify(postingBody),
      headers: await authHeaders("POST", postingPath, { "content-type": "application/json" }),
      method: "POST",
    },
    409,
    "Payment reconciliation blocks rental revenue posting.",
  );
  await expectJsonFailure(
    `${baseUrl}${postingPath}`,
    {
      body: JSON.stringify({
        ...postingBody,
        entries: postingBody.entries.map(entry => ({
          ...entry,
          source: { bookingId },
        })),
      }),
      headers: await authHeaders("POST", postingPath, { "content-type": "application/json" }),
      method: "POST",
    },
    409,
    "Payment reconciliation blocks rental revenue posting.",
  );
  await expectJsonFailure(
    `${baseUrl}${postingPath}`,
    {
      body: JSON.stringify({
        ...postingBody,
        entries: [
          {
            ...postingBody.entries[0],
            id: "rle_stripe_smoke_unreconciled",
            source: { bookingId: unreconciledBookingId },
          },
        ],
      }),
      headers: await authHeaders("POST", postingPath, { "content-type": "application/json" }),
      method: "POST",
    },
    409,
    "Captured payment reconciliation is required before rental revenue posting.",
  );

  const reconciliationRecoveryIntentPayload = await fetchJson(
    `${baseUrl}/api/robomata/rental-payments/payment-intents`,
    {
      body: JSON.stringify({
        bookingId: reconciliationRecoveryBookingId,
        checkoutAccessToken: reconciliationRecoveryCheckoutAccessToken,
        renterId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  const reconciliationRecoveryPaymentIntentId =
    reconciliationRecoveryIntentPayload.payment?.providerReference?.paymentIntentId;
  if (!reconciliationRecoveryPaymentIntentId) {
    throw new Error(
      `Expected reconciliation recovery PaymentIntent, got ${JSON.stringify(reconciliationRecoveryIntentPayload)}`,
    );
  }
  await fetchJson(`${baseUrl}/api/robomata/rental-payments/reconcile`, {
    body: JSON.stringify({ paymentIntentId: reconciliationRecoveryPaymentIntentId }),
    headers: {
      "content-type": "application/json",
      "x-robomata-payment-confirmation": paymentConfirmationSecret,
    },
    method: "POST",
  });
  const reconciliationRecoveryBookingPayload = await fetchJson(
    `${baseUrl}/api/robomata/rental-bookings/${reconciliationRecoveryBookingId}`,
    {
      headers: await authHeaders("GET", `/api/robomata/rental-bookings/${reconciliationRecoveryBookingId}`),
      method: "GET",
    },
  );
  if (
    reconciliationRecoveryBookingPayload.booking?.state !== "confirmed" ||
    reconciliationRecoveryBookingPayload.booking.paymentProviderReference?.paymentIntentId !==
      reconciliationRecoveryPaymentIntentId
  ) {
    throw new Error(
      `Expected reconciliation to confirm recovered booking, got ${JSON.stringify(
        reconciliationRecoveryBookingPayload,
      )}`,
    );
  }

  const reconciliationPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/reconcile`, {
    body: JSON.stringify({ paymentIntentId }),
    headers: {
      "content-type": "application/json",
      "x-robomata-payment-confirmation": paymentConfirmationSecret,
    },
    method: "POST",
  });
  if (reconciliationPayload.payment?.postingBlocked) {
    throw new Error(`Expected reconciliation to clear posting block, got ${JSON.stringify(reconciliationPayload)}`);
  }

  const delayedCapturableWebhookBody = JSON.stringify({
    id: "evt_payment_capturable_delayed_smoke",
    created: Math.floor(Date.now() / 1000) - 30,
    type: "payment_intent.amount_capturable_updated",
    data: {
      object: {
        id: paymentIntentId,
        amount: paymentIntentPayload.payment.authorizedAmountCents,
        amount_capturable: paymentIntentPayload.payment.authorizedAmountCents,
        amount_received: 0,
        capture_method: "manual",
        currency: "usd",
        latest_charge: "ch_stripe_smoke_actual",
        metadata: { bookingId },
        status: "requires_capture",
      },
    },
  });
  const delayedCapturablePayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: delayedCapturableWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(delayedCapturableWebhookBody),
    },
    method: "POST",
  });
  if (delayedCapturablePayload.payment?.postingBlocked || delayedCapturablePayload.payment.status !== "captured") {
    throw new Error(
      `Expected delayed capturable webhook to preserve captured status, got ${JSON.stringify(
        delayedCapturablePayload,
      )}`,
    );
  }

  const delayedFailedWebhookBody = JSON.stringify({
    id: "evt_payment_failed_delayed_smoke",
    created: Math.floor(Date.now() / 1000) - 45,
    type: "payment_intent.payment_failed",
    data: {
      object: {
        id: paymentIntentId,
        amount: paymentIntentPayload.payment.authorizedAmountCents,
        currency: "usd",
        last_payment_error: { message: "Delayed earlier failure in smoke." },
        metadata: { bookingId },
        status: "requires_payment_method",
      },
    },
  });
  const delayedFailedPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: delayedFailedWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(delayedFailedWebhookBody),
    },
    method: "POST",
  });
  if (delayedFailedPayload.payment?.postingBlocked || delayedFailedPayload.payment.status !== "captured") {
    throw new Error(
      `Expected delayed failed webhook to preserve captured status, got ${JSON.stringify(delayedFailedPayload)}`,
    );
  }

  const authorizedThenFailedCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (4 * 24 + 0) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (4 * 24 + 2) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId: longTripPlatformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const authorizedThenFailedBookingId = authorizedThenFailedCheckoutPayload.booking?.id;
  const authorizedThenFailedCheckoutAccessToken = authorizedThenFailedCheckoutPayload.checkoutAccessToken;
  if (!authorizedThenFailedBookingId || !authorizedThenFailedCheckoutAccessToken) {
    throw new Error(
      `Expected authorized-then-failed booking, got ${JSON.stringify(authorizedThenFailedCheckoutPayload)}`,
    );
  }
  const authorizedThenFailedIntentPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/payment-intents`, {
    body: JSON.stringify({
      bookingId: authorizedThenFailedBookingId,
      checkoutAccessToken: authorizedThenFailedCheckoutAccessToken,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const authorizedThenFailedPaymentIntentId =
    authorizedThenFailedIntentPayload.payment?.providerReference?.paymentIntentId;
  if (!authorizedThenFailedPaymentIntentId) {
    throw new Error(
      `Expected authorized-then-failed PaymentIntent, got ${JSON.stringify(authorizedThenFailedIntentPayload)}`,
    );
  }
  await updateStoredPayment(env.ROBOMATA_RENTAL_PAYMENTS_FILE, authorizedThenFailedPaymentIntentId, payment => ({
    ...payment,
    postingBlocked: true,
    postingBlockReason: "Smoke cached authorization under manual capture.",
    status: "requires_capture",
  }));
  const delayedAuthorizedFailureWebhookBody = JSON.stringify({
    id: "evt_payment_authorized_failure_delayed_smoke",
    created: Math.floor(Date.now() / 1000) - 45,
    type: "payment_intent.payment_failed",
    data: {
      object: {
        id: authorizedThenFailedPaymentIntentId,
        amount: authorizedThenFailedIntentPayload.payment.authorizedAmountCents,
        currency: "usd",
        last_payment_error: { message: "Delayed earlier authorization failure in smoke." },
        metadata: { bookingId: authorizedThenFailedBookingId },
        status: "requires_payment_method",
      },
    },
  });
  const delayedAuthorizedFailurePayload = await fetchJson(
    `${baseUrl}/api/robomata/rental-payments/stripe/webhook`,
    {
      body: delayedAuthorizedFailureWebhookBody,
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSignatureHeader(delayedAuthorizedFailureWebhookBody),
      },
      method: "POST",
    },
  );
  if (
    !delayedAuthorizedFailurePayload.payment?.postingBlocked ||
    delayedAuthorizedFailurePayload.payment.status !== "requires_capture"
  ) {
    throw new Error(
      `Expected delayed failure to preserve authorized status, got ${JSON.stringify(
        delayedAuthorizedFailurePayload,
      )}`,
    );
  }

  await expectJsonFailure(
    `${baseUrl}${postingPath}`,
    {
      body: JSON.stringify({
        ...postingBody,
        entries: [
          {
            ...postingBody.entries[0],
            id: "rle_stripe_smoke_mismatched_reference",
            source: { bookingId, paymentIntentId: "pi_mock_wrong_booking" },
          },
        ],
      }),
      headers: await authHeaders("POST", postingPath, { "content-type": "application/json" }),
      method: "POST",
    },
    409,
    "Captured payment reconciliation is required before rental revenue posting.",
  );
  await expectJsonFailure(
    `${baseUrl}${postingPath}`,
    {
      body: JSON.stringify({
        ...postingBody,
        entries: [
          {
            ...postingBody.entries[0],
            facilityAssetId: otherFacilityAssetId,
            id: "rle_stripe_smoke_wrong_facility",
            postingAssetId: otherFacilityAssetId,
            source: { bookingId, paymentIntentId },
          },
        ],
        target: {
          facilityAssetId: otherFacilityAssetId,
          postingAssetId: otherFacilityAssetId,
          postingAssetKind: "facility",
        },
      }),
      headers: await authHeaders("POST", postingPath, { "content-type": "application/json" }),
      method: "POST",
    },
    409,
    "Captured payment reconciliation is required before rental revenue posting.",
  );
  await expectJsonFailure(
    `${baseUrl}${postingPath}`,
    {
      body: JSON.stringify({
        ...postingBody,
        entries: [
          {
            ...postingBody.entries[0],
            id: "rle_stripe_smoke_wrong_platform_vehicle",
            platformVehicleId: "pv_stripe_smoke_other",
            source: { bookingId, paymentIntentId },
          },
        ],
      }),
      headers: await authHeaders("POST", postingPath, { "content-type": "application/json" }),
      method: "POST",
    },
    409,
    "Captured payment reconciliation is required before rental revenue posting.",
  );

  const postingPayload = await fetchJson(`${baseUrl}${postingPath}`, {
    body: JSON.stringify(postingBody),
    headers: await authHeaders("POST", postingPath, { "content-type": "application/json" }),
    method: "POST",
  });
  if (postingPayload.batch?.status !== "ready") {
    throw new Error(`Expected posting batch after reconciliation, got ${JSON.stringify(postingPayload)}`);
  }

  const markFailedPath = `${postingPath}/${postingPayload.batch.id}/mark-failed`;
  const failedPostingPayload = await fetchJson(`${baseUrl}${markFailedPath}`, {
    body: JSON.stringify({ errorMessage: "Smoke retryable posting failure." }),
    headers: await authHeaders("POST", markFailedPath, { "content-type": "application/json" }),
    method: "POST",
  });
  if (failedPostingPayload.batch?.status !== "failed") {
    throw new Error(`Expected posting batch to be marked failed, got ${JSON.stringify(failedPostingPayload)}`);
  }

  await expectJsonFailure(
    `${baseUrl}${postingPath}`,
    {
      body: JSON.stringify({
        ...postingBody,
        entries: [
          {
            ...postingBody.entries[0],
            amountCents: 1,
            source: { bookingId, paymentIntentId },
          },
        ],
        periodEnd: new Date(Date.now() + 32 * 60 * 60 * 1_000).toISOString(),
        periodStart: new Date(Date.now() + 28 * 60 * 60 * 1_000).toISOString(),
      }),
      headers: await authHeaders("POST", postingPath, { "content-type": "application/json" }),
      method: "POST",
    },
    409,
    "Payment-backed revenue exceeds captured payment amount.",
  );

  await expectJsonFailure(
    `${baseUrl}${postingPath}`,
    {
      body: JSON.stringify({
        ...postingBody,
        entries: [
          {
            ...postingBody.entries[0],
            id: "rle_stripe_smoke_prior_posting_reuse",
            source: { bookingId, paymentIntentId },
          },
        ],
        periodEnd: new Date(Date.now() + 36 * 60 * 60 * 1_000).toISOString(),
        periodStart: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      }),
      headers: await authHeaders("POST", postingPath, { "content-type": "application/json" }),
      method: "POST",
    },
    409,
    "Payment-backed revenue exceeds captured payment amount.",
  );

  const disputeWebhookBody = JSON.stringify({
    id: "evt_payment_dispute_smoke",
    created: Math.floor(Date.now() / 1000),
    type: "charge.dispute.created",
    data: {
      object: {
        id: "dp_stripe_smoke",
        amount: 1000,
        charge: "ch_stripe_smoke_actual",
        currency: "usd",
        payment_intent: paymentIntentId,
        reason: "general",
      },
    },
  });
  const disputePayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: disputeWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(disputeWebhookBody),
    },
    method: "POST",
  });
  if (!disputePayload.payment?.postingBlocked || disputePayload.payment.status !== "disputed") {
    throw new Error(`Expected dispute webhook to block posting, got ${JSON.stringify(disputePayload)}`);
  }

  const delayedSuccessAfterDisputeWebhookBody = JSON.stringify({
    id: "evt_payment_success_after_dispute_smoke",
    created: Math.floor(Date.now() / 1000) - 30,
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: paymentIntentId,
        amount: paymentIntentPayload.payment.authorizedAmountCents,
        amount_capturable: 0,
        amount_received: paymentIntentPayload.payment.authorizedAmountCents,
        capture_method: "manual",
        currency: "usd",
        latest_charge: "ch_stripe_smoke_actual",
        metadata: { bookingId },
        status: "succeeded",
      },
    },
  });
  const delayedSuccessAfterDisputePayload = await fetchJson(
    `${baseUrl}/api/robomata/rental-payments/stripe/webhook`,
    {
      body: delayedSuccessAfterDisputeWebhookBody,
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSignatureHeader(delayedSuccessAfterDisputeWebhookBody),
      },
      method: "POST",
    },
  );
  if (
    !delayedSuccessAfterDisputePayload.payment?.postingBlocked ||
    delayedSuccessAfterDisputePayload.payment.status !== "disputed"
  ) {
    throw new Error(
      `Expected delayed success webhook to preserve dispute block, got ${JSON.stringify(
        delayedSuccessAfterDisputePayload,
      )}`,
    );
  }

  const disputedReconciliationPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/reconcile`, {
    body: JSON.stringify({ paymentIntentId }),
    headers: {
      "content-type": "application/json",
      "x-robomata-payment-confirmation": paymentConfirmationSecret,
    },
    method: "POST",
  });
  if (
    !disputedReconciliationPayload.payment?.postingBlocked ||
    disputedReconciliationPayload.payment.status !== "disputed"
  ) {
    throw new Error(
      `Expected reconciliation to preserve dispute posting block, got ${JSON.stringify(disputedReconciliationPayload)}`,
    );
  }

  const disputeClosedWebhookBody = JSON.stringify({
    id: "evt_payment_dispute_closed_smoke",
    created: Math.floor(Date.now() / 1000),
    type: "charge.dispute.closed",
    data: {
      object: {
        id: "dp_stripe_smoke",
        amount: 1000,
        charge: "ch_stripe_smoke_actual",
        currency: "usd",
        payment_intent: paymentIntentId,
        reason: "general",
        status: "won",
      },
    },
  });
  const disputeClosedPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: disputeClosedWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(disputeClosedWebhookBody),
    },
    method: "POST",
  });
  if (disputeClosedPayload.payment?.postingBlocked || disputeClosedPayload.payment.status !== "captured") {
    throw new Error(`Expected closed dispute to clear posting block, got ${JSON.stringify(disputeClosedPayload)}`);
  }
  const staleDisputeOpenPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: disputeWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(disputeWebhookBody),
    },
    method: "POST",
  });
  if (staleDisputeOpenPayload.payment?.postingBlocked || staleDisputeOpenPayload.payment.status !== "captured") {
    throw new Error(
      `Expected stale dispute-open webhook after close to preserve captured status, got ${JSON.stringify(
        staleDisputeOpenPayload,
      )}`,
    );
  }

  const refundWebhookBody = JSON.stringify({
    id: "evt_payment_refund_smoke",
    created: Math.floor(Date.now() / 1000),
    type: "charge.refunded",
    data: {
      object: {
        id: "ch_stripe_smoke_actual",
        amount_refunded: 250,
        currency: "usd",
        payment_intent: paymentIntentId,
      },
    },
  });
  const refundPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: refundWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(refundWebhookBody),
    },
    method: "POST",
  });
  if (refundPayload.payment?.status !== "refunded" || refundPayload.payment.refundedAmountCents !== 250) {
    throw new Error(`Expected partial refund amount to persist, got ${JSON.stringify(refundPayload)}`);
  }

  const duplicateRefundWebhookBody = JSON.stringify({
    id: "evt_payment_refund_duplicate_smoke",
    created: Math.floor(Date.now() / 1000),
    type: "refund.updated",
    data: {
      object: {
        id: "re_stripe_smoke_first",
        amount: 250,
        charge: "ch_stripe_smoke_actual",
        currency: "usd",
        payment_intent: paymentIntentId,
        status: "succeeded",
      },
    },
  });
  const duplicateRefundPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: duplicateRefundWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(duplicateRefundWebhookBody),
    },
    method: "POST",
  });
  if (
    duplicateRefundPayload.payment?.status !== "refunded" ||
    duplicateRefundPayload.payment.refundedAmountCents !== 250
  ) {
    throw new Error(
      `Expected duplicate refund object webhook not to double-count charge refund, got ${JSON.stringify(
        duplicateRefundPayload,
      )}`,
    );
  }

  const refundCreatedWebhookBody = JSON.stringify({
    id: "evt_payment_refund_created_smoke",
    created: Math.floor(Date.now() / 1000),
    type: "refund.created",
    data: {
      object: {
        id: "re_stripe_smoke_created",
        amount: 250,
        charge: "ch_stripe_smoke_actual",
        currency: "usd",
        payment_intent: paymentIntentId,
        status: "succeeded",
      },
    },
  });
  const refundCreatedPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: refundCreatedWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(refundCreatedWebhookBody),
    },
    method: "POST",
  });
  if (refundCreatedPayload.payment?.status !== "refunded" || refundCreatedPayload.payment.refundedAmountCents !== 500) {
    throw new Error(`Expected successful refund.created to be recorded, got ${JSON.stringify(refundCreatedPayload)}`);
  }

  const secondRefundWebhookBody = JSON.stringify({
    id: "evt_payment_refund_second_smoke",
    created: Math.floor(Date.now() / 1000),
    type: "charge.refund.updated",
    data: {
      object: {
        id: "re_stripe_smoke_second",
        amount: 50,
        charge: "ch_stripe_smoke_actual",
        currency: "usd",
        payment_intent: paymentIntentId,
        status: "succeeded",
      },
    },
  });
  const secondRefundPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: secondRefundWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(secondRefundWebhookBody),
    },
    method: "POST",
  });
  if (secondRefundPayload.payment?.status !== "refunded" || secondRefundPayload.payment.refundedAmountCents !== 550) {
    throw new Error(`Expected separate partial refunds to accumulate, got ${JSON.stringify(secondRefundPayload)}`);
  }

  const refundedReconciliationPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/reconcile`, {
    body: JSON.stringify({ paymentIntentId }),
    headers: {
      "content-type": "application/json",
      "x-robomata-payment-confirmation": paymentConfirmationSecret,
    },
    method: "POST",
  });
  if (
    refundedReconciliationPayload.payment?.status !== "refunded" ||
    refundedReconciliationPayload.payment.refundedAmountCents !== 550
  ) {
    throw new Error(
      `Expected reconciliation to preserve refunded state, got ${JSON.stringify(refundedReconciliationPayload)}`,
    );
  }

  const staleRefundFailedWebhookBody = JSON.stringify({
    id: "evt_payment_refund_failed_stale_smoke",
    created: Math.floor(Date.now() / 1000),
    type: "refund.failed",
    data: {
      object: {
        id: "re_stripe_smoke_stale_failed",
        amount: 125,
        charge: "ch_stripe_smoke_actual",
        currency: "usd",
        payment_intent: paymentIntentId,
        status: "failed",
      },
    },
  });
  const staleRefundFailedPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: staleRefundFailedWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(staleRefundFailedWebhookBody),
    },
    method: "POST",
  });
  if (
    staleRefundFailedPayload.payment?.postingBlocked ||
    staleRefundFailedPayload.payment.status !== "refunded" ||
    staleRefundFailedPayload.payment.refundedAmountCents !== 550
  ) {
    throw new Error(
      `Expected stale refund.failed after success to preserve refunded state, got ${JSON.stringify(
        staleRefundFailedPayload,
      )}`,
    );
  }

  await expectJsonFailure(
    `${baseUrl}${postingPath}`,
    {
      body: JSON.stringify({
        ...postingBody,
        entries: [
          {
            ...postingBody.entries[0],
            id: "rle_stripe_smoke_over_captured",
            source: { bookingId, paymentIntentId },
          },
        ],
      }),
      headers: await authHeaders("POST", postingPath, { "content-type": "application/json" }),
      method: "POST",
    },
    409,
    "Payment-backed revenue exceeds captured payment amount.",
  );
  await expectJsonFailure(
    `${baseUrl}${postingPath}`,
    {
      body: JSON.stringify({
        ...postingBody,
        entries: [
          {
            ...postingBody.entries[0],
            amountCents: 450,
            id: "rle_stripe_smoke_refund_adjusted",
            source: { bookingId, paymentIntentId },
          },
        ],
        periodEnd: new Date(Date.now() + 12 * 60 * 60 * 1_000).toISOString(),
        periodStart: new Date(Date.now() - 12 * 60 * 60 * 1_000).toISOString(),
      }),
      headers: await authHeaders("POST", postingPath, { "content-type": "application/json" }),
      method: "POST",
    },
    409,
    "Payment-backed revenue exceeds captured payment amount.",
  );

  const refundFailedWebhookBody = JSON.stringify({
    id: "evt_payment_refund_failed_smoke",
    created: Math.floor(Date.now() / 1000),
    type: "refund.failed",
    data: {
      object: {
        id: "re_stripe_smoke_failed",
        amount: 125,
        charge: "ch_stripe_smoke_actual",
        currency: "usd",
        payment_intent: paymentIntentId,
        status: "failed",
      },
    },
  });
  const refundFailedPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: refundFailedWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(refundFailedWebhookBody),
    },
    method: "POST",
  });
  if (
    refundFailedPayload.payment?.postingBlocked ||
    refundFailedPayload.payment.status !== "refunded" ||
    refundFailedPayload.payment.refundedAmountCents !== 550
  ) {
    throw new Error(`Expected stale refund.failed to preserve refund success, got ${JSON.stringify(refundFailedPayload)}`);
  }

  const failedRefundReconciliationPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/reconcile`, {
    body: JSON.stringify({ paymentIntentId }),
    headers: {
      "content-type": "application/json",
      "x-robomata-payment-confirmation": paymentConfirmationSecret,
    },
    method: "POST",
  });
  if (
    failedRefundReconciliationPayload.payment?.postingBlocked ||
    failedRefundReconciliationPayload.payment.status !== "refunded"
  ) {
    throw new Error(
      `Expected reconciliation to preserve refunded state after stale failed refund, got ${JSON.stringify(
        failedRefundReconciliationPayload,
      )}`,
    );
  }

  const unavailableCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + 5 * 24 * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + 6 * 24 * 60 * 60 * 1_000).toISOString(),
      platformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const unavailableBookingId = unavailableCheckoutPayload.booking?.id;
  const unavailableCheckoutAccessToken = unavailableCheckoutPayload.checkoutAccessToken;
  if (
    !unavailableBookingId ||
    unavailableCheckoutPayload.booking.state !== "pending_payment_authorization" ||
    !unavailableCheckoutAccessToken
  ) {
    throw new Error(`Expected unavailable guard booking, got ${JSON.stringify(unavailableCheckoutPayload)}`);
  }

  const delistedPaymentIntentCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + (6 * 24 + 12) * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + (6 * 24 + 16) * 60 * 60 * 1_000).toISOString(),
      platformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const delistedPaymentIntentBookingId = delistedPaymentIntentCheckoutPayload.booking?.id;
  const delistedPaymentIntentCheckoutAccessToken = delistedPaymentIntentCheckoutPayload.checkoutAccessToken;
  if (!delistedPaymentIntentBookingId || !delistedPaymentIntentCheckoutAccessToken) {
    throw new Error(
      `Expected delisted payment-intent guard booking, got ${JSON.stringify(delistedPaymentIntentCheckoutPayload)}`,
    );
  }

  const unavailablePaymentIntentPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/payment-intents`, {
    body: JSON.stringify({ bookingId: unavailableBookingId, checkoutAccessToken: unavailableCheckoutAccessToken, renterId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const unavailablePaymentIntentId = unavailablePaymentIntentPayload.payment?.providerReference?.paymentIntentId;
  if (!unavailablePaymentIntentId) {
    throw new Error(`Expected unavailable guard PaymentIntent, got ${JSON.stringify(unavailablePaymentIntentPayload)}`);
  }

  const controlsPath = `/api/robomata/rental-inventory/vehicles/${platformVehicleId}/controls`;
  await fetchJson(`${baseUrl}${controlsPath}`, {
    body: JSON.stringify({ operationalStatus: "suspended" }),
    headers: await authHeaders("PATCH", controlsPath, { "content-type": "application/json" }),
    method: "PATCH",
  });
  await expectJsonFailure(
    `${baseUrl}/api/robomata/rental-payments/payment-intents`,
    {
      body: JSON.stringify({
        bookingId: delistedPaymentIntentBookingId,
        checkoutAccessToken: delistedPaymentIntentCheckoutAccessToken,
        renterId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    409,
    "Rental vehicle is no longer available for payment.",
  );
  const unavailableCapturableWebhookBody = JSON.stringify({
    id: "evt_payment_unavailable_capturable_smoke",
    created: Math.floor(Date.now() / 1000),
    type: "payment_intent.amount_capturable_updated",
    data: {
      object: {
        id: unavailablePaymentIntentId,
        amount: unavailablePaymentIntentPayload.payment.authorizedAmountCents,
        amount_capturable: unavailablePaymentIntentPayload.payment.authorizedAmountCents,
        amount_received: 0,
        capture_method: "manual",
        currency: "usd",
        latest_charge: "ch_stripe_smoke_unavailable",
        metadata: { bookingId: unavailableBookingId },
        status: "requires_capture",
      },
    },
  });
  await fetchJson(`${baseUrl}/api/robomata/rental-payments/stripe/webhook`, {
    body: unavailableCapturableWebhookBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader(unavailableCapturableWebhookBody),
    },
    method: "POST",
  });
  const unavailableBookingPayload = await fetchJson(
    `${baseUrl}/api/robomata/rental-bookings/${unavailableBookingId}`,
    {
      headers: await authHeaders("GET", `/api/robomata/rental-bookings/${unavailableBookingId}`),
      method: "GET",
    },
  );
  if (unavailableBookingPayload.booking?.state !== "pending_payment_authorization") {
    throw new Error(
      `Expected unavailable vehicle authorization to leave booking pending, got ${JSON.stringify(
        unavailableBookingPayload,
      )}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        batchId: postingPayload.batch.id,
        bookingId,
        paymentIntentId,
        renterId,
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
