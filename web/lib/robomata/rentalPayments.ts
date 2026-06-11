import type { PlatformVehicleId, ProtocolAssetId } from "~~/lib/robomata/rentalInventory";
import type { RentalMarketplaceListing, RentalMarketplaceTripEstimate } from "~~/lib/robomata/rentalMarketplace";

export type RentalPaymentProvider = "stripe";

export type RentalPaymentCurrency = "USD";

export type RentalPaymentIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_capture"
  | "captured"
  | "partially_captured"
  | "cancelled"
  | "failed"
  | "refunded"
  | "disputed";

export type RentalPaymentProviderEventKind =
  | "payment_intent_created"
  | "authorization_required"
  | "authorization_succeeded"
  | "capture_succeeded"
  | "payment_failed"
  | "refund_succeeded"
  | "refund_failed"
  | "dispute_opened"
  | "chargeback_recorded"
  | "reconciliation_refetched";

export type RentalDepositHoldStatus =
  | "not_required"
  | "authorization_required"
  | "authorized"
  | "partially_captured"
  | "released"
  | "captured"
  | "expired"
  | "failed";

export type RentalPaymentStackDecision = {
  provider: RentalPaymentProvider;
  processor: "Stripe";
  captureModel: "manual_capture";
  depositModel: "card_authorization";
  rationale: string[];
  constraints: string[];
};

export type RentalDepositPolicy = {
  enabled: boolean;
  fixedAmountCents?: number;
  percentOfTripSubtotalBps?: number;
  minAmountCents?: number;
  maxAmountCents?: number;
};

export type RentalPaymentFees = {
  platformFeeCents?: number;
  protectionPlanCents?: number;
  taxesCents?: number;
};

export type RentalCheckoutPaymentPlanInput = {
  bookingId?: string;
  listing: RentalMarketplaceListing;
  tripEstimate: RentalMarketplaceTripEstimate;
  fees?: RentalPaymentFees;
  depositPolicy?: RentalDepositPolicy;
};

export type RentalCheckoutPaymentPlan = {
  bookingId?: string;
  platformVehicleId: PlatformVehicleId;
  facilityAssetId: ProtocolAssetId;
  vehicleAssetId?: ProtocolAssetId;
  provider: RentalPaymentProvider;
  currency: RentalPaymentCurrency;
  rentalCharge: {
    baseAmountCents: number;
    discountAmountCents: number;
    platformFeeCents: number;
    protectionPlanCents: number;
    taxesCents: number;
    totalAuthorizeCents: number;
  };
  depositHold: {
    amountCents: number;
    status: RentalDepositHoldStatus;
  };
  totalDueAtAuthorizationCents: number;
  createdAt: string;
};

export type RentalPaymentProviderReference = {
  provider: RentalPaymentProvider;
  customerId?: string;
  paymentIntentId?: string;
  setupIntentId?: string;
  chargeId?: string;
  refundId?: string;
  disputeId?: string;
};

export type RentalPaymentProviderEvent = {
  id: string;
  kind: RentalPaymentProviderEventKind;
  providerEventId?: string;
  providerReference: RentalPaymentProviderReference;
  status: RentalPaymentIntentStatus;
  amountCents?: number;
  occurredAt: string;
  failureReason?: string;
};

export type RentalPaymentRecord = {
  id: string;
  bookingId: string;
  platformVehicleId: PlatformVehicleId;
  facilityAssetId: ProtocolAssetId;
  vehicleAssetId?: ProtocolAssetId;
  provider: RentalPaymentProvider;
  providerReference: RentalPaymentProviderReference;
  currency: RentalPaymentCurrency;
  authorizedAmountCents: number;
  capturedAmountCents: number;
  refundedAmountCents: number;
  status: RentalPaymentIntentStatus;
  authorizedAt?: string;
  captureBefore?: string;
  capturedAt?: string;
  cancelledAt?: string;
  failureReason?: string;
  postingBlocked: boolean;
  postingBlockReason?: string;
  reconciliationCheckedAt?: string;
  events: RentalPaymentProviderEvent[];
  createdAt: string;
  updatedAt: string;
};

export type RentalStripeAuthorizationRequest = {
  provider: "stripe";
  mode: "payment_intent";
  amountCents: number;
  currency: "usd";
  captureMethod: "manual";
  metadata: {
    bookingId?: string;
    platformVehicleId: PlatformVehicleId;
    facilityAssetId: ProtocolAssetId;
    vehicleAssetId?: ProtocolAssetId;
  };
};

