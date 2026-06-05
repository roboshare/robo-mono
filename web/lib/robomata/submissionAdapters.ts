import { buildAgentReviewInput, reviewBorrowingBase } from "~~/lib/robomata/agentProviders";
import {
  type BorrowingBaseResult,
  type FleetPortfolio,
  type ReceivableResult,
  formatPercentFromBps,
  formatUsd,
} from "~~/lib/robomata/borrowingBase";
import { buildEvidenceAnchor, buildEvidenceRail } from "~~/lib/robomata/evidence";
import { buildLenderPacket } from "~~/lib/robomata/lenderPacket";
import {
  type FacilitySubmission,
  SUI_COMMIT_MODULE_PATH,
  type SubmissionComputation,
  type SubmissionEvidence,
} from "~~/lib/robomata/submissions";

function calculateSubmissionBorrowingBase(portfolio: FleetPortfolio): BorrowingBaseResult {
  const grossReceivablesCents = portfolio.receivables.reduce((sum, receivable) => sum + receivable.outstandingCents, 0);

  const receivableResults = portfolio.receivables.map(receivable => {
    const ineligibleReasons: string[] = [];
    const manuallyExcluded = Boolean((receivable as { manuallyExcluded?: boolean }).manuallyExcluded);

    if (manuallyExcluded) {
      ineligibleReasons.push("Manually excluded");
    } else {
      if (receivable.daysPastDue > 45) ineligibleReasons.push("Over 45 days past due");
      if (!receivable.insured) ineligibleReasons.push("Insurance evidence exception");
      if (!receivable.titleClear) ineligibleReasons.push("Title or lien evidence exception");
      if (!receivable.lockboxMatched) ineligibleReasons.push("Lockbox cash mapping exception");
      if (receivable.utilizationPct < 70) ineligibleReasons.push("Utilization below policy floor");
    }

    return {
      ...receivable,
      eligible: ineligibleReasons.length === 0,
      ineligibleReasons,
    } satisfies ReceivableResult;
  });

  const eligibleReceivablesCents = receivableResults
    .filter(receivable => receivable.eligible)
    .reduce((sum, receivable) => sum + receivable.outstandingCents, 0);
  const concentrationLimitCents = Math.floor((eligibleReceivablesCents * portfolio.concentrationLimitPct) / 100);
  const eligibleExposureByObligor = receivableResults
    .filter(receivable => receivable.eligible)
    .reduce<Map<string, number>>((exposureByObligor, receivable) => {
      exposureByObligor.set(
        receivable.obligor,
        (exposureByObligor.get(receivable.obligor) ?? 0) + receivable.outstandingCents,
      );

      return exposureByObligor;
    }, new Map());
  const concentrationReserveCents = Array.from(eligibleExposureByObligor.values()).reduce(
    (reserveCents, exposureCents) => reserveCents + Math.max(0, exposureCents - concentrationLimitCents),
    0,
  );
  const advanceRateCents = Math.floor((eligibleReceivablesCents * portfolio.advanceRateBps) / 10_000);
  const availableBorrowingBaseCents = Math.max(0, advanceRateCents - concentrationReserveCents);
  const evidenceExceptions = portfolio.evidence.filter(evidence => evidence.status !== "verified");
  const receivableExceptionCount = receivableResults.filter(
    receivable => !receivable.eligible && !receivable.ineligibleReasons.includes("Manually excluded"),
  ).length;

  return {
    portfolio,
    grossReceivablesCents,
    eligibleReceivablesCents,
    concentrationReserveCents,
    advanceRateCents,
    availableBorrowingBaseCents,
    exceptionCount: receivableExceptionCount + evidenceExceptions.length,
    receivableResults,
    evidenceExceptions,
  };
}

export function buildPortfolioFromSubmission(submission: FacilitySubmission): FleetPortfolio {
  return {
    operator: submission.operatorName,
    facilityName: submission.facilityName,
    asOfDate: submission.asOfDate,
    advanceRateBps: 8200,
    concentrationLimitPct: 35,
    receivables: submission.receivables.map(receivable => ({
      id: receivable.id,
      obligor: receivable.obligor,
      vehicleCount: receivable.vehicleCount,
      outstandingCents: receivable.outstandingCents,
      daysPastDue: receivable.daysPastDue,
      utilizationPct: receivable.utilizationPct,
      insured: receivable.insured,
      titleClear: receivable.titleClear,
      lockboxMatched: receivable.lockboxMatched,
      manuallyExcluded: receivable.excluded,
    })),
    evidence: submission.evidence.map(evidence => ({
      id: evidence.id,
      label: evidence.label,
      source: evidence.source,
      status: evidence.status,
      walrusObjectId: evidence.walrusObjectId,
      sealPolicyId: evidence.sealPolicyId,
      digest: evidence.digest,
    })),
  };
}

