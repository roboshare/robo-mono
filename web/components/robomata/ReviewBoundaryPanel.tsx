import type { LenderPacket } from "~~/lib/robomata/lenderPacket";

type ReviewBoundaryPanelProps = {
  boundary: LenderPacket["reviewBoundary"];
};

function formatStatus(value: string | undefined): string {
  return value ? value.replace(/_/g, " ") : "not recorded";
}

export function ReviewBoundaryPanel({ boundary }: ReviewBoundaryPanelProps) {
  return (
    <div className="rounded-2xl border border-base-300 bg-base-100/70 p-4 text-sm leading-relaxed text-base-content/70">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-base-content">Review boundary</div>
          <div className="mt-1">
            Diligence memo output is advisory. Borrowing-base rules remain the source of credit truth.
          </div>
        </div>
        <span className="badge badge-ghost capitalize">{formatStatus(boundary?.reviewMode)}</span>
      </div>
      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <div>Provider: {formatStatus(boundary?.provider)}</div>
        <div>Status: {formatStatus(boundary?.providerStatus)}</div>
        <div>Source of truth: {formatStatus(boundary?.sourceOfTruth)}</div>
        <div>Model: {boundary?.model ?? "not configured"}</div>
      </div>
    </div>
  );
}
