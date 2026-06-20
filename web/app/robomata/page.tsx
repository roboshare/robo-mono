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
import { toConfiguredAppHref } from "~~/lib/appNavigation";
import { isRobomataWorkflowEnabled, isRobomataWorkflowServerEnabled } from "~~/lib/featureFlags";

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
    copy: "Anchors evidence-root state through the Sui facility path so packet history and monitoring can reference the same facility over time.",
  },
];

const RobomataPage = () => {
  const isSubmissionWorkflowAvailable = isRobomataWorkflowEnabled() && isRobomataWorkflowServerEnabled();
  const submissionHref = toConfiguredAppHref(isSubmissionWorkflowAvailable ? "/operator/submissions" : "/operator");
  const operatorHref = toConfiguredAppHref("/operator");

  return (
    <div className="flex flex-1 justify-center px-4 py-8 sm:px-6 sm:py-10">
      <div className="w-full max-w-7xl space-y-8">
        <section className="overflow-hidden rounded-[2rem] border border-base-300 bg-base-100 shadow-xl shadow-base-300/40">
          <div className="grid gap-8 px-6 py-8 sm:px-8 sm:py-10 lg:grid-cols-[1.08fr_0.92fr] lg:px-10">
            <div className="space-y-7">
              <div className="space-y-4">
                <p className="text-sm font-semibold uppercase tracking-[0.3em] text-base-content/50">Robomata</p>
                <h1 className="max-w-4xl text-4xl font-black tracking-tight text-base-content sm:text-5xl lg:text-6xl">
                  Make asset-backed receivables financeable before the lender asks twice.
                </h1>
                <p className="max-w-3xl text-lg leading-relaxed text-base-content/70">
                  Robomata is the operator workspace for turning receivables, asset evidence, policy exceptions,
                  borrowing-base runs, and facility monitoring into lender-ready packets. Deterministic rules calculate
                  credit truth; supervised agents help operators surface gaps without exposing raw evidence.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <a href={submissionHref} className="btn btn-primary rounded-full">
                  {isSubmissionWorkflowAvailable ? "Start a borrowing-base submission" : "Launch operator workflow"}
                  <ArrowRightIcon className="h-4 w-4" />
                </a>
                {isSubmissionWorkflowAvailable ? (
                  <a href={operatorHref} className="btn btn-outline rounded-full">
                    Open operator dashboard
                  </a>
                ) : null}
              </div>

              <div className="rounded-2xl border border-dashed border-base-300 bg-base-200/50 p-4 text-sm leading-relaxed text-base-content/70">
                Private submissions stay permissioned. Operators can prepare a packet, invite a lender through a
                controlled link, and keep sensitive evidence behind access controls instead of forwarding raw files
                through email.
              </div>
            </div>

            <div className="rounded-[1.75rem] border border-base-300 bg-base-200/70 p-5 sm:p-6">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Operating Model</p>
              <div className="mt-5 space-y-4">
                <div className="rounded-2xl border border-base-300 bg-base-100/80 p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/50">Prepare</div>
                  <div className="mt-2 text-lg font-bold text-base-content">Operator-controlled credit workspace</div>
                  <p className="mt-2 text-sm leading-relaxed text-base-content/70">
                    Import receivables, attach evidence, calculate availability, and resolve exceptions before a lender
                    review starts.
                  </p>
                </div>
                <div className="rounded-2xl border border-base-300 bg-base-100/80 p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/50">Share</div>
                  <div className="mt-2 text-lg font-bold text-base-content">
                    Lender-ready packet with review boundary
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-base-content/70">
                    Send one controlled packet with borrowing-base output, exception status, and the evidence a credit
                    team needs to diligence the file.
                  </p>
                </div>
                <div className="rounded-2xl border border-base-300 bg-base-100/80 p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/50">Monitor</div>
                  <div className="mt-2 text-lg font-bold text-base-content">
                    Freshness, evidence, and policy observations
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-base-content/70">
                    Keep sensitive documents controlled while preserving a tamper-evident record of what supported the
                    borrowing-base calculation.
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
              Robomata starts with the reporting materials operators already maintain, then turns them into a structured
              credit package with clear eligibility, evidence, and exception status.
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
};

export default RobomataPage;
