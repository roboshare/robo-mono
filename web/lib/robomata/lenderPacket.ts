import type { AgentReview } from "~~/lib/robomata/agentProviders";
import type { BorrowingBaseResult } from "~~/lib/robomata/borrowingBase";
import type { EvidenceAnchor } from "~~/lib/robomata/evidence";

export type LenderPacketSection = {
  title: string;
  count: number;
  items: string[];
};

export type LenderPacket = {
  certificateId: string;
  preparedFor: string;
  preparedOn: string;
  borrowerCoverageLine: string;
  certificationStatement: string;
  deliveryChecklist: string[];
  reviewBoundary?: Pick<
    AgentReview,
    | "generatedAt"
    | "inputDigest"
    | "model"
    | "outputDigest"
    | "outputSchemaVersion"
    | "policyArtifactId"
    | "policyArtifactVersion"
    | "promptVersion"
    | "provider"
    | "providerStatus"
    | "reviewInputId"
    | "reviewMode"
    | "sourceOfTruth"
  >;
  memoSummary: string;
  exceptionSections: LenderPacketSection[];
  borrowerRequests: string[];
};

function buildReceivableExceptionSection(result: BorrowingBaseResult): LenderPacketSection {
  const items = result.receivableResults
    .filter(receivable => !receivable.eligible)
    .map(receivable => `${receivable.id} ${receivable.obligor}: ${receivable.ineligibleReasons.join("; ")}`);

  return {
    title: "Receivable eligibility exceptions",
    count: items.length,
    items,
  };
}

function buildEvidenceExceptionSection(result: BorrowingBaseResult): LenderPacketSection {
  const items = result.evidenceExceptions.map(
    evidence => `${evidence.id} ${evidence.label}: ${evidence.status} evidence status from ${evidence.source}`,
  );

  return {
    title: "Evidence package exceptions",
    count: items.length,
    items,
  };
}

function getExceptionKey(item: string): string {
  return item.split(":", 1)[0] ?? item;
}

function buildAgentExceptionSection(agentReview: AgentReview, existingKeys: Set<string>): LenderPacketSection | null {
  const items = agentReview.exceptionReview.filter(item => !existingKeys.has(getExceptionKey(item)));

  if (items.length === 0) return null;

  return {
    title: "Agent review notes",
    count: items.length,
    items,
  };
}

export function buildLenderPacket(
  result: BorrowingBaseResult,
  agentReview: AgentReview,
  evidenceAnchor: EvidenceAnchor,
): LenderPacket {
  const eligibleVehicles = result.receivableResults
    .filter(receivable => receivable.eligible)
    .reduce((sum, receivable) => sum + receivable.vehicleCount, 0);
  const totalVehicles = result.receivableResults.reduce((sum, receivable) => sum + receivable.vehicleCount, 0);
  const verifiedCommitments = evidenceAnchor.commitments.filter(commitment => commitment.status === "verified").length;
  const receivableExceptions = buildReceivableExceptionSection(result);
  const evidenceExceptions = buildEvidenceExceptionSection(result);
  const existingExceptionKeys = new Set(
    [...receivableExceptions.items, ...evidenceExceptions.items].map(getExceptionKey),
  );
  const agentExceptions = buildAgentExceptionSection(agentReview, existingExceptionKeys);

  return {
    certificateId: `BBC-${result.portfolio.asOfDate.replace(/-/g, "")}-${result.portfolio.operator
      .replace(/[^A-Za-z0-9]+/g, "")
      .toUpperCase()}`,
    preparedFor: "Lender credit contact",
    preparedOn: result.portfolio.asOfDate,
    borrowerCoverageLine: `${eligibleVehicles} of ${totalVehicles} vehicles support currently eligible receivables under the demo policy.`,
    certificationStatement:
      "Prepared from operator-submitted receivables, servicing, and evidence references for lender diligence. Final advance remains subject to lender approval and exception cure.",
    deliveryChecklist: [
      `Verified evidence commitments: ${verifiedCommitments} of ${evidenceAnchor.commitments.length}`,
      `Evidence root ready for controlled sharing: ${evidenceAnchor.evidenceRoot.slice(0, 24)}...`,
      `Sui facility path prepared: ${evidenceAnchor.suiPackagePath}`,
    ],
    reviewBoundary: {
      generatedAt: agentReview.generatedAt,
      inputDigest: agentReview.inputDigest,
      model: agentReview.model,
      outputDigest: agentReview.outputDigest,
      outputSchemaVersion: agentReview.outputSchemaVersion,
      policyArtifactId: agentReview.policyArtifactId,
      policyArtifactVersion: agentReview.policyArtifactVersion,
      promptVersion: agentReview.promptVersion,
      provider: agentReview.provider,
      providerStatus: agentReview.providerStatus,
      reviewInputId: agentReview.reviewInputId,
      reviewMode: agentReview.reviewMode,
      sourceOfTruth: agentReview.sourceOfTruth,
    },
    memoSummary: agentReview.memo,
    exceptionSections: [receivableExceptions, evidenceExceptions, agentExceptions].filter(
      (section): section is LenderPacketSection => Boolean(section && section.count > 0),
    ),
    borrowerRequests: agentReview.nextActions,
  };
}
