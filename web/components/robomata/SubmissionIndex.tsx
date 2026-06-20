"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRightIcon,
  CircleStackIcon,
  ClipboardDocumentCheckIcon,
  CloudArrowUpIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import { PartnerAccessGate } from "~~/components/partner/PartnerAccessGate";
import { useSelectedNetwork } from "~~/hooks/scaffold-eth";
import { useRobomataApiAuth } from "~~/hooks/useRobomataApiAuth";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import type { FacilitySubmission, FacilitySubmissionSource } from "~~/lib/robomata/submissions";
import {
  facilitySourceLabel,
  submissionNextAction,
  tokenizationStatusLabel,
} from "~~/lib/robomata/workspaceNavigation";
import { notification } from "~~/utils/scaffold-eth";

type ApiPayload<T> = T & { diagnostics?: unknown; error?: string };

const LIVE_FACILITY_SOURCE: FacilitySubmissionSource = "external_asset_pool";

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

const AuthorizedSubmissionIndex = () => {
  const router = useRouter();
  const { address: accountAddress, chainId: accountChainId, connectedAddress } = useTransactingAccount();
  const selectedNetwork = useSelectedNetwork(accountChainId);
  const partnerAuthAddress = accountAddress;
  const signerAddress = connectedAddress ?? accountAddress;
  const getAuthHeaders = useRobomataApiAuth(partnerAuthAddress);
  const [submissions, setSubmissions] = useState<FacilitySubmission[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [form, setForm] = useState({
    asOfDate: new Date().toISOString().slice(0, 10),
    facilityName: "",
    facilitySource: LIVE_FACILITY_SOURCE,
    operatorName: "",
  });

  useEffect(() => {
    if (!partnerAuthAddress) return;

    const load = async () => {
      const path = "/api/robomata/submissions";
      setIsLoading(true);
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
        setSubmissions(payload.submissions ?? []);
      } catch (error) {
        notification.error(error instanceof Error ? error.message : "Failed to load submissions.");
      } finally {
        setIsLoading(false);
      }
    };

    void load();
  }, [getAuthHeaders, partnerAuthAddress, selectedNetwork.id, signerAddress]);

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

  const createSubmission = async () => {
    if (!partnerAuthAddress || !form.operatorName.trim() || !form.facilityName.trim() || !form.asOfDate) {
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
          operatorName: form.operatorName.trim(),
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

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
      <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30 sm:p-8">
        <div className="grid gap-7 xl:grid-cols-[1.05fr_0.95fr]">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Robomata</p>
            <h1 className="mt-3 text-4xl font-black tracking-tight text-base-content sm:text-5xl">
              Capital readiness workspace
            </h1>
            <p className="mt-4 text-lg leading-relaxed text-base-content/70">
              Prepare asset-pool evidence, borrowing-base runs, exception trails, and lender packets before the facility
              moves to Robolend review or downstream tokenization.
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {packageStats.map(item => (
                <div key={item.label} className="rounded-2xl border border-base-300 bg-base-200/60 p-4">
                  <div className="text-3xl font-black text-base-content">{item.value}</div>
                  <div className="mt-1 text-xs font-semibold uppercase tracking-[0.18em] text-base-content/50">
                    {item.label}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[1.5rem] border border-base-300 bg-base-200/60 p-5">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-base-content/50">
              <PlusIcon className="h-4 w-4" />
              New facility package
            </div>
            <div className="mt-4 grid gap-3">
              <div className="flex gap-3 rounded-2xl border border-primary bg-primary/10 p-3">
                <CloudArrowUpIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-base-content">External asset pool</span>
                  <span className="block text-xs leading-relaxed text-base-content/60">
                    Operator-submitted evidence from an outside operating system.
                  </span>
                </span>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="form-control">
                  <span className="label-text">Operator name</span>
                  <input
                    className="input input-bordered"
                    value={form.operatorName}
                    onChange={event => setForm(current => ({ ...current, operatorName: event.target.value }))}
                    placeholder="MetroFleet Logistics"
                  />
                </label>
                <label className="form-control">
                  <span className="label-text">As-of date</span>
                  <input
                    type="date"
                    className="input input-bordered"
                    value={form.asOfDate}
                    onChange={event => setForm(current => ({ ...current, asOfDate: event.target.value }))}
                  />
                </label>
                <label className="form-control md:col-span-2">
                  <span className="label-text">Facility or asset pool name</span>
                  <input
                    className="input input-bordered"
                    value={form.facilityName}
                    onChange={event => setForm(current => ({ ...current, facilityName: event.target.value }))}
                    placeholder="MetroFleet 2026 Fleet Receivables Facility"
                  />
                </label>
              </div>
            </div>
            <button className="btn btn-primary mt-5 rounded-full" onClick={createSubmission} disabled={isCreating}>
              {isCreating ? "Creating..." : "Create facility package"}
            </button>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30 sm:p-8">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
            <ClipboardDocumentCheckIcon className="h-4 w-4" />
            Action queue
          </div>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-base-content">Next best work</h2>
          {isLoading ? (
            <div className="py-16 text-center">
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
                  className="block rounded-2xl border border-base-300 bg-base-200/50 p-4 transition hover:border-primary/40 hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <span className={`badge ${actionToneClass(action.tone)}`}>{action.stage}</span>
                      <h3 className="mt-3 truncate text-lg font-bold text-base-content">{submission.facilityName}</h3>
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

        <div className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30 sm:p-8">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
            <CircleStackIcon className="h-4 w-4" />
            Facility packages
          </div>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-base-content">
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

                return (
                  <Link
                    key={submission.id}
                    href={`/robomata/submissions/${submission.id}`}
                    className="rounded-[1.5rem] border border-base-300 bg-base-200/50 p-5 transition hover:border-primary/40 hover:shadow-md"
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
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
                        <h3 className="mt-3 truncate text-xl font-bold text-base-content">{submission.facilityName}</h3>
                        <p className="mt-2 text-sm text-base-content/70">{submission.operatorName}</p>
                        <p className="mt-2 text-sm leading-relaxed text-base-content/60">{source.description}</p>
                      </div>
                      <div className="grid gap-2 text-sm text-base-content/70 lg:min-w-44 lg:text-right">
                        <div>As of {submission.asOfDate}</div>
                        <div>{submission.receivables.length} receivables</div>
                        <div>{submission.evidence.length} evidence packages</div>
                        <div>Updated {new Date(submission.updatedAt).toLocaleString()}</div>
                      </div>
                    </div>
                  </Link>
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
