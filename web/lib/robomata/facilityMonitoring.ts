import type { BorrowingBaseResult } from "~~/lib/robomata/borrowingBase";
import type { EvidenceAnchor } from "~~/lib/robomata/evidence";
import type { LenderPacket } from "~~/lib/robomata/lenderPacket";
import type { RobomataPolicyEvaluationSummary } from "~~/lib/robomata/policyRules";
import type { SubmissionException } from "~~/lib/robomata/submissions";

export const ROBOMATA_MONITORING_ROOT_VERSION = "robomata.monitoring.v1" as const;

export type FacilityMonitoringStatus =
  | "draft"
  | "observing"
  | "needs_evidence"
  | "needs_review"
  | "ready_for_run"
  | "run_locked"
  | "packet_fresh"
  | "packet_stale"
  | "commit_pending"
  | "commit_verified"
  | "failed";

export type FacilityObservationKind =
  | "receivables_aging"
  | "insurance"
  | "lien_title"
  | "maintenance"
  | "utilization"
  | "lockbox"
  | "ownership"
  | "other";

export type FacilityObservationStatus =
  | "fresh"
  | "stale"
  | "expired"
  | "superseded"
  | "warning"
  | "exception"
  | "pending";

export type FacilityObservationConfidence = "operator_attested" | "third_party" | "system_verified" | "unknown";

export type BorrowingBaseRunStatus =
  | "draft"
  | "computed"
  | "locked"
  | "packet_generated"
  | "committed"
  | "stale"
  | "failed";

export type PacketFreshnessStatus = "fresh" | "stale" | "invalid" | "superseded" | "refresh_available";

export type SuiRootVerificationStatus =
  | "not_started"
  | "pending"
  | "committing"
  | "committed"
  | "verified"
  | "mismatch"
  | "failed"
  | "retryable";

export type SuiRootCommitStatus =
  | "pending"
  | "committing"
  | "committed"
  | "verified"
  | "mismatch"
  | "failed"
  | "retryable";

export type RobomataFacility = {
  id: string;
  partnerAddress: string;
  operatorName: string;
  facilityName: string;
  status: FacilityMonitoringStatus;
  latestRunId?: string;
  latestPacketId?: string;
  suiFacilityObjectId?: string;
  facilityOperatorAddress?: string;
  createdAt: string;
  updatedAt: string;
};

export type FacilityObservation = {
  id: string;
  facilityId: string;
  kind: FacilityObservationKind;
  source: string;
  observedAt: string;
  effectiveAt?: string;
  expiresAt?: string;
  supersedesObservationId?: string;
  status: FacilityObservationStatus;
  confidence: FacilityObservationConfidence;
  linkedAssetIds: string[];
  linkedReceivableIds: string[];
  digest: string;
  storageRef?: string;
  notes?: string;
};

export type BorrowingBaseRun = {
  id: string;
  facilityId: string;
  runNumber: number;
  asOfDate: string;
  status: BorrowingBaseRunStatus;
  policyVersion: string;
  policyArtifactId?: string;
  policyArtifactName?: string;
  policyEvaluations?: RobomataPolicyEvaluationSummary[];
  inputObservationIds: string[];
  inputDigest: string;
  borrowingBase: BorrowingBaseResult;
  exceptions: SubmissionException[];
  evidenceAnchor: EvidenceAnchor;
  rootDigest: string;
  packetId?: string;
  committedAt?: string;
  createdAt: string;
  lockedAt?: string;
};

export type PacketManifest = {
  id: string;
  facilityId: string;
  runId: string;
  runDigest: string;
  generatedAt: string;
  freshnessStatus: PacketFreshnessStatus;
  evidenceObservationIds: string[];
  policyEvaluations?: RobomataPolicyEvaluationSummary[];
  publicMetadata: Record<string, string | number | boolean | null>;
  lenderPacket?: LenderPacket;
};

export type SuiRootPayloadKind = "evidence_batch" | "borrowing_base_run" | "packet_manifest";

export type SuiRootPayload = {
  version: typeof ROBOMATA_MONITORING_ROOT_VERSION;
  kind: SuiRootPayloadKind;
  facilityId: string;
  runId?: string;
  packetManifestId?: string;
  inputDigest: string;
  rootDigest: string;
  generatedAt: string;
};

export type SuiRootCommit = {
  id: string;
  facilityId: string;
  kind: SuiRootPayloadKind;
  version: typeof ROBOMATA_MONITORING_ROOT_VERSION;
  label: string;
  payload: SuiRootPayload;
  inputDigest: string;
  rootDigest: string;
  status: SuiRootCommitStatus;
  txDigest?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  committedAt?: string;
  verifiedAt?: string;
};

export type FacilityMonitoringProjection = {
  facility: RobomataFacility;
  latestRun?: BorrowingBaseRun;
  latestPacket?: PacketManifest;
  latestSuiRootCommit?: SuiRootCommit;
  runHistory: BorrowingBaseRun[];
  packetManifests: PacketManifest[];
  suiRootCommits: SuiRootCommit[];
  observations: FacilityObservation[];
  freshnessStatus: PacketFreshnessStatus;
  suiRootStatus: SuiRootVerificationStatus;
  warnings: string[];
};
