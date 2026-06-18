import type { RobomataAgentActionType } from "~~/lib/robomata/agents";

export const ROBOMATA_DEFAULT_POLICY_VERSION = "submission-v1";
export const ROBOMATA_DEFAULT_ADVANCE_RATE_BPS = 8200;
export const ROBOMATA_DEFAULT_CONCENTRATION_LIMIT_PCT = 35;
export const ROBOMATA_MAX_DAYS_PAST_DUE = 45;
export const ROBOMATA_MIN_UTILIZATION_PCT = 70;

export type RobomataPolicyRule = {
  id: string;
  label: string;
  summary: string;
  value?: string;
};

export type RobomataAgentPolicyRule = RobomataPolicyRule & {
  actionType: RobomataAgentActionType;
};

export type RobomataFacilityPolicyArtifactRuleSet<T extends RobomataPolicyRule = RobomataPolicyRule> = {
  id: string;
  label: string;
  description: string;
  rules: T[];
};

export type RobomataFacilityPolicyArtifact = {
  id: string;
  name: string;
  version: string;
  scope: "platform_default" | "facility_override" | "lender_override";
  status: "active";
  effectiveFrom: string;
  description: string;
  ruleSets: {
    borrowingBase: RobomataFacilityPolicyArtifactRuleSet;
    evidenceFreshness: RobomataFacilityPolicyArtifactRuleSet;
    packetFreshness: RobomataFacilityPolicyArtifactRuleSet;
    suiRoot: RobomataFacilityPolicyArtifactRuleSet;
    agentSupervision: RobomataFacilityPolicyArtifactRuleSet<RobomataAgentPolicyRule>;
  };
};

export type RobomataResolvedFacilityPolicyArtifact = {
  artifact: RobomataFacilityPolicyArtifact;
  resolution: {
    source: "platform_default";
    facilityId?: string;
    submissionId?: string;
  };
};

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

const ROBOMATA_BORROWING_BASE_RULES: RobomataPolicyRule[] = [
  {
    id: "advance-rate",
    label: "Advance rate",
    summary: "Eligible receivables are advanced at the platform default rate.",
    value: formatBps(ROBOMATA_DEFAULT_ADVANCE_RATE_BPS),
  },
  {
    id: "concentration-reserve",
    label: "Concentration reserve",
    summary: "Eligible exposure above the per-obligor concentration limit is reserved from availability.",
    value: `${ROBOMATA_DEFAULT_CONCENTRATION_LIMIT_PCT}% per obligor`,
  },
  {
    id: "days-past-due",
    label: "Days past due",
    summary: "Receivables over the maximum DPD threshold are ineligible.",
    value: `>${ROBOMATA_MAX_DAYS_PAST_DUE} DPD`,
  },
  {
    id: "insurance",
    label: "Insurance evidence",
    summary: "Receivables without insurance evidence are ineligible.",
  },
  {
    id: "title-lien",
    label: "Title and lien evidence",
    summary: "Receivables without clear title or lien evidence are ineligible.",
  },
  {
    id: "lockbox",
    label: "Lockbox mapping",
    summary: "Receivables without matching lockbox cash mapping are ineligible.",
  },
  {
    id: "utilization",
    label: "Utilization floor",
    summary: "Receivables below the platform utilization floor are ineligible.",
    value: `<${ROBOMATA_MIN_UTILIZATION_PCT}%`,
  },
  {
    id: "evidence-status",
    label: "Evidence status",
    summary: "Evidence packages that are pending or in exception count as package exceptions.",
    value: "verified required",
  },
  {
    id: "manual-exclusion",
    label: "Manual exclusion",
    summary: "Operator-excluded receivables are removed from lender-facing borrowing-base output.",
  },
];

const ROBOMATA_EVIDENCE_FRESHNESS_RULES: RobomataPolicyRule[] = [
  {
    id: "verified-evidence",
    label: "Verified evidence",
    summary: "Verified evidence is treated as a fresh monitoring observation for the linked receivables.",
  },
  {
    id: "pending-evidence",
    label: "Pending evidence",
    summary: "Pending evidence keeps the facility in review and prevents packet freshness from being treated as final.",
  },
  {
    id: "exception-evidence",
    label: "Exception evidence",
    summary: "Evidence marked in exception makes the facility packet invalid until resolved or superseded.",
  },
  {
    id: "system-verified-evidence",
    label: "System-verified storage",
    summary: "Seal-encrypted Walrus evidence is disclosed as system-verified provenance when available.",
  },
];

const ROBOMATA_PACKET_FRESHNESS_RULES: RobomataPolicyRule[] = [
  {
    id: "missing-computation",
    label: "Missing computation",
    summary: "A packet is invalid until a borrowing-base computation exists.",
  },
  {
    id: "open-exceptions",
    label: "Open exceptions",
    summary: "Open submission exceptions make the latest lender packet invalid.",
  },
  {
    id: "exception-expired-observations",
    label: "Exception or expired evidence",
    summary: "Exception or expired monitoring observations make the packet invalid.",
  },
  {
    id: "stale-observations",
    label: "Stale evidence",
    summary: "Stale or superseded observations mark the packet stale.",
  },
  {
    id: "newer-observations",
    label: "Newer observations",
    summary: "Fresh observations recorded after the stored packet was generated mark that packet stale.",
  },
  {
    id: "pending-warning-observations",
    label: "Pending evidence",
    summary: "Pending or warning observations require a packet refresh review.",
  },
];