export const DEFAULT_RENTAL_DEPOSIT_POLICY: RentalDepositPolicy = {
  enabled: true,
  percentOfTripSubtotalBps: 5_000,
  minAmountCents: 25_000,
  maxAmountCents: 150_000,
};

export function rentalPaymentStackDecision(): RentalPaymentStackDecision {
  return {
    provider: "stripe",
    processor: "Stripe",
    captureModel: "manual_capture",
    depositModel: "card_authorization",
    rationale: [
      "Supports mainstream renter checkout without requiring an onchain wallet.",
      "Supports separate authorization and capture for trip charges and deposit holds.",
      "Provides webhook events for capture, refund, dispute, and chargeback reconciliation.",
      "Can be provisioned through Vercel Marketplace environment variables without coupling to protocol contracts.",
    ],
    constraints: [
      "Authorization windows are processor and card-network dependent and must be monitored before trip start.",
      "Deposits are operating holds, not protocol escrow, until a later stablecoin escrow product is explicitly added.",
      "Sensitive payment method data must remain with the payment provider and never enter facility metadata.",
    ],
  };
}

function positiveCents(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function calculateRentalDepositHoldCents(
  tripSubtotalCents: number,
  policy: RentalDepositPolicy = DEFAULT_RENTAL_DEPOSIT_POLICY,
): number {
  if (!policy.enabled) return 0;

  const percentAmount = policy.percentOfTripSubtotalBps
    ? Math.floor((tripSubtotalCents * policy.percentOfTripSubtotalBps) / 10_000)
    : 0;
  const baseAmount = Math.max(positiveCents(policy.fixedAmountCents), percentAmount);
  const minAmount = positiveCents(policy.minAmountCents);
  const maxAmount = positiveCents(policy.maxAmountCents) || Number.POSITIVE_INFINITY;
  return Math.min(Math.max(baseAmount, minAmount), maxAmount);
}

export function buildRentalCheckoutPaymentPlan(input: RentalCheckoutPaymentPlanInput): RentalCheckoutPaymentPlan {
  const platformFeeCents = positiveCents(input.fees?.platformFeeCents);
  const protectionPlanCents = positiveCents(input.fees?.protectionPlanCents);
  const taxesCents = positiveCents(input.fees?.taxesCents);
  const totalAuthorizeCents =
    input.tripEstimate.totalBeforeTaxesCents + platformFeeCents + protectionPlanCents + taxesCents;
  const depositHoldCents = calculateRentalDepositHoldCents(
    input.tripEstimate.subtotalCents,
    input.depositPolicy ?? DEFAULT_RENTAL_DEPOSIT_POLICY,
  );

  return {
    bookingId: input.bookingId,
    platformVehicleId: input.listing.platformVehicleId,
    facilityAssetId: input.listing.facilityAssetId,
    vehicleAssetId: input.listing.vehicleAssetId,
    provider: "stripe",
    currency: input.tripEstimate.currency,
    rentalCharge: {
      baseAmountCents: input.tripEstimate.baseAmountCents,
      discountAmountCents: input.tripEstimate.discountAmountCents,
      platformFeeCents,
      protectionPlanCents,
      taxesCents,
      totalAuthorizeCents,
    },
    depositHold: {
      amountCents: depositHoldCents,
      status: depositHoldCents > 0 ? "authorization_required" : "not_required",
    },
    totalDueAtAuthorizationCents: totalAuthorizeCents + depositHoldCents,
    createdAt: new Date().toISOString(),
  };
}

export function buildStripeAuthorizationRequest(plan: RentalCheckoutPaymentPlan): RentalStripeAuthorizationRequest {
  return {
    provider: "stripe",
    mode: "payment_intent",
    amountCents: plan.totalDueAtAuthorizationCents,
    currency: plan.currency.toLowerCase() as "usd",
    captureMethod: "manual",
    metadata: {
      bookingId: plan.bookingId,
      platformVehicleId: plan.platformVehicleId,
      facilityAssetId: plan.facilityAssetId,
      vehicleAssetId: plan.vehicleAssetId,
    },
  };
}

export function paymentAuthorizationExpiry(authorizedAt: string, validityDays = 7): string {
  const authorizedTime = Date.parse(authorizedAt);
  if (!Number.isFinite(authorizedTime)) throw new Error("authorizedAt must be a valid timestamp.");
  return new Date(authorizedTime + validityDays * 24 * 60 * 60 * 1_000).toISOString();
}
