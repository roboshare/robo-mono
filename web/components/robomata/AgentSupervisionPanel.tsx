"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowPathIcon, BoltIcon, CheckCircleIcon, ShieldCheckIcon, XCircleIcon } from "@heroicons/react/24/outline";
import { AgentSupervisionPolicyDisclosure } from "~~/components/robomata/PolicyRulesPanel";
import { isRobomataAgentExecutionClientEnabled, isRobomataAgentsClientEnabled } from "~~/lib/featureFlags";
import {
  type RobomataAgentAction,
  type RobomataAgentActionType,
  type RobomataAgentPolicy,
  type RobomataAgentRun,
  getRobomataAgentActionPermissionDenial,
} from "~~/lib/robomata/agents";
import { resolveRobomataFacilityPolicyArtifact } from "~~/lib/robomata/policyRules";
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
  if (["failed", "rejected", "revoked", "high"].includes(status)) return "badge-error";
  return "badge-ghost";
}

function metadataValue(action: RobomataAgentAction, key: string): string | undefined {
  const value = action.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function formatActionTypes(values: string[]) {
  return values.length ? values.map(formatStatus).join(", ") : "none";
}

const CLIENT_EXECUTABLE_AGENT_ACTION_TYPES = new Set<RobomataAgentActionType>(["evidence_review", "sui_root_review"]);

export const AgentSupervisionPanel = ({
  chainId,
  getAuthHeaders,
  signerAddress,
  submission,
}: AgentSupervisionPanelProps) => {
  const executionClientEnabled = isRobomataAgentExecutionClientEnabled();
  const featureEnabled = isRobomataAgentsClientEnabled();
  const [actions, setActions] = useState<RobomataAgentAction[]>([]);
  const [appointmentNameDraft, setAppointmentNameDraft] = useState("Robomata supervised facility agent");
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
      setAppointmentNameDraft(policyPayload.policy.appointedAgentName ?? "Robomata supervised facility agent");
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

  const policyArtifact = resolveRobomataFacilityPolicyArtifact({
    facilityId: policy?.facilityId ?? submission.facilityMonitoring?.facilityId,
    submissionId: submission.id,
  }).artifact;

  const updatePolicyStatus = async (status: "active" | "paused" | "revoked") => {
    setIsMutating(true);
    try {
      const response = await fetch(policyPath, {
        body: JSON.stringify({
          status,
          ...(status === "revoked" ? { revocationReason: "Revoked from operator supervision panel." } : {}),
        }),
        headers: {
          "content-type": "application/json",
          ...(await getAuthHeaders({ chainId, method: "PATCH", path: policyPath, signerAddress })),
        },
        method: "PATCH",
      });
      const payload = await readJsonResponse<{ policy?: RobomataAgentPolicy }>(response);
      if (!response.ok || !payload.policy) throw new Error(payload.error ?? "Failed to update agent policy.");
      setPolicy(payload.policy);
      setAppointmentNameDraft(payload.policy.appointedAgentName ?? "Robomata supervised facility agent");
      notification.success(
        status === "active"
          ? "Robomata agent policy activated."
          : status === "revoked"
            ? "Robomata agent policy revoked."
            : "Robomata agent policy paused.",
      );
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Failed to update agent policy.");
    } finally {
      setIsMutating(false);
    }
  };

  const updateAppointment = async () => {
    setIsMutating(true);
    try {
      const response = await fetch(policyPath, {
        body: JSON.stringify({ appointedAgentName: appointmentNameDraft }),
        headers: {
          "content-type": "application/json",
          ...(await getAuthHeaders({ chainId, method: "PATCH", path: policyPath, signerAddress })),
        },
        method: "PATCH",
      });
      const payload = await readJsonResponse<{ policy?: RobomataAgentPolicy }>(response);
      if (!response.ok || !payload.policy) throw new Error(payload.error ?? "Failed to update agent appointment.");
      setPolicy(payload.policy);
      setAppointmentNameDraft(payload.policy.appointedAgentName ?? "Robomata supervised facility agent");
      notification.success("Agent appointment updated.");
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Failed to update agent appointment.");
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

  const updateAction = async (
    action: RobomataAgentAction,
    status: "approved" | "rejected" | "completed",
    options?: { execute?: boolean },
  ) => {
    setIsMutating(true);
    try {
      const path = `/api/robomata/submissions/${submission.id}/agent-actions/${action.id}`;
      const response = await fetch(path, {
        body: JSON.stringify({ ...(options?.execute ? { execute: true } : {}), status }),
        headers: {
          "content-type": "application/json",
          ...(await getAuthHeaders({ chainId, method: "PATCH", path, signerAddress })),
        },
        method: "PATCH",
      });
      const payload = await readJsonResponse<{ action?: RobomataAgentAction }>(response);
      if (payload.action) {
        setActions(current =>
          current.map(candidate => (candidate.id === payload.action?.id ? payload.action : candidate)),
        );
      }
      if (!response.ok || !payload.action) throw new Error(payload.error ?? "Failed to update agent action.");
      notification.success(
        options?.execute ? "Agent action execution recorded." : `Agent action ${formatStatus(status)}.`,
      );
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Failed to update agent action.");
    } finally {
      setIsMutating(false);
    }
  };

  if (!featureEnabled) return null;

  const latestRun = runs[0];
  const openActions = actions.filter(action => action.status === "proposed" || action.status === "approved");
  const appointedAgentName = policy?.appointedAgentName ?? "Robomata supervised facility agent";
  const appointedBy = policy?.appointedBy ?? "operator";
  const appointerAddress = policy?.appointerAddress ?? policy?.partnerAddress;
  const plannerBoundary = latestRun?.plannerBoundary;
  const latestPermissionDenial =
    policy && actions.length
      ? actions
          .map(action => {
            const storedReason = metadataValue(action, "permissionDeniedReason");
            if (storedReason) return storedReason;
            if (action.status !== "proposed" && action.status !== "approved") return null;
            return getRobomataAgentActionPermissionDenial({
              actionAuthorization: action.authorization,
              actionType: action.type,
              operation: action.status === "approved" ? "complete" : "approve",
              policy,
            });
          })
          .find((reason): reason is string => Boolean(reason))
      : null;

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
              <span className="badge badge-ghost capitalize">appointed by {formatStatus(appointedBy)}</span>
              <span className="badge badge-ghost capitalize">
                planner {formatStatus(plannerBoundary?.provider ?? "rules")}
              </span>
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
              disabled={isMutating || policy.status === "revoked"}
            >
              {policy.status === "active" ? "Pause" : "Activate"}
            </button>
          ) : null}
          {policy && policy.status !== "revoked" ? (
            <button
              className="btn btn-sm btn-outline rounded-full"
              onClick={() => updatePolicyStatus("revoked")}
              disabled={isMutating}
            >
              Revoke
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
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <div className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/50">Policy</div>
              <div className="mt-2 break-all text-sm font-semibold text-base-content">{policy.id}</div>
              <div className="mt-1 text-sm text-base-content/70">
                Updated {new Date(policy.updatedAt).toLocaleString()}
              </div>
            </div>
            <div className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/50">Appointment</div>
              <div className="mt-2 text-sm font-semibold text-base-content">{appointedAgentName}</div>
              <div className="mt-1 text-sm text-base-content/70 capitalize">
                Appointed by {formatStatus(appointedBy)}
              </div>
              <div className="mt-1 text-xs text-base-content/60 capitalize">
                Via {formatStatus(policy.appointmentAuthorizationSurface ?? "operator_submission_access")}
              </div>
              {policy.appointedAt ? (
                <div className="mt-1 text-xs text-base-content/60">
                  Appointed {new Date(policy.appointedAt).toLocaleString()}
                </div>
              ) : null}
              {appointerAddress ? (
                <div className="mt-1 break-all text-xs text-base-content/60">{appointerAddress}</div>
              ) : null}
              {policy.appointmentAuthorizationId ? (
                <div className="mt-1 break-all text-xs text-base-content/60">
                  Authorization {policy.appointmentAuthorizationId}
                </div>
              ) : null}
              {policy.revokedAt ? (
                <div className="mt-2 rounded-xl border border-error/20 bg-error/10 p-2 text-xs text-base-content/70">
                  Revoked {new Date(policy.revokedAt).toLocaleString()}
                  {policy.revocationReason ? `: ${policy.revocationReason}` : ""}
                  {policy.revocationAuthorizationSurface ? (
                    <div className="mt-1 capitalize">
                      Via {formatStatus(policy.revocationAuthorizationSurface)}
                      {policy.revokedBy ? <span className="break-all"> · {policy.revokedBy}</span> : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="mt-3 flex flex-col gap-2">
                <input
                  className="input input-bordered input-xs w-full rounded-full"
                  value={appointmentNameDraft}
                  onChange={event => setAppointmentNameDraft(event.target.value)}
                  maxLength={80}
                  disabled={isMutating || policy.status === "revoked"}
                  aria-label="Appointed agent name"
                />
                <button
                  className="btn btn-xs btn-outline rounded-full"
                  disabled={
                    isMutating || policy.status === "revoked" || appointmentNameDraft.trim() === appointedAgentName
                  }
                  onClick={updateAppointment}
                >
                  Save appointment
                </button>
              </div>
            </div>
            <div className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/50">Permissions</div>
              <div className="mt-2 text-sm font-semibold text-base-content">
                {policy.allowedActionTypes.length} allowed action types
              </div>
              <div className="mt-1 text-xs text-base-content/60">
                Allowed: {formatActionTypes(policy.allowedActionTypes)}
              </div>
              <div className="mt-2 text-xs text-base-content/60">
                Auto-approved: {formatActionTypes(policy.autoApproveActionTypes)}
              </div>
              <div
                className={`mt-3 rounded-xl border p-2 text-xs ${
                  latestPermissionDenial
                    ? "border-warning/30 bg-warning/10 text-warning-content"
                    : "border-base-300 bg-base-100 text-base-content/60"
                }`}
              >
                <div className="font-semibold text-base-content">Latest permission denial</div>
                <div className="mt-1">{latestPermissionDenial ?? "No current permission denial recorded."}</div>
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
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/50">Planner</div>
              <div className="mt-2 text-sm font-semibold text-base-content capitalize">
                {formatStatus(plannerBoundary?.provider ?? "rules")}
              </div>
              <div className="mt-1 text-sm text-base-content/70 capitalize">
                {plannerBoundary ? formatStatus(plannerBoundary.mode) : "deterministic rules"}
              </div>
              <div className="mt-1 text-xs text-base-content/60 capitalize">
                {plannerBoundary ? formatStatus(plannerBoundary.status) : "no run yet"}
              </div>
              {plannerBoundary?.model ? (
                <div className="mt-1 break-all text-xs text-base-content/60">{plannerBoundary.model}</div>
              ) : null}
            </div>
            <div className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/50">Open actions</div>
              <div className="mt-2 text-sm font-semibold text-base-content">
                {openActions.length} proposed or approved
              </div>
              <div className="mt-1 text-sm text-base-content/70">{actions.length} total retained</div>
            </div>
          </div>

          <AgentSupervisionPolicyDisclosure
            allowedActionTypes={policy.allowedActionTypes}
            policyArtifact={policyArtifact}
          />

          <div className="space-y-3">
            {actions.length ? (
              actions.slice(0, 6).map(action => {
                const permissionDeniedReason = metadataValue(action, "permissionDeniedReason");
                const executionStatus = metadataValue(action, "executionStatus");
                const actionGateDeniedReason = getRobomataAgentActionPermissionDenial({
                  actionAuthorization: action.authorization,
                  actionType: action.type,
                  operation: action.status === "approved" ? "complete" : "approve",
                  policy,
                });
                const actionAuthorization = action.authorization;
                const canExecuteAction =
                  executionClientEnabled &&
                  action.status === "approved" &&
                  CLIENT_EXECUTABLE_AGENT_ACTION_TYPES.has(action.type);
                const executeDeniedReason =
                  action.status === "approved" && CLIENT_EXECUTABLE_AGENT_ACTION_TYPES.has(action.type)
                    ? getRobomataAgentActionPermissionDenial({
                        actionAuthorization: action.authorization,
                        actionType: action.type,
                        executionEnabled: executionClientEnabled,
                        operation: "execute",
                        policy,
                      })
                    : null;

                return (
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
                    <div className="mt-1 text-xs text-base-content/60 capitalize">
                      Planner: {formatStatus(metadataValue(action, "plannerProvider") ?? "rules")} /{" "}
                      {formatStatus(metadataValue(action, "proposalSource") ?? "deterministic_rules")}
                    </div>
                    <div className="mt-1 text-xs text-base-content/60 capitalize">
                      Authorized by {formatStatus(actionAuthorization?.appointedBy ?? "unknown")} /{" "}
                      {formatStatus(actionAuthorization?.appointmentAuthorizationSurface ?? "missing authorization")}
                    </div>
                    <div className="mt-1 break-all text-xs text-base-content/60">
                      Historical authorization: {actionAuthorization?.appointedAgentName ?? "unknown agent"} · policy{" "}
                      {actionAuthorization?.policyId ?? "missing policy"} ·{" "}
                      {actionAuthorization?.appointmentAuthorizationId ?? "missing authorization id"}
                    </div>
                    {executionStatus ? (
                      <div className="mt-2 rounded-2xl border border-base-300 bg-base-100 p-3 text-xs text-base-content/70">
                        Execution {formatStatus(executionStatus)} via{" "}
                        {metadataValue(action, "executionTool") ?? "unknown tool"} · input{" "}
                        {metadataValue(action, "executionInputDigest")?.slice(0, 12) ?? "n/a"} · output{" "}
                        {metadataValue(action, "executionOutputDigest")?.slice(0, 12) ?? "n/a"}
                        {metadataValue(action, "executionFailureReason") ? (
                          <span className="block text-error">{metadataValue(action, "executionFailureReason")}</span>
                        ) : null}
                      </div>
                    ) : null}
                    {permissionDeniedReason ? (
                      <div className="mt-2 rounded-2xl border border-warning/30 bg-warning/10 p-3 text-xs text-warning-content">
                        Permission gate skipped this action: {permissionDeniedReason}
                      </div>
                    ) : action.status === "proposed" || action.status === "approved" ? (
                      actionGateDeniedReason ? (
                        <div className="mt-2 rounded-2xl border border-warning/30 bg-warning/10 p-3 text-xs text-warning-content">
                          Current permission gate blocks this action: {actionGateDeniedReason}
                        </div>
                      ) : null
                    ) : null}
                    <div className="mt-2 text-sm text-base-content/70">{action.reason}</div>
                    {action.status === "proposed" ? (
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          className="btn btn-xs btn-outline rounded-full"
                          disabled={isMutating || Boolean(actionGateDeniedReason)}
                          onClick={() => updateAction(action, "approved")}
                          title={actionGateDeniedReason ?? undefined}
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
                      <div className="mt-4 flex flex-wrap gap-2">
                        {canExecuteAction ? (
                          <button
                            className="btn btn-xs btn-primary rounded-full"
                            disabled={isMutating || Boolean(executeDeniedReason)}
                            onClick={() => updateAction(action, "completed", { execute: true })}
                            title={executeDeniedReason ?? undefined}
                          >
                            Execute audit
                          </button>
                        ) : null}
                        <button
                          className="btn btn-xs btn-outline rounded-full"
                          disabled={isMutating || Boolean(actionGateDeniedReason)}
                          onClick={() => updateAction(action, "completed")}
                          title={actionGateDeniedReason ?? undefined}
                        >
                          Mark complete
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })
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
