import type { EvidenceStatus } from "~~/lib/robomata/borrowingBase";
import {
  type RobomataBorrowingBasePolicyParameters,
  type RobomataFacilityPolicyArtifact,
  resolveRobomataBorrowingBasePolicyParameters,
} from "~~/lib/robomata/policyRules";
import type { FacilitySubmission, SubmissionEvidence, SubmissionReceivable } from "~~/lib/robomata/submissions";

type EvidenceStatusKind = "insurance" | "title_lien" | "lockbox" | "servicing_utilization" | "receivables";

export type EvidenceStatusDerivation = {
  reason: string;
  status: EvidenceStatus;
  subjectIds: string[];
};

export type EvidenceStatusChange = {
  evidenceId: string;
  label: string;
  nextStatus: EvidenceStatus;
  previousStatus: EvidenceStatus;
  reason: string;
};

function classifyEvidenceKind(
  evidence: Pick<SubmissionEvidence, "label" | "scope" | "source">,
): EvidenceStatusKind | null {
  const text = [evidence.scope, evidence.label, evidence.source].join(" ").toLowerCase();

  if (/\b(receivable|receivables|aging|invoice|accounting)\b/.test(text)) return "receivables";
  if (/\b(insurance|insured|coverage|carrier|broker)\b/.test(text)) return "insurance";
  if (/\b(title|lien|ucc|collateral)\b/.test(text)) return "title_lien";
  if (/\b(lockbox|cash|bank|collection|collections)\b/.test(text)) return "lockbox";
  if (/\b(servicing|utilization|telematics|fleet|usage)\b/.test(text)) return "servicing_utilization";

  return null;
}

function getTargetReceivables(input: {
  linkedReceivableIds: string[];
  receivables: SubmissionReceivable[];
}): SubmissionReceivable[] {
  const activeReceivables = input.receivables.filter(receivable => !receivable.excluded);
  if (input.linkedReceivableIds.length === 0) return activeReceivables;

  const linkedIds = new Set(input.linkedReceivableIds);
  return activeReceivables.filter(receivable => linkedIds.has(receivable.id));
}

function exceptionStatus(reason: string, subjectIds: string[]): EvidenceStatusDerivation {
  return {
    reason,
    status: "exception",
    subjectIds,
  };
}

function verifiedStatus(reason: string): EvidenceStatusDerivation {
  return {
    reason,
    status: "verified",
    subjectIds: [],
  };
}

export function deriveEvidenceStatus(input: {
  evidence: Pick<SubmissionEvidence, "label" | "linkedReceivableIds" | "scope" | "source">;
  policy?: RobomataBorrowingBasePolicyParameters;
  receivables: SubmissionReceivable[];
}): EvidenceStatusDerivation {
  const kind = classifyEvidenceKind(input.evidence);
  if (!kind) {
    return {
      reason: "Robomata could not classify this evidence type for deterministic policy checks.",
      status: "pending",
      subjectIds: [],
    };
  }

  const targetReceivables = getTargetReceivables({
    linkedReceivableIds: input.evidence.linkedReceivableIds,
    receivables: input.receivables,
  });
  if (targetReceivables.length === 0) {
    return {
      reason: "No active receivables are linked to this evidence package yet.",
      status: "pending",
      subjectIds: [],
    };
  }

  const policy = input.policy ?? resolveRobomataBorrowingBasePolicyParameters();

  if (kind === "receivables") {
    return verifiedStatus("Receivables evidence is present for the active imported receivable set.");
  }

  if (kind === "insurance") {
    const failed = targetReceivables.filter(receivable => !receivable.insured);
    if (failed.length > 0) {
      return exceptionStatus(
        "One or more active receivables are marked uninsured under the imported data.",
        failed.map(receivable => receivable.id),
      );
    }
    return verifiedStatus("All active targeted receivables are marked insured.");
  }

  if (kind === "title_lien") {
    const failed = targetReceivables.filter(receivable => !receivable.titleClear);
    if (failed.length > 0) {
      return exceptionStatus(
        "One or more active receivables have title or lien exceptions under the imported data.",
        failed.map(receivable => receivable.id),
      );
    }
    return verifiedStatus("All active targeted receivables have clear title and lien status.");
  }

  if (kind === "lockbox") {
    const failed = targetReceivables.filter(receivable => !receivable.lockboxMatched);
    if (failed.length > 0) {
      return exceptionStatus(
        "One or more active receivables have lockbox cash mapping exceptions.",
        failed.map(receivable => receivable.id),
      );
    }
    return verifiedStatus("All active targeted receivables have matched lockbox cash mapping.");
  }

  const failed = targetReceivables.filter(receivable => receivable.utilizationPct < policy.minUtilizationPct);
  if (failed.length > 0) {
    return exceptionStatus(
      `One or more active receivables are below the ${policy.minUtilizationPct}% utilization policy floor.`,
      failed.map(receivable => receivable.id),
    );
  }
  return verifiedStatus("All active targeted receivables meet the utilization policy floor.");
}

export function deriveSubmissionEvidenceStatuses(
  submission: FacilitySubmission,
  options: { policyArtifact?: RobomataFacilityPolicyArtifact } = {},
): EvidenceStatusChange[] {
  const policy = resolveRobomataBorrowingBasePolicyParameters({ artifact: options.policyArtifact });
  const changes: EvidenceStatusChange[] = [];

  submission.evidence = submission.evidence.map(evidence => {
    const derivation = deriveEvidenceStatus({
      evidence,
      policy,
      receivables: submission.receivables,
    });

    if (evidence.status === derivation.status) return evidence;

    changes.push({
      evidenceId: evidence.id,
      label: evidence.label,
      nextStatus: derivation.status,
      previousStatus: evidence.status,
      reason: derivation.reason,
    });

    return {
      ...evidence,
      status: derivation.status,
    };
  });

  return changes;
}
