import Link from "next/link";
import {
  ArrowRightIcon,
  BanknotesIcon,
  BuildingOffice2Icon,
  ClipboardDocumentCheckIcon,
  ExclamationTriangleIcon,
  ShieldCheckIcon,
  TruckIcon,
} from "@heroicons/react/24/outline";
import { calculateBorrowingBase, demoPortfolio, formatPercentFromBps, formatUsd } from "~~/lib/robomata/borrowingBase";
import { buildEvidenceAnchor } from "~~/lib/robomata/evidence";

const RobomataPage = () => {
  const borrowingBase = calculateBorrowingBase(demoPortfolio);
  const evidenceAnchor = buildEvidenceAnchor(demoPortfolio.facilityName, demoPortfolio.evidence);
  const totalVehicles = demoPortfolio.receivables.reduce((sum, receivable) => sum + receivable.vehicleCount, 0);
  const verifiedEvidenceCount = evidenceAnchor.commitments.filter(
    commitment => commitment.status === "verified",
  ).length;
  const exceptionEvidenceCount = evidenceAnchor.commitments.filter(
    commitment => commitment.status === "exception",
  ).length;
  const pendingEvidenceCount = evidenceAnchor.commitments.filter(commitment => commitment.status === "pending").length;

  return (
    <div className="flex flex-1 justify-center px-4 py-8 sm:px-6 sm:py-10">
      <div className="w-full max-w-7xl space-y-8">
        <section className="overflow-hidden rounded-[2rem] border border-base-300 bg-base-100 shadow-xl shadow-base-300/40">
          <div className="grid gap-8 px-6 py-8 sm:px-8 sm:py-10 lg:grid-cols-[1.2fr_0.8fr] lg:px-10">
            <div className="space-y-6">
              <div className="space-y-3">
                <p className="text-sm font-semibold uppercase tracking-[0.3em] text-base-content/50">Robomata</p>
                <h1 className="max-w-3xl text-4xl font-black tracking-tight text-base-content sm:text-5xl">
                  Turn fleet receivables into a lender-ready borrowing base.
                </h1>
                <p className="max-w-2xl text-lg leading-relaxed text-base-content/70">
                  This route shells the first-customer operator workflow around the landed Robomata primitives: a
                  deterministic fleet portfolio, lender-style eligibility output, and reserved rails for diligence and
                  evidence anchoring.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-3xl border border-base-300 bg-base-200/60 p-4">
                  <TruckIcon className="h-6 w-6 text-primary" />
                  <div className="mt-3 text-sm font-semibold text-base-content">Operator packet</div>
                  <p className="mt-1 text-sm text-base-content/70">
                    {demoPortfolio.operator} submits {demoPortfolio.receivables.length} receivables backed by{" "}
                    {totalVehicles} active vehicles.
                  </p>
                </div>
                <div className="rounded-3xl border border-base-300 bg-base-200/60 p-4">
                  <BanknotesIcon className="h-6 w-6 text-primary" />
                  <div className="mt-3 text-sm font-semibold text-base-content">Borrowing-base output</div>
                  <p className="mt-1 text-sm text-base-content/70">
                    Advance rate, concentration reserve, and available borrowing capacity are already calculated.
                  </p>
                </div>
                <div className="rounded-3xl border border-base-300 bg-base-200/60 p-4">
                  <ShieldCheckIcon className="h-6 w-6 text-primary" />
                  <div className="mt-3 text-sm font-semibold text-base-content">Evidence rail</div>
                  <p className="mt-1 text-sm text-base-content/70">
                    Walrus and Seal commitment references are present and ready for richer anchoring in the next PRs.
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <Link href="/markets" className="btn btn-outline rounded-full sm:min-w-44">
                  Keep Markets Live
                </Link>
                <Link href="/partner" className="btn btn-outline rounded-full sm:min-w-44">
                  Keep Partner Flows Live
                </Link>
              </div>
            </div>

            <div className="rounded-[1.75rem] border border-base-300 bg-base-200/70 p-5 sm:p-6">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">First Customer</p>
              <div className="mt-4 space-y-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/50">Operator</div>
                  <div className="mt-1 text-2xl font-bold text-base-content">{demoPortfolio.operator}</div>
                  <p className="mt-2 text-sm text-base-content/70">
                    Mid-market fleet operator seeking faster lender response and more borrowing capacity without
                    replacing its existing finance stack.
                  </p>
                </div>

                <div className="rounded-2xl border border-base-300 bg-base-100/80 p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/50">Facility</div>
                  <div className="mt-2 text-base font-semibold text-base-content">{demoPortfolio.facilityName}</div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">As Of</div>
                      <div className="mt-1 text-sm font-medium text-base-content">{demoPortfolio.asOfDate}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">Advance Rate</div>
                      <div className="mt-1 text-sm font-medium text-base-content">
                        {formatPercentFromBps(demoPortfolio.advanceRateBps)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">
                        Concentration Limit
                      </div>
                      <div className="mt-1 text-sm font-medium text-base-content">
                        {demoPortfolio.concentrationLimitPct}%
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">Exceptions</div>
                      <div className="mt-1 text-sm font-medium text-base-content">{borrowingBase.exceptionCount}</div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-dashed border-base-300 bg-base-100/70 p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/50">
                    Current Workflow Pain
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-base-content/70">
                    The operator still has to normalize receivables, insurance, title, utilization, and lockbox evidence
                    into something a lender can underwrite. This route puts that package into one surface.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[
            {
              label: "Gross Receivables",
              value: formatUsd(borrowingBase.grossReceivablesCents),
              icon: <BuildingOffice2Icon className="h-5 w-5 text-primary" />,
            },
            {
              label: "Eligible Receivables",
              value: formatUsd(borrowingBase.eligibleReceivablesCents),
              icon: <ClipboardDocumentCheckIcon className="h-5 w-5 text-primary" />,
            },
            {
              label: "Available Borrowing Base",
              value: formatUsd(borrowingBase.availableBorrowingBaseCents),
              icon: <BanknotesIcon className="h-5 w-5 text-primary" />,
            },
            {
              label: "Open Exceptions",
              value: borrowingBase.exceptionCount.toString(),
              icon: <ExclamationTriangleIcon className="h-5 w-5 text-primary" />,
            },
          ].map(stat => (
            <div key={stat.label} className="rounded-[1.5rem] border border-base-300 bg-base-100 p-5 shadow-md">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-base-content/60">{stat.label}</div>
                {stat.icon}
              </div>
              <div className="mt-4 text-3xl font-black tracking-tight text-base-content">{stat.value}</div>
            </div>
          ))}
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="overflow-hidden rounded-[2rem] border border-base-300 bg-base-100 shadow-lg shadow-base-300/30">
            <div className="flex items-center justify-between gap-3 border-b border-base-300 px-6 py-5">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
                  Portfolio Inputs
                </p>
                <h2 className="mt-2 text-2xl font-black tracking-tight text-base-content">
                  Fleet receivables under review
                </h2>
              </div>
              <span className="rounded-full border border-base-300 bg-base-200 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-base-content/60">
                Demo scenario
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr className="text-xs uppercase tracking-[0.18em] text-base-content/50">
                    <th>Receivable</th>
                    <th>Obligor</th>
                    <th>Vehicles</th>
                    <th>Outstanding</th>
                    <th>DPD</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {borrowingBase.receivableResults.map(receivable => (
                    <tr key={receivable.id}>
                      <td className="font-semibold text-base-content">{receivable.id}</td>
                      <td>
                        <div className="font-medium text-base-content">{receivable.obligor}</div>
                        <div className="text-xs text-base-content/60">
                          Utilization {receivable.utilizationPct}% • Lockbox{" "}
                          {receivable.lockboxMatched ? "matched" : "exception"}
                        </div>
                      </td>
                      <td>{receivable.vehicleCount}</td>
                      <td>{formatUsd(receivable.outstandingCents)}</td>
                      <td>{receivable.daysPastDue}</td>
                      <td>
                        <span
                          className={`badge rounded-full border-0 ${
                            receivable.eligible
                              ? "badge-success text-success-content"
                              : "badge-error text-error-content"
                          }`}
                        >
                          {receivable.eligible ? "Eligible" : "Exception"}
                        </span>
                        {!receivable.eligible ? (
                          <div className="mt-2 text-xs leading-relaxed text-base-content/70">
                            {receivable.ineligibleReasons.join("; ")}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-6">
            <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
                Borrowing-Base Certificate
              </p>
              <h2 className="mt-2 text-2xl font-black tracking-tight text-base-content">Lender-ready summary</h2>
              <div className="mt-5 space-y-4">
                {[
                  ["Gross receivables", formatUsd(borrowingBase.grossReceivablesCents)],
                  ["Eligible receivables", formatUsd(borrowingBase.eligibleReceivablesCents)],
                  ["Advance rate", formatPercentFromBps(demoPortfolio.advanceRateBps)],
                  ["Concentration reserve", formatUsd(borrowingBase.concentrationReserveCents)],
                  ["Availability", formatUsd(borrowingBase.availableBorrowingBaseCents)],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="flex items-center justify-between gap-4 rounded-2xl bg-base-200/60 px-4 py-3"
                  >
                    <span className="text-sm font-medium text-base-content/70">{label}</span>
                    <span className="text-base font-semibold text-base-content">{value}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Reserved Rails</p>
              <div className="mt-4 grid gap-4">
                <div className="rounded-3xl border border-dashed border-base-300 bg-base-200/40 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-base-content">Agent diligence review</div>
                      <p className="mt-1 text-sm text-base-content/70">
                        Ready to consume {borrowingBase.receivableResults.filter(item => !item.eligible).length}{" "}
                        receivable exceptions and {borrowingBase.evidenceExceptions.length} evidence exceptions.
                      </p>
                    </div>
                    <ArrowRightIcon className="h-5 w-5 text-base-content/40" />
                  </div>
                  <p className="mt-3 text-xs uppercase tracking-[0.16em] text-base-content/50">
                    Full memo and next actions land in ROB-118
                  </p>
                </div>

                <div className="rounded-3xl border border-dashed border-base-300 bg-base-200/40 p-4">
                  <div className="text-sm font-semibold text-base-content">Evidence commitment rail</div>
                  <p className="mt-1 text-sm text-base-content/70">
                    {verifiedEvidenceCount} verified, {exceptionEvidenceCount} exception, {pendingEvidenceCount} pending
                    commitments are already modeled for the operator packet.
                  </p>
                  <div className="mt-3 rounded-2xl bg-base-100/80 px-3 py-2 text-xs text-base-content/70">
                    Evidence root preview: {evidenceAnchor.evidenceRoot.slice(0, 32)}...
                  </div>
                  <p className="mt-3 text-xs uppercase tracking-[0.16em] text-base-content/50">
                    Full anchor surface lands in ROB-120
                  </p>
                </div>
              </div>
            </section>
          </div>
        </section>
      </div>
    </div>
  );
};

export default RobomataPage;
