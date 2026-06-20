"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useReadContract } from "wagmi";
import {
  ArrowPathIcon,
  ArrowRightIcon,
  BuildingStorefrontIcon,
  ChevronDownIcon,
  CircleStackIcon,
  ClipboardDocumentCheckIcon,
  CloudArrowUpIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { PartnerAccessGate } from "~~/components/partner/PartnerAccessGate";
import { useSelectedNetwork } from "~~/hooks/scaffold-eth";
import { useRobomataApiAuth } from "~~/hooks/useRobomataApiAuth";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import {
  type FacilitySubmission,
  type FacilitySubmissionSource,
  canDeleteDraftFacilitySubmission,
} from "~~/lib/robomata/submissions";
import {
  facilitySourceLabel,
  submissionNextAction,
  tokenizationStatusLabel,
} from "~~/lib/robomata/workspaceNavigation";
import { getDeployedContract } from "~~/utils/contracts";
import { notification } from "~~/utils/scaffold-eth";
import { getSubgraphQueryUrl } from "~~/utils/subgraph";

type ApiPayload<T> = T & { diagnostics?: unknown; error?: string };

const LIVE_FACILITY_SOURCE: FacilitySubmissionSource = "external_asset_pool";
const SUBMISSION_INDEX_CACHE_VERSION = 2;
const PARTNER_PROFILE_QUERY = `
  query PartnerProfile($id: ID!) {
    partner(id: $id) {
      name
      isAuthorized
    }
  }
`;

const sourceOptions: Array<{
  description: string;
  disabled?: boolean;
  icon: typeof BuildingStorefrontIcon;
  label: string;
  value: FacilitySubmissionSource;
}> = [
  {
    description: "Operator-submitted evidence from an outside operating system.",
    icon: CloudArrowUpIcon,
    label: "External asset pool",
    value: "external_asset_pool",
  },
  {
    description: "A refreshable servicer, accounting, or source-system feed.",
    disabled: true,
    icon: ArrowPathIcon,
    label: "Connected external system",
    value: "connected_external_system",
  },
  {
    description: "First-party rental operations and servicing data.",
    disabled: true,
    icon: BuildingStorefrontIcon,
    label: "Rental platform facility",
    value: "rental_platform",
  },
];

type SubmissionIndexCachePayload = {
  cachedAt: number;
  submissions: CompactSubmissionIndexEntry[];
  version: number;
};

type CompactSubmissionIndexEntry = Pick<
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

type SubmissionIndexView = FacilitySubmission & {
  evidenceCount?: number;
  hasComputation?: boolean;
  receivableCount?: number;
};

function actionToneClass(tone: ReturnType<typeof submissionNextAction>["tone"]) {
  if (tone === "success") return "badge-success";
  if (tone === "warning") return "badge-warning";
  if (tone === "info") return "badge-info";
  return "badge-ghost";
}

function logResponseDiagnostics(payload: { diagnostics?: unknown }) {
  if (payload.diagnostics) {
    console.warn("Robomata API diagnostics", payload.diagnostics);
  }
}

function abbreviatedAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function submissionIndexCacheKey(partnerAddress: string | undefined, chainId: number) {
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

function submissionReceivableCount(submission: SubmissionIndexView) {
  return typeof submission.receivableCount === "number" ? submission.receivableCount : submission.receivables.length;
}

function submissionEvidenceCount(submission: SubmissionIndexView) {
  return typeof submission.evidenceCount === "number" ? submission.evidenceCount : submission.evidence.length;
}

function canDeleteDraftFromIndex(submission: SubmissionIndexView) {
  return (
    submissionReceivableCount(submission) === 0 &&
    submissionEvidenceCount(submission) === 0 &&
    submission.hasComputation !== true &&
    canDeleteDraftFacilitySubmission(submission)
  );
}

function readSubmissionIndexCache(cacheKey: string | null): SubmissionIndexView[] | null {
  if (!cacheKey || typeof window === "undefined") return null;

  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(cacheKey) ?? "") as SubmissionIndexCachePayload;
    if (parsed.version !== SUBMISSION_INDEX_CACHE_VERSION || !Array.isArray(parsed.submissions)) return null;
    return parsed.submissions.map(hydrateSubmissionIndexEntry);
  } catch {
    return null;
  }
}

