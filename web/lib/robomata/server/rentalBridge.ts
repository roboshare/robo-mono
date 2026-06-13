import { createHash, createVerify } from "node:crypto";
import "server-only";
import type { RentalBookingRecord } from "~~/lib/robomata/rentalBookings";
import type { BridgeTransferSnapshot } from "~~/lib/robomata/server/rentalPaymentStore";

const BRIDGE_API_BASE = "https://api.bridge.xyz/v0";
const DEFAULT_BRIDGE_WEBHOOK_TOLERANCE_MS = 10 * 60 * 1_000;

export type BridgeWebhookEvent = {
  api_version?: string;
  event_category?: string;
  event_created_at?: string;
  event_id: string;
  event_object: Record<string, unknown>;
  event_object_changes?: Record<string, unknown>;
  event_type: string;
};

type BridgeApiError = {
  message?: string;
  error?: {
    message?: string;
  };
};

function bridgeApiKey() {
  return process.env.BRIDGE_API_KEY?.trim();
}

function bridgeApiBase() {
  return (process.env.BRIDGE_API_BASE_URL?.trim() || BRIDGE_API_BASE).replace(/\/+$/, "");
}

function isBridgeMockEnabled() {
  return process.env.ROBOMATA_RENTAL_BRIDGE_MOCK === "true";
}

function bridgeCustomerId() {
  return process.env.ROBOMATA_RENTAL_BRIDGE_CUSTOMER_ID?.trim();
}

function allowAnyBridgeSourceAddress() {
  return process.env.ROBOMATA_RENTAL_BRIDGE_ALLOW_ANY_FROM_ADDRESS === "true";
}

function configuredRail(key: string, fallback: string) {
  return process.env[key]?.trim() || fallback;
}

function centsToDecimal(amountCents: number): string {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error("Bridge rental transfer amount must be a positive integer cent amount.");
  }
  const dollars = Math.floor(amountCents / 100);
  const cents = String(amountCents % 100).padStart(2, "0");
  return `${dollars}.${cents}`;
}

function bridgeHeaders(idempotencyKey?: string) {
  const key = bridgeApiKey();
  if (!key && !isBridgeMockEnabled()) throw new Error("BRIDGE_API_KEY is required for live Bridge rental transfers.");
  return {
    "Api-Key": key ?? "",
    "Content-Type": "application/json",
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  };
}

