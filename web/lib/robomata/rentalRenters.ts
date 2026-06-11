export type RenterVerificationStatus = "not_started" | "pending" | "approved" | "manual_review" | "failed" | "expired";

export type RenterVerificationKind = "identity" | "driver_license" | "sanctions";

export type RenterVerificationDecisionSource = "provider" | "admin_override" | "system";

export type RenterVerificationActorType = "provider" | "admin" | "system";

export type RenterVerificationActor = {
  id: string;
  type: RenterVerificationActorType;
  displayName?: string;
};

export type RenterVerificationCheck = {
  kind: RenterVerificationKind;
  status: RenterVerificationStatus;
  provider?: string;
  providerReferenceId?: string;
  reason?: string;
  decisionSource?: RenterVerificationDecisionSource;
  policyVersion?: string;
  actor?: RenterVerificationActor;
  reviewedBy?: string;
  reviewedAt?: string;
  expiresAt?: string;
  updatedAt: string;
};

export type RenterVerificationAuditAction = "verification_updated" | "manual_override_applied";

export type RenterVerificationAuditEvent = {
  id: string;
  action: RenterVerificationAuditAction;
  kind: RenterVerificationKind;
  fromStatus: RenterVerificationStatus;
  toStatus: RenterVerificationStatus;
  decisionSource: RenterVerificationDecisionSource;
  policyVersion: string;
  actor: RenterVerificationActor;
  provider?: string;
  providerReferenceId?: string;
  reason?: string;
  createdAt: string;
};

export type RenterVerificationPolicy = {
  version: string;
  requiredCheckoutChecks: RenterVerificationKind[];
  blockingStatuses: RenterVerificationStatus[];
  sensitiveDataBoundary: string[];
};

export type RenterProfile = {
  id: string;
  email?: string;
  phone?: string;
  displayName?: string;
  verification: Record<RenterVerificationKind, RenterVerificationCheck>;
  verificationAuditLog: RenterVerificationAuditEvent[];
  createdAt: string;
  updatedAt: string;
};

export type RenterProfileInput = {
  email?: string;
  phone?: string;
  displayName?: string;
};

export type RenterVerificationUpdate = {
  kind: RenterVerificationKind;
  status: RenterVerificationStatus;
  provider?: string;
  providerReferenceId?: string;
  reason?: string;
  decisionSource?: RenterVerificationDecisionSource;
  policyVersion?: string;
  actor?: RenterVerificationActor;
  reviewedBy?: string;
  reviewedAt?: string;
  expiresAt?: string;
};

export type RenterCheckoutEligibility = {
  eligible: boolean;
  blockingChecks: RenterVerificationKind[];
  policyVersion: string;
  renterId: string;
};

export const RENTER_VERIFICATION_POLICY_V1: RenterVerificationPolicy = {
  version: "renter-verification-v1",
  requiredCheckoutChecks: ["identity", "driver_license", "sanctions"],
  blockingStatuses: ["not_started", "pending", "manual_review", "failed", "expired"],
  sensitiveDataBoundary: [
    "Do not store raw identity documents or driver-license images in Roboshare.",
    "Do not store full SSNs, full DOBs, sanctions payloads, or biometric artifacts in Roboshare.",
    "Store provider references, statuses, reasons, expiry, actor attribution, and audit events only.",
  ],
};

export const REQUIRED_RENTER_CHECKOUT_VERIFICATIONS = RENTER_VERIFICATION_POLICY_V1.requiredCheckoutChecks;

export function emptyRenterVerification(kind: RenterVerificationKind, now: string): RenterVerificationCheck {
  return {
    kind,
    status: "not_started",
    decisionSource: "system",
    policyVersion: RENTER_VERIFICATION_POLICY_V1.version,
    updatedAt: now,
  };
}

export function renterCheckoutEligibility(
  renter: RenterProfile,
  policy: RenterVerificationPolicy = RENTER_VERIFICATION_POLICY_V1,
): RenterCheckoutEligibility {
  const blockingChecks = policy.requiredCheckoutChecks.filter(kind => {
    const check = renter.verification[kind];
    if (policy.blockingStatuses.includes(check.status)) return true;
    if (!check.expiresAt) return false;
    return Date.parse(check.expiresAt) <= Date.now();
  });

  return {
    eligible: blockingChecks.length === 0,
    blockingChecks,
    policyVersion: policy.version,
    renterId: renter.id,
  };
}
