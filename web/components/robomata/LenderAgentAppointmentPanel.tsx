"use client";

import { useState } from "react";
import { ShieldCheckIcon } from "@heroicons/react/24/outline";
import type { RobomataAgentPolicy } from "~~/lib/robomata/agents";
import type { SharedLenderPacketView } from "~~/lib/robomata/shareLinks";

type LenderAgentAppointment = NonNullable<SharedLenderPacketView["agentAppointment"]>;

type LenderAgentAppointmentPanelProps = {
  appointment?: LenderAgentAppointment;
  shareToken: string;
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

function statusBadgeClass(status?: string) {
  if (status === "active") return "badge-success";
  if (status === "paused") return "badge-warning";
  if (status === "revoked") return "badge-error";
  return "badge-ghost";
}

export function LenderAgentAppointmentPanel({ appointment, shareToken }: LenderAgentAppointmentPanelProps) {
  const flags = appointment?.flags ?? {
    agentsEnabled: false,
    lenderAppointmentEnabled: false,
    mutationsEnabled: false,
    shareLinksEnabled: false,
  };
  const canMutate =
    flags.agentsEnabled && flags.lenderAppointmentEnabled && flags.mutationsEnabled && flags.shareLinksEnabled;
  const [draftName, setDraftName] = useState(
    appointment?.policy?.appointedAgentName ?? "Lender-appointed Robomata facility agent",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [policy, setPolicy] = useState(appointment?.policy);

  const updateAppointment = async (input: { appointedAgentName?: string; status?: "revoked" }) => {
    setErrorMessage(null);
    setIsSaving(true);
    try {
      const response = await fetch(`/api/robomata/share/${encodeURIComponent(shareToken)}/agent-policy`, {
        body: JSON.stringify({
          ...input,
          ...(input.status === "revoked" ? { revocationReason: "Revoked from protected lender packet share." } : {}),
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      const payload = await readJsonResponse<{ policy?: RobomataAgentPolicy }>(response);
      if (!response.ok || !payload.policy) {
        throw new Error(payload.error ?? "Failed to update lender agent appointment.");
      }
      setPolicy(payload.policy);
      setDraftName(payload.policy.appointedAgentName ?? draftName);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update lender agent appointment.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-base-300 bg-base-200/50 p-4 text-sm leading-relaxed text-base-content/70">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-semibold text-base-content">
            <ShieldCheckIcon className="h-4 w-4 text-primary" />
            Lender agent appointment
          </div>
          <div className="mt-1">
            This share link can appoint a lender-side supervised agent only when the lender appointment flag is enabled.
          </div>
        </div>
        <div className={`badge ${statusBadgeClass(policy?.status)} capitalize`}>
          {policy?.status ?? "not appointed"}
        </div>
      </div>

      <div className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
        <div>Agents: {flags.agentsEnabled ? "enabled" : "disabled"}</div>
        <div>Lender appointment: {flags.lenderAppointmentEnabled ? "enabled" : "disabled"}</div>
        <div>Mutations: {flags.mutationsEnabled ? "enabled" : "disabled"}</div>
        <div>Share links: {flags.shareLinksEnabled ? "enabled" : "disabled"}</div>
      </div>

      {policy ? (
        <div className="mt-4 rounded-xl border border-base-300 bg-base-100 p-3">
          <div className="font-semibold text-base-content">{policy.appointedAgentName}</div>
          <div className="mt-1 text-xs text-base-content/60">
            Appointed by {formatStatus(policy.appointedBy ?? "operator")} ·{" "}
            {formatStatus(policy.appointmentAuthorizationSurface ?? "operator_submission_access")}
          </div>
          <div className="mt-1 break-all text-xs text-base-content/60">Policy: {policy.id}</div>
          {policy.revokedAt ? (
            <div className="mt-2 rounded-xl border border-error/20 bg-error/10 p-2 text-xs text-base-content/70">
              Revoked {policy.revokedAt}
              {policy.revocationReason ? `: ${policy.revocationReason}` : ""}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-dashed border-base-300 bg-base-100 p-3 text-xs text-base-content/60">
          No lender appointment has been recorded for this packet yet.
        </div>
      )}

      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <input
          className="input input-bordered input-sm min-w-0 flex-1 rounded-full"
          disabled={!canMutate || isSaving}
          maxLength={80}
          onChange={event => setDraftName(event.target.value)}
          placeholder="Lender-appointed agent name"
          value={draftName}
        />
        <button
          className="btn btn-primary btn-sm rounded-full"
          disabled={!canMutate || isSaving || !draftName.trim() || policy?.status === "revoked"}
          onClick={() => updateAppointment({ appointedAgentName: draftName })}
          type="button"
        >
          {isSaving ? "Saving..." : "Save appointment"}
        </button>
        {policy?.status !== "revoked" ? (
          <button
            className="btn btn-outline btn-sm rounded-full"
            disabled={!canMutate || isSaving || !policy}
            onClick={() => updateAppointment({ status: "revoked" })}
            type="button"
          >
            Revoke
          </button>
        ) : null}
      </div>

      {!canMutate ? (
        <div className="mt-3 text-xs text-base-content/60">
          Lender appointment is read-only until share links, agents, agent mutations, and lender appointment are all
          enabled on the server.
        </div>
      ) : null}
      {errorMessage ? <div className="mt-3 text-xs text-error">{errorMessage}</div> : null}
    </div>
  );
}
