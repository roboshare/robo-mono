import Link from "next/link";
import { ArrowRightIcon, BanknotesIcon, BuildingLibraryIcon, ChartBarSquareIcon } from "@heroicons/react/24/outline";
import { toConfiguredAppHref } from "~~/lib/appNavigation";
import { isRobomataWorkflowEnabled } from "~~/lib/featureFlags";

const productFlow = [
  {
    label: "Robomata",
    title: "Prepare the packet",
    copy: "Operators structure receivables, evidence, exceptions, and borrowing-base output.",
    href: "/products/robomata",
  },
  {
    label: "Robolend",
    title: "Review the facility",
    copy: "Capital providers review packets now; monitoring and policy history follow.",
    href: "/products/robolend",
  },
  {
    label: "Robomarkets",
    title: "Distribute exposure",
    copy: "Standardized offerings and secondary access follow once the facility is ready.",
    href: "/products/robomarkets",
  },
];

const HomePage = () => {
  const launchAppHref = isRobomataWorkflowEnabled() ? "/dashboard" : "/operator";
  const resolvedLaunchAppHref = toConfiguredAppHref(launchAppHref);

  return (
    <div className="flex flex-1 justify-center px-4 py-8 sm:px-6 sm:py-12">
      <div className="w-full max-w-7xl space-y-10">
        <section className="overflow-hidden rounded-[2.25rem] border border-base-300 bg-base-100 shadow-xl shadow-base-300/40">
          <div className="grid items-start gap-8 px-6 py-9 sm:px-9 sm:py-12 lg:grid-cols-[1.12fr_0.88fr] lg:px-12">
            <div className="space-y-7">
              <div className="space-y-4">
                <p className="text-sm font-semibold uppercase tracking-[0.32em] text-base-content/50">Roboshare</p>
                <h1 className="max-w-4xl text-4xl font-black tracking-tight text-base-content sm:text-6xl">
                  Agent-supervised programmable credit rails for asset-backed finance.
                </h1>
                <p className="max-w-3xl text-lg leading-relaxed text-base-content/70">
                  Roboshare helps operators turn receivables, asset evidence, policy exceptions, and monitoring signals
                  into lender-ready credit workflows. Robomata prepares the operator packet today; Robolend and
                  Robomarkets extend it into lender review and distribution.
                </p>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <a href={resolvedLaunchAppHref} className="btn btn-primary rounded-full sm:min-w-48">
                  Launch App
                </a>
                <Link href="/products/robomata" className="btn btn-outline rounded-full sm:min-w-48">
                  Explore Robomata
                  <ArrowRightIcon className="h-4 w-4" />
                </Link>
              </div>

              <p className="max-w-2xl text-sm leading-relaxed text-base-content/60">
                Robomata is the live operator workspace. Robolend and Robomarkets sit downstream for capital-provider
                review and distribution.
              </p>
            </div>

            <div className="self-start rounded-[1.75rem] border border-base-300 bg-base-200/70 p-5 sm:p-6">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">System Flow</p>
              <div className="mt-5 flex flex-col gap-3">
                {productFlow.map((item, index) => (
                  <Link
                    key={item.label}
                    href={item.href}
                    className="group block rounded-2xl border border-base-300 bg-base-100/85 p-3.5 transition hover:border-primary/40 hover:bg-base-100"
                  >
                    <div className="flex items-start gap-4">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-black text-primary">
                        {index + 1}
                      </div>
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/50">
                          {item.label}
                        </div>
                        <h3 className="mt-1 text-base font-black tracking-tight text-base-content">{item.title}</h3>
                        <p className="mt-2 text-sm leading-relaxed text-base-content/70">{item.copy}</p>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-3">
          <div className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
            <BanknotesIcon className="h-7 w-7 text-primary" />
            <h2 className="mt-4 text-2xl font-black tracking-tight text-base-content">For Operators</h2>
            <p className="mt-3 text-sm leading-relaxed text-base-content/70">
              Prepare receivables, evidence, exception cures, borrowing-base runs, and monitored packets in one
              repeatable workflow.
            </p>
            <Link href="/products/robomata" className="btn btn-ghost mt-5 rounded-full px-0 text-primary">
              See Robomata
              <ArrowRightIcon className="h-4 w-4" />
            </Link>
          </div>

          <div className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
            <BuildingLibraryIcon className="h-7 w-7 text-primary" />
            <h2 className="mt-4 text-2xl font-black tracking-tight text-base-content">For Capital Providers</h2>
            <p className="mt-3 text-sm leading-relaxed text-base-content/70">
              Robolend supports packet review now; policy observations, monitoring, and credit approval history are
              coming soon.
            </p>
            <Link href="/products/robolend" className="btn btn-ghost mt-5 rounded-full px-0 text-primary">
              Preview Robolend
              <ArrowRightIcon className="h-4 w-4" />
            </Link>
          </div>

          <div className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
            <ChartBarSquareIcon className="h-7 w-7 text-primary" />
            <h2 className="mt-4 text-2xl font-black tracking-tight text-base-content">For Investors</h2>
            <p className="mt-3 text-sm leading-relaxed text-base-content/70">
              Access standardized exposure only after facilities become structured, reviewed, committed, and ready for
              downstream distribution.
            </p>
            <Link href="/products/robomarkets" className="btn btn-ghost mt-5 rounded-full px-0 text-primary">
              Explore Robomarkets
              <ArrowRightIcon className="h-4 w-4" />
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
};

export default HomePage;
