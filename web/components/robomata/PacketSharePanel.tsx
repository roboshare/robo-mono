"use client";

import { useCallback, useEffect, useState } from "react";
import { ClipboardDocumentIcon, LinkIcon } from "@heroicons/react/24/outline";
import { isRobomataShareLinksClientEnabled } from "~~/lib/featureFlags";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";
import { notification } from "~~/utils/scaffold-eth";

type ShareLinkResponse = {
  id: string;
  submissionId: string;
  status: "active" | "revoked" | "expired";
  recipientLabel?: string;
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
  lastAccessedAt?: string;
  accessCount: number;
  metadata?: Record<string, string | number | boolean | null>;
};

type CreateShareLinkResponse = {
  shareLink?: ShareLinkResponse;
  token?: string;
  url?: string;
  apiUrl?: string;
  error?: string;
};

type PacketSharePanelProps = {
  chainId: number;
  getAuthHeaders: (input: {
    chainId?: number;
    method?: string;
    path?: string;
    signerAddress?: string;
  }) => Promise<Record<string, string>>;
  isBusy: boolean;
  setIsBusy: (value: boolean) => void;
  signerAddress?: string;
  submission: FacilitySubmission;
};

function statusBadgeClass(status: ShareLinkResponse["status"]) {
  if (status === "active") return "badge-success";
  if (status === "revoked") return "badge-error";
  if (status === "expired") return "badge-warning";
  return "badge-ghost";
}

function monitoringRunId(link: ShareLinkResponse) {
  const runId = link.metadata?.runId;
  return typeof runId === "string" && runId.trim() ? runId : undefined;
}

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

