#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
const facilityAssetId = "facility-stripe-smoke-asset";

let serverProcess;
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
    ROBOMATA_RENTAL_INVENTORY_FACILITY_OWNERS_JSON: JSON.stringify({ [facilityAssetId]: partnerAccount.address }),
    ROBOMATA_RENTAL_INVENTORY_FILE: inventoryFile,
    ROBOMATA_RENTAL_PAYMENT_CONFIRMATION_SECRET: paymentConfirmationSecret,
    ROBOMATA_RENTAL_PAYMENTS_ENABLED: "true",
    ROBOMATA_RENTAL_PAYMENTS_FILE: path.join(tempDir, "payments.json"),
    ROBOMATA_RENTAL_REVENUE_FILE: path.join(tempDir, "revenue.json"),
    ROBOMATA_RENTAL_REVENUE_POSTING_ENABLED: "true",
    ROBOMATA_RENTAL_STRIPE_MOCK: "true",
    ROBOMATA_RENTAL_STRIPE_MOCK_RECONCILE_STATUS: "succeeded",
    ROBOMATA_RENTER_ACCOUNTS_ENABLED: "true",
    ROBOMATA_RENTER_ACCOUNTS_FILE: path.join(tempDir, "renters.json"),
    ROBOMATA_WORKFLOW_MUTATIONS_ENABLED: "true",
    STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
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

  const checkoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + 10 * 24 * 60 * 60 * 1_000).toISOString(),
      platformVehicleId,
      renterId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const bookingId = checkoutPayload.booking?.id;
  if (!bookingId || checkoutPayload.booking.state !== "pending_payment_authorization") {
    throw new Error(`Expected payment-gated booking, got ${JSON.stringify(checkoutPayload)}`);
  }

  const unreconciledCheckoutPayload = await fetchJson(`${baseUrl}/api/robomata/rental-bookings/checkout`, {
    body: JSON.stringify({
      dateFrom: new Date(Date.now() + 21 * 24 * 60 * 60 * 1_000).toISOString(),
      dateTo: new Date(Date.now() + 23 * 24 * 60 * 60 * 1_000).toISOString(),
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

  const paymentIntentPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/payment-intents`, {
    body: JSON.stringify({ bookingId, renterId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const paymentIntentId = paymentIntentPayload.payment?.providerReference?.paymentIntentId;
  if (!paymentIntentId || !paymentIntentPayload.clientSecret) {
    throw new Error(`Expected mock PaymentIntent and client secret, got ${JSON.stringify(paymentIntentPayload)}`);
  }

  const repeatedPaymentIntentPayload = await fetchJson(`${baseUrl}/api/robomata/rental-payments/payment-intents`, {
    body: JSON.stringify({ bookingId, renterId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (
    repeatedPaymentIntentPayload.payment?.providerReference?.paymentIntentId !== paymentIntentId ||
    !repeatedPaymentIntentPayload.clientSecret
  ) {
    throw new Error(
      `Expected repeated PaymentIntent creation to return existing intent and client secret, got ${JSON.stringify(
        repeatedPaymentIntentPayload,
      )}`,
    );
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

  const authHeaders = authHeaderBuilder({ account: partnerAccount, partnerAddress: partnerAccount.address });
  const postingPath = "/api/robomata/rental-revenue/posting-batches";
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

  const postingPayload = await fetchJson(`${baseUrl}${postingPath}`, {
    body: JSON.stringify(postingBody),
    headers: await authHeaders("POST", postingPath, { "content-type": "application/json" }),
    method: "POST",
  });
  if (postingPayload.batch?.status !== "ready") {
    throw new Error(`Expected posting batch after reconciliation, got ${JSON.stringify(postingPayload)}`);
  }

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
    refundedReconciliationPayload.payment.refundedAmountCents !== 250
  ) {
    throw new Error(
      `Expected reconciliation to preserve refunded state, got ${JSON.stringify(refundedReconciliationPayload)}`,
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