function writeSubmissionIndexCache(cacheKey: string | null, submissions: SubmissionIndexView[]) {
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

async function readJsonResponse<T>(response: Response): Promise<ApiPayload<T>> {
  const text = await response.text();
  if (!text.trim()) return {} as ApiPayload<T>;

  try {
    return JSON.parse(text) as ApiPayload<T>;
  } catch {
    return {
      error: `Unexpected ${response.status} response from ${new URL(response.url).pathname}.`,
    } as ApiPayload<T>;
  }
}

function useSubgraphPartnerName(accountAddress: string | undefined, chainId: number | undefined) {
  const subgraphUrl = useMemo(() => getSubgraphQueryUrl(chainId), [chainId]);
  const [partnerName, setPartnerName] = useState<string | null>(null);

  useEffect(() => {
    if (!accountAddress || !subgraphUrl) {
      setPartnerName(null);
      return;
    }

    let cancelled = false;
    setPartnerName(null);

    fetch(subgraphUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: PARTNER_PROFILE_QUERY,
        variables: { id: accountAddress.toLowerCase() },
      }),
    })
      .then(async response => {
        const payload = (await response.json()) as {
          data?: { partner?: { isAuthorized?: boolean; name?: string | null } | null };
          errors?: Array<{ message?: string }>;
        };
        if (!response.ok || payload.errors?.length) {
          throw new Error(payload.errors?.[0]?.message ?? "Failed to read partner profile from subgraph.");
        }
        if (!cancelled) {
          const partner = payload.data?.partner;
          setPartnerName(partner?.isAuthorized === true && partner.name?.trim() ? partner.name.trim() : null);
        }
      })
      .catch(() => {
        if (!cancelled) setPartnerName(null);
      });

    return () => {
      cancelled = true;
    };
  }, [accountAddress, subgraphUrl]);

  return partnerName;
}

