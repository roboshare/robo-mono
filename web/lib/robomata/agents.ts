import type {
  FacilityMonitoringProjection,
  PacketFreshnessStatus,
  SuiRootVerificationStatus,
} from "~~/lib/robomata/facilityMonitoring";
import type { RobomataPolicyEvaluationSummary } from "~~/lib/robomata/policyRules";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";

export type RobomataAgentPolicyStatus = "active" | "paused" | "revoked";

export type RobomataAgentActionType =
  | "evidence_review"
  | "packet_refresh"
  | "borrowing_base_recompute"
  | "sui_root_review"
  | "tokenization_readiness";

export type RobomataAgentActionStatus = "proposed" | "approved" | "rejected" | "completed" | "skipped";

export type RobomataAgentActionSeverity = "low" | "medium" | "high";

export type RobomataAgentRunStatus = "completed" | "failed";

export type RobomataAgentActionPermissionOperation = "approve" | "auto_approve" | "complete" | "execute" | "propose";

export type RobomataAgentPlannerExecutionBoundary = "audit_only_adapter_flagged" | "proposal_only";
export type RobomataAgentPlannerRequiredApproval = "none_auto_approved" | "operator";
export type RobomataAgentPlannerRiskLevel = RobomataAgentActionSeverity;
export type RobomataAgentPlannerSuggestedTool = "none" | "robomata.agent.advisory_audit.v1";

export type RobomataAgentAppointer = "lender" | "operator" | "platform";
export type RobomataAgentAppointmentAuthorizationSurface = "operator_submission_access" | "protected_lender_share_link";

export type RobomataAgentPlannerProvider = "anthropic" | "google" | "openai" | "rules";

export type RobomataAgentPlannerMode = "deterministic_fallback" | "deterministic_rules" | "llm_live" | "llm_stubbed";

export type RobomataAgentPlannerStatus =
  | "schema_invalid_fallback"
  | "configured_without_feature_flag"
  | "configured_without_key"
  | "configured_without_model"
  | "live_completed"
  | "live_error_fallback"
  | "rate_limited_fallback"
  | "rules_engine"
  | "stubbed_pending_controls";

export type RobomataAgentEventType =
  | "policy_created"
  | "policy_revoked"
  | "policy_updated"
  | "run_completed"
  | "run_failed"
  | "action_proposed"
  | "action_approved"
  | "action_rejected"
  | "action_completed"
  | "action_execution_failed"
  | "action_execution_succeeded"
  | "action_skipped";

export type RobomataAgentMetadata = Record<string, string | number | boolean | null>;

export type RobomataAgentPlannerInputControls = {
  allowedFields: string[];
  excludedMaterial: string[];
  generatedAt: string;
  maxCandidateActions: number;
  maxRecentActions: number;
  maxRecentRuns: number;
  maxTextLength: number;
  rawEvidenceIncluded: false;
  secretMaterialIncluded: false;
};

export type RobomataAgentPlannerBoundary = {
  provider: RobomataAgentPlannerProvider;
  status: RobomataAgentPlannerStatus;
  mode: RobomataAgentPlannerMode;
  model?: string;
  allowedToolCount?: number;
  candidateActionCount?: number;
  generatedAt?: string;
  inputControls?: RobomataAgentPlannerInputControls;
  memoryProvider?: "memwal";
  memoryRecallCount?: number;
  memoryRecallStatus?: string;
  memoryWriteJobId?: string;
  memoryWriteStatus?: string;
  memwalNamespace?: string;
  outputSchemaVersion?: "agent-supervision-plan-output-v1" | "agent-supervision-plan-output-v2";
  plannerInputDigest?: string;
  plannerOutputDigest?: string;
  promptVersion?: "agent-supervision-planner-v1";
  recentActionCount?: number;
  recentRunCount?: number;
  sourceOfTruth: "agent_policy_rules";
  sourceDataDigest?: string;
  version: "agent-supervision-v1";
};

export const ROBOMATA_AGENT_ACTION_TYPES: RobomataAgentActionType[] = [
  "evidence_review",
  "packet_refresh",
  "borrowing_base_recompute",
  "sui_root_review",
  "tokenization_readiness",
];

export type RobomataAgentPolicy = {
  id: string;
  submissionId: string;
  facilityId: string;
  partnerAddress: string;
  appointedAgentName?: string;
  appointedBy?: RobomataAgentAppointer;
  appointerAddress?: string;
  appointmentAuthorizationId?: string;
  appointmentAuthorizationSurface?: RobomataAgentAppointmentAuthorizationSurface;
  appointedAt?: string;
  status: RobomataAgentPolicyStatus;
  allowedActionTypes: RobomataAgentActionType[];
  autoApproveActionTypes: RobomataAgentActionType[];
  createdAt: string;
  updatedAt: string;
  pausedAt?: string;
  revocationAuthorizationSurface?: RobomataAgentAppointmentAuthorizationSurface | "platform_admin";
  revocationReason?: string;
  revokedAt?: string;
  revokedBy?: string;
  lastRunAt?: string;
};

export type RobomataAgentActionAuthorization = {
  appointedAgentName?: string;
  appointedAt?: string;
  appointedBy?: RobomataAgentAppointer;
  appointmentAuthorizationId?: string;
  appointmentAuthorizationSurface?: RobomataAgentAppointmentAuthorizationSurface;
  policyId: string;
};

