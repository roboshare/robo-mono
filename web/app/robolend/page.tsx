import Link from "next/link";
import {
  ArrowRightIcon,
  BanknotesIcon,
  ClipboardDocumentCheckIcon,
  ScaleIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";

const reviewSteps = [
  {
    title: "Packet review",
    copy: "Review Robomata facility packets, evidence references, borrowing-base runs, and exception history.",
    icon: ClipboardDocumentCheckIcon,
  },
  {
    title: "Credit model layer",
    copy: "Apply lender models, compare policy observations, and track required approvals before tokenization.",
    icon: ScaleIcon,
  },
  {
    title: "Tokenization approval",
    copy: "Approve terms, agent policies, monitoring requirements, and the authorization boundary for market distribution.",
    icon: ShieldCheckIcon,
  },
];

const RobolendPage = () => (
  <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
    <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="max-w-4xl">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
            <BanknotesIcon className="h-4 w-4" />
            Capital-provider workspace
          </div>
          <h1 className="mt-3 text-4xl font-black tracking-tight text-base-content sm:text-5xl">Robolend</h1>
          <p className="mt-4 text-lg leading-relaxed text-base-content/70">
            Robolend sits between Robomata and Robomarkets: lenders review packet state, apply credit models, and
            approve tokenization before exposure reaches market distribution.
          </p>
        </div>
        <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-bold uppercase tracking-[0.16em] text-amber-700">
          Coming next
        </span>
      </div>
    </section>

    <section className="grid gap-4 lg:grid-cols-3">
      {reviewSteps.map(step => {
        const Icon = step.icon;
        return (
          <article key={step.title} className="rounded-[1.5rem] border border-base-300 bg-base-100 p-5">
            <Icon className="h-5 w-5 text-primary" />
            <h2 className="mt-4 text-xl font-black tracking-tight text-base-content">{step.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-base-content/70">{step.copy}</p>
          </article>
        );
      })}
    </section>

    <section className="flex flex-col gap-3 rounded-[1.5rem] border border-base-300 bg-base-100 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 className="text-lg font-black tracking-tight text-base-content">Current handoff</h2>
        <p className="mt-1 text-sm text-base-content/70">
          Prepare lender-ready packets in Robomata today; approved exposure moves downstream to Robomarkets.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href="/robomata/submissions" className="btn btn-primary rounded-full">
          Open Robomata
          <ArrowRightIcon className="h-4 w-4" />
        </Link>
        <Link href="/markets" className="btn btn-outline rounded-full">
          Open Robomarkets
        </Link>
      </div>
    </section>
  </div>
);

export default RobolendPage;
