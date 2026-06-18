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

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

export const ROBOMATA_BORROWING_BASE_POLICY_RULES: RobomataPolicyRule[] = [
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

export const ROBOMATA_PACKET_FRESHNESS_POLICY_RULES: RobomataPolicyRule[] = [
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

export const ROBOMATA_AGENT_SUPERVISION_POLICY_RULES: RobomataAgentPolicyRule[] = [
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
