import type { RobomataAgentPolicy } from "~~/lib/robomata/agents";
import type { EvidenceCommitment } from "~~/lib/robomata/evidence";
import type { BorrowingBaseRun, PacketFreshnessStatus, PacketManifest } from "~~/lib/robomata/facilityMonitoring";
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

export type SubmissionShareLinkMonitoringBinding = {
  facilityId: string;
  runId: string;
  policyArtifactId?: string;
  policyArtifactName?: string;
  policyArtifactVersion?: string;
  runPolicyVersion?: string;
  packetManifestId: string;
  packetGeneratedAt: string;
  packetFreshnessStatus: PacketFreshnessStatus;
  runRootDigest?: string;
  packetRootDigest?: string;
  monitoringRootVersion?: string;
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
  monitoring?: SubmissionShareLinkMonitoringBinding & {
    currentPacketFreshnessStatus?: PacketFreshnessStatus;
    pinnedAtShare: boolean;
  };
  agentAppointment?: {
    flags: {
      agentsEnabled: boolean;
      lenderAppointmentEnabled: boolean;
      mutationsEnabled: boolean;
      shareLinksEnabled: boolean;
    };
    policy?: Pick<
      RobomataAgentPolicy,
      | "appointedAgentName"
      | "appointedAt"
      | "appointedBy"
      | "appointmentAuthorizationId"
      | "appointmentAuthorizationSurface"
      | "id"
      | "revocationAuthorizationSurface"
      | "revocationReason"
      | "revokedAt"
      | "revokedBy"
      | "status"
      | "updatedAt"
    >;
  };
};

function linkedExceptionIdsForEvidence(exceptions: SubmissionException[], evidenceId: string): string[] {
  return exceptions
    .filter(exception => exception.kind === "evidence" && exception.itemId === evidenceId)
    .map(exception => exception.id);
}

function observationIdForEvidence(evidenceId: string): string {
  return `obs_${evidenceId}`;
}

export function buildSharedLenderPacketView({
  monitoring,
  packetManifest,
  run,
  shareLink,
  submission,
  agentAppointment,
}: {
  agentAppointment?: SharedLenderPacketView["agentAppointment"];
  monitoring?: SharedLenderPacketView["monitoring"];
  packetManifest?: PacketManifest;
  run?: BorrowingBaseRun;
  shareLink: SubmissionShareLink;
  submission: FacilitySubmission;
}): SharedLenderPacketView {
  if (!submission.computation && (!packetManifest || !run)) {
    throw new Error("Submission does not have lender packet output.");
  }

  const exceptions = run?.exceptions ?? submission.exceptions;
  const evidence = packetManifest
    ? submission.evidence.filter(entry =>
        packetManifest.evidenceObservationIds.includes(observationIdForEvidence(entry.id)),
      )
    : submission.evidence;

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
    borrowingBase: run?.borrowingBase ?? submission.computation!.borrowingBase,
    lenderPacket: packetManifest?.lenderPacket ?? submission.computation!.lenderPacket,
    exceptions: exceptions.map(exception => ({
      id: exception.id,
      severity: exception.severity,
      title: exception.title,
      message: exception.message,
      actionStatus: exception.actionStatus,
    })),
    evidence: evidence.map(evidence => ({
      id: evidence.id,
      filename: evidence.filename,
      scope: evidence.scope,
      uploadedAt: evidence.uploadedAt,
      storageBackend: evidence.storageBackend,
      encryptionBackend: evidence.encryptionBackend,
      status: evidence.status,
      linkedExceptionIds: linkedExceptionIdsForEvidence(exceptions, evidence.id),
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
    monitoring,
    agentAppointment,
  };
}
