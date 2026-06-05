import type { AgentReview } from "~~/lib/robomata/agentProviders";
import type { BorrowingBaseResult } from "~~/lib/robomata/borrowingBase";
import type { EvidenceAnchor, EvidenceCommitment, EvidenceRail } from "~~/lib/robomata/evidence";
import type { LenderPacket } from "~~/lib/robomata/lenderPacket";

export type FacilitySubmissionStatus =
  | "draft"
  | "needs_evidence"
  | "ready_to_compute"
  | "needs_review"
  | "ready_for_lender"
  | "committed";

export type SubmissionStorageBackend = "walrus" | "walrus-mock";

export type SubmissionExceptionKind = "receivable" | "evidence" | "submission";
export type SubmissionExceptionSeverity = "high" | "medium" | "low";
export type SubmissionExceptionActionStatus = "open" | "excluded" | "replaced" | "resolved";

export type SubmissionReceivable = {
  id: string;
  obligor: string;
  vehicleCount: number;
  outstandingCents: number;
  daysPastDue: number;
  utilizationPct: number;
  insured: boolean;
  titleClear: boolean;
  lockboxMatched: boolean;
  excluded: boolean;
  sourceRow: number;
};

export type SubmissionEvidence = EvidenceCommitment & {
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  scope: string;
  linkedReceivableIds: string[];
  storageBackend: SubmissionStorageBackend;
  walrusBlobId: string;
  walrusEventId?: string;
  aggregatorUrl?: string;
};

export type SubmissionException = {
  id: string;
  kind: SubmissionExceptionKind;
  itemId: string;
  severity: SubmissionExceptionSeverity;
  title: string;
  message: string;
  nextAction: string;
  actionStatus: SubmissionExceptionActionStatus;
};

export type SubmissionAuditEvent = {
  id: string;
  type:
    | "submission_created"
    | "submission_updated"
    | "receivables_imported"
    | "evidence_uploaded"
    | "borrowing_base_computed"
    | "receivable_excluded"
    | "receivable_updated"
    | "evidence_updated"
    | "sui_commit_prepared"
    | "sui_commit_completed";
  createdAt: string;
  message: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export type SubmissionEvidenceCommit = {
  status: "not_started" | "ready" | "committed" | "failed";
  evidenceRoot?: string;
  rootDigest?: string;
  txDigest?: string;
  committedAt?: string;
  facilityObjectId?: string;
  facilityOperatorAddress?: string;
  modulePath: string;
  commitMode: "prepared" | "configured";
  errorMessage?: string;
};

export type SubmissionComputation = {
  computedAt: string;
  borrowingBase: BorrowingBaseResult;
  agentReview: AgentReview;
  lenderPacket: LenderPacket;
  evidenceAnchor: EvidenceAnchor;
  evidenceRail: EvidenceRail;
};

export type FacilitySubmission = {
  id: string;
  partnerAddress: string;
  operatorName: string;
  facilityName: string;
  asOfDate: string;
  status: FacilitySubmissionStatus;
  receivables: SubmissionReceivable[];
  evidence: SubmissionEvidence[];
  exceptions: SubmissionException[];
  computation: SubmissionComputation | null;
  evidenceCommit: SubmissionEvidenceCommit;
  auditEvents: SubmissionAuditEvent[];
  createdAt: string;
  updatedAt: string;
};

export type CreateSubmissionInput = {
  partnerAddress: string;
  operatorName: string;
  facilityName: string;
  asOfDate: string;
};

export const SUI_COMMIT_MODULE_PATH = "protocols/sui::robomata_overflow::facility::commit_evidence";

export function nowIsoString(): string {
  return new Date().toISOString();
}

export function createSubmissionId(): string {
  return `sub_${crypto.randomUUID()}`;
}

export function createAuditEvent(
  type: SubmissionAuditEvent["type"],
  message: string,
  metadata?: SubmissionAuditEvent["metadata"],
): SubmissionAuditEvent {
  return {
    id: `audit_${crypto.randomUUID()}`,
    type,
    createdAt: nowIsoString(),
    message,
    metadata,
  };
}

function parseStringMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => typeof value === "string" && value.trim())
        .map(([key, value]) => [key, (value as string).trim()]),
    );
  } catch {
    return {};
  }
}