const ROBOMATA_SUI_ROOT_RULES: RobomataPolicyRule[] = [
  {
    id: "not-started",
    label: "No root committed",
    summary: "A borrowing-base run or packet manifest has not been anchored until a Sui root commit is created.",
  },
  {
    id: "pending",
    label: "Commit pending",
    summary:
      "Pending or committing roots require operator follow-up before the evidence anchor is treated as verified.",
  },
  {
    id: "committed",
    label: "Evidence anchored",
    summary: "Committed roots show the evidence reference was submitted on Sui but still needs indexed verification.",
  },
  {
    id: "verified",
    label: "Verified root",
    summary:
      "Verified roots indicate the stored monitoring payload digest matches the committed Sui evidence reference.",
  },
  {
    id: "mismatch",
    label: "Digest mismatch",
    summary:
      "Mismatched roots require review because the stored monitoring payload no longer matches the committed digest.",
  },
  {
    id: "retryable",
    label: "Retryable failure",
    summary: "Failed or retryable root states require a new operator-visible commit or reconciliation attempt.",
  },
];

const ROBOMATA_AGENT_SUPERVISION_RULES: RobomataAgentPolicyRule[] = [
  {
    id: "evidence-review",
    actionType: "evidence_review",
    label: "Evidence review",
    summary: "Propose review when monitoring observations are not fresh.",
  },
  {
    id: "borrowing-base-recompute",
    actionType: "borrowing_base_recompute",
    label: "Borrowing-base recompute",
    summary: "Propose compute when receivables and evidence exist but no run artifact is locked.",
  },
  {
    id: "packet-refresh",
    actionType: "packet_refresh",
    label: "Packet refresh",
    summary: "Propose packet review when packet freshness is anything other than fresh.",
  },
  {
    id: "sui-root-review",
    actionType: "sui_root_review",
    label: "Sui root review",
    summary: "Propose review when evidence-root verification is pending, failed, mismatched, or retryable.",
  },
  {
    id: "tokenization-readiness",
    actionType: "tokenization_readiness",
    label: "Tokenization readiness",
    summary: "Propose handoff when evidence is committed but tokenization has not reached offering readiness.",
  },
];

export const ROBOMATA_DEFAULT_FACILITY_POLICY_ARTIFACT: RobomataFacilityPolicyArtifact = {
  id: "robomata-default-facility-policy",
  name: "Robomata platform default facility policy",
  version: ROBOMATA_DEFAULT_POLICY_VERSION,
  scope: "platform_default",
  status: "active",
  effectiveFrom: "2026-06-18",
  description:
    "Versioned metadata for the current deterministic Robomata rules. Facility and lender overrides are not active yet.",
  ruleSets: {
    borrowingBase: {
      id: "borrowing-base-eligibility",
      label: "Borrowing-base eligibility rules",
      description: "The current platform-default rules used to compute eligibility, reserves, and exceptions.",
      rules: ROBOMATA_BORROWING_BASE_RULES,
    },
    evidenceFreshness: {
      id: "evidence-freshness",
      label: "Evidence freshness rules",
      description: "The deterministic rules that map evidence records into monitoring observation status.",
      rules: ROBOMATA_EVIDENCE_FRESHNESS_RULES,
    },
    packetFreshness: {
      id: "packet-freshness",
      label: "Packet freshness rules",
      description: "The deterministic monitoring rules that classify lender packet freshness.",
      rules: ROBOMATA_PACKET_FRESHNESS_RULES,
    },
    suiRoot: {
      id: "sui-evidence-root",
      label: "Sui evidence-root rules",
      description:
        "The deterministic evidence-anchor rules that classify monitoring root commit and verification status.",
      rules: ROBOMATA_SUI_ROOT_RULES,
    },
    agentSupervision: {
      id: "agent-supervision-actions",
      label: "Supervised action proposal rules",
      description: "The current deterministic rules that can propose actions. Operators still approve or reject them.",
      rules: ROBOMATA_AGENT_SUPERVISION_RULES,
    },
  },
};

export function resolveRobomataFacilityPolicyArtifact(input?: {
  facilityId?: string;
  submissionId?: string;
}): RobomataResolvedFacilityPolicyArtifact {
  return {
    artifact: ROBOMATA_DEFAULT_FACILITY_POLICY_ARTIFACT,
    resolution: {
      source: "platform_default",
      facilityId: input?.facilityId,
      submissionId: input?.submissionId,
    },
  };
}

export const ROBOMATA_BORROWING_BASE_POLICY_RULES =
  ROBOMATA_DEFAULT_FACILITY_POLICY_ARTIFACT.ruleSets.borrowingBase.rules;
export const ROBOMATA_EVIDENCE_FRESHNESS_POLICY_RULES =
  ROBOMATA_DEFAULT_FACILITY_POLICY_ARTIFACT.ruleSets.evidenceFreshness.rules;
export const ROBOMATA_PACKET_FRESHNESS_POLICY_RULES =
  ROBOMATA_DEFAULT_FACILITY_POLICY_ARTIFACT.ruleSets.packetFreshness.rules;
export const ROBOMATA_SUI_ROOT_POLICY_RULES = ROBOMATA_DEFAULT_FACILITY_POLICY_ARTIFACT.ruleSets.suiRoot.rules;
export const ROBOMATA_AGENT_SUPERVISION_POLICY_RULES =
  ROBOMATA_DEFAULT_FACILITY_POLICY_ARTIFACT.ruleSets.agentSupervision.rules;
