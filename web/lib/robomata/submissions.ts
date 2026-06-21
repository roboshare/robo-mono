import type { AgentReview } from "~~/lib/robomata/agentProviders";
import type { BorrowingBaseResult } from "~~/lib/robomata/borrowingBase";
import type { EvidenceAnchor, EvidenceCommitment, EvidenceRail } from "~~/lib/robomata/evidence";
import type { FacilityMonitoringStatus, PacketFreshnessStatus } from "~~/lib/robomata/facilityMonitoring";
import type { LenderPacket } from "~~/lib/robomata/lenderPacket";

export type FacilitySubmissionStatus =
  | "draft"
  | "needs_evidence"
  | "ready_to_compute"
  | "needs_review"
  | "ready_for_lender"
  | "committed";

export type FacilitySubmissionSource = "rental_platform" | "external_asset_pool" | "connected_external_system";

export type SubmissionStorageBackend = "walrus" | "walrus-mock";
export type SubmissionEncryptionBackend = "none" | "seal";

export type SubmissionExceptionKind = "receivable" | "evidence" | "submission";
export type SubmissionExceptionSeverity = "high" | "medium" | "low";
export type SubmissionExceptionActionStatus = "open" | "excluded" | "replaced" | "resolved";

export type SubmissionReceivable = {
  id: string;
  obligor: string;
  vehicleCount: number;
  outstandingCents: number;
  daysPastDue: number;
  utilizationPct: number;
  insured: boolean;
  titleClear: boolean;
  lockboxMatched: boolean;
  excluded: boolean;
  sourceRow: number;
};

export type SubmissionEvidence = EvidenceCommitment & {
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  scope: string;
  linkedReceivableIds: string[];
  storageBackend: SubmissionStorageBackend;
  encryptionBackend: SubmissionEncryptionBackend;
  sealEncrypted?: boolean;
  walrusBlobId: string;
  walrusEventId?: string;
  aggregatorUrl?: string;
  plaintextDigest: string;
  ciphertextDigest?: string;
  sealPackageId?: string;
  sealIdentity?: string;
  sealThreshold?: number;
  sealKeyServerObjectIds?: string[];
  sealKeyServerAggregatorUrl?: string;
};

export type SubmissionException = {
  id: string;
  kind: SubmissionExceptionKind;
  itemId: string;
  severity: SubmissionExceptionSeverity;
  title: string;
  message: string;
  nextAction: string;
  actionStatus: SubmissionExceptionActionStatus;
};

