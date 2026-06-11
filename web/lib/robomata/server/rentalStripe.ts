import { createHmac, timingSafeEqual } from "node:crypto";
import "server-only";
import type { RentalBookingRecord } from "~~/lib/robomata/rentalBookings";
import type { StripePaymentIntentSnapshot } from "~~/lib/robomata/server/rentalPaymentStore";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

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
  status?: string;
}): StripePaymentIntentSnapshot {
  return {
    amount: input.amountCents,
    amount_capturable: input.amountCents,
    amount_received: 0,
    capture_method: "manual",
    client_secret: `pi_mock_${input.booking.id}_secret_mock`,
    currency: "usd",
    id: `pi_mock_${input.booking.id}`,
    latest_charge: `ch_mock_${input.booking.id}`,
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
}): Promise<StripePaymentIntentSnapshot> {
  const amountCents = input.booking.paymentPlan.totalDueAtAuthorizationCents;
  if (isStripeMockEnabled()) return mockPaymentIntent({ amountCents, booking: input.booking });

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
    headers: stripeJsonHeaders(),
    method: "POST",
  });
  return stripePaymentIntentFromJson(payload);
}

export async function retrieveStripeRentalPaymentIntent(paymentIntentId: string): Promise<StripePaymentIntentSnapshot> {
  if (isStripeMockEnabled()) {
    return {
      amount: 1_000,
      amount_capturable: 1_000,
      amount_received: 0,
      capture_method: "manual",
      currency: "usd",
      id: paymentIntentId,
      latest_charge: `ch_mock_${paymentIntentId}`,
      status: process.env.ROBOMATA_RENTAL_STRIPE_MOCK_RECONCILE_STATUS ?? "requires_capture",
    };
  }
  const payload = await stripeRequest(`/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
    headers: stripeJsonHeaders(),
    method: "GET",
  });
  return stripePaymentIntentFromJson(payload);
}

function parseStripeSignatureHeader(header: string): { timestamp: string; signature: string } {
  const parts = Object.fromEntries(
    header
      .split(",")
      .map(part => part.split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key.trim(), value.trim()]),
  );
  if (!parts.t || !parts.v1) throw new Error("Invalid Stripe signature header.");
  return { signature: parts.v1, timestamp: parts.t };
}

export function verifyStripeWebhookPayload(input: {
  payload: string;
  signatureHeader: string | null;
}): StripeWebhookEvent {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret && process.env.NODE_ENV === "development") return JSON.parse(input.payload) as StripeWebhookEvent;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is required for Stripe webhook verification.");
  if (!input.signatureHeader) throw new Error("Missing Stripe signature header.");

  const { signature, timestamp } = parseStripeSignatureHeader(input.signatureHeader);
  const expected = createHmac("sha256", secret).update(`${timestamp}.${input.payload}`).digest("hex");
  const providedBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    throw new Error("Invalid Stripe webhook signature.");
  }
  return JSON.parse(input.payload) as StripeWebhookEvent;
}
