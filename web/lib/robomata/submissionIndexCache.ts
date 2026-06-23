import type { FacilitySubmission } from "~~/lib/robomata/submissions";

const SUBMISSION_INDEX_CACHE_VERSION = 2;

export type CompactSubmissionIndexEntry = Pick<
  FacilitySubmission,
  | "asOfDate"
  | "createdAt"
  | "facilityMonitoring"
  | "facilityName"
  | "facilitySource"
  | "id"
  | "operatorName"
  | "partnerAddress"
  | "status"
  | "updatedAt"
> & {
  evidenceCommit: Pick<
    FacilitySubmission["evidenceCommit"],
    | "commitMode"
    | "facilityAssignmentErrorMessage"
    | "facilityAssignmentOperatorAddress"
    | "facilityAssignmentRootDigest"
    | "facilityAssignmentStartedAt"
    | "facilityObjectId"
    | "facilityOperatorAddress"
    | "modulePath"
    | "status"
  >;
  evidenceCount: number;
  hasComputation: boolean;
  receivableCount: number;
  tokenization: Pick<FacilitySubmission["tokenization"], "status">;
};

export type SubmissionIndexView = FacilitySubmission & {
  evidenceCount?: number;
  hasComputation?: boolean;
  receivableCount?: number;
};

type SubmissionIndexCachePayload = {
  cachedAt: number;
  submissions: CompactSubmissionIndexEntry[];
  version: number;
};

export function submissionIndexCacheKey(partnerAddress: string | undefined, chainId: number) {
  return partnerAddress ? `robomata-submissions:${chainId}:${partnerAddress.toLowerCase()}` : null;
}

function compactSubmissionIndexEntry(submission: SubmissionIndexView): CompactSubmissionIndexEntry {
  return {
    asOfDate: submission.asOfDate,
    createdAt: submission.createdAt,
    evidenceCommit: {
      commitMode: submission.evidenceCommit.commitMode,
      facilityAssignmentErrorMessage: submission.evidenceCommit.facilityAssignmentErrorMessage,
      facilityAssignmentOperatorAddress: submission.evidenceCommit.facilityAssignmentOperatorAddress,
      facilityAssignmentRootDigest: submission.evidenceCommit.facilityAssignmentRootDigest,
      facilityAssignmentStartedAt: submission.evidenceCommit.facilityAssignmentStartedAt,
      facilityObjectId: submission.evidenceCommit.facilityObjectId,
      facilityOperatorAddress: submission.evidenceCommit.facilityOperatorAddress,
      modulePath: submission.evidenceCommit.modulePath,
      status: submission.evidenceCommit.status,
    },
    evidenceCount: typeof submission.evidenceCount === "number" ? submission.evidenceCount : submission.evidence.length,
    facilityMonitoring: submission.facilityMonitoring,
    facilityName: submission.facilityName,
    facilitySource: submission.facilitySource,
    hasComputation:
      typeof submission.hasComputation === "boolean" ? submission.hasComputation : Boolean(submission.computation),
    id: submission.id,
    operatorName: submission.operatorName,
    partnerAddress: submission.partnerAddress,
    receivableCount:
      typeof submission.receivableCount === "number" ? submission.receivableCount : submission.receivables.length,
    status: submission.status,
    tokenization: { status: submission.tokenization.status },
    updatedAt: submission.updatedAt,
  };
}

function hydrateSubmissionIndexEntry(entry: CompactSubmissionIndexEntry): SubmissionIndexView {
  return {
    asOfDate: entry.asOfDate,
    auditEvents: [],
    computation: entry.hasComputation ? ({} as FacilitySubmission["computation"]) : null,
    createdAt: entry.createdAt,
    evidence: [],
    evidenceCommit: entry.evidenceCommit,
    evidenceCount: entry.evidenceCount,
    exceptions: [],
    facilityMonitoring: entry.facilityMonitoring,
    facilityName: entry.facilityName,
    facilitySource: entry.facilitySource,
    hasComputation: entry.hasComputation,
    id: entry.id,
    operatorName: entry.operatorName,
    partnerAddress: entry.partnerAddress,
    receivableCount: entry.receivableCount,
    receivables: [],
    status: entry.status,
    tokenization: {
      anchors: {},
      evm: {},
      status: entry.tokenization.status,
      terms: {},
    },
    updatedAt: entry.updatedAt,
  };
}

function readRawSubmissionIndexCache(cacheKey: string | null): SubmissionIndexCachePayload | null {
  if (!cacheKey || typeof window === "undefined") return null;

  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(cacheKey) ?? "") as SubmissionIndexCachePayload;
    if (parsed.version !== SUBMISSION_INDEX_CACHE_VERSION || !Array.isArray(parsed.submissions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readSubmissionIndexCache(cacheKey: string | null): SubmissionIndexView[] | null {
  const cached = readRawSubmissionIndexCache(cacheKey);
  if (!cached) return null;

  try {
    return cached.submissions.map(hydrateSubmissionIndexEntry);
  } catch (error) {
    console.warn("Unable to hydrate cached Robomata submission index", error);
    return null;
  }
}

export function writeSubmissionIndexCache(cacheKey: string | null, submissions: SubmissionIndexView[]) {
  if (!cacheKey || typeof window === "undefined") return;
  const payload: SubmissionIndexCachePayload = {
    cachedAt: Date.now(),
    submissions: submissions.map(compactSubmissionIndexEntry),
    version: SUBMISSION_INDEX_CACHE_VERSION,
  };
  try {
    window.sessionStorage.setItem(cacheKey, JSON.stringify(payload));
  } catch (error) {
    console.warn("Unable to cache Robomata submission index", error);
  }
}

export function evictSubmissionFromSubmissionIndexCache(cacheKey: string | null, submissionId: string) {
  if (!cacheKey || typeof window === "undefined") return;

  const cached = readRawSubmissionIndexCache(cacheKey);
  if (!cached) return;

  const nextSubmissions = cached.submissions.filter(submission => submission.id !== submissionId);
  try {
    window.sessionStorage.setItem(
      cacheKey,
      JSON.stringify({
        cachedAt: Date.now(),
        submissions: nextSubmissions,
        version: SUBMISSION_INDEX_CACHE_VERSION,
      } satisfies SubmissionIndexCachePayload),
    );
  } catch (error) {
    console.warn("Unable to evict deleted Robomata submission from cache", error);
  }
}