export type RobomataAgentAction = {
  id: string;
  runId: string;
  policyId: string;
  submissionId: string;
  facilityId: string;
  partnerAddress: string;
  type: RobomataAgentActionType;
  status: RobomataAgentActionStatus;
  severity: RobomataAgentActionSeverity;
  title: string;
  message: string;
  reason: string;
  proposedAt: string;
  authorization?: RobomataAgentActionAuthorization;
  decidedAt?: string;
  decisionReason?: string;
  metadata?: RobomataAgentMetadata;
};

export type RobomataAgentRun = {
  id: string;
  policyId: string;
  submissionId: string;
  facilityId: string;
  partnerAddress: string;
  status: RobomataAgentRunStatus;
  startedAt: string;
  completedAt: string;
  actionCount: number;
  summary: string;
  policyArtifactId?: string;
  policyArtifactName?: string;
  policyArtifactVersion?: string;
  policyEvaluations?: RobomataPolicyEvaluationSummary[];
  plannerBoundary?: RobomataAgentPlannerBoundary;
  projectionStatus: FacilityMonitoringProjection["facility"]["status"];
  freshnessStatus: PacketFreshnessStatus;
  suiRootStatus: SuiRootVerificationStatus;
  errorMessage?: string;
};

export type RobomataAgentEvent = {
  id: string;
  type: RobomataAgentEventType;
  policyId: string;
  submissionId: string;
  actionId?: string;
  runId?: string;
  createdAt: string;
  message: string;
  metadata?: RobomataAgentMetadata;
};

export type RobomataAgentActionDraft = Omit<
  RobomataAgentAction,
  | "authorization"
  | "id"
  | "runId"
  | "policyId"
  | "submissionId"
  | "facilityId"
  | "partnerAddress"
  | "proposedAt"
  | "status"
>;

export function defaultAllowedAgentActionTypes(): RobomataAgentActionType[] {
  return [...ROBOMATA_AGENT_ACTION_TYPES];
}

export function createDefaultAgentPolicy(
  submission: Pick<FacilitySubmission, "id" | "partnerAddress" | "facilityMonitoring">,
  now: string,
): RobomataAgentPolicy {
  return {
    id: `agent_policy_${submission.id}`,
    submissionId: submission.id,
    facilityId: submission.facilityMonitoring?.facilityId ?? `facility_${submission.id}`,
    partnerAddress: submission.partnerAddress,
    appointedAgentName: "Robomata supervised facility agent",
    appointedBy: "operator",
    appointerAddress: submission.partnerAddress,
    appointmentAuthorizationId: submission.partnerAddress,
    appointmentAuthorizationSurface: "operator_submission_access",
    appointedAt: now,
    status: "paused",
    allowedActionTypes: defaultAllowedAgentActionTypes(),
    autoApproveActionTypes: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeAgentActionTypes(values: unknown): RobomataAgentActionType[] {
  if (!Array.isArray(values)) return defaultAllowedAgentActionTypes();
  const allowed = new Set(ROBOMATA_AGENT_ACTION_TYPES);
  const normalized = values.filter((value): value is RobomataAgentActionType => {
    return typeof value === "string" && allowed.has(value as RobomataAgentActionType);
  });
  return [...new Set(normalized)];
}

export function isAgentActionAllowed(policy: RobomataAgentPolicy, type: RobomataAgentActionType): boolean {
  return policy.allowedActionTypes.includes(type);
}

export function buildAgentActionAuthorization(policy: RobomataAgentPolicy): RobomataAgentActionAuthorization {
  return {
    appointedAgentName: policy.appointedAgentName,
    appointedAt: policy.appointedAt,
    appointedBy: policy.appointedBy,
    appointmentAuthorizationId: policy.appointmentAuthorizationId,
    appointmentAuthorizationSurface: policy.appointmentAuthorizationSurface,
    policyId: policy.id,
  };
}

export function agentActionAuthorizationMatchesPolicy(
  actionAuthorization: RobomataAgentActionAuthorization | undefined,
  policy: RobomataAgentPolicy,
): boolean {
  if (!actionAuthorization) return false;

  return (
    actionAuthorization.policyId === policy.id &&
    actionAuthorization.appointedAt === policy.appointedAt &&
    actionAuthorization.appointedBy === policy.appointedBy &&
    actionAuthorization.appointmentAuthorizationId === policy.appointmentAuthorizationId &&
    actionAuthorization.appointmentAuthorizationSurface === policy.appointmentAuthorizationSurface
  );
}

export function getRobomataAgentActionPermissionDenial(input: {
  actionAuthorization?: RobomataAgentActionAuthorization;
  actionType: RobomataAgentActionType;
  executionEnabled?: boolean;
  operation: RobomataAgentActionPermissionOperation;
  policy: RobomataAgentPolicy;
}): string | null {
  if (input.operation === "execute" && !input.executionEnabled) {
    return "Delegated agent execution is disabled by feature flag.";
  }
  if (input.policy.status !== "active") {
    return `Current agent appointment is ${input.policy.status}; ${input.operation.replace(/_/g, " ")} requires an active appointment.`;
  }
  if (!isAgentActionAllowed(input.policy, input.actionType)) {
    return `${input.actionType.replace(/_/g, " ")} is not allowed by the current agent appointment.`;
  }
  if (input.operation === "auto_approve" && !input.policy.autoApproveActionTypes.includes(input.actionType)) {
    return `${input.actionType.replace(/_/g, " ")} is not auto-approved by the current agent appointment.`;
  }
  if (input.actionAuthorization && !agentActionAuthorizationMatchesPolicy(input.actionAuthorization, input.policy)) {
    return "This action was authorized by a different agent appointment than the current policy.";
  }
  if (!input.actionAuthorization && input.operation === "execute") {
    return "This action is missing agent appointment authorization metadata.";
  }

  return null;
}
