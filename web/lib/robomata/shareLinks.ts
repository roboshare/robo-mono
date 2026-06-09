import type { EvidenceCommitment } from "~~/lib/robomata/evidence";
import type {
  FacilitySubmission,
  FacilitySubmissionStatus,
  SubmissionComputation,
  SubmissionEncryptionBackend,
  SubmissionException,
  SubmissionStorageBackend,
} from "~~/lib/robomata/submissions";

export type SubmissionShareLinkStatus = "active" | "revoked" | "expired";

export type SubmissionShareLink = {
  id: string;
  submissionId: string;
  partnerAddress: string;
  creatorPartnerAddress: string;
  creatorPrivyUserId?: string;
  tokenHash: string;
  status: SubmissionShareLinkStatus;
  recipientLabel?: string;
  recipientEmailHash?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  revokedByPartnerAddress?: string;
  lastAccessedAt?: string;
  accessCount: number;
  metadata?: Record<string, string | number | boolean | null>;
};

export type SubmissionShareLinkAuditEvent = {
  id: string;
  shareLinkId: string;
  submissionId: string;
  type: "packet_share_created" | "packet_share_viewed" | "packet_share_revoked" | "packet_share_expired";
  createdAt: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export type SharedLenderPacketEvidence = {
  id: string;
  filename: string;
  scope: string;
  uploadedAt: string;
  storageBackend: SubmissionStorageBackend;
  encryptionBackend: SubmissionEncryptionBackend;
  status: EvidenceCommitment["status"];
  linkedExceptionIds: string[];
  advanced: {
    walrusBlobId?: string;
    walrusEventId?: string;
    plaintextDigest: string;
    ciphertextDigest?: string;
    sealPackageId?: string;
    sealIdentity?: string;
    sealThreshold?: number;
    sealKeyServerObjectIds?: string[];
    suiTxDigest?: string;
    evidenceRoot?: string;
  };
};

export type SharedLenderPacketView = {
  shareLink: {
    id: string;
    status: SubmissionShareLinkStatus;
    expiresAt: string;
    lastAccessedAt?: string;
    accessCount: number;
  };
  submission: {
    id: string;
    operatorName: string;
    facilityName: string;
    asOfDate: string;
    status: FacilitySubmissionStatus;
    updatedAt: string;
  };
  borrowingBase: SubmissionComputation["borrowingBase"];
  lenderPacket: SubmissionComputation["lenderPacket"];
  exceptions: Array<Pick<SubmissionException, "id" | "severity" | "title" | "message" | "actionStatus">>;
  evidence: SharedLenderPacketEvidence[];
};

function linkedExceptionIdsForEvidence(submission: FacilitySubmission, evidenceId: string): string[] {
  return submission.exceptions
    .filter(exception => exception.kind === "evidence" && exception.itemId === evidenceId)
    .map(exception => exception.id);
}

export function buildSharedLenderPacketView({
  shareLink,
  submission,
}: {
  shareLink: SubmissionShareLink;
  submission: FacilitySubmission;
}): SharedLenderPacketView {
  if (!submission.computation) {
    throw new Error("Submission does not have lender packet output.");
  }

  return {
    shareLink: {
      id: shareLink.id,
      status: shareLink.status,
      expiresAt: shareLink.expiresAt,
      lastAccessedAt: shareLink.lastAccessedAt,
      accessCount: shareLink.accessCount,
    },
    submission: {
      id: submission.id,
      operatorName: submission.operatorName,
      facilityName: submission.facilityName,
      asOfDate: submission.asOfDate,
      status: submission.status,
      updatedAt: submission.updatedAt,
    },
    borrowingBase: submission.computation.borrowingBase,
    lenderPacket: submission.computation.lenderPacket,
    exceptions: submission.exceptions.map(exception => ({
      id: exception.id,
      severity: exception.severity,
      title: exception.title,
      message: exception.message,
      actionStatus: exception.actionStatus,
    })),
    evidence: submission.evidence.map(evidence => ({
      id: evidence.id,
      filename: evidence.filename,
      scope: evidence.scope,
      uploadedAt: evidence.uploadedAt,
      storageBackend: evidence.storageBackend,
      encryptionBackend: evidence.encryptionBackend,
      status: evidence.status,
      linkedExceptionIds: linkedExceptionIdsForEvidence(submission, evidence.id),
      advanced: {
        walrusBlobId: evidence.walrusBlobId,
        walrusEventId: evidence.walrusEventId,
        plaintextDigest: evidence.plaintextDigest,
        ciphertextDigest: evidence.ciphertextDigest,
        sealPackageId: evidence.sealPackageId,
        sealIdentity: evidence.sealIdentity,
        sealThreshold: evidence.sealThreshold,
        sealKeyServerObjectIds: evidence.sealKeyServerObjectIds,
        suiTxDigest: submission.evidenceCommit.txDigest,
        evidenceRoot: submission.evidenceCommit.evidenceRoot,
      },
    })),
  };
}