export const PacketSharePanel = ({
  chainId,
  getAuthHeaders,
  isBusy,
  setIsBusy,
  signerAddress,
  submission,
}: PacketSharePanelProps) => {
  const [shareLinks, setShareLinks] = useState<ShareLinkResponse[]>([]);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [recipientLabel, setRecipientLabel] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const featureEnabled = isRobomataShareLinksClientEnabled();
  const canShare = featureEnabled && Boolean(submission.computation?.lenderPacket);

  const loadShareLinks = useCallback(async () => {
    if (!canShare) return;

    const path = `/api/robomata/submissions/${submission.id}/share-links`;
    setIsLoading(true);
    try {
      const response = await fetch(path, {
        headers: await getAuthHeaders({ chainId, method: "GET", path, signerAddress }),
      });
      const payload = await readJsonResponse<{ shareLinks?: ShareLinkResponse[] }>(response);
      if (!response.ok) throw new Error(payload.error ?? "Failed to load lender packet links.");
      setShareLinks(payload.shareLinks ?? []);
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Failed to load lender packet links.");
    } finally {
      setIsLoading(false);
    }
  }, [canShare, chainId, getAuthHeaders, signerAddress, submission.id]);

  useEffect(() => {
    void loadShareLinks();
  }, [loadShareLinks]);

  if (!featureEnabled) return null;

  const createShareLink = async () => {
    if (!canShare) {
      notification.error("Compute the lender packet before creating a share link.");
      return;
    }

    const path = `/api/robomata/submissions/${submission.id}/share-links`;
    setIsBusy(true);
    try {
      const body = {
        ...(recipientLabel.trim() ? { recipientLabel: recipientLabel.trim() } : {}),
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      };
      const headers = new Headers({ "content-type": "application/json" });
      const authHeaders = await getAuthHeaders({ chainId, method: "POST", path, signerAddress });
      Object.entries(authHeaders).forEach(([key, value]) => headers.set(key, value));
      const response = await fetch(path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const payload = await readJsonResponse<CreateShareLinkResponse>(response);
      if (!response.ok || !payload.shareLink || !payload.url) {
        throw new Error(payload.error ?? "Failed to create lender packet link.");
      }

      setCreatedUrl(payload.url);
      setRecipientLabel("");
      setExpiresAt("");
      await navigator.clipboard?.writeText(payload.url).catch(() => undefined);
      notification.success("Lender packet link created.");
      await loadShareLinks();
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Failed to create lender packet link.");
    } finally {
      setIsBusy(false);
    }
  };

  const revokeShareLink = async (shareLinkId: string) => {
    const path = `/api/robomata/submissions/${submission.id}/share-links/${shareLinkId}`;
    setIsBusy(true);
    try {
      const headers = new Headers({ "content-type": "application/json" });
      const authHeaders = await getAuthHeaders({ chainId, method: "PATCH", path, signerAddress });
      Object.entries(authHeaders).forEach(([key, value]) => headers.set(key, value));
      const response = await fetch(path, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "revoked" }),
      });
      const payload = await readJsonResponse<{ shareLink?: ShareLinkResponse }>(response);
      if (!response.ok || !payload.shareLink) {
        throw new Error(payload.error ?? "Failed to revoke lender packet link.");
      }

      notification.success("Lender packet link revoked.");
      await loadShareLinks();
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Failed to revoke lender packet link.");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-[1.5rem] border border-base-300 bg-base-200/50 p-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2 break-words text-sm font-semibold text-base-content">
            <LinkIcon className="h-4 w-4" />
            Protected lender packet links
          </div>
          <p className="mt-2 break-words text-sm leading-relaxed text-base-content/70">
            Create an opaque, expiring packet link for one lender. The link is bearer-style access, so revoke it when
            diligence is complete.
          </p>
        </div>
        <button
          className="btn btn-sm btn-outline h-auto min-h-8 max-w-full whitespace-normal rounded-full text-center"
          onClick={loadShareLinks}
          disabled={isLoading || isBusy}
        >
          Refresh
        </button>
      </div>

      {canShare ? (
        <div className="mt-4 grid min-w-0 max-w-full gap-3 md:grid-cols-[1fr_0.8fr_auto]">
          <input
            className="input input-bordered w-full min-w-0 max-w-full"
            placeholder="Recipient label, e.g. Lender credit team"
            value={recipientLabel}
            onChange={event => setRecipientLabel(event.target.value)}
            disabled={isBusy}
          />
          <input
            className="input input-bordered w-full min-w-0 max-w-full"
            type="datetime-local"
            value={expiresAt}
            onChange={event => setExpiresAt(event.target.value)}
            disabled={isBusy}
          />
          <button
            className="btn btn-primary h-auto min-h-10 w-full min-w-0 max-w-full whitespace-normal rounded-full text-center md:w-auto"
            onClick={createShareLink}
            disabled={isBusy}
          >
            Create link
          </button>
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-warning/20 bg-warning/10 p-3 text-sm text-base-content/70">
          Compute the lender packet before creating a protected share link.
        </div>
      )}

      {createdUrl ? (
        <div className="mt-4 rounded-2xl border border-success/20 bg-success/10 p-3 text-sm">
          <div className="font-semibold text-base-content">Created link</div>
          <div className="mt-1 break-all text-base-content/70">{createdUrl}</div>
          <button
            className="btn btn-xs btn-outline mt-3 rounded-full"
            onClick={() => navigator.clipboard?.writeText(createdUrl)}
          >
            <ClipboardDocumentIcon className="h-3 w-3" />
            Copy again
          </button>
        </div>
      ) : null}

      <div className="mt-4 space-y-3">
        {shareLinks.length ? (
          shareLinks.map(link => (
            <div key={link.id} className="min-w-0 overflow-hidden rounded-2xl border border-base-300 bg-base-100 p-4">
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="break-words font-semibold text-base-content">
                    {link.recipientLabel ?? "Lender packet link"}
                  </div>
                  <div className="mt-1 break-words text-xs text-base-content/60">
                    Expires {link.expiresAt} · {link.accessCount} views
                    {link.lastAccessedAt ? ` · last accessed ${link.lastAccessedAt}` : ""}
                  </div>
                  {monitoringRunId(link) ? (
                    <div className="mt-1 break-all text-xs text-base-content/60">
                      Pinned run: {monitoringRunId(link)}
                    </div>
                  ) : null}
                </div>
                <div className={`badge ${statusBadgeClass(link.status)} capitalize`}>{link.status}</div>
              </div>
              {link.status === "active" ? (
                <button
                  className="btn btn-sm btn-outline mt-3 rounded-full"
                  onClick={() => revokeShareLink(link.id)}
                  disabled={isBusy}
                >
                  Revoke link
                </button>
              ) : null}
            </div>
          ))
        ) : (
          <div className="rounded-2xl border border-dashed border-base-300 p-4 text-sm text-base-content/60">
            {isLoading ? "Loading lender packet links..." : "No lender packet links have been created yet."}
          </div>
        )}
      </div>
    </div>
  );
};
