import Link from "next/link";
import {
  ArrowRightIcon,
  BanknotesIcon,
  BuildingStorefrontIcon,
  ChartBarSquareIcon,
  CubeTransparentIcon,
} from "@heroicons/react/24/outline";

const marketRoles = [
  {
    title: "Structured before distribution",
    copy: "Robomata prepares the facility, borrowing-base state, evidence references, and exception trail before an offering reaches markets.",
    icon: CubeTransparentIcon,
  },
  {
    title: "Primary and secondary access",
    copy: "Robomarkets is the distribution layer for offerings and secondary liquidity once exposure is standardized enough to present.",
    icon: BuildingStorefrontIcon,
  },
  {
    title: "Financeability-led supply",
    copy: "The market surface should follow operator financeability and capital-provider review, not lead with generic listings.",
    icon: BanknotesIcon,
  },
];

const RobomarketsPage = () => (
  <div className="flex flex-1 justify-center px-4 py-8 sm:px-6 sm:py-12">
    <div className="w-full max-w-7xl space-y-10">
      <section className="overflow-hidden rounded-[2.25rem] border border-base-300 bg-base-100 shadow-xl shadow-base-300/40">
        <div className="grid items-stretch gap-8 px-6 py-9 sm:px-9 sm:py-12 lg:grid-cols-[1.12fr_0.88fr] lg:px-12">
          <div className="flex h-full flex-col gap-7">
            <div className="space-y-4">
              <p className="text-sm font-semibold uppercase tracking-[0.32em] text-base-content/50">Robomarkets</p>
              <h1 className="max-w-4xl text-4xl font-black tracking-tight text-base-content sm:text-6xl">
                Distribution for financeable asset exposure.
              </h1>
              <p className="max-w-3xl text-lg leading-relaxed text-base-content/70">
                Robomarkets is the downstream market layer for standardized and tokenized exposure. Facilities should
                arrive here after Robomata has organized the operator packet and capital providers have a clear path to
                review the underlying evidence.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <Link
                href="/markets"
                className="btn group rounded-full border-primary bg-primary text-primary-content transition-colors hover:border-primary hover:bg-primary-content hover:text-primary sm:min-w-48"
              >
                Open live markets
                <ArrowRightIcon className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link href="/products/robomata" className="btn btn-outline rounded-full sm:min-w-48">
                Start with Robomata
              </Link>
            </div>
          </div>

          <div className="flex h-full flex-col rounded-[1.75rem] border border-base-300 bg-base-200/70 p-5 sm:p-6">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Market Role</p>
            <div className="mt-5 flex flex-1 flex-col gap-4">
              {marketRoles.map(item => {
                const Icon = item.icon;

                return (
                  <div key={item.title} className="flex-1 rounded-2xl border border-base-300 bg-base-100/85 p-4">
                    <Icon className="h-6 w-6 text-primary" />
                    <h2 className="mt-3 text-lg font-black tracking-tight text-base-content">{item.title}</h2>
                    <p className="mt-2 text-sm leading-relaxed text-base-content/70">{item.copy}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-3">
        <div className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
          <ChartBarSquareIcon className="h-7 w-7 text-primary" />
          <h2 className="mt-4 text-2xl font-black tracking-tight text-base-content">Offerings</h2>
          <p className="mt-3 text-sm leading-relaxed text-base-content/70">
            Present standardized asset-backed exposure after the facility has a clear borrowing-base and evidence trail.
          </p>
        </div>
        <div className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
          <BuildingStorefrontIcon className="h-7 w-7 text-primary" />
          <h2 className="mt-4 text-2xl font-black tracking-tight text-base-content">Secondary Liquidity</h2>
          <p className="mt-3 text-sm leading-relaxed text-base-content/70">
            Support post-origination liquidity without turning early financeability work into a generic marketplace.
          </p>
        </div>
        <div className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
          <BanknotesIcon className="h-7 w-7 text-primary" />
          <h2 className="mt-4 text-2xl font-black tracking-tight text-base-content">Capital Access</h2>
          <p className="mt-3 text-sm leading-relaxed text-base-content/70">
            Connect structured facilities to broader capital only after operators and reviewers have a trustworthy
            packet.
          </p>
        </div>
      </section>
    </div>
  </div>
);

export default RobomarketsPage;