function parseSuiFacilityObjectIdMap(): Record<string, string> {
  return parseStringMap(process.env.ROBOMATA_SUI_FACILITY_IDS_JSON);
}

function parseSuiFacilityOperatorMap(): Record<string, string> {
  return parseStringMap(process.env.ROBOMATA_SUI_FACILITY_OPERATORS_JSON);
}

export function resolveSubmissionFacilityObjectId(
  submission: Pick<FacilitySubmission, "id" | "facilityName" | "evidenceCommit">,
): string | undefined {
  const facilityIds = parseSuiFacilityObjectIdMap();
  const configured = facilityIds[submission.id] ?? facilityIds[submission.facilityName];
  if (configured) return configured;

  const existing = submission.evidenceCommit.facilityObjectId?.trim();
  if (existing) return existing;
}

export function resolveSubmissionFacilityOperatorAddress(
  submission: Pick<FacilitySubmission, "id" | "facilityName" | "evidenceCommit">,
): string | undefined {
  const operators = parseSuiFacilityOperatorMap();
  const configured = operators[submission.id] ?? operators[submission.facilityName];
  if (configured) return configured;

  const existing = submission.evidenceCommit.facilityOperatorAddress?.trim();
  if (existing) return existing;
}

export function deriveSubmissionStatus(submission: FacilitySubmission): FacilitySubmissionStatus {
  if (submission.evidenceCommit.status === "committed") return "committed";
  if (submission.computation) {
    return submission.computation.borrowingBase.exceptionCount > 0 ? "needs_review" : "ready_for_lender";
  }
  if (submission.receivables.length > 0 && submission.evidence.length > 0) return "ready_to_compute";
  if (submission.receivables.length > 0) return "needs_evidence";
  return "draft";
}

export function createSubmissionShell(input: CreateSubmissionInput): FacilitySubmission {
  const createdAt = nowIsoString();
  const shell: FacilitySubmission = {
    id: createSubmissionId(),
    partnerAddress: input.partnerAddress,
    operatorName: input.operatorName,
    facilityName: input.facilityName,
    asOfDate: input.asOfDate,
    status: "draft",
    receivables: [],
    evidence: [],
    exceptions: [],
    computation: null,
    evidenceCommit: {
      status: "not_started",
      modulePath: SUI_COMMIT_MODULE_PATH,
      commitMode: "prepared",
    },
    auditEvents: [],
    createdAt,
    updatedAt: createdAt,
  };

  shell.auditEvents.push(
    createAuditEvent("submission_created", `Created submission shell for ${shell.facilityName}.`, {
      partnerAddress: shell.partnerAddress,
    }),
  );
  shell.status = deriveSubmissionStatus(shell);
  return shell;
}

export function touchSubmission(submission: FacilitySubmission): FacilitySubmission {
  submission.status = deriveSubmissionStatus(submission);
  submission.updatedAt = nowIsoString();
  return submission;
}

export function invalidateSubmissionArtifacts(submission: FacilitySubmission): FacilitySubmission {
  const facilityObjectId = resolveSubmissionFacilityObjectId(submission);
  const facilityOperatorAddress = resolveSubmissionFacilityOperatorAddress(submission);
  submission.computation = null;
  submission.exceptions = [];
  submission.evidenceCommit = {
    status: "not_started",
    modulePath: SUI_COMMIT_MODULE_PATH,
    commitMode: "prepared",
    facilityObjectId,
    facilityOperatorAddress,
  };
  return touchSubmission(submission);
}

export function addAuditEvent(
  submission: FacilitySubmission,
  type: SubmissionAuditEvent["type"],
  message: string,
  metadata?: SubmissionAuditEvent["metadata"],
): FacilitySubmission {
  submission.auditEvents.unshift(createAuditEvent(type, message, metadata));
  return touchSubmission(submission);
}
