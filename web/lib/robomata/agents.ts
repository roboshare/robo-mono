import type {
  FacilityMonitoringProjection,
  PacketFreshnessStatus,
  SuiRootVerificationStatus,
} from "~~/lib/robomata/facilityMonitoring";
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

export type RobomataAgentAppointer = "lender" | "operator" | "platform";
export type RobomataAgentAppointmentAuthorizationSurface = "operator_submission_access" | "protected_lender_share_link";

export type RobomataAgentPlannerProvider = "anthropic" | "google" | "openai" | "rules";

export type RobomataAgentPlannerMode = "deterministic_fallback" | "deterministic_rules" | "llm_live" | "llm_stubbed";

export type RobomataAgentPlannerStatus =
  | "configured_without_feature_flag"
  | "configured_without_key"
  | "configured_without_model"
  | "live_completed"
  | "live_error_fallback"
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
  | "action_skipped";

export type RobomataAgentMetadata = Record<string, string | number | boolean | null>;

export type RobomataAgentPlannerBoundary = {
  provider: RobomataAgentPlannerProvider;
  status: RobomataAgentPlannerStatus;
  mode: RobomataAgentPlannerMode;
  model?: string;
  sourceOfTruth: "agent_policy_rules";
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
  "id" | "runId" | "policyId" | "submissionId" | "facilityId" | "partnerAddress" | "proposedAt" | "status"
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
