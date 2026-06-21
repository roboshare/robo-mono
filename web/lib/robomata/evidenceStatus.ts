import type { EvidenceStatus } from "~~/lib/robomata/borrowingBase";
import {
  type RobomataBorrowingBasePolicyParameters,
  type RobomataFacilityPolicyArtifact,
  resolveRobomataBorrowingBasePolicyParameters,
} from "~~/lib/robomata/policyRules";
import type {
  FacilitySubmission,
  SubmissionEvidence,
  SubmissionEvidenceDerivedFacts,
  SubmissionReceivable,
} from "~~/lib/robomata/submissions";

export type EvidenceStatusKind = "insurance" | "title_lien" | "lockbox" | "servicing_utilization" | "receivables";

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

export function classifyEvidenceKind(
  evidence: Pick<SubmissionEvidence, "label" | "scope" | "source">,
): EvidenceStatusKind | null {
  const text = [evidence.scope, evidence.label, evidence.source].join(" ").toLowerCase();

  if (/\b(insurance|insured|coverage|carrier|broker)\b/.test(text)) return "insurance";
  if (/\b(title|lien|ucc|collateral)\b/.test(text)) return "title_lien";
  if (/\b(lockbox|cash|bank|collection|collections)\b/.test(text)) return "lockbox";
  if (/\b(servicing|utilization|telematics|fleet|usage)\b/.test(text)) return "servicing_utilization";
  if (/\b(receivable|receivables|aging|invoice|accounting)\b/.test(text)) return "receivables";

  return null;
}

function normalizedEvidenceText(input: { evidenceText?: string }) {
  return (input.evidenceText ?? "").toLowerCase();
}

function hasNegativeEvidenceCue(text: string, kind: Exclude<EvidenceStatusKind, "receivables">) {
  if (kind === "insurance") {
    return /\b(uninsured|(?:policy|coverage|insurance)\b.{0,16}\b(?:cancel(?:led|ed)|expired|inactive|lapsed|missing|exception|not\s+(?:active|current|in force))|(?:cancel(?:led|ed)|expired|inactive|lapsed|missing|exception|not\s+(?:active|current|in force))\b.{0,16}\b(?:policy|coverage|insurance)|coverage\s+(?:is\s+)?not\s+(?:active|current|in force)|(?:not|without)\s+(?:currently\s+)?(?:covered|insured|coverage|insurance))\b/.test(
      text,
    );
  }

  if (kind === "title_lien") {
    return /\b((?:title|lien|ucc|collateral)\b.{0,24}\b(?:not\s+(?:clear|cleared|verified)|unverified|missing|exception|cancel(?:led|ed)|expired|lapsed)|(?:unverified|missing|exception|cancel(?:led|ed)|expired|lapsed)\b.{0,24}\b(?:clear|cleared|verified|current)?\s*(?:title|lien|ucc|collateral))\b/.test(
      text,
    );
  }

  if (kind === "lockbox") {
    return /\b((?:lockbox|cash|bank|collection|collections)\b.{0,24}\b(?:not\s+(?:matched|verified|reconciled)|unmatched|unverified|missing|exception)|(?:unmatched|unverified|missing|exception)\b.{0,24}\b(?:matched|verified|reconciled)?\s*(?:lockbox|cash|bank|collection|collections))\b/.test(
      text,
    );
  }

  const utilizationWindow = text.match(/\butili[sz]ation\b.{0,48}/)?.[0] ?? "";
  return (
    /\butili[sz]ation\b.{0,24}\b(?:missing|exception|stale|not\s+(?:current|verified))\b/.test(text) ||
    (/\bbelow\b/.test(utilizationWindow) && !/\bnot\s+below\b/.test(utilizationWindow))
  );
}

function hasPositiveEvidenceCue(text: string) {
  return /\b(active|covered|coverage active|clear|cleared|matched|verified|current|corrected|in force|reconciled)\b/.test(
    text,
  );
}

function evidenceTargetsReceivable(facts: SubmissionEvidenceDerivedFacts, receivableId: string) {
  return facts.receivableIds.includes(receivableId);
}

export function deriveEvidenceFacts(input: {
  evidence: Pick<SubmissionEvidence, "label" | "linkedReceivableIds" | "scope" | "source">;
  evidenceText?: string;
}): SubmissionEvidenceDerivedFacts | undefined {
  const kind = classifyEvidenceKind(input.evidence);
  if (!kind || kind === "receivables") return undefined;
  if (input.evidence.linkedReceivableIds.length === 0) return undefined;

  const text = normalizedEvidenceText({ evidenceText: input.evidenceText });
  if (hasNegativeEvidenceCue(text, kind) || !hasPositiveEvidenceCue(text)) return undefined;

  const baseFacts = {
    derivedAt: new Date().toISOString(),
    reason: "Derived from explicit affirmative evidence package cues.",
    receivableIds: input.evidence.linkedReceivableIds,
  };

  if (kind === "insurance") {
    return {
      ...baseFacts,
      insured: true,
    };
  }

  if (kind === "title_lien") {
    return {
      ...baseFacts,
      titleClear: true,
    };
  }

  if (kind === "lockbox") {
    return {
      ...baseFacts,
      lockboxMatched: true,
    };
  }

  const utilizationMatch = text.match(
    /\butili[sz]ation(?:\s+(pct|percent|rate))?\D{0,16}(\d{1,3})(?:\.\d+)?\s*(%|pct|percent)?\b/,
  );
  const hasExplicitUtilizationUnit =
    utilizationMatch?.[1] === "pct" || utilizationMatch?.[1] === "percent" || Boolean(utilizationMatch?.[3]);
  const utilizationPct =
    utilizationMatch && hasExplicitUtilizationUnit ? Number.parseInt(utilizationMatch[2], 10) : undefined;
  if (
    typeof utilizationPct === "number" &&
    Number.isFinite(utilizationPct) &&
    utilizationPct >= 0 &&
    utilizationPct <= 100
  ) {
    return {
      ...baseFacts,
      utilizationPct,
    };
  }

  return undefined;
}

