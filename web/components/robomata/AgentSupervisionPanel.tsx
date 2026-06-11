"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowPathIcon, BoltIcon, CheckCircleIcon, ShieldCheckIcon, XCircleIcon } from "@heroicons/react/24/outline";
import { isRobomataAgentsClientEnabled } from "~~/lib/featureFlags";
import type { RobomataAgentAction, RobomataAgentPolicy, RobomataAgentRun } from "~~/lib/robomata/agents";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";
import { notification } from "~~/utils/scaffold-eth";

type AgentSupervisionPanelProps = {
  chainId: number;
  getAuthHeaders: (input: {
    chainId?: number;
    method?: string;
    path?: string;
    signerAddress?: string;
  }) => Promise<Record<string, string>>;
  signerAddress?: string;
  submission: FacilitySubmission;
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

function formatStatus(value: string) {
  return value.replace(/_/g, " ");
}

function statusBadgeClass(status: string) {
  if (["active", "completed", "approved"].includes(status)) return "badge-success";
  if (["paused", "proposed", "medium", "low"].includes(status)) return "badge-warning";
  if (["failed", "rejected", "high"].includes(status)) return "badge-error";
  return "badge-ghost";
}

export const AgentSupervisionPanel = ({
  chainId,
  getAuthHeaders,
  signerAddress,
  submission,
}: AgentSupervisionPanelProps) => {
  const featureEnabled = isRobomataAgentsClientEnabled();
  const [actions, setActions] = useState<RobomataAgentAction[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [policy, setPolicy] = useState<RobomataAgentPolicy | null>(null);
  const [runs, setRuns] = useState<RobomataAgentRun[]>([]);
  const [serverUnavailable, setServerUnavailable] = useState(false);
  const loadSequenceRef = useRef(0);

  const policyPath = `/api/robomata/submissions/${submission.id}/agent-policy`;
  const runsPath = `/api/robomata/submissions/${submission.id}/agent-runs`;

  const loadAgentState = useCallback(async () => {
    if (!featureEnabled) return;

    const loadSequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadSequence;
    const isCurrentLoad = () => loadSequenceRef.current === loadSequence;
    setIsLoading(true);
    setServerUnavailable(false);
    try {
      const [policyResponse, runsResponse] = await Promise.all([
        fetch(policyPath, {
          headers: await getAuthHeaders({ chainId, method: "GET", path: policyPath, signerAddress }),
        }),
        fetch(runsPath, {
          headers: await getAuthHeaders({ chainId, method: "GET", path: runsPath, signerAddress }),
        }),
      ]);
      const policyPayload = await readJsonResponse<{ policy?: RobomataAgentPolicy }>(policyResponse);
      const runsPayload = await readJsonResponse<{ actions?: RobomataAgentAction[]; runs?: RobomataAgentRun[] }>(
        runsResponse,
      );

      if (!isCurrentLoad()) return;
      if (policyResponse.status === 404 || runsResponse.status === 404) {
        setServerUnavailable(true);
        setPolicy(null);
        setActions([]);
        setRuns([]);
        return;
      }
      if (!policyResponse.ok || !policyPayload.policy) {
        throw new Error(policyPayload.error ?? "Failed to load agent policy.");
      }
      if (!runsResponse.ok || !runsPayload.runs || !runsPayload.actions) {
        throw new Error(runsPayload.error ?? "Failed to load agent runs.");
      }

      setPolicy(policyPayload.policy);
      setRuns(runsPayload.runs);
      setActions(runsPayload.actions);
    } catch (error) {
      if (!isCurrentLoad()) return;
      notification.error(error instanceof Error ? error.message : "Failed to load Robomata agents.");
    } finally {
      if (isCurrentLoad()) setIsLoading(false);
    }
  }, [chainId, featureEnabled, getAuthHeaders, policyPath, runsPath, signerAddress]);

  useEffect(() => {
    void loadAgentState();
  }, [loadAgentState, submission.updatedAt]);

  const updatePolicyStatus = async (status: "active" | "paused") => {
    setIsMutating(true);
    try {
      const response = await fetch(policyPath, {
        body: JSON.stringify({ status }),
        headers: {
          "content-type": "application/json",
          ...(await getAuthHeaders({ chainId, method: "PATCH", path: policyPath, signerAddress })),
        },
        method: "PATCH",
      });
      const payload = await readJsonResponse<{ policy?: RobomataAgentPolicy }>(response);
      if (!response.ok || !payload.policy) throw new Error(payload.error ?? "Failed to update agent policy.");
      setPolicy(payload.policy);
      notification.success(status === "active" ? "Robomata agent policy activated." : "Robomata agent policy paused.");
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Failed to update agent policy.");
    } finally {
      setIsMutating(false);
    }
  };

  const runAgent = async () => {
    setIsMutating(true);
    try {
      const response = await fetch(runsPath, {
        body: JSON.stringify({}),
        headers: {
          "content-type": "application/json",
          ...(await getAuthHeaders({ chainId, method: "POST", path: runsPath, signerAddress })),
        },
        method: "POST",
      });
      const payload = await readJsonResponse<{ actions?: RobomataAgentAction[]; run?: RobomataAgentRun }>(response);
      if (!response.ok || !payload.run) throw new Error(payload.error ?? "Failed to run Robomata agent.");
      notification.success(payload.run.summary);
      await loadAgentState();
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Failed to run Robomata agent.");
    } finally {
      setIsMutating(false);
    }
  };

  const updateAction = async (action: RobomataAgentAction, status: "approved" | "rejected" | "completed") => {
    setIsMutating(true);
    try {
      const path = `/api/robomata/submissions/${submission.id}/agent-actions/${action.id}`;
      const response = await fetch(path, {
        body: JSON.stringify({ status }),
        headers: {
          "content-type": "application/json",
          ...(await getAuthHeaders({ chainId, method: "PATCH", path, signerAddress })),
        },
        method: "PATCH",
      });
      const payload = await readJsonResponse<{ action?: RobomataAgentAction }>(response);
      if (!response.ok || !payload.action) throw new Error(payload.error ?? "Failed to update agent action.");
      setActions(current =>
        current.map(candidate => (candidate.id === payload.action?.id ? payload.action : candidate)),
      );
      notification.success(`Agent action ${formatStatus(status)}.`);
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Failed to update agent action.");
    } finally {
      setIsMutating(false);
    }
  };

  if (!featureEnabled) return null;

  const latestRun = runs[0];
  const openActions = actions.filter(action => action.status === "proposed" || action.status === "approved");

  return (
    <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
            <ShieldCheckIcon className="h-4 w-4" />
            Agent supervision
          </div>
          {policy ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <span className={`badge ${statusBadgeClass(policy.status)} capitalize`}>{policy.status}</span>
              <span className="badge badge-ghost">{policy.allowedActionTypes.length} action types allowed</span>
              {latestRun ? (
                <span className={`badge ${statusBadgeClass(latestRun.status)} capitalize`}>
                  last run {formatStatus(latestRun.status)}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-sm btn-outline rounded-full" onClick={loadAgentState} disabled={isLoading}>
            <ArrowPathIcon className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          {policy ? (
            <button
              className="btn btn-sm btn-outline rounded-full"
              onClick={() => updatePolicyStatus(policy.status === "active" ? "paused" : "active")}
              disabled={isMutating}
            >
              {policy.status === "active" ? "Pause" : "Activate"}
            </button>
          ) : null}
          <button
            className="btn btn-sm btn-primary rounded-full"
            onClick={runAgent}
            disabled={isMutating || policy?.status !== "active"}
          >
            <BoltIcon className="h-4 w-4" />
            Run check
          </button>
        </div>
      </div>

      {serverUnavailable ? (
        <div className="mt-4 rounded-[1.5rem] border border-warning/20 bg-warning/10 p-4 text-sm text-base-content/70">
          Agent supervision is not enabled on this server.
        </div>
      ) : policy ? (
        <div className="mt-5 space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/50">Policy</div>
              <div className="mt-2 break-all text-sm font-semibold text-base-content">{policy.id}</div>
              <div className="mt-1 text-sm text-base-content/70">
                Updated {new Date(policy.updatedAt).toLocaleString()}
              </div>
            </div>
            <div className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/50">Latest run</div>
              <div className="mt-2 text-sm font-semibold text-base-content">{latestRun?.summary ?? "No run yet"}</div>
              <div className="mt-1 text-sm text-base-content/70">
                {latestRun ? new Date(latestRun.completedAt).toLocaleString() : "Activate policy to run checks"}
              </div>
            </div>
            <div className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/50">Open actions</div>
              <div className="mt-2 text-sm font-semibold text-base-content">
                {openActions.length} proposed or approved
              </div>
              <div className="mt-1 text-sm text-base-content/70">{actions.length} total retained</div>
            </div>
          </div>

          <div className="space-y-3">
            {actions.length ? (
              actions.slice(0, 6).map(action => (
                <div key={action.id} className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-base-content">{action.title}</div>
                      <div className="mt-1 text-sm text-base-content/70">{action.message}</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className={`badge ${statusBadgeClass(action.severity)} capitalize`}>
                        {formatStatus(action.severity)}
                      </span>
                      <span className={`badge ${statusBadgeClass(action.status)} capitalize`}>
                        {formatStatus(action.status)}
                      </span>
                    </div>
                  </div>
                  <div className="mt-3 text-xs text-base-content/60">
                    {formatStatus(action.type)} - proposed {new Date(action.proposedAt).toLocaleString()}
                  </div>
                  <div className="mt-2 text-sm text-base-content/70">{action.reason}</div>
                  {action.status === "proposed" ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        className="btn btn-xs btn-outline rounded-full"
                        disabled={isMutating}
                        onClick={() => updateAction(action, "approved")}
                      >
                        <CheckCircleIcon className="h-4 w-4" />
                        Approve
                      </button>
                      <button
                        className="btn btn-xs btn-outline rounded-full"
                        disabled={isMutating}
                        onClick={() => updateAction(action, "rejected")}
                      >
                        <XCircleIcon className="h-4 w-4" />
                        Reject
                      </button>
                    </div>
                  ) : action.status === "approved" ? (
                    <div className="mt-4">
                      <button
                        className="btn btn-xs btn-outline rounded-full"
                        disabled={isMutating}
                        onClick={() => updateAction(action, "completed")}
                      >
                        Mark complete
                      </button>
                    </div>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="rounded-[1.5rem] border border-dashed border-base-300 p-4 text-sm text-base-content/60">
                No supervised agent actions have been proposed.
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-[1.5rem] border border-dashed border-base-300 p-4 text-sm text-base-content/60">
          {isLoading ? "Loading agent supervision..." : "No agent policy loaded."}
        </div>
      )}
    </section>
  );
};
