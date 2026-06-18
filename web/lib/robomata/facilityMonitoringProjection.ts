import {
  type BorrowingBaseRun,
  type FacilityMonitoringProjection,
  type FacilityMonitoringStatus,
  type FacilityObservation,
  type FacilityObservationKind,
  type PacketFreshnessStatus,
  type PacketManifest,
  type RobomataFacility,
  type SuiRootVerificationStatus,
} from "~~/lib/robomata/facilityMonitoring";
import {
  buildBorrowingBasePolicyEvaluation,
  buildEvidenceFreshnessPolicyEvaluation,
  buildPacketFreshnessPolicyEvaluation,
  buildSuiRootPolicyEvaluation,
  resolveRobomataFacilityPolicyArtifact,
  summarizeRobomataPolicyEvaluations,
} from "~~/lib/robomata/policyRules";
import type { FacilitySubmission, SubmissionEvidence } from "~~/lib/robomata/submissions";

function facilityIdForSubmission(submission: FacilitySubmission): string {
  return submission.facilityMonitoring?.facilityId ?? `fac_${submission.id.replace(/^sub_/, "")}`;
}

function observationKind(evidence: SubmissionEvidence): FacilityObservationKind {
  const searchText = `${evidence.id} ${evidence.label} ${evidence.scope} ${evidence.source}`.toLowerCase();

  if (searchText.includes("receivable") || searchText.includes("aging")) return "receivables_aging";
  if (searchText.includes("insurance") || searchText.includes("policy")) return "insurance";
  if (searchText.includes("lien") || searchText.includes("title") || searchText.includes("ucc")) return "lien_title";
  if (searchText.includes("maintenance") || searchText.includes("servicing")) return "maintenance";
  if (searchText.includes("utilization") || searchText.includes("telematics")) return "utilization";
  if (searchText.includes("lockbox") || searchText.includes("bank")) return "lockbox";
  if (searchText.includes("ownership") || searchText.includes("owner")) return "ownership";
  return "other";
}

function observationStatus(evidence: SubmissionEvidence): FacilityObservation["status"] {
  if (evidence.status === "verified") return "fresh";
  if (evidence.status === "exception") return "exception";
  return "pending";
}

function observationConfidence(evidence: SubmissionEvidence): FacilityObservation["confidence"] {
  if (evidence.encryptionBackend === "seal" && evidence.storageBackend === "walrus") return "system_verified";
  if (evidence.source.toLowerCase().includes("operator")) return "operator_attested";
  if (evidence.status === "verified") return "third_party";
  return "unknown";
}

function buildObservations(submission: FacilitySubmission, facilityId: string): FacilityObservation[] {
  return submission.evidence.map(evidence => ({
    id: `obs_${evidence.id}`,
    facilityId,
    kind: observationKind(evidence),
    source: evidence.source,
    observedAt: evidence.uploadedAt,
    status: observationStatus(evidence),
    confidence: observationConfidence(evidence),
    linkedAssetIds: [],
    linkedReceivableIds: evidence.linkedReceivableIds,
    digest: evidence.plaintextDigest || evidence.digest,
    storageRef: evidence.walrusObjectId || evidence.walrusBlobId,
    notes: evidence.scope,
  }));
}

function monitoringStatus(
  submission: FacilitySubmission,
  freshnessStatus: PacketFreshnessStatus,
): FacilityMonitoringStatus {
  if (submission.evidenceCommit.status === "failed") return "failed";
  if (submission.evidenceCommit.status === "committing") return "commit_pending";
  if (submission.evidenceCommit.status === "committed") return "commit_verified";
  if (freshnessStatus === "stale") return "packet_stale";
  if (freshnessStatus === "fresh") return "packet_fresh";
  if (submission.computation) return submission.exceptions.length > 0 ? "needs_review" : "run_locked";
  if (submission.receivables.length > 0 && submission.evidence.length > 0) return "ready_for_run";
  if (submission.receivables.length > 0) return "needs_evidence";
  return "draft";
}

function packetFreshness(submission: FacilitySubmission, observations: FacilityObservation[]): PacketFreshnessStatus {
  if (!submission.computation) return "invalid";
  if (submission.exceptions.some(exception => exception.actionStatus === "open")) return "invalid";
  if (observations.some(observation => observation.status === "expired" || observation.status === "exception")) {
    return "invalid";
  }
  if (observations.some(observation => observation.status === "stale" || observation.status === "superseded")) {
    return "stale";
  }
  if (observations.some(observation => observation.status === "pending" || observation.status === "warning")) {
    return "refresh_available";
  }
  return "fresh";
}

function suiRootStatus(submission: FacilitySubmission): SuiRootVerificationStatus {
  if (submission.evidenceCommit.status === "failed") return "failed";
  if (submission.evidenceCommit.status === "committing") return "committing";
  if (submission.evidenceCommit.status === "committed") return "verified";
  if (submission.evidenceCommit.status === "ready") return "pending";
  return "not_started";
}

