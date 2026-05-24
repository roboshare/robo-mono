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
import { buildAgentReviewInput, reviewBorrowingBase } from "~~/lib/robomata/agentProviders";
import { calculateBorrowingBase, demoPortfolio, formatPercentFromBps, formatUsd } from "~~/lib/robomata/borrowingBase";
import { buildEvidenceAnchor, buildEvidenceRail } from "~~/lib/robomata/evidence";
import { buildLenderPacket } from "~~/lib/robomata/lenderPacket";

export const dynamic = "force-dynamic";

const RobomataPage = async () => {
  const borrowingBase = calculateBorrowingBase(demoPortfolio);
  const evidenceAnchor = buildEvidenceAnchor(demoPortfolio.facilityName, demoPortfolio.evidence);
  const evidenceRail = buildEvidenceRail(evidenceAnchor);
  const agentReview = await reviewBorrowingBase(buildAgentReviewInput(borrowingBase));
  const lenderPacket = buildLenderPacket(borrowingBase, agentReview, evidenceAnchor);
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
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
                    Borrowing-Base Certificate
                  </p>
                  <h2 className="mt-2 text-2xl font-black tracking-tight text-base-content">
                    Lender-ready certificate
                  </h2>
                </div>
                <span className="rounded-full border border-base-300 bg-base-200 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-base-content/60">
                  {lenderPacket.certificateId}
                </span>
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl bg-base-200/60 px-4 py-3">
                  <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">Prepared For</div>
                  <div className="mt-1 text-sm font-semibold text-base-content">{lenderPacket.preparedFor}</div>
                </div>
                <div className="rounded-2xl bg-base-200/60 px-4 py-3">
                  <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">Prepared On</div>
                  <div className="mt-1 text-sm font-semibold text-base-content">{lenderPacket.preparedOn}</div>
                </div>
              </div>
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
              <div className="mt-5 space-y-3 rounded-3xl border border-base-300 bg-base-200/40 p-4">
                <div className="text-sm font-semibold text-base-content">Certificate statement</div>
                <p className="text-sm leading-relaxed text-base-content/70">{lenderPacket.certificationStatement}</p>
                <p className="text-sm text-base-content/80">{lenderPacket.borrowerCoverageLine}</p>
              </div>
            </section>

            <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
                    Exception Memo
                  </p>
                  <h2 className="mt-2 text-2xl font-black tracking-tight text-base-content">Lender follow-up packet</h2>
                </div>
                <span className="rounded-full border border-base-300 bg-base-200 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-base-content/60">
                  {agentReview.provider}
                </span>
              </div>

              <div className="mt-5 space-y-4">
                <div className="rounded-3xl border border-base-300 bg-base-200/50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-base-content">{agentReview.headline}</div>
                      <p className="mt-2 text-sm leading-relaxed text-base-content/70">{agentReview.memo}</p>
                    </div>
                    <ArrowRightIcon className="h-5 w-5 text-base-content/40" />
                  </div>
                </div>

                <div className="rounded-3xl border border-base-300 bg-base-100/80 p-4">
                  <div className="text-sm font-semibold text-base-content">Exceptions to clear</div>
                  <div className="mt-3 space-y-4">
                    {lenderPacket.exceptionSections.map(section => (
                      <div key={section.title} className="rounded-2xl bg-base-200/60 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-base-content">{section.title}</div>
                          <span className="rounded-full bg-base-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-base-content/60">
                            {section.count}
                          </span>
                        </div>
                        <div className="mt-3 space-y-3">
                          {section.items.map(item => (
                            <div key={item} className="text-sm text-base-content/80">
                              {item}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-3xl border border-base-300 bg-base-100/80 p-4">
                  <div className="text-sm font-semibold text-base-content">Borrower requests before lender send</div>
                  <div className="mt-3 space-y-3">
                    {lenderPacket.borrowerRequests.map(action => (
                      <div key={action} className="rounded-2xl bg-base-200/60 px-4 py-3 text-sm text-base-content/80">
                        {action}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-3xl border border-dashed border-base-300 bg-base-200/40 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-base-content">Evidence anchor trail</div>
                    <span className="rounded-full border border-base-300 bg-base-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-base-content/60">
                      Demo references
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-base-content/70">
                    {verifiedEvidenceCount} verified, {exceptionEvidenceCount} exception, {pendingEvidenceCount} pending
                    commitments are grouped below and tied to an explicit Sui/Walrus/Seal anchor path.
                  </p>
                  <div className="mt-3 grid gap-3">
                    {evidenceRail.anchorReferences.map(reference => (
                      <div key={reference.label} className="rounded-2xl bg-base-100/80 px-3 py-3">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-base-content/50">
                          {reference.label}
                        </div>
                        <div className="mt-1 break-all text-xs text-base-content/80">{reference.value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 space-y-3">
                    {evidenceRail.demoDisclosures.map(item => (
                      <div key={item} className="rounded-2xl bg-base-100/80 px-3 py-2 text-xs text-base-content/70">
                        {item}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          </div>
        </section>

        <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Evidence Library</p>
              <h2 className="mt-2 text-2xl font-black tracking-tight text-base-content">
                Controlled evidence references
              </h2>
            </div>
            <span className="rounded-full border border-base-300 bg-base-200 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-base-content/60">
              Demo commitments only
            </span>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            {evidenceRail.groups.map(group => (
              <div key={group.id} className="rounded-[1.5rem] border border-base-300 bg-base-200/35 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-bold text-base-content">{group.title}</div>
                    <p className="mt-1 text-sm leading-relaxed text-base-content/70">{group.description}</p>
                  </div>
                  <span className="rounded-full border border-base-300 bg-base-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-base-content/60">
                    {group.commitments.length} refs
                  </span>
                </div>

                <div className="mt-4 space-y-3">
                  {group.commitments.map(commitment => (
                    <div key={commitment.id} className="rounded-2xl border border-base-300 bg-base-100/80 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-base-content">{commitment.label}</div>
                          <div className="mt-1 text-xs text-base-content/60">{commitment.source}</div>
                        </div>
                        <span
                          className={`badge rounded-full border-0 ${
                            commitment.status === "verified"
                              ? "badge-success text-success-content"
                              : commitment.status === "exception"
                                ? "badge-error text-error-content"
                                : "badge-warning text-warning-content"
                          }`}
                        >
                          {commitment.status}
                        </span>
                      </div>

                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <div className="rounded-xl bg-base-200/60 px-3 py-2">
                          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-base-content/50">
                            Walrus object
                          </div>
                          <div className="mt-1 break-all text-xs text-base-content/75">{commitment.walrusObjectId}</div>
                        </div>
                        <div className="rounded-xl bg-base-200/60 px-3 py-2">
                          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-base-content/50">
                            Seal policy
                          </div>
                          <div className="mt-1 break-all text-xs text-base-content/75">{commitment.sealPolicyId}</div>
                        </div>
                      </div>

                      <div className="mt-3 rounded-xl bg-base-200/60 px-3 py-2">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-base-content/50">
                          Digest
                        </div>
                        <div className="mt-1 break-all text-xs text-base-content/75">{commitment.digest}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};

export default RobomataPage;