const AuthorizedSubmissionIndex = () => {
  const router = useRouter();
  const { address: accountAddress, chainId: accountChainId, connectedAddress } = useTransactingAccount();
  const selectedNetwork = useSelectedNetwork(accountChainId);
  const partnerAuthAddress = accountAddress;
  const signerAddress = connectedAddress ?? accountAddress;
  const getAuthHeaders = useRobomataApiAuth(partnerAuthAddress);
  const partnerManagerContract = getDeployedContract(selectedNetwork.id, "PartnerManager");
  const subgraphPartnerName = useSubgraphPartnerName(partnerAuthAddress, selectedNetwork.id);
  const { data: onchainPartnerName, isFetching: isFetchingOnchainPartnerName } = useReadContract({
    address: partnerManagerContract?.address,
    abi: partnerManagerContract?.abi,
    functionName: "getPartnerName",
    args: partnerAuthAddress ? [partnerAuthAddress] : undefined,
    query: { enabled: !!partnerAuthAddress && !!partnerManagerContract },
  });
  const [submissions, setSubmissions] = useState<SubmissionIndexView[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [deletingSubmissionId, setDeletingSubmissionId] = useState<string | null>(null);
  const [form, setForm] = useState<{
    asOfDate: string;
    facilityName: string;
    facilitySource: FacilitySubmissionSource;
  }>({
    asOfDate: new Date().toISOString().slice(0, 10),
    facilityName: "",
    facilitySource: LIVE_FACILITY_SOURCE,
  });
  const submissionCacheKey = useMemo(
    () => submissionIndexCacheKey(partnerAuthAddress, selectedNetwork.id),
    [partnerAuthAddress, selectedNetwork.id],
  );
  const partnerName =
    subgraphPartnerName ??
    (!isFetchingOnchainPartnerName && typeof onchainPartnerName === "string" && onchainPartnerName.trim()
      ? onchainPartnerName.trim()
      : null);
  const operatorName = partnerName ?? partnerAuthAddress ?? "";
  const operatorDisplayName =
    partnerName ?? (partnerAuthAddress ? abbreviatedAddress(partnerAuthAddress) : "Connect wallet");

  useEffect(() => {
    if (!partnerAuthAddress) return;

    const load = async () => {
      const path = "/api/robomata/submissions";
      const cachedSubmissions = readSubmissionIndexCache(submissionCacheKey);
      if (cachedSubmissions) {
        setSubmissions(cachedSubmissions);
        setIsLoading(false);
      } else {
        setIsLoading(true);
      }
      try {
        const response = await fetch(path, {
          headers: await getAuthHeaders({ chainId: selectedNetwork.id, method: "GET", path, signerAddress }),
        });
        const payload = await readJsonResponse<{ submissions?: FacilitySubmission[] }>(response);
        if (!response.ok) {
          logResponseDiagnostics(payload);
          notification.error(payload.error ?? `Failed to load submissions (${response.status}).`);
          return;
        }
        const nextSubmissions = payload.submissions ?? [];
        setSubmissions(nextSubmissions);
        writeSubmissionIndexCache(submissionCacheKey, nextSubmissions);
      } catch (error) {
        notification.error(error instanceof Error ? error.message : "Failed to load submissions.");
      } finally {
        setIsLoading(false);
      }
    };

    void load();
  }, [getAuthHeaders, partnerAuthAddress, selectedNetwork.id, signerAddress, submissionCacheKey]);

  const packageStats = useMemo(() => {
    const readyForLender = submissions.filter(
      submission => submission.evidenceCommit.status === "committed" || submission.status === "ready_for_lender",
    ).length;
    const needsWork = submissions.filter(submission =>
      ["draft", "needs_evidence", "ready_to_compute", "needs_review"].includes(submission.status),
    ).length;
    const underReview = submissions.filter(submission =>
      ["draft", "ready_to_sign", "registered", "failed"].includes(submission.tokenization.status),
    ).length;
    const offeringLive = submissions.filter(submission => submission.tokenization.status === "offering_created").length;

    return [
      { label: "Needs work", value: needsWork },
      { label: "Ready for lender", value: readyForLender },
      { label: "Lender review", value: underReview },
      { label: "Offering live", value: offeringLive },
    ];
  }, [submissions]);

  const actionQueue = useMemo(
    () =>
      submissions
        .map(submission => ({ action: submissionNextAction(submission), submission }))
        .filter(item => item.submission.tokenization.status !== "offering_created")
        .slice(0, 4),
    [submissions],
  );
  const hasDraftPackage = useMemo(() => submissions.some(submission => submission.status === "draft"), [submissions]);

  const createSubmission = async () => {
    if (!partnerAuthAddress || !operatorName.trim() || !form.facilityName.trim() || !form.asOfDate) {
      notification.error("Complete the facility package details first.");
      return;
    }

    setIsCreating(true);
    try {
      const path = "/api/robomata/submissions";
      const response = await fetch(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await getAuthHeaders({ chainId: selectedNetwork.id, method: "POST", path, signerAddress })),
        },
        body: JSON.stringify({
          asOfDate: form.asOfDate,
          facilityName: form.facilityName.trim(),
          facilitySource: form.facilitySource,
          operatorName: operatorName.trim(),
        }),
      });
      const payload = await readJsonResponse<{ submission?: FacilitySubmission }>(response);

      if (!response.ok || !payload.submission) {
        logResponseDiagnostics(payload);
        notification.error(payload.error ?? `Failed to create facility package (${response.status}).`);
        return;
      }

      router.push(`/robomata/submissions/${payload.submission.id}`);
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Failed to create facility package.");
    } finally {
      setIsCreating(false);
    }
  };

  const deleteDraftSubmission = useCallback(
    async (submission: FacilitySubmission) => {
      if (!partnerAuthAddress || !signerAddress) return;
      if (!canDeleteDraftFromIndex(submission)) return;
      if (!window.confirm(`Delete draft facility package "${submission.facilityName}"?`)) return;

      setDeletingSubmissionId(submission.id);
      try {
        const path = `/api/robomata/submissions/${submission.id}`;
        const response = await fetch(path, {
          method: "DELETE",
          headers: await getAuthHeaders({ chainId: selectedNetwork.id, method: "DELETE", path, signerAddress }),
        });
        const payload = await readJsonResponse<Record<string, never>>(response);
        if (!response.ok) {
          logResponseDiagnostics(payload);
          notification.error(payload.error ?? `Failed to delete draft package (${response.status}).`);
          return;
        }

        setSubmissions(current => {
          const nextSubmissions = current.filter(candidate => candidate.id !== submission.id);
          writeSubmissionIndexCache(submissionCacheKey, nextSubmissions);
          return nextSubmissions;
        });
        notification.success("Draft facility package deleted.");
      } catch (error) {
        notification.error(error instanceof Error ? error.message : "Failed to delete draft package.");
      } finally {
        setDeletingSubmissionId(null);
      }
    },
    [getAuthHeaders, partnerAuthAddress, selectedNetwork.id, signerAddress, submissionCacheKey],
  );

  const selectedSource = sourceOptions.find(option => option.value === form.facilitySource) ?? sourceOptions[0];
  const SelectedSourceIcon = selectedSource.icon;

  const renderNewFacilityPackagePanel = (variant: "workspace" | "rail" = "workspace") => {
    const isRailVariant = variant === "rail";

    return (
      <div className="min-w-0 rounded-[1.25rem] border border-base-300 bg-base-200/60 p-4 sm:rounded-[1.5rem] sm:p-6">
        <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-base-content/50">
          <PlusIcon className="h-4 w-4" />
          New facility package
        </div>
        <div className={`mt-4 grid gap-4 ${isRailVariant ? "" : "xl:grid-cols-[0.85fr_1.15fr] xl:items-start"}`}>
          <details className="dropdown w-full">
            <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 rounded-2xl border border-primary bg-primary/10 p-3 transition hover:border-primary">
              <span className="flex min-w-0 gap-3">
                <SelectedSourceIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-base-content">{selectedSource.label}</span>
                  <span className="block text-xs leading-relaxed text-base-content/60">
                    {selectedSource.description}
                  </span>
                </span>
              </span>
              <ChevronDownIcon className="h-4 w-4 shrink-0 text-base-content/50" />
            </summary>
            <ul className="dropdown-content z-10 mt-2 w-full rounded-2xl border border-base-300 bg-base-100 p-2 shadow-xl">
              {sourceOptions.map(option => {
                const Icon = option.icon;
                const isSelected = option.value === form.facilitySource;

                return (
                  <li key={option.value}>
                    <button
                      type="button"
                      disabled={option.disabled}
                      className={`flex w-full items-start gap-3 rounded-xl p-3 text-left transition ${
                        isSelected ? "bg-primary/10" : "hover:bg-base-200"
                      } disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent`}
                      onClick={() => {
                        if (!option.disabled) setForm(current => ({ ...current, facilitySource: option.value }));
                      }}
                    >
                      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-base-content">
                          {option.label}
                          {option.disabled ? <span className="badge badge-warning badge-sm">Soon</span> : null}
                        </span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-base-content/60">
                          {option.description}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </details>
          <div
            className={`grid min-w-0 gap-3 ${
              isRailVariant
                ? "sm:grid-cols-2"
                : "md:grid-cols-[minmax(0,0.85fr)_minmax(12rem,0.55fr)_auto] md:items-end"
            }`}
          >
            <div className="min-w-0 rounded-2xl border border-base-300 bg-base-100 px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-base-content/50">Operator</div>
              <div className="mt-1 truncate text-sm font-semibold text-base-content">{operatorDisplayName}</div>
            </div>
            <label className="form-control min-w-0">
              <span className="label-text">As-of date</span>
              <input
                type="date"
                className="input input-bordered w-full min-w-0"
                value={form.asOfDate}
                onChange={event => setForm(current => ({ ...current, asOfDate: event.target.value }))}
              />
            </label>
            <button
              className={`btn btn-primary w-full rounded-full ${isRailVariant ? "sm:col-span-2" : "md:w-auto md:self-end"}`}
              onClick={createSubmission}
              disabled={isCreating}
            >
              {isCreating ? "Creating..." : "Create facility package"}
            </button>
            <label className={`form-control min-w-0 ${isRailVariant ? "sm:col-span-2" : "md:col-span-3"}`}>
              <span className="label-text">Facility or asset pool name</span>
              <input
                className="input input-bordered w-full min-w-0"
                value={form.facilityName}
                onChange={event => setForm(current => ({ ...current, facilityName: event.target.value }))}
                placeholder="MetroFleet 2026 Fleet Receivables Facility"
              />
            </label>
          </div>
        </div>
      </div>
    );
  };

  const actionQueuePanel = (
    <div className="min-w-0 rounded-[1.5rem] border border-base-300 bg-base-100 p-4 shadow-lg shadow-base-300/30 sm:rounded-[2rem] sm:p-6">
      <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
        <ClipboardDocumentCheckIcon className="h-4 w-4" />
        Action queue
      </div>
      <h2 className="mt-2 text-xl font-black tracking-tight text-base-content sm:text-2xl">Next best work</h2>
      {isLoading ? (
        <div className="py-10 text-center sm:py-16">
          <span className="loading loading-spinner loading-lg text-primary"></span>
        </div>
      ) : actionQueue.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-base-300 bg-base-200/40 p-6 text-sm text-base-content/70">
          No active package actions. Create a new facility package or review completed offerings below.
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {actionQueue.map(({ action, submission }) => (
            <Link
              key={submission.id}
              href={action.href}
              className="block min-w-0 overflow-hidden rounded-2xl border border-base-300 bg-base-200/50 p-4 transition hover:border-primary/40 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className={`badge ${actionToneClass(action.tone)}`}>{action.stage}</span>
                  <h3 className="mt-3 break-words text-lg font-bold text-base-content">{submission.facilityName}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-base-content/70">{action.description}</p>
                </div>
                <ArrowRightIcon className="mt-1 h-5 w-5 shrink-0 text-primary" />
              </div>
              <div className="mt-3 text-sm font-semibold text-primary">{action.label}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 overflow-x-hidden px-3 py-5 sm:gap-6 sm:px-6 sm:py-10">
      <section className="min-w-0 rounded-[1.5rem] border border-base-300 bg-base-100 p-4 shadow-lg shadow-base-300/30 sm:rounded-[2rem] sm:p-8">
        <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[1.05fr_0.95fr] xl:gap-7">
          <div className="min-w-0 max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Robomata</p>
            <h1 className="mt-3 break-words text-3xl font-black tracking-tight text-base-content sm:text-5xl">
              Capital readiness workspace
            </h1>
            <p className="mt-4 text-base leading-relaxed text-base-content/70 sm:text-lg">
              Prepare asset-pool evidence, borrowing-base runs, exception trails, and lender packets before the facility
              moves to Robolend review or downstream tokenization.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
              {packageStats.map(item => (
                <div key={item.label} className="min-w-0 rounded-2xl border border-base-300 bg-base-200/60 p-3 sm:p-4">
                  <div className="text-2xl font-black text-base-content sm:text-3xl">{item.value}</div>
                  <div className="mt-1 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-base-content/50 sm:text-xs sm:tracking-[0.18em]">
                    {item.label}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {hasDraftPackage ? actionQueuePanel : renderNewFacilityPackagePanel("rail")}
        </div>
      </section>

      <section className="grid min-w-0 gap-5 sm:gap-6">
        <div className="min-w-0">{hasDraftPackage ? renderNewFacilityPackagePanel() : actionQueuePanel}</div>

        <div className="min-w-0 rounded-[1.5rem] border border-base-300 bg-base-100 p-4 shadow-lg shadow-base-300/30 sm:rounded-[2rem] sm:p-8">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
            <CircleStackIcon className="h-4 w-4" />
            Facility packages
          </div>
          <h2 className="mt-2 text-xl font-black tracking-tight text-base-content sm:text-2xl">
            Source systems and lender status
          </h2>

          {isLoading ? (
            <div className="py-16 text-center">
              <span className="loading loading-spinner loading-lg text-primary"></span>
            </div>
          ) : submissions.length === 0 ? (
            <div className="mt-8 rounded-[1.5rem] border border-dashed border-base-300 bg-base-200/40 p-8 text-center text-base-content/70">
              No facility packages yet. Create the first package above.
            </div>
          ) : (
            <div className="mt-6 grid gap-4">
              {submissions.map(submission => {
                const action = submissionNextAction(submission);
                const source = facilitySourceLabel(submission.facilitySource);
                const canDeleteDraft = canDeleteDraftFromIndex(submission);

                return (
                  <div
                    key={submission.id}
                    className="min-w-0 rounded-[1.5rem] border border-base-300 bg-base-200/50 p-4 transition hover:border-primary/40 hover:shadow-md sm:p-5"
                  >
                    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(14rem,18rem)] lg:items-start">
                      <Link href={`/robomata/submissions/${submission.id}`} className="min-w-0 flex-1">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="badge badge-outline">{source.label}</span>
                            <span className={`badge ${actionToneClass(action.tone)}`}>{action.stage}</span>
                            {submission.tokenization.status !== "not_started" ? (
                              <span className="badge badge-info">
                                {tokenizationStatusLabel(submission.tokenization.status)}
                              </span>
                            ) : null}
                          </div>
                          <h3 className="mt-3 break-words text-xl font-bold text-base-content">
                            {submission.facilityName}
                          </h3>
                          <p className="mt-2 text-sm text-base-content/70">{submission.operatorName}</p>
                          <p className="mt-2 text-sm leading-relaxed text-base-content/60">{source.description}</p>
                        </div>
                      </Link>
                      <div className="grid min-w-0 gap-2 rounded-2xl border border-base-300 bg-base-100/70 p-3 text-sm text-base-content/70 lg:text-right">
                        <div>As of {submission.asOfDate}</div>
                        <div>{submissionReceivableCount(submission)} receivables</div>
                        <div>{submissionEvidenceCount(submission)} evidence packages</div>
                        <div>Updated {new Date(submission.updatedAt).toLocaleString()}</div>
                        {canDeleteDraft ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs justify-self-start rounded-full text-error hover:bg-error/10 lg:justify-self-end"
                            disabled={deletingSubmissionId === submission.id}
                            onClick={() => void deleteDraftSubmission(submission)}
                          >
                            <TrashIcon className="h-4 w-4" />
                            {deletingSubmissionId === submission.id ? "Deleting..." : "Delete draft"}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

export const SubmissionIndex = () => {
  return (
    <PartnerAccessGate>
      <AuthorizedSubmissionIndex />
    </PartnerAccessGate>
  );
};