function buildLatestRun(submission: FacilitySubmission, facilityId: string, observations: FacilityObservation[]) {
  if (!submission.computation) return undefined;
  const policyArtifact = resolveRobomataFacilityPolicyArtifact({ facilityId, submissionId: submission.id }).artifact;

  const status: BorrowingBaseRun["status"] =
    submission.evidenceCommit.status === "committed"
      ? "committed"
      : submission.exceptions.some(exception => exception.actionStatus === "open")
        ? "computed"
        : "locked";

  return {
    id: submission.facilityMonitoring?.latestRunId ?? `run_${submission.id}`,
    facilityId,
    runNumber: 1,
    asOfDate: submission.asOfDate,
    status,
    policyArtifactId: policyArtifact.id,
    policyArtifactName: policyArtifact.name,
    policyEvaluations: [
      buildBorrowingBasePolicyEvaluation({
        artifact: policyArtifact,
        borrowingBase: submission.computation.borrowingBase,
        evaluatedAt: submission.computation.computedAt,
      }),
    ],
    policyVersion: policyArtifact.version,
    inputObservationIds: observations.map(observation => observation.id),
    inputDigest: submission.evidenceCommit.evidenceRoot ?? submission.computation.evidenceAnchor.evidenceRoot,
    borrowingBase: submission.computation.borrowingBase,
    exceptions: submission.exceptions,
    evidenceAnchor: submission.computation.evidenceAnchor,
    rootDigest: submission.evidenceCommit.rootDigest ?? "",
    packetId: submission.facilityMonitoring?.latestPacketId ?? `packet_${submission.id}`,
    committedAt: submission.evidenceCommit.committedAt,
    createdAt: submission.computation.computedAt,
    lockedAt: status === "locked" || status === "committed" ? submission.computation.computedAt : undefined,
  } satisfies BorrowingBaseRun;
}

function buildLatestPacket(
  submission: FacilitySubmission,
  facilityId: string,
  run: BorrowingBaseRun | undefined,
  freshnessStatus: PacketFreshnessStatus,
  observations: FacilityObservation[],
) {
  if (!run || !submission.computation) return undefined;
  const policyArtifact = resolveRobomataFacilityPolicyArtifact({
    facilityId,
    submissionId: submission.id,
  }).artifact;
  const policyEvaluations = [
    buildEvidenceFreshnessPolicyEvaluation({
      artifact: policyArtifact,
      evaluatedAt: submission.computation.computedAt,
      observations: observations,
    }),
    buildPacketFreshnessPolicyEvaluation({
      artifact: policyArtifact,
      evaluatedAt: submission.computation.computedAt,
      freshnessStatus,
      hasComputation: Boolean(submission.computation),
      observations,
      openExceptionCount: submission.exceptions.filter(exception => exception.actionStatus === "open").length,
    }),
    buildSuiRootPolicyEvaluation({
      artifact: policyArtifact,
      evaluatedAt: submission.computation.computedAt,
      suiRootStatus: suiRootStatus(submission),
    }),
  ];
  const policyEvaluationSummary = summarizeRobomataPolicyEvaluations(policyEvaluations);

  return {
    id: submission.facilityMonitoring?.latestPacketId ?? `packet_${submission.id}`,
    facilityId,
    runId: run.id,
    runDigest: run.rootDigest || run.inputDigest,
    generatedAt: submission.computation.computedAt,
    freshnessStatus,
    evidenceObservationIds: run.inputObservationIds,
    policyEvaluations,
    publicMetadata: {
      facilityName: submission.facilityName,
      operatorName: submission.operatorName,
      asOfDate: submission.asOfDate,
      grossReceivablesCents: submission.computation.borrowingBase.grossReceivablesCents,
      availableBorrowingBaseCents: submission.computation.borrowingBase.availableBorrowingBaseCents,
      exceptionCount: submission.computation.borrowingBase.exceptionCount,
      policyArtifactId: policyArtifact.id,
      policyArtifactName: policyArtifact.name,
      policyArtifactVersion: policyArtifact.version,
      policyEvaluationFailedCount: policyEvaluationSummary.failedCount,
      policyEvaluationSummary: policyEvaluationSummary.summary,
      policyEvaluationWarningCount: policyEvaluationSummary.warningCount,
    },
    lenderPacket: submission.computation.lenderPacket,
  } satisfies PacketManifest;
}

function buildWarnings(submission: FacilitySubmission, observations: FacilityObservation[]): string[] {
  const warnings: string[] = [];

  if (!submission.evidenceCommit.facilityObjectId) {
    warnings.push("Sui facility assignment is not available for this submission.");
  }
  if (!submission.computation) {
    warnings.push("Borrowing-base computation is required before monitoring can report packet freshness.");
  }
  if (observations.some(observation => observation.status !== "fresh")) {
    warnings.push("One or more evidence observations require review before a packet can be treated as fresh.");
  }
  return warnings;
}

export function buildFacilityMonitoringProjection(submission: FacilitySubmission): FacilityMonitoringProjection {
  const facilityId = facilityIdForSubmission(submission);
  const observations = buildObservations(submission, facilityId);
  const freshnessStatus =
    submission.facilityMonitoring?.packetFreshnessStatus ?? packetFreshness(submission, observations);
  const latestRun = buildLatestRun(submission, facilityId, observations);
  const latestPacket = buildLatestPacket(submission, facilityId, latestRun, freshnessStatus, observations);

  const facility: RobomataFacility = {
    id: facilityId,
    partnerAddress: submission.partnerAddress,
    operatorName: submission.operatorName,
    facilityName: submission.facilityName,
    status: submission.facilityMonitoring?.status ?? monitoringStatus(submission, freshnessStatus),
    latestRunId: latestRun?.id,
    latestPacketId: latestPacket?.id,
    suiFacilityObjectId: submission.evidenceCommit.facilityObjectId,
    facilityOperatorAddress: submission.evidenceCommit.facilityOperatorAddress,
    createdAt: submission.createdAt,
    updatedAt: submission.updatedAt,
  };

  return {
    facility,
    latestRun,
    latestPacket,
    latestSuiRootCommit: undefined,
    runHistory: latestRun ? [latestRun] : [],
    packetManifests: latestPacket ? [latestPacket] : [],
    suiRootCommits: [],
    observations,
    freshnessStatus,
    suiRootStatus: suiRootStatus(submission),
    warnings: buildWarnings(submission, observations),
  };
}
