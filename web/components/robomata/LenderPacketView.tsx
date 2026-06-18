import {
  BanknotesIcon,
  ClipboardDocumentCheckIcon,
  DocumentTextIcon,
  ExclamationTriangleIcon,
  LockClosedIcon,
} from "@heroicons/react/24/outline";
import {
  BorrowingBasePolicyDisclosure,
  PacketFreshnessPolicyDisclosure,
} from "~~/components/robomata/PolicyRulesPanel";
import { ReviewBoundaryPanel } from "~~/components/robomata/ReviewBoundaryPanel";
import { formatPercentFromBps, formatUsd } from "~~/lib/robomata/borrowingBase";
import type { SharedLenderPacketView } from "~~/lib/robomata/shareLinks";

type LenderPacketViewProps = {
  packet: SharedLenderPacketView;
};

function evidenceBadgeClass(status: string) {
  if (status === "verified") return "badge-success";
  if (status === "exception") return "badge-error";
  if (status === "pending") return "badge-warning";
  return "badge-ghost";
}

function shareStatusClass(status: string) {
  if (status === "active") return "badge-success";
  if (status === "expired") return "badge-warning";
  if (status === "revoked") return "badge-error";
  return "badge-ghost";
}

function freshnessBadgeClass(status: string) {
  if (status === "fresh") return "badge-success";
  if (["stale", "superseded", "refresh_available"].includes(status)) return "badge-warning";
  if (status === "invalid") return "badge-error";
  return "badge-ghost";
}

function formatStatus(value: string) {
  return value.replace(/_/g, " ");
}

