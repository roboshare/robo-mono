import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import "server-only";
import type { RentalBookingRecord } from "~~/lib/robomata/rentalBookings";
import { getRentalBookingStore } from "~~/lib/robomata/server/rentalBookingStore";
import { getRentalPaymentStore } from "~~/lib/robomata/server/rentalPaymentStore";
import type { StripePaymentIntentSnapshot } from "~~/lib/robomata/server/rentalPaymentStore";

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const DEFAULT_STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

type StripeApiError = {
  error?: {
    message?: string;
    type?: string;
  };
};

export type StripeWebhookEvent = {
  id: string;
  created?: number;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
};

function stripeSecretKey() {
  return process.env.STRIPE_SECRET_KEY?.trim();
}

function isStripeMockEnabled() {
  return process.env.ROBOMATA_RENTAL_STRIPE_MOCK === "true";
}

function stripeJsonHeaders() {
  const key = stripeSecretKey();
  if (!key && !isStripeMockEnabled()) throw new Error("STRIPE_SECRET_KEY is required for live rental payments.");
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/x-www-form-urlencoded",
  };
}

function mockPaymentIntent(input: {
  amountCents: number;
  booking: RentalBookingRecord;
  idempotencyKey?: string;
  status?: string;
}): StripePaymentIntentSnapshot {
  const idSuffix = input.idempotencyKey
    ? `_${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 10)}`
    : "";
  const id = `pi_mock_${input.booking.id}${idSuffix}`;
  return {
    amount: input.amountCents,
    amount_capturable: input.amountCents,
    amount_received: 0,
    capture_method: "manual",
    client_secret: `${id}_secret_mock`,
    currency: "usd",
    id,
    latest_charge: `ch_mock_${input.booking.id}`,
    metadata: {
      bookingId: input.booking.id,
      facilityAssetId: input.booking.facilityAssetId,
      platformVehicleId: input.booking.platformVehicleId,
      ...(input.booking.vehicleAssetId ? { vehicleAssetId: input.booking.vehicleAssetId } : {}),
    },
    status: input.status ?? "requires_capture",
  };
}

function stripePaymentIntentFromJson(value: unknown): StripePaymentIntentSnapshot {
  const intent = value as Partial<StripePaymentIntentSnapshot>;
  if (!intent.id || !intent.currency || !intent.status || typeof intent.amount !== "number") {
    throw new Error("Stripe PaymentIntent response did not include required fields.");
  }
  return {
    amount: intent.amount,
    amount_capturable: intent.amount_capturable,
    amount_received: intent.amount_received,
    capture_method: intent.capture_method,
    client_secret: intent.client_secret,
    currency: intent.currency,
    customer: intent.customer,
    id: intent.id,
    latest_charge: intent.latest_charge,
    metadata: intent.metadata,
    status: intent.status,
  };
}

