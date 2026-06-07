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
import { useSelectedNetwork } from "~~/hooks/scaffold-eth";
import { usePrivySuiWalletBinding } from "~~/hooks/usePrivySuiWalletBinding";
import { useRobomataApiAuth } from "~~/hooks/useRobomataApiAuth";
import {
  type OperatorSuiCommitRequest,
  shouldReleaseOperatorCommitReservation,
  useSuiOperatorWallet,
} from "~~/hooks/useSuiOperatorWallet";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import { formatPercentFromBps, formatUsd } from "~~/lib/robomata/borrowingBase";
import type { FacilitySubmission, SubmissionComputation, SubmissionReceivable } from "~~/lib/robomata/submissions";
import { notification } from "~~/utils/scaffold-eth";

type SubmissionWorkspaceProps = {
  submissionId?: string;
  readOnly?: boolean;
  loadLatest?: boolean;
};

type CommitEvidenceResponse = {
  submission?: FacilitySubmission;
  operatorCommit?: OperatorSuiCommitRequest;
  error?: string;
};

type PendingOperatorCommit = {
  submissionId: string;
  rootDigest: string;
  txDigest?: string;
  walletAddress?: string;
  walletName: string;
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

function buildSubmissionSummaryCards(computation: SubmissionComputation) {
  const { borrowingBase } = computation;
  return [
    { label: "Gross Receivables", value: formatUsd(borrowingBase.grossReceivablesCents) },
    { label: "Eligible Receivables", value: formatUsd(borrowingBase.eligibleReceivablesCents) },
    { label: "Available Borrowing Base", value: formatUsd(borrowingBase.availableBorrowingBaseCents) },
    { label: "Open Exceptions", value: borrowingBase.exceptionCount.toString() },
    { label: "Advance Rate", value: formatPercentFromBps(borrowingBase.portfolio.advanceRateBps) },
  ];
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
  const [receivablesCsvText, setReceivablesCsvText] = useState("");
  const [evidenceText, setEvidenceText] = useState("");
  const [pendingOperatorCommit, setPendingOperatorCommit] = useState<PendingOperatorCommit | null>(null);
  const { address: accountAddress, chainId: accountChainId, connectedAddress } = useTransactingAccount();
  const selectedNetwork = useSelectedNetwork(accountChainId);
  const partnerAuthAddress = accountAddress;
  const signerAddress = connectedAddress ?? accountAddress;
  const getAuthHeaders = useRobomataApiAuth(partnerAuthAddress);
  const { hasSuiWallet, signAndExecuteOperatorCommit, suiWalletNames } = useSuiOperatorWallet();
  const {
    binding: privySuiBinding,
    error: privySuiBindingError,
    featureEnabled: privySuiBindingFeatureEnabled,
    isEnsuring: isEnsuringPrivySuiBinding,
  } = usePrivySuiWalletBinding({
    chainId: selectedNetwork.id,
    enabled: !readOnly,
    getAuthHeaders,
    partnerAddress: partnerAuthAddress,
    signerAddress,
  });

  const summaryCards = useMemo(
    () => (submission?.computation ? buildSubmissionSummaryCards(submission.computation) : []),
    [submission],
  );
  const isCommitted = submission?.status === "committed" || submission?.evidenceCommit.status === "committed";
  const canMutate = !readOnly && !isCommitted;
  const canRetryPendingOperatorCommit = Boolean(
    submission &&
      pendingOperatorCommit?.submissionId === submission.id &&
      pendingOperatorCommit.rootDigest === submission.evidenceCommit.rootDigest,
  );

  const loadSubmission = useCallback(async () => {
    setIsLoading(true);
    try {
      if (!partnerAuthAddress) {
        setSubmission(null);
        setIsLoading(false);
        return;
      }

      if (submissionId) {
        const path = `/api/robomata/submissions/${submissionId}`;
        const response = await fetch(path, {
          headers: await getAuthHeaders({ chainId: selectedNetwork.id, method: "GET", path, signerAddress }),
        });
        const payload = (await response.json()) as { submission?: FacilitySubmission; error?: string };
        if (!response.ok || !payload.submission) throw new Error(payload.error ?? "Failed to load submission.");
        setSubmission(payload.submission);
        setIsLoading(false);
        return;
      }

      if (loadLatest) {
        const path = "/api/robomata/submissions";
        const response = await fetch(path, {
          headers: await getAuthHeaders({ chainId: selectedNetwork.id, method: "GET", path, signerAddress }),
        });
        const payload = (await response.json()) as { submissions?: FacilitySubmission[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Failed to load submissions.");
        setSubmission(payload.submissions?.[0] ?? null);
      }
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Failed to load submission.");
    } finally {
      setIsLoading(false);
    }
  }, [getAuthHeaders, loadLatest, partnerAuthAddress, selectedNetwork.id, signerAddress, submissionId]);

  useEffect(() => {
    void loadSubmission();
  }, [loadSubmission]);

  const updateSubmission = async (url: string, init?: RequestInit) => {
    if (!partnerAuthAddress) {
      notification.error("Connect a partner wallet before updating the submission.");
      return false;
    }

    setIsBusy(true);
    try {
      const headers = new Headers(init?.headers);
      const authHeaders = await getAuthHeaders({
        chainId: selectedNetwork.id,
        method: init?.method ?? "GET",
        path: url,
        signerAddress,
      });
      Object.entries(authHeaders).forEach(([key, value]) => headers.set(key, value));
      const response = await fetch(url, { ...init, headers });
      const payload = (await response.json().catch(() => ({}))) as { submission?: FacilitySubmission; error?: string };

      if (!response.ok || !payload.submission) {
        notification.error(payload.error ?? "Submission update failed.");
        return false;
      }

      setSubmission(payload.submission);
      return true;
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Submission update failed.");
      return false;
    } finally {
      setIsBusy(false);
    }
  };

  const importReceivables = async (file: File) => {
    if (!submission) return;
    const formData = new FormData();
    formData.set("file", file);
    const didUpdate = await updateSubmission(`/api/robomata/submissions/${submission.id}/receivables/import`, {
      method: "POST",
      body: formData,
    });
    if (didUpdate) setReceivablesCsvText("");
  };

  const importReceivablesFromText = async () => {
    const csvText = receivablesCsvText.trim();
    if (!csvText) {
      notification.error("Paste receivables CSV before importing.");
      return;
    }

    await importReceivables(new File([csvText], "receivables.csv", { type: "text/csv" }));
  };

  const uploadEvidence = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!submission) return;

    const form = event.currentTarget;
    const formData = new FormData(form);
    const uploadedFile = formData.get("file");
    if (!(uploadedFile instanceof File) || uploadedFile.size === 0) {
      if (!evidenceText.trim()) {
        notification.error("Attach an evidence file or paste evidence text.");
        return;
      }

      const label = String(formData.get("label") ?? "evidence").trim() || "evidence";
      formData.set(
        "file",
        new File([evidenceText], `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.txt`, { type: "text/plain" }),
      );
    }

    const didUpdate = await updateSubmission(`/api/robomata/submissions/${submission.id}/evidence`, {
      method: "POST",
      body: formData,
    });
    if (didUpdate) {
      form.reset();
      setEvidenceText("");
    }
  };

  const recompute = async () => {
    if (!submission) return;
    await updateSubmission(`/api/robomata/submissions/${submission.id}/compute`, { method: "POST" });
  };

  const commitEvidence = async () => {
    if (!submission) return;
    const path = `/api/robomata/submissions/${submission.id}/commit-evidence`;

    if (submission.evidenceCommit.commitMode !== "operator_configured") {
      await updateSubmission(path, { method: "POST" });
      return;
    }

    if (!partnerAuthAddress) {
      notification.error("Connect a partner wallet before committing evidence.");
      return;
    }

    setIsBusy(true);
    try {
      const completeOperatorCommit = async (commit: PendingOperatorCommit) => {
        const completeHeaders = new Headers({ "content-type": "application/json" });
        const completeAuthHeaders = await getAuthHeaders({
          chainId: selectedNetwork.id,
          method: "POST",
          path,
          signerAddress,
        });
        Object.entries(completeAuthHeaders).forEach(([key, value]) => completeHeaders.set(key, value));
        const completeResponse = await fetch(path, {
          method: "POST",
          headers: completeHeaders,
          body: JSON.stringify({
            mode: "operator_complete",
            txDigest: commit.txDigest,
            walletAddress: commit.walletAddress,
          }),
        });
        const completePayload = (await completeResponse.json().catch(() => ({}))) as CommitEvidenceResponse;
        if (completePayload.submission) setSubmission(completePayload.submission);
        if (!completeResponse.ok || !completePayload.submission) {
          const errorMessage = completePayload.error ?? "Failed to reconcile the operator Sui commit.";
          if (
            completePayload.submission?.evidenceCommit.status === "failed" ||
            (errorMessage.includes("Sui transaction") && errorMessage.includes("failed"))
          ) {
            setPendingOperatorCommit(null);
          }
          throw new Error(errorMessage);
        }

        if (completeResponse.status === 202) {
          setPendingOperatorCommit(commit);
          notification.error(
            completePayload.error ?? "Sui commit is awaiting event indexing. Retry completion shortly.",
          );
        } else {
          setPendingOperatorCommit(null);
          notification.success(`Evidence committed with ${commit.walletName}.`);
        }
      };

      const releasePreparedOperatorCommit = async () => {
        const releaseHeaders = new Headers({ "content-type": "application/json" });
        const releaseAuthHeaders = await getAuthHeaders({
          chainId: selectedNetwork.id,
          method: "POST",
          path,
          signerAddress,
        });
        Object.entries(releaseAuthHeaders).forEach(([key, value]) => releaseHeaders.set(key, value));
        const releaseResponse = await fetch(path, {
          method: "POST",
          headers: releaseHeaders,
          body: JSON.stringify({ mode: "operator_release" }),
        });
        const releasePayload = (await releaseResponse.json().catch(() => ({}))) as CommitEvidenceResponse;
        if (releasePayload.submission) setSubmission(releasePayload.submission);
        if (!releaseResponse.ok) {
          throw new Error(releasePayload.error ?? "Failed to release the prepared Sui commit.");
        }
      };

      if (canRetryPendingOperatorCommit && pendingOperatorCommit) {
        await completeOperatorCommit(pendingOperatorCommit);
        return;
      }

      if (submission.evidenceCommit.status === "committing") {
        await completeOperatorCommit({
          submissionId: submission.id,
          rootDigest: submission.evidenceCommit.rootDigest ?? "",
          walletName: "Sui wallet",
        });
        return;
      }

      const prepareHeaders = new Headers({ "content-type": "application/json" });
      const prepareAuthHeaders = await getAuthHeaders({
        chainId: selectedNetwork.id,
        method: "POST",
        path,
        signerAddress,
      });
      Object.entries(prepareAuthHeaders).forEach(([key, value]) => prepareHeaders.set(key, value));
      const prepareResponse = await fetch(path, {
        method: "POST",
        headers: prepareHeaders,
        body: JSON.stringify({ mode: "operator_prepare" }),
      });
      const preparePayload = (await prepareResponse.json().catch(() => ({}))) as CommitEvidenceResponse;
      if (!prepareResponse.ok || !preparePayload.submission || !preparePayload.operatorCommit) {
        throw new Error(preparePayload.error ?? "Failed to prepare Sui transaction for operator signing.");
      }

      setSubmission(preparePayload.submission);
      let signed;
      try {
        signed = await signAndExecuteOperatorCommit(preparePayload.operatorCommit);
      } catch (error) {
        if (shouldReleaseOperatorCommitReservation(error)) {
          await releasePreparedOperatorCommit();
        }
        throw error;
      }
      const pendingCommit = {
        submissionId: submission.id,
        rootDigest: preparePayload.operatorCommit.rootDigest,
        txDigest: signed.txDigest,
        walletAddress: signed.walletAddress,
        walletName: signed.walletName,
      };
      setPendingOperatorCommit(pendingCommit);
      await completeOperatorCommit(pendingCommit);
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Operator Sui evidence commit failed.");
    } finally {
      setIsBusy(false);
    }
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
              ) : isCommitted ? (
                <div className="rounded-2xl border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
                  This submission is committed. Create a new submission for additional evidence or receivable changes.
                </div>
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
          {canMutate ? (
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
                  <div className="mt-4">
                    <textarea
                      className="textarea textarea-bordered min-h-36 w-full text-sm"
                      placeholder={`Or paste CSV:\nreceivable,obligor,vehicles,outstanding,dpd,utilization,insured,title,lockbox\nAR-1007,Northstar Delivery Co.,28,386400,12,91,yes,yes,yes`}
                      value={receivablesCsvText}
                      onChange={event => setReceivablesCsvText(event.target.value)}
                    />
                    <button
                      className="btn btn-outline mt-3 rounded-full"
                      type="button"
                      onClick={importReceivablesFromText}
                      disabled={isBusy}
                    >
                      Import pasted CSV
                    </button>
                  </div>
                </div>

                <form className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-5" onSubmit={uploadEvidence}>
                  <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-base-content/50">
                    <CloudArrowUpIcon className="h-4 w-4" />
                    Evidence upload
                  </div>
                  <div className="mt-4 grid gap-3">
                    <input name="file" type="file" className="file-input file-input-bordered w-full" />
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
                      defaultValue="robomata_overflow::facility::seal_approve"
                    />
                    <input
                      name="linkedReceivableIds"
                      className="input input-bordered w-full"
                      placeholder="Linked receivable ids (comma separated)"
                    />
                    <textarea
                      className="textarea textarea-bordered min-h-28 w-full text-sm"
                      placeholder="Or paste authorized evidence text when you do not have a local file handy."
                      value={evidenceText}
                      onChange={event => setEvidenceText(event.target.value)}
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
                      {canMutate ? <th>Actions</th> : null}
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
                            {canMutate ? (
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
                            ) : null}
                          </tr>
                          {canMutate && isEditing ? (
                            <tr key={`${receivable.id}-edit`}>
                              <td colSpan={canMutate ? 6 : 5}>
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
              <div className="mt-4 text-sm text-base-content/70">
                {!submission.computation
                  ? "No exceptions yet. Compute the submission first."
                  : isCommitted
                    ? "All exceptions were resolved before the evidence root was committed."
                    : "No open exceptions. The submission is ready for lender review."}
              </div>
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
                    <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold uppercase tracking-[0.14em]">
                      <span className="rounded-full bg-base-100 px-3 py-1 text-base-content/60">
                        {evidence.storageBackend === "walrus" ? "Walrus stored" : "Mock storage"}
                      </span>
                      <span className="rounded-full bg-base-100 px-3 py-1 text-base-content/60">
                        {evidence.encryptionBackend === "seal" || evidence.sealEncrypted
                          ? "Seal encrypted"
                          : "Not encrypted"}
                      </span>
                    </div>
                    {canMutate ? (
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
                          <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">
                            Committed object digest
                          </div>
                          <div className="mt-1 break-all">{evidence.digest}</div>
                        </div>
                        <div>
                          <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">
                            Plaintext audit digest
                          </div>
                          <div className="mt-1 break-all">{evidence.plaintextDigest}</div>
                        </div>
                        {evidence.ciphertextDigest ? (
                          <div>
                            <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">
                              Seal ciphertext digest
                            </div>
                            <div className="mt-1 break-all">{evidence.ciphertextDigest}</div>
                          </div>
                        ) : null}
                        <div>
                          <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">Walrus object</div>
                          <div className="mt-1 break-all">{evidence.walrusObjectId}</div>
                        </div>
                        {evidence.walrusEventId ? (
                          <div>
                            <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">
                              Walrus certification event
                            </div>
                            <div className="mt-1 break-all">{evidence.walrusEventId}</div>
                          </div>
                        ) : null}
                        <div>
                          <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">Seal policy</div>
                          <div className="mt-1 break-all">{evidence.sealPolicyId}</div>
                        </div>
                        {evidence.sealIdentity ? (
                          <div>
                            <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">
                              Seal identity
                            </div>
                            <div className="mt-1 break-all">{evidence.sealIdentity}</div>
                          </div>
                        ) : null}
                        {evidence.sealPackageId ? (
                          <div>
                            <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">Seal package</div>
                            <div className="mt-1 break-all">{evidence.sealPackageId}</div>
                          </div>
                        ) : null}
                        {evidence.sealKeyServerObjectIds?.length ? (
                          <div>
                            <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">
                              Seal key servers
                            </div>
                            <div className="mt-1 break-all">{evidence.sealKeyServerObjectIds.join(", ")}</div>
                          </div>
                        ) : null}
                        {evidence.sealKeyServerAggregatorUrl ? (
                          <div>
                            <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">
                              Seal aggregator
                            </div>
                            <div className="mt-1 break-all">{evidence.sealKeyServerAggregatorUrl}</div>
                          </div>
                        ) : null}
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
                  {!readOnly &&
                  ["configured", "operator_configured"].includes(submission.evidenceCommit.commitMode) &&
                  submission.evidenceCommit.status !== "committed" ? (
                    <button
                      className="btn btn-primary mt-4 rounded-full"
                      onClick={commitEvidence}
                      disabled={
                        isBusy ||
                        (submission.evidenceCommit.commitMode === "operator_configured" &&
                          submission.evidenceCommit.status !== "committing" &&
                          !hasSuiWallet &&
                          !canRetryPendingOperatorCommit)
                      }
                    >
                      {submission.evidenceCommit.status === "committing"
                        ? "Reconcile Sui evidence commit"
                        : submission.evidenceCommit.status === "failed"
                          ? "Retry Sui evidence commit"
                          : submission.evidenceCommit.commitMode === "operator_configured"
                            ? "Sign and commit with Sui wallet"
                            : "Commit evidence on Sui"}
                    </button>
                  ) : null}
                  {!readOnly && submission.evidenceCommit.commitMode === "operator_configured" ? (
                    <div className="mt-3 rounded-2xl border border-info/20 bg-info/10 p-3 text-sm text-base-content/70">
                      <div className="font-semibold text-base-content">Operator-owned commit is enabled.</div>
                      {privySuiBindingFeatureEnabled ? (
                        <div className="mt-2">
                          {isEnsuringPrivySuiBinding
                            ? "Creating or locating the operator's Robomata Sui wallet..."
                            : privySuiBinding
                              ? `Default operator Sui wallet: ${privySuiBinding.suiAddress}`
                              : privySuiBindingError
                                ? `Privy Sui wallet binding is unavailable: ${privySuiBindingError}`
                                : "Privy Sui wallet binding is enabled but no wallet is bound yet."}
                        </div>
                      ) : null}
                      <div className="mt-2">
                        Evidence signing currently uses a compatible Sui wallet-standard extension
                        {suiWalletNames.length
                          ? ` (${suiWalletNames.join(", ")}).`
                          : ". No compatible Sui wallet is available in this browser."}
                      </div>
                      {privySuiBinding?.suiAddress &&
                      submission.evidenceCommit.facilityOperatorAddress &&
                      privySuiBinding.suiAddress.toLowerCase() !==
                        submission.evidenceCommit.facilityOperatorAddress.toLowerCase() ? (
                        <div className="mt-2 text-warning">
                          The bound Privy Sui wallet does not match this submission&apos;s configured facility operator.
                          Update the facility operator mapping before using the embedded wallet as the signer.
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {!readOnly &&
                  submission.evidenceCommit.commitMode === "configured" &&
                  submission.evidenceCommit.status === "committing" ? (
                    <div className="mt-4 text-sm text-base-content/70">
                      Sui commit is in progress. If this state becomes stale, retrying the API will reconcile Sui events
                      before another transaction can be sent.
                    </div>
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
