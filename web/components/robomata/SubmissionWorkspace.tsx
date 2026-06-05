"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  CloudArrowUpIcon,
  DocumentArrowUpIcon,
  ExclamationTriangleIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";
import { useRobomataApiAuth } from "~~/hooks/useRobomataApiAuth";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import { formatUsd } from "~~/lib/robomata/borrowingBase";
import { buildSubmissionSummaryCards } from "~~/lib/robomata/submissionAdapters";
import type { FacilitySubmission, SubmissionReceivable } from "~~/lib/robomata/submissions";
import { notification } from "~~/utils/scaffold-eth";

type SubmissionWorkspaceProps = {
  submissionId?: string;
  readOnly?: boolean;
  loadLatest?: boolean;
};

function statusClass(status: FacilitySubmission["status"]) {
  if (status === "committed") return "badge-success";
  if (status === "ready_for_lender") return "badge-info";
  if (status === "needs_review") return "badge-warning";
  return "badge-ghost";
}

function sectionTitle(readOnly: boolean) {
  return readOnly ? "Lender-ready review surface" : "Operator submission workspace";
}

function centsToDollarInput(cents: number | undefined): string {
  return ((cents ?? 0) / 100).toFixed(2);
}

function dollarsToCents(value: string): number {
  return Math.round(Number(value) * 100);
}