async function stripeRequest(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${STRIPE_API_BASE}${path}`, init);
  const payload = (await response.json()) as StripeApiError | unknown;
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload && "error" in payload
        ? ((payload as StripeApiError).error?.message ?? "Stripe API request failed.")
        : "Stripe API request failed.";
    throw new Error(message);
  }
  return payload;
}

export async function createStripeRentalPaymentIntent(input: {
  booking: RentalBookingRecord;
  idempotencyKey?: string;
}): Promise<StripePaymentIntentSnapshot> {
  const amountCents = input.booking.paymentPlan.totalDueAtAuthorizationCents;
  const idempotencyKey = input.idempotencyKey ?? `robomata-rental-booking-${input.booking.id}`;
  if (isStripeMockEnabled()) {
    return mockPaymentIntent({ amountCents, booking: input.booking, idempotencyKey: input.idempotencyKey });
  }

  const body = new URLSearchParams({
    amount: String(amountCents),
    capture_method: "manual",
    currency: input.booking.paymentPlan.currency.toLowerCase(),
    "metadata[bookingId]": input.booking.id,
    "metadata[facilityAssetId]": input.booking.facilityAssetId,
    "metadata[platformVehicleId]": input.booking.platformVehicleId,
  });
  if (input.booking.vehicleAssetId) body.set("metadata[vehicleAssetId]", input.booking.vehicleAssetId);
  body.set("automatic_payment_methods[enabled]", "true");

  const payload = await stripeRequest("/payment_intents", {
    body,
    headers: {
      ...stripeJsonHeaders(),
      "idempotency-key": idempotencyKey,
    },
    method: "POST",
  });
  return stripePaymentIntentFromJson(payload);
}

export async function cancelStripeRentalPaymentIntent(paymentIntentId: string): Promise<StripePaymentIntentSnapshot> {
  if (isStripeMockEnabled()) {
    const snapshot = await retrieveStripeRentalPaymentIntent(paymentIntentId);
    return {
      ...snapshot,
      amount_capturable: 0,
      status: "canceled",
    };
  }
  const payload = await stripeRequest(`/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`, {
    headers: stripeJsonHeaders(),
    method: "POST",
  });
  return stripePaymentIntentFromJson(payload);
}

export async function retrieveStripeRentalPaymentIntent(paymentIntentId: string): Promise<StripePaymentIntentSnapshot> {
  if (isStripeMockEnabled()) {
    let status = process.env.ROBOMATA_RENTAL_STRIPE_MOCK_RECONCILE_STATUS ?? "requires_capture";
    const statusOverrideFile = process.env.ROBOMATA_RENTAL_STRIPE_MOCK_RECONCILE_STATUS_FILE;
    if (statusOverrideFile) {
      try {
        const overrides = JSON.parse(await readFile(statusOverrideFile, "utf8")) as Record<string, string>;
        if (overrides[paymentIntentId]) {
          status = overrides[paymentIntentId];
        }
      } catch {
        // Fall back to env var default when override file is missing or invalid.
      }
    }
    const existingPayment = await getRentalPaymentStore().getPaymentByPaymentIntent(paymentIntentId);
    const bookingId = /^pi_mock_(rb_[0-9a-f-]+)(?:_[0-9a-f]{10})?$/.exec(paymentIntentId)?.[1];
    const booking = !existingPayment && bookingId ? await getRentalBookingStore().getBooking(bookingId) : undefined;
    const amount = existingPayment?.authorizedAmountCents ?? booking?.paymentPlan.totalDueAtAuthorizationCents ?? 1_000;
    return {
      amount,
      amount_capturable: status === "requires_capture" ? amount : 0,
      amount_received: status === "succeeded" ? Math.max(existingPayment?.capturedAmountCents ?? 0, amount) : 0,
      capture_method: "manual",
      client_secret: `${paymentIntentId}_secret_mock`,
      currency: existingPayment?.currency.toLowerCase() ?? "usd",
      id: paymentIntentId,
      latest_charge: existingPayment?.providerReference.chargeId ?? `ch_mock_${paymentIntentId}`,
      metadata: {
        ...(existingPayment
          ? {
              bookingId: existingPayment.bookingId,
              facilityAssetId: existingPayment.facilityAssetId,
              platformVehicleId: existingPayment.platformVehicleId,
              ...(existingPayment.vehicleAssetId ? { vehicleAssetId: existingPayment.vehicleAssetId } : {}),
            }
          : booking
            ? {
                bookingId: booking.id,
                facilityAssetId: booking.facilityAssetId,
                platformVehicleId: booking.platformVehicleId,
                ...(booking.vehicleAssetId ? { vehicleAssetId: booking.vehicleAssetId } : {}),
              }
            : bookingId
              ? { bookingId }
              : {}),
      },
      status,
    };
  }
  const payload = await stripeRequest(`/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
    headers: stripeJsonHeaders(),
    method: "GET",
  });
  return stripePaymentIntentFromJson(payload);
}

function parseStripeSignatureHeader(header: string): { signatures: string[]; timestamp: string } {
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [rawKey, ...rawValue] = part.split("=");
    const key = rawKey?.trim();
    const value = rawValue.join("=").trim();
    if (!key || !value) continue;
    if (key === "t") timestamp = value;
    if (key === "v1") signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) throw new Error("Invalid Stripe signature header.");
  return { signatures, timestamp };
}

function stripeWebhookToleranceSeconds() {
  const parsed = Number.parseInt(
    process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS ?? String(DEFAULT_STRIPE_WEBHOOK_TOLERANCE_SECONDS),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STRIPE_WEBHOOK_TOLERANCE_SECONDS;
}

export function verifyStripeWebhookPayload(input: {
  payload: string;
  signatureHeader: string | null;
}): StripeWebhookEvent {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret && isStripeMockEnabled()) return JSON.parse(input.payload) as StripeWebhookEvent;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is required for Stripe webhook verification.");
  if (!input.signatureHeader) throw new Error("Missing Stripe signature header.");

  const { signatures, timestamp } = parseStripeSignatureHeader(input.signatureHeader);
  const timestampSeconds = Number.parseInt(timestamp, 10);
  const toleranceSeconds = stripeWebhookToleranceSeconds();
  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) {
    throw new Error("Invalid Stripe webhook signature timestamp.");
  }
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    throw new Error("Stripe webhook signature timestamp is outside the allowed tolerance.");
  }
  const expected = createHmac("sha256", secret).update(`${timestamp}.${input.payload}`).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const hasValidSignature = signatures.some(signature => {
    const providedBuffer = Buffer.from(signature, "hex");
    return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
  });
  if (!hasValidSignature) {
    throw new Error("Invalid Stripe webhook signature.");
  }
  return JSON.parse(input.payload) as StripeWebhookEvent;
}
