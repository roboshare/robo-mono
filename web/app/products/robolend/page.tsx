import Link from "next/link";
import {
  ArrowRightIcon,
  BellAlertIcon,
  BuildingLibraryIcon,
  ChartPieIcon,
  ClipboardDocumentCheckIcon,
  ClockIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";

const reviewSteps = [
  {
    title: "Receive lender-ready packets",
    copy: "Review borrowing-base output, exceptions, evidence status, and packet freshness from one controlled link.",
  },
  {
    title: "Monitor facilities over time",
    copy: "Track when receivables, evidence, or committed roots make an existing packet stale or ready for renewal.",
  },
  {
    title: "Allocate into standardized exposure",
    copy: "Move from underwriting to distribution only after the facility object is structured and tokenization-ready.",
  },
];

const RobolendPage = () => (
  <div className="flex flex-1 justify-center px-4 py-8 sm:px-6 sm:py-10">
    <div className="w-full max-w-7xl space-y-8">
      <section className="overflow-hidden rounded-[2rem] border border-base-300 bg-base-100 shadow-xl shadow-base-300/40">
        <div className="grid gap-8 px-6 py-8 sm:px-8 sm:py-10 lg:grid-cols-[1.1fr_0.9fr] lg:px-10">
          <div className="space-y-7">
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 rounded-full border border-warning/25 bg-warning/10 px-4 py-2 text-sm font-bold text-warning">
                <ClockIcon className="h-4 w-4" />
                Coming soon
              </div>
              <p className="text-sm font-semibold uppercase tracking-[0.3em] text-base-content/50">Robolend</p>
              <h1 className="max-w-4xl text-4xl font-black tracking-tight text-base-content sm:text-5xl lg:text-6xl">
                Credit review and monitoring for capital providers.
              </h1>
              <p className="max-w-3xl text-lg leading-relaxed text-base-content/70">
                Robolend is the planned capital-provider workspace for reviewing Robomata packets, monitoring facility
                freshness, and organizing credit exposure. It is not a live lender dashboard yet.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <Link href="/products/robomata" className="btn btn-primary rounded-full sm:min-w-48">
                See the operator workflow
                <ArrowRightIcon className="h-4 w-4" />
              </Link>
              <Link href="/markets" className="btn btn-outline rounded-full sm:min-w-48">
                View markets layer
              </Link>
            </div>
          </div>

          <div className="rounded-[1.75rem] border border-base-300 bg-base-200/70 p-5 sm:p-6">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Capital Provider</p>
            <div className="mt-5 space-y-4">
              <div className="rounded-2xl border border-base-300 bg-base-100/80 p-4">
                <BuildingLibraryIcon className="h-6 w-6 text-primary" />
                <h2 className="mt-3 text-lg font-black tracking-tight text-base-content">Designed for credit teams</h2>
                <p className="mt-2 text-sm leading-relaxed text-base-content/70">
                  Lenders, banks, captives, private credit funds, and allocators need structured packet review before
                  they need a generic asset marketplace.
                </p>
              </div>
              <div className="rounded-2xl border border-base-300 bg-base-100/80 p-4">
                <BellAlertIcon className="h-6 w-6 text-primary" />
                <h2 className="mt-3 text-lg font-black tracking-tight text-base-content">Monitoring before trading</h2>
                <p className="mt-2 text-sm leading-relaxed text-base-content/70">
                  Packet freshness, evidence status, and borrowing-base changes should be visible before exposure moves
                  downstream into distribution.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-3">
        {reviewSteps.map((step, index) => (
          <div key={step.title} className="rounded-[1.5rem] border border-base-300 bg-base-100 p-5 shadow-md">
            {index === 0 ? (
              <ClipboardDocumentCheckIcon className="h-6 w-6 text-primary" />
            ) : index === 1 ? (
              <ShieldCheckIcon className="h-6 w-6 text-primary" />
            ) : (
              <ChartPieIcon className="h-6 w-6 text-primary" />
            )}
            <h2 className="mt-4 text-xl font-black tracking-tight text-base-content">{step.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-base-content/70">{step.copy}</p>
          </div>
        ))}
      </section>
    </div>
  </div>
);

export default RobolendPage;