function buildSubmissionExceptions(
  result: BorrowingBaseResult,
  evidence: SubmissionEvidence[],
): FacilitySubmission["exceptions"] {
  const receivableExceptions: FacilitySubmission["exceptions"] = result.receivableResults
    .filter(receivable => !receivable.eligible && !receivable.ineligibleReasons.includes("Manually excluded"))
    .map(receivable => ({
      id: `exception_${receivable.id}`,
      kind: "receivable" as const,
      itemId: receivable.id,
      severity: receivable.ineligibleReasons.some(reason => reason.includes("Over 45"))
        ? ("high" as const)
        : ("medium" as const),
      title: `${receivable.id} requires action`,
      message: receivable.ineligibleReasons.join("; "),
      nextAction: receivable.ineligibleReasons.includes("Manually excluded")
        ? "Reinstate or leave excluded before recomputing."
        : "Exclude the receivable or correct the upstream data before recomputing.",
      actionStatus: receivable.ineligibleReasons.includes("Manually excluded")
        ? ("excluded" as const)
        : ("open" as const),
    }));

  const evidenceExceptions: FacilitySubmission["exceptions"] = evidence
    .filter(record => record.status !== "verified")
    .map(record => ({
      id: `exception_${record.id}`,
      kind: "evidence" as const,
      itemId: record.id,
      severity: record.status === "exception" ? ("high" as const) : ("medium" as const),
      title: `${record.label} needs evidence follow-up`,
      message: `${record.label} is currently ${record.status}.`,
      nextAction:
        record.status === "exception"
          ? "Upload corrected evidence or replace the current package before lender send."
          : "Upload the missing evidence package and recompute the submission.",
      actionStatus: "open" as const,
    }));

  return [...receivableExceptions, ...evidenceExceptions];
}

async function buildEvidenceCommitPreview(evidenceRoot: string) {
  const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(evidenceRoot));
  const rootDigest = Array.from(new Uint8Array(digestBytes), byte => byte.toString(16).padStart(2, "0")).join("");

  return {
    status: "ready" as const,
    evidenceRoot,
    rootDigest: `0x${rootDigest}`,
    modulePath: SUI_COMMIT_MODULE_PATH,
    commitMode:
      process.env.ROBOMATA_SUI_PACKAGE_ID &&
      process.env.ROBOMATA_SUI_FACILITY_ID &&
      process.env.ROBOMATA_SUI_CLIENT_CONFIG
        ? ("configured" as const)
        : ("prepared" as const),
  };
}

export async function computeSubmissionArtifacts(submission: FacilitySubmission): Promise<SubmissionComputation> {
  const portfolio = buildPortfolioFromSubmission(submission);
  const borrowingBase = calculateSubmissionBorrowingBase(portfolio);
  const evidenceAnchor = buildEvidenceAnchor(portfolio.facilityName, portfolio.evidence);
  const evidenceRail = buildEvidenceRail(evidenceAnchor);
  const agentReview = await reviewBorrowingBase(buildAgentReviewInput(borrowingBase));
  const lenderPacket = buildLenderPacket(borrowingBase, agentReview, evidenceAnchor);

  submission.exceptions = buildSubmissionExceptions(borrowingBase, submission.evidence);
  submission.evidenceCommit = await buildEvidenceCommitPreview(evidenceAnchor.evidenceRoot);

  return {
    computedAt: new Date().toISOString(),
    borrowingBase,
    agentReview,
    lenderPacket,
    evidenceAnchor,
    evidenceRail,
  };
}

export function buildSubmissionSummaryCards(computation: SubmissionComputation) {
  const { borrowingBase } = computation;
  return [
    { label: "Gross Receivables", value: formatUsd(borrowingBase.grossReceivablesCents) },
    { label: "Eligible Receivables", value: formatUsd(borrowingBase.eligibleReceivablesCents) },
    { label: "Available Borrowing Base", value: formatUsd(borrowingBase.availableBorrowingBaseCents) },
    { label: "Open Exceptions", value: borrowingBase.exceptionCount.toString() },
    { label: "Advance Rate", value: formatPercentFromBps(borrowingBase.portfolio.advanceRateBps) },
  ];
}