export type SubmissionAuditEvent = {
  id: string;
  type:
    | "submission_created"
    | "submission_updated"
    | "receivables_imported"
    | "receivables_removed"
    | "evidence_uploaded"
    | "borrowing_base_computed"
    | "receivable_excluded"
    | "receivable_updated"
    | "evidence_updated"
    | "evidence_removed"
    | "packet_share_created"
    | "packet_share_revoked"
    | "sui_facility_assigned"
    | "sui_commit_prepared"
    | "sui_commit_completed"
    | "tokenization_drafted"
    | "tokenization_terms_updated"
    | "tokenization_prepared"
    | "tokenization_completed"
    | "policy_reviewed";
  createdAt: string;
  message: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export type SubmissionPolicyReviewRole = "lender" | "operator";
export type SubmissionPolicyReviewStatus = "accepted" | "needs_changes";
export type SubmissionPolicyReviewSurface = "operator_submission_access" | "protected_lender_share_link";

export type SubmissionPolicyReview = {
  id: string;
  role: SubmissionPolicyReviewRole;
  status: SubmissionPolicyReviewStatus;
  reviewedArtifactId: string;
  reviewedArtifactName: string;
  reviewedArtifactVersion: string;
  reviewedAt: string;
  reviewedBy: string;
  reviewSurface: SubmissionPolicyReviewSurface;
  rationale?: string;
};

export type SubmissionEvidenceCommit = {
  status: "not_started" | "ready" | "committing" | "committed" | "failed";
  evidenceRoot?: string;
  rootDigest?: string;
  txDigest?: string;
  commitStartedAt?: string;
  committedAt?: string;
  facilityObjectId?: string;
  facilityOperatorAddress?: string;
  facilityAssignmentStartedAt?: string;
  facilityAssignmentRootDigest?: string;
  facilityAssignmentOperatorAddress?: string;
  facilityAssignmentErrorMessage?: string;
  modulePath: string;
  commitMode: "prepared" | "configured" | "operator_configured";
  commitAuthority?: "server" | "operator";
  operatorWalletAddress?: string;
  sponsorshipMode?: "native_sui";
  sponsorAddress?: string;
  errorMessage?: string;
};

export type SubmissionFacilityMonitoringRef = {
  facilityId: string;
  latestRunId?: string;
  latestPacketId?: string;
  status: FacilityMonitoringStatus;
  packetFreshnessStatus?: PacketFreshnessStatus;
};

export type SubmissionComputation = {
  computedAt: string;
  borrowingBase: BorrowingBaseResult;
  agentReview: AgentReview;
  lenderPacket: LenderPacket;
  evidenceAnchor: EvidenceAnchor;
  evidenceRail: EvidenceRail;
};

export type SubmissionTokenizationStatus =
  | "not_started"
  | "draft"
  | "ready_to_sign"
  | "registered"
  | "offering_created"
  | "failed";

export type SubmissionTokenizationAnchors = {
  evidenceRoot?: string;
  rootDigest?: string;
  suiTxDigest?: string;
  facilityCommitment?: string;
};

export type SubmissionTokenizationTerms = {
  offeringLimitCents?: number;
  tokenPrice?: number;
  maturityMonths?: number;
  revenueShareBps?: number;
  targetYieldBps?: number;
  immediateProceeds?: boolean;
  protectionEnabled?: boolean;
};

export type SubmissionTokenizationEvmResult = {
  registryAddress?: string;
  assetId?: string;
  revenueTokenId?: string;
  txHash?: string;
  assetMetadataUri?: string;
  revenueTokenMetadataUri?: string;
  preparedCallArgs?: [string, string, string, string, string, string, string, boolean, boolean];
};

export type SubmissionTokenization = {
  status: SubmissionTokenizationStatus;
  anchors: SubmissionTokenizationAnchors;
  terms: SubmissionTokenizationTerms;
  evm: SubmissionTokenizationEvmResult;
  preparedAt?: string;
  completedAt?: string;
  failedAt?: string;
  errorMessage?: string;
};

export type FacilitySubmission = {
  id: string;
  partnerAddress: string;
  facilitySource: FacilitySubmissionSource;
  operatorName: string;
  facilityName: string;
  asOfDate: string;
  status: FacilitySubmissionStatus;
  receivables: SubmissionReceivable[];
  evidence: SubmissionEvidence[];
  exceptions: SubmissionException[];
  computation: SubmissionComputation | null;
  evidenceCommit: SubmissionEvidenceCommit;
  tokenization: SubmissionTokenization;
  facilityMonitoring?: SubmissionFacilityMonitoringRef;
  policyReviews?: SubmissionPolicyReview[];
  auditEvents: SubmissionAuditEvent[];
  createdAt: string;
  updatedAt: string;
};

export type CreateSubmissionInput = {
  partnerAddress: string;
  facilitySource?: FacilitySubmissionSource;
  operatorName: string;
  facilityName: string;
  asOfDate: string;
};

export const SUI_COMMIT_MODULE_PATH = "protocols/sui::robomata_overflow::facility::commit_evidence";

export function nowIsoString(): string {
  return new Date().toISOString();
}

export function createSubmissionId(): string {
  return `sub_${crypto.randomUUID()}`;
}

export function createAuditEvent(
  type: SubmissionAuditEvent["type"],
  message: string,
  metadata?: SubmissionAuditEvent["metadata"],
): SubmissionAuditEvent {
  return {
    id: `audit_${crypto.randomUUID()}`,
    type,
    createdAt: nowIsoString(),
    message,
    metadata,
  };
}

export function createSubmissionPolicyReview(input: {
  artifactId: string;
  artifactName: string;
  artifactVersion: string;
  rationale?: string;
  reviewedAt?: string;
  reviewedBy: string;
  reviewSurface: SubmissionPolicyReviewSurface;
  role: SubmissionPolicyReviewRole;
  status: SubmissionPolicyReviewStatus;
}): SubmissionPolicyReview {
  const reviewedAt = input.reviewedAt ?? nowIsoString();
  return {
    id: `policy_review_${input.role}_${input.reviewedBy}_${input.artifactId}_${input.artifactVersion}`.replace(
      /[^a-zA-Z0-9_:-]/g,
      "_",
    ),
    role: input.role,
    status: input.status,
    reviewedArtifactId: input.artifactId,
    reviewedArtifactName: input.artifactName,
    reviewedArtifactVersion: input.artifactVersion,
    reviewedAt,
    reviewedBy: input.reviewedBy,
    reviewSurface: input.reviewSurface,
    rationale: input.rationale,
  };
}

export function upsertSubmissionPolicyReview(
  submission: FacilitySubmission,
  review: SubmissionPolicyReview,
): FacilitySubmission {
  const reviews = submission.policyReviews ?? [];
  submission.policyReviews = [
    review,
    ...reviews.filter(
      candidate =>
        !(
          candidate.role === review.role &&
          candidate.reviewedArtifactId === review.reviewedArtifactId &&
          candidate.reviewedArtifactVersion === review.reviewedArtifactVersion &&
          candidate.reviewedBy === review.reviewedBy &&
          candidate.reviewSurface === review.reviewSurface
        ),
    ),
  ];
  return submission;
}

export function createDefaultSubmissionTokenization(): SubmissionTokenization {
  return {
    status: "not_started",
    anchors: {},
    terms: {},
    evm: {},
  };
}

export function normalizeSubmissionTokenization(submission: FacilitySubmission): FacilitySubmission {
  submission.facilitySource = submission.facilitySource ?? "external_asset_pool";
  submission.policyReviews = submission.policyReviews ?? [];
  submission.tokenization = {
    ...createDefaultSubmissionTokenization(),
    ...(submission.tokenization ?? {}),
    anchors: {
      ...((submission.tokenization as SubmissionTokenization | undefined)?.anchors ?? {}),
    },
    terms: {
      ...((submission.tokenization as SubmissionTokenization | undefined)?.terms ?? {}),
    },
    evm: {
      ...((submission.tokenization as SubmissionTokenization | undefined)?.evm ?? {}),
    },
  };
  return submission;
}

export function resolveSubmissionFacilityObjectId(
  submission: Pick<FacilitySubmission, "id" | "evidenceCommit">,
): string | undefined {
  const existing = submission.evidenceCommit.facilityObjectId?.trim();
  if (existing) return existing;
}

export function resolveSubmissionFacilityOperatorAddress(
  submission: Pick<FacilitySubmission, "id" | "evidenceCommit">,
): string | undefined {
  const existing = submission.evidenceCommit.facilityOperatorAddress?.trim();
  if (existing) return existing;
}

export function deriveSubmissionStatus(submission: FacilitySubmission): FacilitySubmissionStatus {
  if (submission.evidenceCommit.status === "committed") return "committed";
  if (submission.computation) {
    return submission.computation.borrowingBase.exceptionCount > 0 ? "needs_review" : "ready_for_lender";
  }
  if (submission.receivables.length > 0 && submission.evidence.length > 0) return "ready_to_compute";
  if (submission.receivables.length > 0) return "needs_evidence";
  return "draft";
}

type DraftDeletionSubmissionView = FacilitySubmission & {
  evidenceCount?: number;
  hasComputation?: boolean;
  receivableCount?: number;
};

export function canDeleteDraftFacilitySubmission(submission: DraftDeletionSubmissionView): boolean {
  const receivableCount =
    typeof submission.receivableCount === "number" ? submission.receivableCount : submission.receivables.length;
  const evidenceCount =
    typeof submission.evidenceCount === "number" ? submission.evidenceCount : submission.evidence.length;
  const hasComputation =
    typeof submission.hasComputation === "boolean" ? submission.hasComputation : Boolean(submission.computation);
  const hasEvidenceCommitArtifacts = Boolean(
    submission.evidenceCommit.evidenceRoot?.trim() ||
      submission.evidenceCommit.rootDigest?.trim() ||
      submission.evidenceCommit.txDigest?.trim() ||
      submission.evidenceCommit.commitStartedAt?.trim() ||
      submission.evidenceCommit.committedAt?.trim(),
  );
  const hasPendingFacilityAssignment = Boolean(
    submission.evidenceCommit.facilityAssignmentStartedAt?.trim() ||
      submission.evidenceCommit.facilityAssignmentRootDigest?.trim() ||
      submission.evidenceCommit.facilityAssignmentOperatorAddress?.trim(),
  );
  const hasActiveEvidenceCommit = ["committing", "committed"].includes(submission.evidenceCommit.status);

  return (
    submission.status === "draft" &&
    receivableCount === 0 &&
    evidenceCount === 0 &&
    !hasComputation &&
    !hasActiveEvidenceCommit &&
    !hasEvidenceCommitArtifacts &&
    !hasPendingFacilityAssignment &&
    submission.tokenization.status === "not_started"
  );
}

export function createSubmissionShell(input: CreateSubmissionInput): FacilitySubmission {
  const createdAt = nowIsoString();
  const shell: FacilitySubmission = {
    id: createSubmissionId(),
    partnerAddress: input.partnerAddress,
    facilitySource: input.facilitySource ?? "external_asset_pool",
    operatorName: input.operatorName,
    facilityName: input.facilityName,
    asOfDate: input.asOfDate,
    status: "draft",
    receivables: [],
    evidence: [],
    exceptions: [],
    computation: null,
    evidenceCommit: {
      status: "not_started",
      modulePath: SUI_COMMIT_MODULE_PATH,
      commitMode: "prepared",
    },
    tokenization: createDefaultSubmissionTokenization(),
    facilityMonitoring: undefined,
    auditEvents: [],
    createdAt,
    updatedAt: createdAt,
  };

  shell.auditEvents.push(
    createAuditEvent("submission_created", `Created submission shell for ${shell.facilityName}.`, {
      partnerAddress: shell.partnerAddress,
    }),
  );
  shell.status = deriveSubmissionStatus(shell);
  return shell;
}

export function touchSubmission(submission: FacilitySubmission): FacilitySubmission {
  normalizeSubmissionTokenization(submission);
  submission.status = deriveSubmissionStatus(submission);
  submission.updatedAt = nowIsoString();
  return submission;
}

export function invalidateSubmissionArtifacts(submission: FacilitySubmission): FacilitySubmission {
  const previousCommit = submission.evidenceCommit;
  submission.computation = null;
  submission.exceptions = [];
  submission.evidenceCommit = {
    status: "not_started",
    modulePath: SUI_COMMIT_MODULE_PATH,
    commitMode: previousCommit.commitMode,
    facilityObjectId: previousCommit.facilityObjectId,
    facilityOperatorAddress: previousCommit.facilityOperatorAddress,
    facilityAssignmentStartedAt: previousCommit.facilityAssignmentStartedAt,
    facilityAssignmentRootDigest: previousCommit.facilityAssignmentRootDigest,
    facilityAssignmentOperatorAddress: previousCommit.facilityAssignmentOperatorAddress,
    facilityAssignmentErrorMessage: previousCommit.facilityAssignmentErrorMessage,
  };
  if (submission.facilityMonitoring) {
    submission.facilityMonitoring = {
      ...submission.facilityMonitoring,
      latestPacketId: undefined,
      latestRunId: undefined,
    };
  }
  submission.tokenization = createDefaultSubmissionTokenization();
  return touchSubmission(submission);
}

export function addAuditEvent(
  submission: FacilitySubmission,
  type: SubmissionAuditEvent["type"],
  message: string,
  metadata?: SubmissionAuditEvent["metadata"],
): FacilitySubmission {
  submission.auditEvents.unshift(createAuditEvent(type, message, metadata));
  return touchSubmission(submission);
}