async function bridgeRequest(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${bridgeApiBase()}${path}`, init);
  const payload = (await response.json()) as BridgeApiError | unknown;
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload
        ? ((payload as BridgeApiError).error?.message ?? (payload as BridgeApiError).message)
        : undefined;
    throw new Error(message ?? "Bridge API request failed.");
  }
  return payload;
}

function bridgeTransferFromJson(value: unknown): BridgeTransferSnapshot {
  const transfer = value as Partial<BridgeTransferSnapshot>;
  if (!transfer.id || !transfer.state) {
    throw new Error("Bridge transfer response did not include required fields.");
  }
  return {
    amount: transfer.amount,
    client_reference_id: transfer.client_reference_id,
    created_at: transfer.created_at,
    currency: transfer.currency,
    destination: transfer.destination,
    id: transfer.id,
    on_behalf_of: transfer.on_behalf_of,
    receipt: transfer.receipt,
    source: transfer.source,
    source_deposit_instructions: transfer.source_deposit_instructions,
    state: transfer.state,
    updated_at: transfer.updated_at,
  };
}

function mockBridgeTransfer(input: {
  booking: RentalBookingRecord;
  fromAddress?: string;
  idempotencyKey?: string;
}): BridgeTransferSnapshot {
  const idSuffix = input.idempotencyKey
    ? `_${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 10)}`
    : "";
  const id = `bt_mock_${input.booking.id}${idSuffix}`;
  const sourceRail = configuredRail("ROBOMATA_RENTAL_BRIDGE_SOURCE_RAIL", "base");
  const sourceCurrency = configuredRail("ROBOMATA_RENTAL_BRIDGE_SOURCE_CURRENCY", "usdc");
  const destinationRail = configuredRail("ROBOMATA_RENTAL_BRIDGE_DESTINATION_RAIL", sourceRail);
  const destinationCurrency = configuredRail("ROBOMATA_RENTAL_BRIDGE_DESTINATION_CURRENCY", sourceCurrency);
  const destinationAddress = process.env.ROBOMATA_RENTAL_BRIDGE_DESTINATION_ADDRESS?.trim() || "0xbridgeMockTreasury";
  return {
    amount: centsToDecimal(input.booking.paymentPlan.totalDueAtAuthorizationCents),
    client_reference_id: input.booking.id,
    created_at: new Date().toISOString(),
    currency: "usd",
    destination: {
      currency: destinationCurrency,
      payment_rail: destinationRail,
      to_address: destinationAddress,
    },
    id,
    on_behalf_of: bridgeCustomerId() ?? "bridge_mock_customer",
    source: {
      currency: sourceCurrency,
      from_address: input.fromAddress,
      payment_rail: sourceRail,
    },
    source_deposit_instructions: {
      amount: centsToDecimal(input.booking.paymentPlan.totalDueAtAuthorizationCents),
      currency: sourceCurrency,
      payment_rail: sourceRail,
      to_address: destinationAddress,
    },
    state: "awaiting_funds",
    updated_at: new Date().toISOString(),
  };
}

export async function createBridgeRentalTransfer(input: {
  booking: RentalBookingRecord;
  fromAddress?: string;
  idempotencyKey?: string;
  returnAddress?: string;
}): Promise<BridgeTransferSnapshot> {
  const idempotencyKey = input.idempotencyKey ?? `robomata-rental-booking-${input.booking.id}-bridge`;
  const sourceRail = configuredRail("ROBOMATA_RENTAL_BRIDGE_SOURCE_RAIL", "base");
  const sourceCurrency = configuredRail("ROBOMATA_RENTAL_BRIDGE_SOURCE_CURRENCY", "usdc");
  const destinationRail = configuredRail("ROBOMATA_RENTAL_BRIDGE_DESTINATION_RAIL", sourceRail);
  const destinationCurrency = configuredRail("ROBOMATA_RENTAL_BRIDGE_DESTINATION_CURRENCY", sourceCurrency);
  const allowAnyFromAddress = allowAnyBridgeSourceAddress();
  if (!input.fromAddress && !allowAnyFromAddress) {
    throw new Error("Bridge rental transfers require fromAddress unless allow-any-from-address is explicitly enabled.");
  }
  if (isBridgeMockEnabled()) {
    return mockBridgeTransfer({ booking: input.booking, fromAddress: input.fromAddress, idempotencyKey });
  }

  const customerId = bridgeCustomerId();
  if (!customerId) throw new Error("ROBOMATA_RENTAL_BRIDGE_CUSTOMER_ID is required for Bridge rental transfers.");

  const destinationAddress = process.env.ROBOMATA_RENTAL_BRIDGE_DESTINATION_ADDRESS?.trim();
  if (!destinationAddress) {
    throw new Error("ROBOMATA_RENTAL_BRIDGE_DESTINATION_ADDRESS is required for Bridge rental transfers.");
  }

  const payload = {
    amount: centsToDecimal(input.booking.paymentPlan.totalDueAtAuthorizationCents),
    client_reference_id: input.booking.id,
    destination: {
      currency: destinationCurrency,
      payment_rail: destinationRail,
      to_address: destinationAddress,
    },
    features: allowAnyFromAddress ? { allow_any_from_address: true } : undefined,
    on_behalf_of: customerId,
    return_instructions: input.returnAddress ? { return_address: input.returnAddress } : undefined,
    source: {
      currency: sourceCurrency,
      from_address: input.fromAddress,
      payment_rail: sourceRail,
    },
  };

  const transfer = await bridgeRequest("/transfers", {
    body: JSON.stringify(payload),
    headers: bridgeHeaders(idempotencyKey),
    method: "POST",
  });
  return bridgeTransferFromJson(transfer);
}

function parseBridgeSignatureHeader(header: string): { signature: string; timestamp: string } {
  let timestamp: string | undefined;
  let signature: string | undefined;
  for (const part of header.split(",")) {
    const [rawKey, ...rawValue] = part.split("=");
    const key = rawKey?.trim();
    const value = rawValue.join("=").trim();
    if (key === "t") timestamp = value;
    if (key === "v0") signature = value;
  }
  if (!timestamp || !signature) throw new Error("Invalid Bridge signature header.");
  return { signature, timestamp };
}

function bridgeWebhookToleranceMs() {
  const parsed = Number.parseInt(
    process.env.BRIDGE_WEBHOOK_TOLERANCE_MS ?? String(DEFAULT_BRIDGE_WEBHOOK_TOLERANCE_MS),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BRIDGE_WEBHOOK_TOLERANCE_MS;
}

function bridgeWebhookPublicKey() {
  return process.env.BRIDGE_WEBHOOK_PUBLIC_KEY?.trim() || process.env.ROBOMATA_RENTAL_BRIDGE_WEBHOOK_PUBLIC_KEY?.trim();
}

export function verifyBridgeWebhookPayload(input: {
  payload: string;
  signatureHeader: string | null;
}): BridgeWebhookEvent {
  const publicKey = bridgeWebhookPublicKey();
  if (!publicKey && process.env.NODE_ENV === "development") return JSON.parse(input.payload) as BridgeWebhookEvent;
  if (!publicKey) throw new Error("BRIDGE_WEBHOOK_PUBLIC_KEY is required for Bridge webhook verification.");
  if (!input.signatureHeader) throw new Error("Missing Bridge signature header.");

  const { signature, timestamp } = parseBridgeSignatureHeader(input.signatureHeader);
  const timestampMs = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) throw new Error("Invalid Bridge webhook timestamp.");
  if (Math.abs(Date.now() - timestampMs) > bridgeWebhookToleranceMs()) {
    throw new Error("Bridge webhook signature timestamp is outside the allowed tolerance.");
  }

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${timestamp}.${input.payload}`);
  if (!verifier.verify(publicKey, signature, "base64")) throw new Error("Invalid Bridge webhook signature.");
  return JSON.parse(input.payload) as BridgeWebhookEvent;
}
