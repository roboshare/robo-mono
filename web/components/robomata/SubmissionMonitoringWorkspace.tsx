"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AgentSupervisionPanel } from "~~/components/robomata/AgentSupervisionPanel";
import { FacilityMonitoringPanel } from "~~/components/robomata/FacilityMonitoringPanel";
import { useSelectedNetwork } from "~~/hooks/scaffold-eth";
import { useRobomataApiAuth } from "~~/hooks/useRobomataApiAuth";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";
import { notification } from "~~/utils/scaffold-eth";

type SubmissionMonitoringWorkspaceProps = {
  submissionId: string;
};

async function readJsonResponse<T>(response: Response): Promise<T & { error?: string }> {
  const text = await response.text();
  if (!text.trim()) return {} as T & { error?: string };

  try {
    return JSON.parse(text) as T & { error?: string };
  } catch {
    return {
      error: `Unexpected ${response.status} response from ${new URL(response.url).pathname}.`,
    } as T & { error?: string };
  }
}

function statusClass(status: FacilitySubmission["status"]) {
  if (status === "committed") return "badge-success";
  if (status === "ready_for_lender") return "badge-info";
  if (status === "needs_review") return "badge-warning";
  return "badge-ghost";
}

export function SubmissionMonitoringWorkspace({ submissionId }: SubmissionMonitoringWorkspaceProps) {
  const [submission, setSubmission] = useState<FacilitySubmission | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { address: accountAddress, chainId: accountChainId, connectedAddress } = useTransactingAccount();
  const selectedNetwork = useSelectedNetwork(accountChainId);
  const signerAddress = connectedAddress ?? accountAddress;
  const getAuthHeaders = useRobomataApiAuth(accountAddress);

  const loadSubmission = useCallback(async () => {
    setIsLoading(true);
    try {
      if (!accountAddress) {
        setSubmission(null);
        setLoadError(null);
        return;
      }

      const path = `/api/robomata/submissions/${submissionId}`;
      const response = await fetch(path, {
        headers: await getAuthHeaders({ chainId: selectedNetwork.id, method: "GET", path, signerAddress }),
      });
      const payload = await readJsonResponse<{ submission?: FacilitySubmission }>(response);
      if (!response.ok || !payload.submission) throw new Error(payload.error ?? "Failed to load submission.");

      setSubmission(payload.submission);
      setLoadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load submission.";
      setSubmission(null);
      setLoadError(message);
      notification.error(message);
    } finally {
      setIsLoading(false);
    }
  }, [accountAddress, getAuthHeaders, selectedNetwork.id, signerAddress, submissionId]);

  useEffect(() => {
    void loadSubmission();
  }, [loadSubmission]);

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
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
            {loadError ? "Monitoring unavailable" : "Connect partner wallet"}
          </p>
          <h1 className="mt-3 text-3xl font-black tracking-tight text-base-content">
            {loadError ? "Unable to load monitoring" : "No submission loaded"}
          </h1>
          <p className="mt-4 text-base-content/70">
            {loadError ?? "Connect the operator wallet that owns this facility package."}
          </p>
          <div className="mt-6 flex justify-center gap-3">
            {loadError ? (
              <button className="btn btn-primary rounded-full" onClick={() => void loadSubmission()}>
                Retry
              </button>
            ) : null}
            <Link href={`/robomata/submissions/${submissionId}`} className="btn btn-outline rounded-full">
              Back to workspace
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const workspaceHref = `/robomata/submissions/${submission.id}`;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
      <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30 sm:p-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
              Robomata monitoring
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <h1 className="min-w-0 break-words text-4xl font-black tracking-tight text-base-content sm:text-5xl">
                {submission.facilityName}
              </h1>
              <span className={`badge ${statusClass(submission.status)} capitalize`}>
                {submission.status.replace(/_/g, " ")}
              </span>
            </div>
            <p className="mt-4 text-base leading-relaxed text-base-content/70 sm:text-lg">
              Monitoring details, policy diagnostics, run history, evidence observations, and supervised-agent state for
              this submission.
            </p>
          </div>
          <Link href={workspaceHref} className="btn btn-outline shrink-0 rounded-full">
            Back to workspace
          </Link>
        </div>
      </section>

      <FacilityMonitoringPanel
        chainId={selectedNetwork.id}
        getAuthHeaders={getAuthHeaders}
        signerAddress={signerAddress}
        submission={submission}
        workspaceHref={workspaceHref}
      />
      <AgentSupervisionPanel
        chainId={selectedNetwork.id}
        getAuthHeaders={getAuthHeaders}
        signerAddress={signerAddress}
        submission={submission}
      />
    </div>
  );
}