export const LenderPacketView = ({ packet }: LenderPacketViewProps) => {
  const { borrowingBase } = packet;

  return (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Lender packet</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-base-content">
              {packet.submission.facilityName}
            </h1>
            <p className="mt-2 text-base text-base-content/70">
              {packet.submission.operatorName} · as of {packet.submission.asOfDate}
            </p>
          </div>
          <div className={`badge ${shareStatusClass(packet.shareLink.status)} gap-2 px-3 py-3 capitalize`}>
            {packet.shareLink.status}
          </div>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-4">
          <div className="rounded-2xl border border-base-300 bg-base-200/50 p-4">
            <BanknotesIcon className="h-5 w-5 text-primary" />
            <div className="mt-3 text-xs uppercase tracking-[0.16em] text-base-content/50">Availability</div>
            <div className="mt-1 text-xl font-black text-base-content">
              {formatUsd(borrowingBase.availableBorrowingBaseCents)}
            </div>
          </div>
          <div className="rounded-2xl border border-base-300 bg-base-200/50 p-4">
            <ClipboardDocumentCheckIcon className="h-5 w-5 text-primary" />
            <div className="mt-3 text-xs uppercase tracking-[0.16em] text-base-content/50">Eligible</div>
            <div className="mt-1 text-xl font-black text-base-content">
              {formatUsd(borrowingBase.eligibleReceivablesCents)}
            </div>
          </div>
          <div className="rounded-2xl border border-base-300 bg-base-200/50 p-4">
            <DocumentTextIcon className="h-5 w-5 text-primary" />
            <div className="mt-3 text-xs uppercase tracking-[0.16em] text-base-content/50">Advance rate</div>
            <div className="mt-1 text-xl font-black text-base-content">
              {formatPercentFromBps(borrowingBase.portfolio.advanceRateBps)}
            </div>
          </div>
          <div className="rounded-2xl border border-base-300 bg-base-200/50 p-4">
            <ExclamationTriangleIcon className="h-5 w-5 text-primary" />
            <div className="mt-3 text-xs uppercase tracking-[0.16em] text-base-content/50">Exceptions</div>
            <div className="mt-1 text-xl font-black text-base-content">{borrowingBase.exceptionCount}</div>
          </div>
        </div>
        <div className="mt-5 rounded-2xl border border-base-300 bg-base-200/50 p-4 text-sm leading-relaxed text-base-content/70">
          <div className="font-semibold text-base-content">{packet.lenderPacket.certificateId}</div>
          <div className="mt-2">{packet.lenderPacket.certificationStatement}</div>
          <div className="mt-3 text-xs uppercase tracking-[0.16em] text-base-content/50">
            Expires {packet.shareLink.expiresAt}
          </div>
          {packet.shareLink.lastAccessedAt ? (
            <div className="mt-1 text-xs text-base-content/60">
              Last accessed {packet.shareLink.lastAccessedAt} · {packet.shareLink.accessCount} views
            </div>
          ) : null}
        </div>
        <div className="mt-5">
          <ReviewBoundaryPanel boundary={packet.lenderPacket.reviewBoundary} />
        </div>
        <div className="mt-5">
          <BorrowingBasePolicyDisclosure />
        </div>
        {packet.monitoring ? (
          <div className="mt-5 rounded-2xl border border-base-300 bg-base-200/50 p-4 text-sm leading-relaxed text-base-content/70">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-base-content">Packet freshness</div>
                <div className="mt-1">
                  This lender packet is pinned to borrowing-base run{" "}
                  <span className="break-all font-mono text-xs">{packet.monitoring.runId}</span>.
                </div>
              </div>
              <div className={`badge ${freshnessBadgeClass(packet.monitoring.packetFreshnessStatus)} capitalize`}>
                {formatStatus(packet.monitoring.packetFreshnessStatus)}
              </div>
            </div>
            <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
              <div>Packet manifest: {packet.monitoring.packetManifestId}</div>
              <div>Generated: {packet.monitoring.packetGeneratedAt}</div>
              {packet.monitoring.currentPacketFreshnessStatus ? (
                <div>Current status: {formatStatus(packet.monitoring.currentPacketFreshnessStatus)}</div>
              ) : null}
              {packet.monitoring.runRootDigest ? (
                <div className="break-all">Run root: {packet.monitoring.runRootDigest}</div>
              ) : null}
            </div>
            <div className="mt-4">
              <PacketFreshnessPolicyDisclosure />
            </div>
          </div>
        ) : null}
      </section>

      <section className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <div className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Exception memo</p>
          <h2 className="mt-2 text-2xl font-black text-base-content">Borrower follow-up packet</h2>
          <p className="mt-3 text-sm leading-relaxed text-base-content/70">{packet.lenderPacket.memoSummary}</p>
          <div className="mt-5 space-y-3">
            {packet.lenderPacket.exceptionSections.length ? (
              packet.lenderPacket.exceptionSections.map(section => (
                <div key={section.title} className="rounded-2xl border border-base-300 bg-base-200/50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-semibold text-base-content">{section.title}</div>
                    <div className="badge badge-ghost">{section.count}</div>
                  </div>
                  <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-base-content/70">
                    {section.items.map(item => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-success/20 bg-success/10 p-4 text-sm text-base-content/70">
                No open exception sections are present in this packet.
              </div>
            )}
          </div>
        </div>

        <div className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Evidence</p>
          <h2 className="mt-2 text-2xl font-black text-base-content">Controlled evidence status</h2>
          <div className="mt-5 space-y-3">
            {packet.evidence.map(evidence => (
              <div key={evidence.id} className="rounded-2xl border border-base-300 bg-base-200/50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-base-content">{evidence.filename}</div>
                    <div className="mt-1 text-sm text-base-content/60">{evidence.scope}</div>
                  </div>
                  <div className={`badge ${evidenceBadgeClass(evidence.status)} capitalize`}>{evidence.status}</div>
                </div>
                <div className="mt-3 text-xs text-base-content/60">
                  Uploaded {evidence.uploadedAt} · {evidence.storageBackend} · {evidence.encryptionBackend}
                </div>
                <details className="mt-3 rounded-xl border border-base-300 bg-base-100 p-3">
                  <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-base-content">
                    <LockClosedIcon className="h-4 w-4" />
                    Advanced evidence details
                  </summary>
                  <div className="mt-3 space-y-2 break-all text-xs text-base-content/60">
                    <div>Walrus blob: {evidence.advanced.walrusBlobId ?? "not available"}</div>
                    <div>Plaintext digest: {evidence.advanced.plaintextDigest}</div>
                    {evidence.advanced.ciphertextDigest ? (
                      <div>Ciphertext digest: {evidence.advanced.ciphertextDigest}</div>
                    ) : null}
                    {evidence.advanced.sealIdentity ? <div>Seal identity: {evidence.advanced.sealIdentity}</div> : null}
                    {evidence.advanced.suiTxDigest ? <div>Sui tx: {evidence.advanced.suiTxDigest}</div> : null}
                    {evidence.advanced.evidenceRoot ? <div>Evidence root: {evidence.advanced.evidenceRoot}</div> : null}
                  </div>
                </details>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
};
