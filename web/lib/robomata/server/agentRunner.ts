import "server-only";
import { isRobomataAgentMemoryEnabled } from "~~/lib/featureFlags";
import {
  type RobomataAgentActionDraft,
  type RobomataAgentActionSeverity,
  type RobomataAgentActionType,
  type RobomataAgentPolicy,
} from "~~/lib/robomata/agents";
import type { FacilityMonitoringProjection, FacilityObservationStatus } from "~~/lib/robomata/facilityMonitoring";
import {
  type RobomataFacilityPolicyArtifact,
  resolveRobomataFacilityPolicyArtifact,
} from "~~/lib/robomata/policyRules";
import { recallRobomataAgentMemory, rememberRobomataAgentRunMemory } from "~~/lib/robomata/server/agentMemory";
import {
  ROBOMATA_AGENT_PLANNER_MAX_RECENT_ACTIONS,
  ROBOMATA_AGENT_PLANNER_MAX_RECENT_RUNS,
  planRobomataAgentActions,
  plannerBoundarySummary,
} from "~~/lib/robomata/server/agentPlanner";
import { getRobomataAgentStore } from "~~/lib/robomata/server/agentStore";
import { getFacilityMonitoringStore } from "~~/lib/robomata/server/facilityMonitoringStore";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";

export class RobomataAgentPolicyPausedError extends Error {
  constructor() {
    super("Robomata agent policy is paused for this submission.");
  }
}

export class RobomataAgentPolicyRevokedError extends Error {
  constructor() {
    super("Robomata agent policy has been revoked for this submission.");
  }
}

type RunAgentForSubmissionInput = {
  force?: boolean;
  submission: FacilitySubmission;
  suppressAutoApprove?: boolean;
};

function appendAction(
  actions: RobomataAgentActionDraft[],
  policy: RobomataAgentPolicy,
  policyArtifact: RobomataFacilityPolicyArtifact,
  action: RobomataAgentActionDraft & { type: RobomataAgentActionType },
) {
  void policy;
  const policyRule = policyArtifact.ruleSets.agentSupervision.rules.find(rule => rule.actionType === action.type);

  actions.push({
    ...action,
    metadata: {
      ...action.metadata,
      policyArtifactId: policyArtifact.id,
      policyArtifactVersion: policyArtifact.version,
      policyRuleId: policyRule?.id ?? action.type,
      policyRuleLabel: policyRule?.label ?? action.title,
      policyRuleSummary: policyRule?.summary ?? action.reason,
    },
  });
}

function observationSeverity(statuses: FacilityObservationStatus[]): RobomataAgentActionSeverity {
  if (statuses.some(status => ["exception", "expired"].includes(status))) return "high";
  if (statuses.some(status => ["stale", "warning"].includes(status))) return "medium";
  return "low";
}

function buildAgentActionDrafts(
  submission: FacilitySubmission,
  policy: RobomataAgentPolicy,
  projection: FacilityMonitoringProjection,
): RobomataAgentActionDraft[] {
  const actions: RobomataAgentActionDraft[] = [];
  const policyArtifact = resolveRobomataFacilityPolicyArtifact({
    facilityId: projection.facility.id,
    submissionId: submission.id,
  }).artifact;
  const nonFreshObservations = projection.observations.filter(
    observation => !["fresh", "superseded"].includes(observation.status),
  );

  if (nonFreshObservations.length) {
    appendAction(actions, policy, policyArtifact, {
      type: "evidence_review",
      severity: observationSeverity(nonFreshObservations.map(observation => observation.status)),
      title: "Review facility evidence freshness",
      message: `${nonFreshObservations.length} monitoring observation${
        nonFreshObservations.length === 1 ? "" : "s"
      } need operator review before the lender packet should be trusted.`,
      reason: "Facility monitoring detected stale, pending, warning, expired, or exception observations.",
      metadata: {
        observationCount: nonFreshObservations.length,
        statuses: [...new Set(nonFreshObservations.map(observation => observation.status))].join(","),
      },
    });
  }

  if (!projection.latestRun && submission.receivables.length > 0 && submission.evidence.length > 0) {
    appendAction(actions, policy, policyArtifact, {
      type: "borrowing_base_recompute",
      severity: "medium",
      title: "Compute borrowing base run",
      message: "Receivables and evidence are present, but no locked borrowing-base run exists for monitoring.",
      reason: "Agent supervision requires a run artifact before packet freshness and Sui roots can be evaluated.",
      metadata: {
        evidenceCount: submission.evidence.length,
        receivableCount: submission.receivables.length,
      },
    });
  }

  if (projection.freshnessStatus !== "fresh") {
    appendAction(actions, policy, policyArtifact, {
      type: "packet_refresh",
      severity: projection.freshnessStatus === "invalid" ? "high" : "medium",
      title: "Refresh lender packet",
      message: `Latest packet freshness is ${projection.freshnessStatus.replace(/_/g, " ")}.`,
      reason: "Lender-facing packet state should be regenerated or reviewed before sharing.",
      metadata: {
        freshnessStatus: projection.freshnessStatus,
        latestPacketId: projection.latestPacket?.id ?? null,
      },
    });
  }

  if (["pending", "failed", "mismatch", "retryable"].includes(projection.suiRootStatus)) {
    appendAction(actions, policy, policyArtifact, {
      type: "sui_root_review",
      severity: ["failed", "mismatch"].includes(projection.suiRootStatus) ? "high" : "medium",
      title: "Review Sui root commit",
      message: `Sui root verification is ${projection.suiRootStatus.replace(/_/g, " ")}.`,
      reason: "The packet evidence root needs an operator-visible commit or reconciliation path.",
      metadata: {
        latestRootCommitId: projection.latestSuiRootCommit?.id ?? null,
        suiRootStatus: projection.suiRootStatus,
      },
    });
  }

  if (
    submission.evidenceCommit.status === "committed" &&
    ["not_started", "draft", "failed"].includes(submission.tokenization.status)
  ) {
    appendAction(actions, policy, policyArtifact, {
      type: "tokenization_readiness",
      severity: submission.tokenization.status === "failed" ? "high" : "low",
      title: "Prepare tokenization handoff",
      message: "Evidence is committed, but tokenization is not registered or offering-ready.",
      reason: "Committed packet evidence can now be advanced into the controlled tokenization origination path.",
      metadata: {
        tokenizationStatus: submission.tokenization.status,
      },
    });
  }

  return actions;
}

