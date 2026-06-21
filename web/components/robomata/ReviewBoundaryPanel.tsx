import type { LenderPacket } from "~~/lib/robomata/lenderPacket";

type ReviewBoundaryPanelProps = {
  boundary: LenderPacket["reviewBoundary"];
};

function formatStatus(value: string | undefined): string {
  return value ? value.replace(/_/g, " ") : "not recorded";
}

function shortDigest(value: string | undefined): string {
  return value ? value.slice(0, 16) : "not recorded";
}

function formatPolicyArtifact(boundary: LenderPacket["reviewBoundary"]): string {
  if (boundary?.policyArtifactId && boundary.policyArtifactVersion) {
    return `${boundary.policyArtifactId} v${boundary.policyArtifactVersion}`;
  }
  return boundary?.policyArtifactId ?? boundary?.policyArtifactVersion ?? "not recorded";
}

function formatBooleanFlag(value: boolean | undefined): string {
  if (typeof value !== "boolean") return "not recorded";
  return value ? "yes" : "no";
}

export function ReviewBoundaryPanel({ boundary }: ReviewBoundaryPanelProps) {
  const controls = boundary?.providerInputControls;

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
      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
        <div>
          <span className="font-semibold text-base-content/80">Source of truth:</span>{" "}
          {formatStatus(boundary?.sourceOfTruth)}
        </div>
        <div>
          <span className="font-semibold text-base-content/80">Policy:</span> {formatPolicyArtifact(boundary)}
        </div>
        <div>
          <span className="font-semibold text-base-content/80">Generated:</span>{" "}
          {boundary?.generatedAt ? new Date(boundary.generatedAt).toLocaleString() : "not recorded"}
        </div>
      </div>
      <details className="mt-3 rounded-xl border border-base-300 bg-base-200/50 p-3">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.14em] text-base-content/50">
          Technical provenance
        </summary>
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          <div>Provider: {formatStatus(boundary?.provider)}</div>
          <div>Status: {formatStatus(boundary?.providerStatus)}</div>
          <div>Model: {boundary?.model ?? "not configured"}</div>
          <div>Prompt: {boundary?.promptVersion ?? "not recorded"}</div>
          <div>Schema: {boundary?.outputSchemaVersion ?? "not recorded"}</div>
          <div>Review input: {boundary?.reviewInputId ?? "not recorded"}</div>
          <div>Input digest: {shortDigest(boundary?.inputDigest)}</div>
          <div>Source data digest: {shortDigest(boundary?.sourceDataDigest)}</div>
          <div>Provider input digest: {shortDigest(boundary?.providerInputDigest)}</div>
          <div>Output digest: {shortDigest(boundary?.outputDigest)}</div>
          <div>Provider input rows: {controls?.maxExceptionRows ?? "not recorded"}</div>
          <div>Provider text cap: {controls?.maxTextLength ?? "not recorded"}</div>
          <div>Raw evidence sent: {formatBooleanFlag(controls?.rawEvidenceIncluded)}</div>
          <div>Secret material sent: {formatBooleanFlag(controls?.secretMaterialIncluded)}</div>
        </div>
      </details>
    </div>
  );
}
