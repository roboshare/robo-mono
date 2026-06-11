"use client";

import { FormEvent, useState } from "react";
import type {
  RentalInvestorDashboard,
  RentalInvestorDashboardInput,
  RentalInvestorKpiKey,
} from "~~/lib/robomata/rentalInvestorKpis";

type DashboardResponse = {
  dashboard?: RentalInvestorDashboard;
  error?: string;
};

const now = new Date("2026-06-11T12:00:00.000Z");
const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59)).toISOString();

const sampleInput: RentalInvestorDashboardInput = {
  attribution: {
    facilityAssetId: "facility-austin-fleet-1",
    platformVehicleIds: ["pv-austin-r1s-1", "pv-austin-r1s-2"],
  },
  computedAt: now.toISOString(),
  freshness: "fresh",
  metrics: {
    availableVehicleDays: 60,
    bookedDays: 42,
    cancellationCount: 3,
    disputeCount: 1,
    distributionPostedAt: "2026-06-10T18:00:00.000Z",
    downtimeDays: 5,
    grossBookingValueCents: 186_000,
    periodEnd,
    periodStart,
    platformVehicleIds: ["pv-austin-r1s-1", "pv-austin-r1s-2"],
    recognizedRevenueCents: 148_000,
    revenueRecognizedAt: "2026-06-09T12:00:00.000Z",
  },
  ledgerEntries: [
    {
      id: "rle-austin-1",
      amountCents: 88_000,
      createdAt: "2026-06-09T12:00:00.000Z",
      currency: "USD",
      facilityAssetId: "facility-austin-fleet-1",
      kind: "recognized_revenue",
      occurredAt: "2026-06-09T12:00:00.000Z",
      platformVehicleId: "pv-austin-r1s-1",
      postingAssetId: "facility-austin-fleet-1",
      postingAssetKind: "facility",
      source: { bookingId: "rb-austin-1", tripId: "trip-austin-1" },
    },
    {
      id: "rle-austin-2",
      amountCents: 60_000,
      createdAt: "2026-06-09T12:30:00.000Z",
      currency: "USD",
      facilityAssetId: "facility-austin-fleet-1",
      kind: "recognized_revenue",
      occurredAt: "2026-06-09T12:30:00.000Z",
      platformVehicleId: "pv-austin-r1s-2",
      postingAssetId: "facility-austin-fleet-1",
      postingAssetKind: "facility",
      source: { bookingId: "rb-austin-2", tripId: "trip-austin-2" },
    },
    {
      id: "rle-austin-refund",
      amountCents: -12_000,
      createdAt: "2026-06-09T13:00:00.000Z",
      currency: "USD",
      facilityAssetId: "facility-austin-fleet-1",
      kind: "renter_refund",
      occurredAt: "2026-06-09T13:00:00.000Z",
      platformVehicleId: "pv-austin-r1s-2",
      postingAssetId: "facility-austin-fleet-1",
      postingAssetKind: "facility",
      source: { bookingId: "rb-austin-2", tripId: "trip-austin-2" },
    },
  ],
  postingBatches: [
    {
      id: "rpb-austin-june-1",
      attestation: {
        attestationId: "rra-austin-june-1",
        batchId: "rpb-austin-june-1",
        createdAt: "2026-06-10T18:00:00.000Z",
        createdBy: "0x0000000000000000000000000000000000000001",
        currency: "USD",
        ledgerEntryCount: 1,
        ledgerEntryIds: ["rle-austin-1"],
        ledgerEntriesDigest: "0x1111111111111111111111111111111111111111111111111111111111111111",
        periodEnd,
        periodStart,
        platformBoundary: "Aggregate facility and permitted vehicle KPI data only.",
        postingAssetId: "facility-austin-fleet-1",
        postingAssetKind: "facility",
        protocolBoundary: "Protocol receives finalized distribution amount and attestation reference.",
        rolloutMode: "metadata_only",
        schema: "robomata.rental_revenue_attestation",
        sourceSystem: "robomata-rental-platform",
        totalRecognizedRevenueCents: 88_000,
        version: "v1",
      },
      createdAt: "2026-06-10T18:00:00.000Z",
      currency: "USD",
      entryIds: ["rle-austin-1"],
      facilityAssetId: "facility-austin-fleet-1",
      idempotencyKey: "rpb-austin-june-1",
      periodEnd,
      periodStart,
      postedAt: "2026-06-10T19:00:00.000Z",
      postingAssetId: "facility-austin-fleet-1",
      postingAssetKind: "facility",
      protocolTxHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
      status: "posted",
      totalRecognizedRevenueCents: 88_000,
    },
  ],
};

const kpiLabels: Record<RentalInvestorKpiKey, string> = {
  booked_days: "Booked days",
  cancellation_count: "Cancellations",
  claims_impact_cents: "Claims impact",
  dispute_count: "Disputes",
  downtime_days: "Downtime days",
  gross_booking_value_cents: "Gross booking value",
  posted_revenue_cents: "Posted revenue",
  posting_variance_cents: "Posting variance",
  recognized_revenue_cents: "Recognized revenue",
  time_to_distribution_hours: "Time to distribution",
  utilization_rate_bps: "Utilization",
};