export async function runRobomataAgentForSubmission(input: RunAgentForSubmissionInput) {
  const store = getRobomataAgentStore();
  const policy = await store.getOrCreateDefaultPolicy(input.submission);
  if (policy.status === "revoked") {
    throw new RobomataAgentPolicyRevokedError();
  }
  if (policy.status !== "active" && !input.force) {
    throw new RobomataAgentPolicyPausedError();
  }

  const startedAt = new Date().toISOString();
  const projection = await getFacilityMonitoringStore().getProjectionForSubmission(input.submission);
  const candidateActions = buildAgentActionDrafts(input.submission, policy, projection);
  const policyArtifact = resolveRobomataFacilityPolicyArtifact({
    facilityId: projection.facility.id,
    submissionId: input.submission.id,
  }).artifact;
  const [recentRuns, recentActions] = await Promise.all([
    store.listRuns(input.submission.id, input.submission.partnerAddress, ROBOMATA_AGENT_PLANNER_MAX_RECENT_RUNS),
    store.listActions(input.submission.id, input.submission.partnerAddress, ROBOMATA_AGENT_PLANNER_MAX_RECENT_ACTIONS),
  ]);
  const memoryContext = isRobomataAgentMemoryEnabled()
    ? await recallRobomataAgentMemory({
        policy,
        projection,
        submission: input.submission,
      })
    : undefined;
  const { actions: actionDrafts, plannerBoundary } = await planRobomataAgentActions({
    candidateActions,
    memoryContext,
    policyArtifact,
    policy,
    projection,
    recentActions,
    recentRuns,
    submission: input.submission,
    suppressAutoApprove: input.suppressAutoApprove,
  });
  const completedAt = new Date().toISOString();
  const proposalSummary = actionDrafts.length
    ? `Proposed ${actionDrafts.length} supervised agent action${actionDrafts.length === 1 ? "" : "s"}.`
    : "No supervised agent actions proposed.";
  const summary = `${proposalSummary} ${plannerBoundarySummary(plannerBoundary)}`;

  const recorded = await store.recordRun({
    policy,
    projection,
    status: "completed",
    startedAt,
    completedAt,
    summary,
    actionDrafts,
    plannerBoundary,
    suppressAutoApprove: input.suppressAutoApprove,
  });
  if (isRobomataAgentMemoryEnabled()) {
    const memoryWrite = await rememberRobomataAgentRunMemory({
      actions: recorded.actions,
      projection,
      run: recorded.run,
      submission: input.submission,
    });
    try {
      const persistedRun = await store.recordRunMemoryWrite({
        memoryWrite,
        partnerAddress: input.submission.partnerAddress,
        runId: recorded.run.id,
        submissionId: input.submission.id,
      });
      if (persistedRun) {
        recorded.run = persistedRun;
      }
    } catch {
      // The run/actions are already durable. Do not make retry paths duplicate them
      // just because optional memory-write provenance failed to persist.
    }
  }
  return recorded;
}