export function evidenceSupportsReceivable(input: {
  evidence: Pick<SubmissionEvidence, "derivedFacts" | "label" | "linkedReceivableIds" | "scope" | "source">;
  kind: Exclude<EvidenceStatusKind, "receivables">;
  policy?: RobomataBorrowingBasePolicyParameters;
  receivableId: string;
}) {
  const facts =
    input.evidence.derivedFacts ??
    deriveEvidenceFacts({
      evidence: input.evidence,
    });
  if (!facts || !evidenceTargetsReceivable(facts, input.receivableId)) return false;

  if (input.kind === "insurance") return facts.insured === true;
  if (input.kind === "title_lien") return facts.titleClear === true;
  if (input.kind === "lockbox") return facts.lockboxMatched === true;

  const policy = input.policy ?? resolveRobomataBorrowingBasePolicyParameters();
  return typeof facts.utilizationPct === "number" && facts.utilizationPct >= policy.minUtilizationPct;
}

function getReceivableTargets(input: { linkedReceivableIds: string[]; receivables: SubmissionReceivable[] }): {
  activeTargets: SubmissionReceivable[];
  linkedTargets: SubmissionReceivable[];
} {
  const activeReceivables = input.receivables.filter(receivable => !receivable.excluded);
  if (input.linkedReceivableIds.length === 0) {
    return {
      activeTargets: activeReceivables,
      linkedTargets: [],
    };
  }

  const linkedIds = new Set(input.linkedReceivableIds);
  const linkedTargets = input.receivables.filter(receivable => linkedIds.has(receivable.id));
  return {
    activeTargets: linkedTargets.filter(receivable => !receivable.excluded),
    linkedTargets,
  };
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
    return verifiedStatus(
      "This supporting artifact is retained as non-blocking because it does not match a deterministic policy evidence type.",
    );
  }

  const { activeTargets, linkedTargets } = getReceivableTargets({
    linkedReceivableIds: input.evidence.linkedReceivableIds,
    receivables: input.receivables,
  });
  if (activeTargets.length === 0) {
    if (linkedTargets.length > 0 && linkedTargets.every(receivable => receivable.excluded)) {
      return verifiedStatus("All linked receivables are excluded, so this evidence package is non-blocking.");
    }

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
    const failed = activeTargets.filter(
      receivable =>
        !receivable.insured &&
        !evidenceSupportsReceivable({
          evidence: input.evidence,
          kind,
          policy,
          receivableId: receivable.id,
        }),
    );
    if (failed.length > 0) {
      return exceptionStatus(
        "One or more active receivables are marked uninsured under the imported data.",
        failed.map(receivable => receivable.id),
      );
    }
    return verifiedStatus("All active targeted receivables are marked insured.");
  }

  if (kind === "title_lien") {
    const failed = activeTargets.filter(
      receivable =>
        !receivable.titleClear &&
        !evidenceSupportsReceivable({
          evidence: input.evidence,
          kind,
          policy,
          receivableId: receivable.id,
        }),
    );
    if (failed.length > 0) {
      return exceptionStatus(
        "One or more active receivables have title or lien exceptions under the imported data.",
        failed.map(receivable => receivable.id),
      );
    }
    return verifiedStatus("All active targeted receivables have clear title and lien status.");
  }

  if (kind === "lockbox") {
    const failed = activeTargets.filter(
      receivable =>
        !receivable.lockboxMatched &&
        !evidenceSupportsReceivable({
          evidence: input.evidence,
          kind,
          policy,
          receivableId: receivable.id,
        }),
    );
    if (failed.length > 0) {
      return exceptionStatus(
        "One or more active receivables have lockbox cash mapping exceptions.",
        failed.map(receivable => receivable.id),
      );
    }
    return verifiedStatus("All active targeted receivables have matched lockbox cash mapping.");
  }

  const failed = activeTargets.filter(
    receivable =>
      receivable.utilizationPct < policy.minUtilizationPct &&
      !evidenceSupportsReceivable({
        evidence: input.evidence,
        kind,
        policy,
        receivableId: receivable.id,
      }),
  );
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