function formatCurrency(cents: number) {
  return new Intl.NumberFormat("en-US", { currency: "USD", style: "currency" }).format(cents / 100);
}

function formatKpiValue(key: RentalInvestorKpiKey, value: number) {
  if (key.endsWith("_cents")) return formatCurrency(value);
  if (key === "utilization_rate_bps") return `${(value / 100).toFixed(1)}%`;
  if (key === "time_to_distribution_hours") return `${value}h`;
  return value.toLocaleString();
}

function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export const RentalInvestorPerformanceExperience = () => {
  const [inputJson, setInputJson] = useState(prettyJson(sampleInput));
  const [dashboard, setDashboard] = useState<RentalInvestorDashboard | null>(null);
  const [message, setMessage] = useState<string | null>("Load the sample package or paste investor KPI input JSON.");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function buildDashboard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    setMessage(null);
    try {
      const input = JSON.parse(inputJson) as RentalInvestorDashboardInput;
      const response = await fetch("/api/robomata/rental-investor/dashboard", {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as DashboardResponse;
      if (!response.ok || !payload.dashboard) {
        throw new Error(payload.error ?? `Investor dashboard request failed: ${response.status}`);
      }
      setDashboard(payload.dashboard);
      setMessage(`Built investor dashboard for ${payload.dashboard.facilityAssetId}.`);
    } catch (buildError) {
      setDashboard(null);
      setError(buildError instanceof Error ? buildError.message : "Failed to build investor dashboard.");
    } finally {
      setIsLoading(false);
    }
  }

  const variance = dashboard?.varianceReport;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <section className="overflow-hidden rounded-[2rem] border border-base-300 bg-base-100 shadow-xl shadow-base-300/30">
        <div className="grid gap-6 bg-gradient-to-br from-zinc-950 via-stone-900 to-amber-950 p-8 text-white lg:grid-cols-[1fr_24rem]">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.32em] text-amber-200/80">Investor transparency</p>
            <h1 className="mt-4 max-w-3xl text-4xl font-black tracking-tight sm:text-5xl">
              Rental performance, variance, and provenance in one investor view.
            </h1>
            <p className="mt-4 max-w-3xl text-base text-stone-200">
              Review facility-level KPIs, permitted vehicle drilldowns, protocol-posting variance, and attestation
              references without exposing renter identity or support narratives.
            </p>
          </div>
          <div className="rounded-[1.5rem] border border-white/10 bg-white/10 p-5 backdrop-blur">
            <p className="text-sm font-semibold text-amber-100">Disclosure boundary</p>
            <p className="mt-2 text-sm text-stone-200">
              Investor-facing metrics are aggregate operating data tied to financing assets. Renter verification, claims
              narratives, and guaranteed-return language stay excluded.
            </p>
          </div>
        </div>
      </section>

      {message && <div className="alert alert-success shadow-sm">{message}</div>}
      {error && <div className="alert alert-error shadow-sm">{error}</div>}

      <section className="grid gap-5 lg:grid-cols-[26rem_1fr]">
        <form
          className="rounded-[1.5rem] border border-base-300 bg-base-100 p-5 shadow-lg shadow-base-300/20"
          onSubmit={event => void buildDashboard(event)}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-black">Dashboard input</h2>
              <p className="mt-1 text-sm text-base-content/60">
                Paste the KPI package produced by reporting jobs or use the sample package.
              </p>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setInputJson(prettyJson(sampleInput))}
              type="button"
            >
              Reset
            </button>
          </div>
          <textarea
            className="textarea textarea-bordered mt-4 min-h-[32rem] font-mono text-xs"
            value={inputJson}
            onChange={event => setInputJson(event.target.value)}
          />
          <button className="btn btn-primary mt-4 w-full" disabled={isLoading} type="submit">
            {isLoading ? "Building..." : "Build investor dashboard"}
          </button>
        </form>

        <div className="flex flex-col gap-5">
          {dashboard ? (
            <>
              <section className="rounded-[1.5rem] border border-base-300 bg-base-100 p-5 shadow-lg shadow-base-300/20">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.24em] text-base-content/50">
                      Financing asset
                    </p>
                    <h2 className="mt-2 break-all text-2xl font-black">{dashboard.facilityAssetId}</h2>
                    <p className="text-sm text-base-content/60">
                      {new Date(dashboard.periodStart).toLocaleDateString()} -{" "}
                      {new Date(dashboard.periodEnd).toLocaleDateString()} / computed{" "}
                      {new Date(dashboard.computedAt).toLocaleString()}
                    </p>
                  </div>
                  <span className="badge badge-lg badge-primary">{dashboard.summary.settlementStatus}</span>
                </div>
              </section>

              <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {dashboard.snapshot.kpis.map(kpi => (
                  <div className="rounded-2xl border border-base-300 bg-base-100 p-4 shadow-sm" key={kpi.key}>
                    <p className="text-xs font-bold uppercase tracking-[0.18em] text-base-content/50">
                      {kpiLabels[kpi.key]}
                    </p>
                    <p className="mt-3 text-2xl font-black">{formatKpiValue(kpi.key, kpi.value)}</p>
                    <p className="mt-2 text-xs text-base-content/60">
                      {kpi.source} / {kpi.freshness}
                    </p>
                  </div>
                ))}
              </section>

              {variance && (
                <section className="rounded-[1.5rem] border border-base-300 bg-base-100 p-5 shadow-lg shadow-base-300/20">
                  <div className="grid gap-4 lg:grid-cols-3">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.18em] text-base-content/50">
                        Recognized revenue
                      </p>
                      <p className="mt-2 text-3xl font-black">{formatCurrency(variance.recognizedRevenueCents)}</p>
                    </div>
                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.18em] text-base-content/50">
                        Protocol posted
                      </p>
                      <p className="mt-2 text-3xl font-black">{formatCurrency(variance.postedRevenueCents)}</p>
                    </div>
                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.18em] text-base-content/50">Variance</p>
                      <p className="mt-2 text-3xl font-black">{formatCurrency(variance.varianceCents)}</p>
                    </div>
                  </div>

                  {variance.staleOrIncompleteReasons.length > 0 && (
                    <div className="mt-5 rounded-2xl bg-warning/10 p-4 text-sm">
                      <p className="font-bold text-warning-content">Data gaps</p>
                      <ul className="mt-2 list-disc pl-5">
                        {variance.staleOrIncompleteReasons.map(reason => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="mt-5 overflow-x-auto">
                    <table className="table table-zebra">
                      <thead>
                        <tr>
                          <th>Platform vehicle</th>
                          <th>Recognized</th>
                          <th>Posted</th>
                          <th>Variance</th>
                          <th>Ledger entries</th>
                        </tr>
                      </thead>
                      <tbody>
                        {variance.vehicleDrilldowns.map(row => (
                          <tr key={row.platformVehicleId}>
                            <td className="font-mono text-xs">{row.platformVehicleId}</td>
                            <td>{formatCurrency(row.recognizedRevenueCents)}</td>
                            <td>{formatCurrency(row.postedRevenueCents)}</td>
                            <td>{formatCurrency(row.varianceCents)}</td>
                            <td className="font-mono text-xs">{row.ledgerEntryIds.join(", ") || "none"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              <section className="grid gap-5 xl:grid-cols-2">
                <div className="rounded-[1.5rem] border border-base-300 bg-base-100 p-5 shadow-lg shadow-base-300/20">
                  <h3 className="text-xl font-black">Posting attestations</h3>
                  <div className="mt-4 flex flex-col gap-3">
                    {dashboard.varianceReport.attestations.map(attestation => (
                      <div className="rounded-2xl bg-base-200/60 p-4" key={attestation.batchId}>
                        <p className="font-bold">{attestation.batchId}</p>
                        <p className="mt-1 break-all text-xs text-base-content/60">
                          {attestation.attestationId ?? "No attestation metadata"}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <span className="badge badge-outline">{attestation.status}</span>
                          <span className="badge badge-outline">{attestation.rolloutMode ?? "legacy"}</span>
                        </div>
                        {attestation.protocolTxHash && (
                          <p className="mt-3 break-all font-mono text-xs">{attestation.protocolTxHash}</p>
                        )}
                      </div>
                    ))}
                    {dashboard.varianceReport.attestations.length === 0 && (
                      <p className="text-sm text-base-content/60">No posting batches matched this period.</p>
                    )}
                  </div>
                </div>

                <div className="rounded-[1.5rem] border border-base-300 bg-base-100 p-5 shadow-lg shadow-base-300/20">
                  <h3 className="text-xl font-black">Disclosure boundary</h3>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <div>
                      <p className="font-bold">Allowed</p>
                      <ul className="mt-2 list-disc pl-5 text-sm text-base-content/70">
                        {dashboard.disclosureBoundary.allowed.map(item => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p className="font-bold">Excluded</p>
                      <ul className="mt-2 list-disc pl-5 text-sm text-base-content/70">
                        {dashboard.disclosureBoundary.excluded.map(item => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              </section>
            </>
          ) : (
            <section className="rounded-[1.5rem] border border-dashed border-base-300 bg-base-100 p-10 text-center">
              <h2 className="text-2xl font-black">Build a dashboard to inspect investor reporting.</h2>
              <p className="mx-auto mt-2 max-w-2xl text-base-content/60">
                The output will show KPI cards, revenue variance, vehicle-level drilldowns, posting attestation
                metadata, and disclosure boundaries.
              </p>
            </section>
          )}
        </div>
      </section>
    </main>
  );
};
