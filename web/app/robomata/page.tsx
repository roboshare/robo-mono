import Link from "next/link";
import {
  ArrowRightIcon,
  BanknotesIcon,
  ClipboardDocumentCheckIcon,
  DocumentArrowUpIcon,
  ExclamationTriangleIcon,
  LockClosedIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "@heroicons/react/24/outline";

const workflowSteps = [
  {
    title: "Create a facility submission",
    description: "Start with operator, facility, and as-of date so the borrowing base has a clear reporting boundary.",
  },
  {
    title: "Import receivables",
    description: "Upload the receivables CSV that lenders already ask operators to normalize by hand.",
  },
  {
    title: "Attach evidence",
    description:
      "Add receivables, insurance, collateral, servicing, utilization, and lockbox evidence with source metadata.",
  },
  {
    title: "Compute availability",
    description:
      "Apply deterministic eligibility, concentration, and advance-rate rules to produce lender-ready capacity.",
  },
  {
    title: "Resolve exceptions",
    description:
      "Separate clean collateral from missing, stale, or policy-breaking evidence before the packet is sent.",
  },
  {
    title: "Commit the evidence root",
    description: "Use Sui, Walrus, and Seal to anchor a controlled evidence trail after the packet is ready.",
  },
];

const valueProps = [
  {
    label: "For operators",
    icon: DocumentArrowUpIcon,
    copy: "Turn lender diligence from an email-and-spreadsheet scramble into a repeatable submission workflow.",
  },
  {
    label: "For lenders",
    icon: ClipboardDocumentCheckIcon,
    copy: "Receive a cleaner borrowing-base packet with eligibility cuts, exception trails, and evidence status already organized.",
  },
  {
    label: "For evidence",
    icon: ShieldCheckIcon,
    copy: "Keep sensitive files controlled while preserving verifiable commitments for audit and monitoring.",
  },
];

const railCards = [
  {
    label: "Borrowing-base engine",
    icon: BanknotesIcon,
    copy: "Calculates gross receivables, eligibility, reserves, advance rates, availability, and exception counts from persisted submissions.",
  },
  {
    label: "Exception workflow",
    icon: ExclamationTriangleIcon,
    copy: "Turns policy breaks into operator actions: exclude a receivable, add evidence, fix an allowed field, and recompute.",
  },
  {
    label: "Controlled evidence",
    icon: LockClosedIcon,
    copy: "Stores encrypted evidence through Walrus and Seal when configured, with technical details kept behind advanced disclosures.",
  },
  {
    label: "Programmable commit trail",
    icon: SparklesIcon,
    copy: "Anchors the evidence root through the Sui facility path so future lenders can monitor the same financial object over time.",
  },
];

const RobomataPage = () => (
  <div className="flex flex-1 justify-center px-4 py-8 sm:px-6 sm:py-10">
    <div className="w-full max-w-7xl space-y-8">
      <section className="overflow-hidden rounded-[2rem] border border-base-300 bg-base-100 shadow-xl shadow-base-300/40">
        <div className="grid gap-8 px-6 py-8 sm:px-8 sm:py-10 lg:grid-cols-[1.08fr_0.92fr] lg:px-10">
          <div className="space-y-7">
            <div className="space-y-4">
              <p className="text-sm font-semibold uppercase tracking-[0.3em] text-base-content/50">Robomata</p>
              <h1 className="max-w-4xl text-4xl font-black tracking-tight text-base-content sm:text-5xl lg:text-6xl">
                Make fleet receivables financeable before the lender asks twice.
              </h1>
              <p className="max-w-3xl text-lg leading-relaxed text-base-content/70">
                Robomata helps fleet operators package receivables, evidence, exceptions, and borrowing-base output into
                a lender-ready workflow. The operator workspace lives in Partner Submissions; this page explains the
                product surface and why the evidence rail matters.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link href="/partner/submissions" className="btn btn-primary rounded-full">
                Start a borrowing-base submission
                <ArrowRightIcon className="h-4 w-4" />
              </Link>
              <Link href="/partner" className="btn btn-outline rounded-full">
                Open partner dashboard
              </Link>
            </div>

            <div className="rounded-2xl border border-dashed border-base-300 bg-base-200/50 p-4 text-sm leading-relaxed text-base-content/70">
              Partner access is required to create or view private submissions. Protected lender packet links are a
              separate controlled-sharing surface and are not public facility browsing.
            </div>
          </div>

          <div className="rounded-[1.75rem] border border-base-300 bg-base-200/70 p-5 sm:p-6">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
              Product Architecture
            </p>
            <div className="mt-5 space-y-4">
              <div className="rounded-2xl border border-base-300 bg-base-100/80 p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/50">Public</div>
                <div className="mt-2 text-lg font-bold text-base-content">/robomata</div>
                <p className="mt-2 text-sm leading-relaxed text-base-content/70">
                  Product positioning, workflow explanation, and operator entry points.
                </p>
              </div>
              <div className="rounded-2xl border border-base-300 bg-base-100/80 p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/50">Operator</div>
                <div className="mt-2 text-lg font-bold text-base-content">/partner/submissions</div>
                <p className="mt-2 text-sm leading-relaxed text-base-content/70">
                  Authenticated submission list, workspace, receivables import, evidence upload, compute, and commit.
                </p>
              </div>
              <div className="rounded-2xl border border-base-300 bg-base-100/80 p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/50">Lender</div>
                <div className="mt-2 text-lg font-bold text-base-content">Protected packet links</div>
                <p className="mt-2 text-sm leading-relaxed text-base-content/70">
                  Planned controlled links for one lender-ready packet with expiry, revocation, and audit state.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {valueProps.map(item => {
          const Icon = item.icon;

          return (
            <div key={item.label} className="rounded-[1.5rem] border border-base-300 bg-base-100 p-5 shadow-md">
              <Icon className="h-6 w-6 text-primary" />
              <h2 className="mt-4 text-xl font-black tracking-tight text-base-content">{item.label}</h2>
              <p className="mt-2 text-sm leading-relaxed text-base-content/70">{item.copy}</p>
            </div>
          );
        })}
      </section>

      <section className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30 sm:p-8">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Working Flow</p>
          <h2 className="mt-2 text-3xl font-black tracking-tight text-base-content">
            From receivables export to lender-ready packet.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-base-content/70">
            The MVP is centered on one product object: a partner-owned facility submission. It is not a public market,
            not a public facility directory, and not a generic tokenization demo.
          </p>

          <div className="mt-6 space-y-3">
            {workflowSteps.map((step, index) => (
              <div key={step.title} className="flex gap-4 rounded-2xl border border-base-300 bg-base-200/50 p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-black text-primary-content">
                  {index + 1}
                </div>
                <div>
                  <h3 className="font-bold text-base-content">{step.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-base-content/70">{step.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30 sm:p-8">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Rails</p>
          <h2 className="mt-2 text-3xl font-black tracking-tight text-base-content">
            Financeability first, programmable evidence underneath.
          </h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {railCards.map(item => {
              const Icon = item.icon;

              return (
                <div key={item.label} className="rounded-2xl border border-base-300 bg-base-200/50 p-5">
                  <Icon className="h-6 w-6 text-primary" />
                  <h3 className="mt-4 font-bold text-base-content">{item.label}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-base-content/70">{item.copy}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  </div>
);

export default RobomataPage;
