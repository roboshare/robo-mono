"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowPathIcon, CheckCircleIcon, CircleStackIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { isRobomataFacilityMonitoringClientEnabled } from "~~/lib/featureFlags";
import { formatUsd } from "~~/lib/robomata/borrowingBase";
import type {
  FacilityMonitoringProjection,
  FacilityMonitoringStatus,
  FacilityObservation,
  FacilityObservationStatus,
  PacketFreshnessStatus,
  PacketManifest,
  SuiRootVerificationStatus,
} from "~~/lib/robomata/facilityMonitoring";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";
import { notification } from "~~/utils/scaffold-eth";

type FacilityMonitoringPanelProps = {
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

function statusBadgeClass(
  status: FacilityMonitoringStatus | PacketFreshnessStatus | SuiRootVerificationStatus | string,
) {
  if (["fresh", "packet_fresh", "verified", "commit_verified", "locked", "committed"].includes(status)) {
    return "badge-success";
  }
  if (
    [
      "stale",
      "packet_stale",
      "refresh_available",
      "pending",
      "committing",
      "commit_pending",
      "computed",
      "medium",
    ].includes(status)
  ) {
    return "badge-warning";
  }
  if (["invalid", "failed", "mismatch", "high"].includes(status)) return "badge-error";
  return "badge-ghost";
}

function observationBadgeClass(status: FacilityObservationStatus) {
  if (status === "fresh") return "badge-success";
  if (["stale", "expired", "warning", "pending"].includes(status)) return "badge-warning";
  if (status === "exception") return "badge-error";
  return "badge-ghost";
}

function formatStatus(value: string) {
  return value.replace(/_/g, " ");
}

function formatDateTime(value: string | undefined) {
  return value ? new Date(value).toLocaleString() : "Not available";
}

function shortDigest(value: string | undefined) {
  if (!value) return "Not available";
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function packetForRun(packetManifests: PacketManifest[], runId: string) {
  return packetManifests.find(packet => packet.runId === runId);
}

function observationLinkSummary(observation: FacilityObservation) {
  const parts = [];
  if (observation.linkedReceivableIds.length) parts.push(`${observation.linkedReceivableIds.length} receivables`);
  if (observation.linkedAssetIds.length) parts.push(`${observation.linkedAssetIds.length} assets`);
  return parts.length ? parts.join(" / ") : "No linked receivables or assets";
}

export const FacilityMonitoringPanel = ({
  chainId,
  getAuthHeaders,
  signerAddress,
  submission,
}: FacilityMonitoringPanelProps) => {
  const featureEnabled = isRobomataFacilityMonitoringClientEnabled();
  const [projection, setProjection] = useState<FacilityMonitoringProjection | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [serverUnavailable, setServerUnavailable] = useState(false);
  const loadSequenceRef = useRef(0);

  const loadMonitoring = useCallback(async () => {
    if (!featureEnabled) return;

    const path = `/api/robomata/submissions/${submission.id}/facility-monitoring`;
    const loadSequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadSequence;
    const isCurrentLoad = () => loadSequenceRef.current === loadSequence;
    setIsLoading(true);
    setServerUnavailable(false);
    setProjection(null);
    try {
      const response = await fetch(path, {
        headers: await getAuthHeaders({ chainId, method: "GET", path, signerAddress }),
      });
      const payload = await readJsonResponse<{ monitoring?: FacilityMonitoringProjection }>(response);

      if (!isCurrentLoad()) return;
      if (response.status === 404) {
        setProjection(null);
        setServerUnavailable(true);
        return;
      }
      if (!response.ok || !payload.monitoring) {
        throw new Error(payload.error ?? "Failed to load facility monitoring.");
      }

      setProjection(payload.monitoring);
    } catch (error) {
      if (!isCurrentLoad()) return;
      setProjection(null);
      notification.error(error instanceof Error ? error.message : "Failed to load facility monitoring.");
    } finally {
      if (isCurrentLoad()) setIsLoading(false);
    }
  }, [chainId, featureEnabled, getAuthHeaders, signerAddress, submission.id]);

  useEffect(() => {
    void loadMonitoring();
  }, [loadMonitoring, submission.updatedAt]);

  if (!featureEnabled) return null;

  return (
    <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
            <CircleStackIcon className="h-4 w-4" />
            Facility monitor
          </div>
          {projection ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <span className={`badge ${statusBadgeClass(projection.facility.status)} capitalize`}>
                {formatStatus(projection.facility.status)}
              </span>
              <span className={`badge ${statusBadgeClass(projection.freshnessStatus)} capitalize`}>
                packet {formatStatus(projection.freshnessStatus)}
              </span>
              <span className={`badge ${statusBadgeClass(projection.suiRootStatus)} capitalize`}>
                Sui {formatStatus(projection.suiRootStatus)}
              </span>
            </div>
          ) : null}
        </div>
        <button className="btn btn-sm btn-outline rounded-full" onClick={loadMonitoring} disabled={isLoading}>
          <ArrowPathIcon className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {serverUnavailable ? (
        <div className="mt-4 rounded-[1.5rem] border border-warning/20 bg-warning/10 p-4 text-sm text-base-content/70">
          Monitoring is not enabled on this server.
        </div>
      ) : projection ? (
        <div className="mt-5 space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/50">Facility</div>
              <div className="mt-2 break-all text-sm font-semibold text-base-content">{projection.facility.id}</div>
              <div className="mt-1 text-sm text-base-content/70">
                Updated {new Date(projection.facility.updatedAt).toLocaleString()}
              </div>
            </div>
            <div className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/50">Latest run</div>
              <div className="mt-2 break-all text-sm font-semibold text-base-content">
                {projection.latestRun?.id ?? "Not computed"}
              </div>
              <div className="mt-1 text-sm text-base-content/70">
                {projection.latestRun ? `As of ${projection.latestRun.asOfDate}` : "Waiting on borrowing base"}
              </div>
            </div>
            <div className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/50">Packet</div>
              <div className="mt-2 break-all text-sm font-semibold text-base-content">
                {projection.latestPacket?.id ?? "Not generated"}
              </div>
              <div className="mt-1 text-sm text-base-content/70">
                {projection.latestPacket ? `Generated ${projection.latestPacket.generatedAt}` : "No packet yet"}
              </div>
            </div>
          </div>

          {projection.warnings.length ? (
            <div className="rounded-[1.5rem] border border-warning/20 bg-warning/10 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-base-content">
                <ExclamationTriangleIcon className="h-4 w-4" />
                Monitoring warnings
              </div>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-base-content/70">
                {projection.warnings.map(warning => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="rounded-[1.5rem] border border-success/20 bg-success/10 p-4 text-sm text-base-content/70">
              <div className="flex items-center gap-2 font-semibold text-base-content">
                <CheckCircleIcon className="h-4 w-4" />
                No monitoring warnings
              </div>
            </div>
          )}

          {projection.latestRun?.exceptions.length ? (
            <div className="rounded-[1.5rem] border border-error/20 bg-error/10 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-base-content">
                <ExclamationTriangleIcon className="h-4 w-4" />
                Open run exceptions
              </div>
              <div className="mt-3 grid gap-2">
                {projection.latestRun.exceptions.map(exception => (
                  <div
                    key={exception.id}
                    className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-error/10 bg-base-100/70 p-3 text-sm"
                  >
                    <div>
                      <div className="font-semibold text-base-content">{exception.message}</div>
                      <div className="mt-1 text-base-content/60">
                        {exception.kind} - action {formatStatus(exception.actionStatus)}
                      </div>
                    </div>
                    <span className={`badge ${statusBadgeClass(exception.severity)} capitalize`}>
                      {formatStatus(exception.severity)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-base-content">Immutable run history</div>
                <div className="mt-1 text-sm text-base-content/60">
                  {projection.runHistory.length} run{projection.runHistory.length === 1 ? "" : "s"} retained for this
                  facility.
                </div>
              </div>
              <span className={`badge ${statusBadgeClass(projection.freshnessStatus)} capitalize`}>
                latest packet {formatStatus(projection.freshnessStatus)}
              </span>
            </div>

            {projection.runHistory.length ? (
              <div className="mt-4 overflow-x-auto">
                <table className="table table-sm">
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>As of</th>
                      <th>Availability</th>
                      <th>Inputs</th>
                      <th>Packet</th>
                      <th>Root</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projection.runHistory.map(run => {
                      const packet = packetForRun(projection.packetManifests, run.id);
                      return (
                        <tr key={run.id}>
                          <td>
                            <div className="break-all font-semibold text-base-content">{run.id}</div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              <span className={`badge badge-xs ${statusBadgeClass(run.status)} capitalize`}>
                                {formatStatus(run.status)}
                              </span>
                              <span className="badge badge-ghost badge-xs">
                                {run.exceptions.length} exception{run.exceptions.length === 1 ? "" : "s"}
                              </span>
                            </div>
                          </td>
                          <td>
                            <div>{run.asOfDate}</div>
                            <div className="text-xs text-base-content/60">Locked {formatDateTime(run.lockedAt)}</div>
                          </td>
                          <td>{formatUsd(run.borrowingBase.availableBorrowingBaseCents)}</td>
                          <td>{run.inputObservationIds.length}</td>
                          <td>
                            <div className="break-all text-xs">{packet?.id ?? "No packet"}</div>
                            {packet ? (
                              <span className={`badge badge-xs ${statusBadgeClass(packet.freshnessStatus)} capitalize`}>
                                {formatStatus(packet.freshnessStatus)}
                              </span>
                            ) : null}
                          </td>
                          <td className="break-all text-xs" title={run.rootDigest || run.inputDigest}>
                            {shortDigest(run.rootDigest || run.inputDigest)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mt-4 rounded-xl border border-dashed border-base-300 p-3 text-sm text-base-content/60">
                No borrowing-base run has been locked for this facility yet.
              </div>
            )}
          </div>

          <div className="space-y-3">
            {projection.observations.length ? (
              projection.observations.map(observation => (
                <div key={observation.id} className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold capitalize text-base-content">{formatStatus(observation.kind)}</div>
                      <div className="mt-1 text-sm text-base-content/70">
                        {observation.source} - observed {new Date(observation.observedAt).toLocaleString()}
                      </div>
                    </div>
                    <span className={`badge ${observationBadgeClass(observation.status)} capitalize`}>
                      {formatStatus(observation.status)}
                    </span>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-base-content/60 sm:grid-cols-2">
                    <div>{observationLinkSummary(observation)}</div>
                    <div>Confidence: {formatStatus(observation.confidence)}</div>
                    <div>Effective: {formatDateTime(observation.effectiveAt)}</div>
                    <div>Expires: {formatDateTime(observation.expiresAt)}</div>
                    {observation.supersedesObservationId ? (
                      <div className="break-all">Supersedes: {observation.supersedesObservationId}</div>
                    ) : null}
                    {observation.storageRef ? <div className="break-all">Storage: {observation.storageRef}</div> : null}
                  </div>
                  {observation.notes ? (
                    <div className="mt-2 text-xs text-base-content/60">{observation.notes}</div>
                  ) : null}
                  <div className="mt-3 break-all text-xs text-base-content/60">Digest: {observation.digest}</div>
                </div>
              ))
            ) : (
              <div className="rounded-[1.5rem] border border-dashed border-base-300 p-4 text-sm text-base-content/60">
                No monitoring observations yet.
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-[1.5rem] border border-dashed border-base-300 p-4 text-sm text-base-content/60">
          {isLoading ? "Loading facility monitoring..." : "No monitoring projection loaded."}
        </div>
      )}
    </section>
  );
};
