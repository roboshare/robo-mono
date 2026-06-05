import Link from "next/link";
import {
  BanknotesIcon,
  BuildingOffice2Icon,
  ClipboardDocumentCheckIcon,
  ExclamationTriangleIcon,
  ShieldCheckIcon,
  TruckIcon,
} from "@heroicons/react/24/outline";
import { RobomataSubmissionRoute } from "~~/components/robomata/RobomataSubmissionRoute";
import { isRobomataWorkflowEnabled, isRobomataWorkflowServerEnabled } from "~~/lib/featureFlags";
import { buildAgentReviewInput, reviewBorrowingBase } from "~~/lib/robomata/agentProviders";
import { calculateBorrowingBase, demoPortfolio, formatUsd } from "~~/lib/robomata/borrowingBase";
import { buildEvidenceAnchor } from "~~/lib/robomata/evidence";
import { buildLenderPacket } from "~~/lib/robomata/lenderPacket";

export const dynamic = "force-dynamic";

const RobomataDemoPage = async () => {
  const borrowingBase = calculateBorrowingBase(demoPortfolio);
  const evidenceAnchor = buildEvidenceAnchor(demoPortfolio.facilityName, demoPortfolio.evidence);
  const agentReview = await reviewBorrowingBase(buildAgentReviewInput(borrowingBase));
  const lenderPacket = buildLenderPacket(borrowingBase, agentReview, evidenceAnchor);
  const totalVehicles = demoPortfolio.receivables.reduce((sum, receivable) => sum + receivable.vehicleCount, 0);

  return (
    <div className="flex flex-1 justify-center px-4 py-8 sm:px-6 sm:py-10">
      <div className="w-full max-w-7xl space-y-8">
        <section className="overflow-hidden rounded-[2rem] border border-base-300 bg-base-100 shadow-xl shadow-base-300/40">
          <div className="grid gap-8 px-6 py-8 sm:px-8 sm:py-10 lg:grid-cols-[1.15fr_0.85fr] lg:px-10">
            <div className="space-y-6">
              <div className="space-y-3">
                <p className="text-sm font-semibold uppercase tracking-[0.3em] text-base-content/50">Robomata</p>
                <h1 className="max-w-3xl text-4xl font-black tracking-tight text-base-content sm:text-5xl">
                  Turn fleet receivables into a lender-ready borrowing base.
                </h1>
                <p className="max-w-2xl text-lg leading-relaxed text-base-content/70">
                  Public demo mode shows the verified borrowing-base narrative while the working submission workflow
                  remains behind its release flag.
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
                    Eligibility, reserves, and borrowing capacity are computed from deterministic demo inputs.
                  </p>
                </div>
                <div className="rounded-3xl border border-base-300 bg-base-200/60 p-4">
                  <ShieldCheckIcon className="h-6 w-6 text-primary" />
                  <div className="mt-3 text-sm font-semibold text-base-content">Evidence rail</div>
                  <p className="mt-1 text-sm text-base-content/70">
                    Evidence commitments remain visible without exposing the editable submission workflow.
                  </p>
                </div>
              </div>

              <div className="rounded-2xl border border-dashed border-base-300 bg-base-200/50 p-4 text-sm text-base-content/70">
                Enable <code>NEXT_PUBLIC_ENABLE_ROBOMATA_WORKFLOW=true</code> and{" "}
                <code>ROBOMATA_WORKFLOW_ENABLED=true</code> in controlled previews to replace this demo with a real
                read-only submission projection.
              </div>
            </div>

            <div className="rounded-[1.75rem] border border-base-300 bg-base-200/70 p-5 sm:p-6">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Demo Facility</p>
              <div className="mt-4 space-y-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/50">Operator</div>
                  <div className="mt-1 text-2xl font-bold text-base-content">{demoPortfolio.operator}</div>
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
                      <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">Exceptions</div>
                      <div className="mt-1 text-sm font-medium text-base-content">{borrowingBase.exceptionCount}</div>
                    </div>
                  </div>
                </div>
                <Link href="/partner" className="btn btn-outline w-full rounded-full">
                  Open partner workspace
                </Link>
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
            <div className="border-b border-base-300 px-6 py-5">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Portfolio Inputs</p>
              <h2 className="mt-2 text-2xl font-black tracking-tight text-base-content">
                Fleet receivables under review
              </h2>
            </div>

            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr className="text-xs uppercase tracking-[0.18em] text-base-content/50">
                    <th>Receivable</th>
                    <th>Obligor</th>
                    <th>Outstanding</th>
                    <th>DPD</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {borrowingBase.receivableResults.map(receivable => (
                    <tr key={receivable.id}>
                      <td className="font-semibold text-base-content">{receivable.id}</td>
                      <td>{receivable.obligor}</td>
                      <td>{formatUsd(receivable.outstandingCents)}</td>
                      <td>{receivable.daysPastDue}</td>
                      <td>
                        <span className={`badge ${receivable.eligible ? "badge-success" : "badge-error"}`}>
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
              <h2 className="mt-2 text-2xl font-black tracking-tight text-base-content">Lender-ready certificate</h2>
              <div className="mt-5 grid gap-3">
                <div className="rounded-2xl bg-base-200/60 px-4 py-3">
                  <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">Certificate</div>
                  <div className="mt-1 text-sm font-semibold text-base-content">{lenderPacket.certificateId}</div>
                </div>
                <div className="rounded-2xl bg-base-200/60 px-4 py-3">
                  <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">Availability</div>
                  <div className="mt-1 text-sm font-semibold text-base-content">
                    {formatUsd(borrowingBase.availableBorrowingBaseCents)}
                  </div>
                </div>
                <p className="rounded-2xl border border-base-300 bg-base-100/70 p-4 text-sm leading-relaxed text-base-content/70">
                  {lenderPacket.certificationStatement}
                </p>
              </div>
            </section>

            <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Evidence</p>
              <h2 className="mt-2 text-2xl font-black tracking-tight text-base-content">Controlled evidence summary</h2>
              <div className="mt-5 space-y-3">
                {evidenceAnchor.commitments.map(commitment => (
                  <div key={commitment.id} className="rounded-2xl border border-base-300 bg-base-200/50 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-semibold text-base-content">{commitment.label}</div>
                        <div className="mt-1 text-sm text-base-content/60">{commitment.source}</div>
                      </div>
                      <span className="badge capitalize">{commitment.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </section>
      </div>
    </div>
  );
};

const RobomataPage = () =>
  isRobomataWorkflowEnabled() && isRobomataWorkflowServerEnabled() ? <RobomataSubmissionRoute /> : <RobomataDemoPage />;

export default RobomataPage;