export const SubmissionWorkspace = ({
  submissionId,
  readOnly = false,
  loadLatest = false,
}: SubmissionWorkspaceProps) => {
  const [submission, setSubmission] = useState<FacilitySubmission | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [editingReceivableId, setEditingReceivableId] = useState<string | null>(null);
  const [draftReceivable, setDraftReceivable] = useState<Partial<SubmissionReceivable>>({});
  const { address: accountAddress } = useTransactingAccount();
  const getAuthHeaders = useRobomataApiAuth(accountAddress);

  const summaryCards = useMemo(
    () => (submission?.computation ? buildSubmissionSummaryCards(submission.computation) : []),
    [submission],
  );

  const loadSubmission = useCallback(async () => {
    setIsLoading(true);
    try {
      if (!accountAddress) {
        setSubmission(null);
        setIsLoading(false);
        return;
      }

      const authHeaders = await getAuthHeaders();

      if (submissionId) {
        const response = await fetch(`/api/robomata/submissions/${submissionId}`, { headers: authHeaders });
        const payload = (await response.json()) as { submission?: FacilitySubmission; error?: string };
        if (!response.ok || !payload.submission) throw new Error(payload.error ?? "Failed to load submission.");
        setSubmission(payload.submission);
        setIsLoading(false);
        return;
      }

      if (loadLatest) {
        const response = await fetch("/api/robomata/submissions", { headers: authHeaders });
        const payload = (await response.json()) as { submissions?: FacilitySubmission[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Failed to load submissions.");
        setSubmission(payload.submissions?.[0] ?? null);
      }
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Failed to load submission.");
    } finally {
      setIsLoading(false);
    }
  }, [accountAddress, getAuthHeaders, loadLatest, submissionId]);

  useEffect(() => {
    void loadSubmission();
  }, [loadSubmission]);

  const updateSubmission = async (url: string, init?: RequestInit) => {
    if (!accountAddress) {
      notification.error("Connect a partner wallet before updating the submission.");
      return;
    }

    setIsBusy(true);
    const headers = new Headers(init?.headers);
    const authHeaders = await getAuthHeaders();
    Object.entries(authHeaders).forEach(([key, value]) => headers.set(key, value));
    const response = await fetch(url, { ...init, headers });
    const payload = (await response.json()) as { submission?: FacilitySubmission; error?: string };
    setIsBusy(false);

    if (!response.ok || !payload.submission) {
      notification.error(payload.error ?? "Submission update failed.");
      return;
    }

    setSubmission(payload.submission);
  };

  const importReceivables = async (file: File) => {
    if (!submission) return;
    const formData = new FormData();
    formData.set("file", file);
    await updateSubmission(`/api/robomata/submissions/${submission.id}/receivables/import`, {
      method: "POST",
      body: formData,
    });
  };

  const uploadEvidence = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!submission) return;

    const formData = new FormData(event.currentTarget);
    await updateSubmission(`/api/robomata/submissions/${submission.id}/evidence`, {
      method: "POST",
      body: formData,
    });
    event.currentTarget.reset();
  };

  const recompute = async () => {
    if (!submission) return;
    await updateSubmission(`/api/robomata/submissions/${submission.id}/compute`, { method: "POST" });
  };

  const commitEvidence = async () => {
    if (!submission) return;
    await updateSubmission(`/api/robomata/submissions/${submission.id}/commit-evidence`, { method: "POST" });
  };

  const patchSubmission = async (body: Record<string, unknown>) => {
    if (!submission) return;
    await updateSubmission(`/api/robomata/submissions/${submission.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  if (isLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <span className="loading loading-spinner loading-lg text-primary"></span>
      </div>
    );
  }

  if (!submission) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6">
        <div className="rounded-[2rem] border border-base-300 bg-base-100 p-8 text-center shadow-lg shadow-base-300/30">
          <h1 className="text-3xl font-black tracking-tight text-base-content">No submission available</h1>
          <p className="mt-4 text-base-content/70">
            {readOnly
              ? "Create a borrowing-base submission from the partner workflow first."
              : "Create a submission from the submissions index first."}
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <Link href="/partner/submissions" className="btn btn-primary rounded-full">
              Open partner submissions
            </Link>
            {!readOnly ? null : (
              <Link href="/partner" className="btn btn-outline rounded-full">
                Return to partner dashboard
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30 sm:p-8">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
              {sectionTitle(readOnly)}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <h1 className="text-4xl font-black tracking-tight text-base-content sm:text-5xl">
                {submission.facilityName}
              </h1>
              <span className={`badge ${statusClass(submission.status)} capitalize`}>
                {submission.status.replace(/_/g, " ")}
              </span>
            </div>
            <p className="mt-4 text-lg leading-relaxed text-base-content/70">
              {submission.operatorName} · as of {submission.asOfDate} · {submission.receivables.length} receivables ·{" "}
              {submission.evidence.length} evidence packages
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              {readOnly ? (
                <Link href={`/partner/submissions/${submission.id}`} className="btn btn-primary rounded-full">
                  Manage in partner workflow
                </Link>
              ) : (
                <>
                  <button className="btn btn-primary rounded-full" onClick={recompute} disabled={isBusy}>
                    <ArrowPathIcon className="h-4 w-4" />
                    Compute borrowing base
                  </button>
                  <Link href={`/robomata?submission=${submission.id}`} className="btn btn-outline rounded-full">
                    <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                    Open read-only Robomata view
                  </Link>
                </>
              )}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:w-[360px]">
            {summaryCards.length > 0 ? (
              summaryCards.map(card => (
                <div key={card.label} className="rounded-2xl border border-base-300 bg-base-200/60 p-4">
                  <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">{card.label}</div>
                  <div className="mt-2 text-2xl font-bold text-base-content">{card.value}</div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-base-300 bg-base-200/50 p-4 text-sm text-base-content/70 sm:col-span-2">
                Import receivables and evidence, then compute the borrowing base to generate lender output and evidence
                commit state.
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-6">
          {!readOnly ? (
            <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
              <div className="grid gap-6 lg:grid-cols-2">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-base-content/50">
                    <DocumentArrowUpIcon className="h-4 w-4" />
                    Receivables import
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-base-content/70">
                    Upload a lender-borrowing-base style CSV with receivable id, obligor, vehicles, amount, DPD,
                    utilization, insurance, title, and lockbox fields.
                  </p>
                  <label className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-[1.5rem] border border-dashed border-base-300 bg-base-200/40 p-6 text-center text-sm text-base-content/70">
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={event => {
                        const file = event.target.files?.[0];
                        if (file) void importReceivables(file);
                      }}
                    />
                    Click to upload receivables CSV
                  </label>
                </div>

                <form className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-5" onSubmit={uploadEvidence}>
                  <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-base-content/50">
                    <CloudArrowUpIcon className="h-4 w-4" />
                    Evidence upload
                  </div>
                  <div className="mt-4 grid gap-3">
                    <input name="file" type="file" className="file-input file-input-bordered w-full" required />
                    <input
                      name="label"
                      className="input input-bordered w-full"
                      placeholder="Insurance schedule"
                      required
                    />
                    <input
                      name="source"
                      className="input input-bordered w-full"
                      placeholder="Operator-authorized insurance broker export"
                      required
                    />
                    <input name="scope" className="input input-bordered w-full" placeholder="Insurance" required />
                    <select name="status" className="select select-bordered w-full" defaultValue="pending">
                      <option value="pending">Pending</option>
                      <option value="verified">Verified</option>
                      <option value="exception">Exception</option>
                    </select>
                    <input
                      name="sealPolicyId"
                      className="input input-bordered w-full"
                      defaultValue="seal://policy/lender-auditor-read"
                    />
                    <input
                      name="linkedReceivableIds"
                      className="input input-bordered w-full"
                      placeholder="Linked receivable ids (comma separated)"
                    />
                    <button className="btn btn-primary rounded-full" type="submit" disabled={isBusy}>
                      Upload evidence
                    </button>
                  </div>
                </form>
              </div>
            </section>
          ) : null}

          <section className="overflow-hidden rounded-[2rem] border border-base-300 bg-base-100 shadow-lg shadow-base-300/30">
            <div className="border-b border-base-300 px-6 py-5">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Receivables</p>
              <h2 className="mt-2 text-2xl font-black tracking-tight text-base-content">Collateral under review</h2>
            </div>

            {submission.receivables.length === 0 ? (
              <div className="p-6 text-base-content/70">No receivables imported yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr className="text-xs uppercase tracking-[0.18em] text-base-content/50">
                      <th>Receivable</th>
                      <th>Obligor</th>
                      <th>Amount</th>
                      <th>DPD</th>
                      <th>Status</th>
                      {readOnly ? null : <th>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {submission.receivables.map(receivable => {
                      const result = submission.computation?.borrowingBase.receivableResults.find(
                        item => item.id === receivable.id,
                      );
                      const isEditing = editingReceivableId === receivable.id;
                      return (
                        <Fragment key={receivable.id}>
                          <tr key={receivable.id}>
                            <td className="font-semibold text-base-content">{receivable.id}</td>
                            <td>
                              <div className="font-medium text-base-content">{receivable.obligor}</div>
                              <div className="text-xs text-base-content/60">{receivable.vehicleCount} vehicles</div>
                            </td>
                            <td>{formatUsd(receivable.outstandingCents)}</td>
                            <td>{receivable.daysPastDue}</td>
                            <td>
                              <span
                                className={`badge border-0 ${
                                  result?.eligible ? "badge-success text-success-content" : "badge-warning"
                                }`}
                              >
                                {result?.eligible ? "Eligible" : receivable.excluded ? "Excluded" : "Needs review"}
                              </span>
                            </td>
                            {readOnly ? null : (
                              <td>
                                <div className="flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    className="btn btn-xs btn-outline"
                                    onClick={() => {
                                      setEditingReceivableId(isEditing ? null : receivable.id);
                                      setDraftReceivable(receivable);
                                    }}
                                  >
                                    {isEditing ? "Close edit" : "Edit"}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-xs btn-outline"
                                    onClick={() =>
                                      patchSubmission({
                                        action: "excludeReceivable",
                                        receivableId: receivable.id,
                                        excluded: !receivable.excluded,
                                      })
                                    }
                                  >
                                    {receivable.excluded ? "Reinstate" : "Exclude"}
                                  </button>
                                </div>
                              </td>
                            )}
                          </tr>
                          {isEditing ? (
                            <tr key={`${receivable.id}-edit`}>
                              <td colSpan={readOnly ? 5 : 6}>
                                <div className="grid gap-3 rounded-2xl bg-base-200/60 p-4 md:grid-cols-4">
                                  <input
                                    className="input input-bordered"
                                    value={draftReceivable.obligor ?? ""}
                                    onChange={event =>
                                      setDraftReceivable(current => ({ ...current, obligor: event.target.value }))
                                    }
                                  />
                                  <label className="form-control">
                                    <span className="label-text">Outstanding dollars</span>
                                    <input
                                      className="input input-bordered"
                                      type="number"
                                      min="0"
                                      step="0.01"
                                      value={centsToDollarInput(draftReceivable.outstandingCents)}
                                      onChange={event =>
                                        setDraftReceivable(current => ({
                                          ...current,
                                          outstandingCents: dollarsToCents(event.target.value),
                                        }))
                                      }
                                    />
                                  </label>
                                  <input
                                    className="input input-bordered"
                                    type="number"
                                    value={draftReceivable.daysPastDue ?? 0}
                                    onChange={event =>
                                      setDraftReceivable(current => ({
                                        ...current,
                                        daysPastDue: Number(event.target.value),
                                      }))
                                    }
                                  />
                                  <input
                                    className="input input-bordered"
                                    type="number"
                                    value={draftReceivable.utilizationPct ?? 0}
                                    onChange={event =>
                                      setDraftReceivable(current => ({
                                        ...current,
                                        utilizationPct: Number(event.target.value),
                                      }))
                                    }
                                  />
                                  <label className="label cursor-pointer justify-start gap-2">
                                    <input
                                      type="checkbox"
                                      className="checkbox checkbox-sm"
                                      checked={Boolean(draftReceivable.insured)}
                                      onChange={event =>
                                        setDraftReceivable(current => ({ ...current, insured: event.target.checked }))
                                      }
                                    />
                                    <span className="label-text">Insured</span>
                                  </label>
                                  <label className="label cursor-pointer justify-start gap-2">
                                    <input
                                      type="checkbox"
                                      className="checkbox checkbox-sm"
                                      checked={Boolean(draftReceivable.titleClear)}
                                      onChange={event =>
                                        setDraftReceivable(current => ({
                                          ...current,
                                          titleClear: event.target.checked,
                                        }))
                                      }
                                    />
                                    <span className="label-text">Title clear</span>
                                  </label>
                                  <label className="label cursor-pointer justify-start gap-2">
                                    <input
                                      type="checkbox"
                                      className="checkbox checkbox-sm"
                                      checked={Boolean(draftReceivable.lockboxMatched)}
                                      onChange={event =>
                                        setDraftReceivable(current => ({
                                          ...current,
                                          lockboxMatched: event.target.checked,
                                        }))
                                      }
                                    />
                                    <span className="label-text">Lockbox matched</span>
                                  </label>
                                  <div className="flex gap-2">
                                    <button
                                      type="button"
                                      className="btn btn-primary btn-sm rounded-full"
                                      onClick={() =>
                                        patchSubmission({
                                          action: "updateReceivable",
                                          receivableId: receivable.id,
                                          patch: draftReceivable,
                                        }).then(() => setEditingReceivableId(null))
                                      }
                                    >
                                      Save changes
                                    </button>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <div className="space-y-6">
          <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
              <ExclamationTriangleIcon className="h-4 w-4" />
              Exceptions and next actions
            </div>
            {submission.exceptions.length === 0 ? (
              <div className="mt-4 text-sm text-base-content/70">No exceptions yet. Compute the submission first.</div>
            ) : (
              <div className="mt-4 space-y-3">
                {submission.exceptions.map(exception => (
                  <div key={exception.id} className="rounded-[1.5rem] border border-base-300 bg-base-200/50 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-semibold text-base-content">{exception.title}</div>
                        <div className="mt-2 text-sm text-base-content/70">{exception.message}</div>
                        <div className="mt-2 text-sm font-medium text-base-content">{exception.nextAction}</div>
                      </div>
                      <span className="badge badge-warning capitalize">{exception.actionStatus}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
              <ShieldCheckIcon className="h-4 w-4" />
              Evidence library
            </div>
            {submission.evidence.length === 0 ? (
              <div className="mt-4 text-sm text-base-content/70">No evidence uploaded yet.</div>
            ) : (
              <div className="mt-4 space-y-4">
                {submission.evidence.map(evidence => (
                  <div key={evidence.id} className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-semibold text-base-content">{evidence.label}</div>
                        <div className="text-sm text-base-content/70">{evidence.source}</div>
                        <div className="mt-1 text-xs uppercase tracking-[0.16em] text-base-content/50">
                          {evidence.scope}
                        </div>
                      </div>
                      <span className={`badge ${evidence.status === "verified" ? "badge-success" : "badge-warning"}`}>
                        {evidence.status}
                      </span>
                    </div>
                    <div className="mt-3 text-sm text-base-content/70">
                      Uploaded {new Date(evidence.uploadedAt).toLocaleString()} · {evidence.filename}
                    </div>
                    {!readOnly ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {(["verified", "pending", "exception"] as const).map(status => (
                          <button
                            key={status}
                            type="button"
                            className="btn btn-xs btn-outline rounded-full"
                            onClick={() =>
                              patchSubmission({
                                action: "updateEvidenceStatus",
                                evidenceId: evidence.id,
                                status,
                              })
                            }
                          >
                            Mark {status}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <details className="mt-4 rounded-2xl border border-base-300 bg-base-100 p-4">
                      <summary className="cursor-pointer text-sm font-semibold text-base-content">
                        Advanced details
                      </summary>
                      <div className="mt-3 grid gap-3 text-sm text-base-content/70">
                        <div>
                          <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">Digest</div>
                          <div className="mt-1 break-all">{evidence.digest}</div>
                        </div>
                        <div>
                          <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">Walrus object</div>
                          <div className="mt-1 break-all">{evidence.walrusObjectId}</div>
                        </div>
                        <div>
                          <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">Seal policy</div>
                          <div className="mt-1 break-all">{evidence.sealPolicyId}</div>
                        </div>
                      </div>
                    </details>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
              <CheckCircleIcon className="h-4 w-4" />
              Lender packet and Sui commit
            </div>
            {submission.computation ? (
              <div className="mt-4 space-y-4">
                <div className="rounded-[1.5rem] border border-base-300 bg-base-200/50 p-4">
                  <div className="text-sm font-semibold text-base-content">
                    {submission.computation.lenderPacket.certificateId}
                  </div>
                  <div className="mt-2 text-sm text-base-content/70">
                    {submission.computation.lenderPacket.certificationStatement}
                  </div>
                  <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-base-content/70">
                    {submission.computation.lenderPacket.borrowerRequests.map(item => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-[1.5rem] border border-base-300 bg-base-200/50 p-4">
                  <div className="text-sm font-semibold text-base-content">Evidence commit status</div>
                  <div className="mt-2 text-sm text-base-content/70">
                    {submission.evidenceCommit.status.replace(/_/g, " ")} · {submission.evidenceCommit.modulePath}
                  </div>
                  {submission.evidenceCommit.evidenceRoot ? (
                    <div className="mt-3 text-xs text-base-content/60 break-all">
                      Root: {submission.evidenceCommit.evidenceRoot}
                    </div>
                  ) : null}
                  {submission.evidenceCommit.errorMessage ? (
                    <div className="mt-3 text-sm text-error">{submission.evidenceCommit.errorMessage}</div>
                  ) : null}
                  {!readOnly && submission.evidenceCommit.commitMode === "configured" ? (
                    <button className="btn btn-primary mt-4 rounded-full" onClick={commitEvidence} disabled={isBusy}>
                      Commit evidence on Sui
                    </button>
                  ) : null}
                  {!readOnly && submission.evidenceCommit.commitMode === "prepared" ? (
                    <div className="mt-4 text-sm text-base-content/70">
                      Sui commit is prepared, but the runtime is not configured with a facility/package/client config
                      yet.
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="mt-4 text-sm text-base-content/70">
                Compute the submission to generate lender packet output and the evidence root preview.
              </div>
            )}
          </section>
        </div>
      </section>
    </div>
  );
};
