import Link from "next/link";
import {
  ArrowRightIcon,
  BanknotesIcon,
  BuildingLibraryIcon,
  ChartBarSquareIcon,
  ClipboardDocumentCheckIcon,
  CubeTransparentIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";

const productFlow = [
  {
    label: "Robomata",
    title: "Operators become financeable",
    copy: "Fleet operators turn receivables, evidence, exceptions, and borrowing-base output into lender-ready packets.",
    href: "/products/robomata",
  },
  {
    label: "Robolend",
    title: "Capital providers review and monitor",
    copy: "Credit teams get a cleaner path to packet review, freshness monitoring, and portfolio oversight. Coming soon.",
    href: "/products/robolend",
  },
  {
    label: "Markets",
    title: "Standardized exposure can distribute",
    copy: "Committed facilities can move downstream into tokenized exposure and market distribution when ready.",
    href: "/markets",
  },
];

const proofPoints = [
  {
    icon: ClipboardDocumentCheckIcon,
    title: "Borrowing-base packets",
    copy: "Eligibility, reserves, advance rates, and exceptions are prepared from operator-controlled submissions.",
  },
  {
    icon: ShieldCheckIcon,
    title: "Controlled evidence rails",
    copy: "Sensitive source files stay permissioned while commitments can support audit, monitoring, and packet freshness.",
  },
  {
    icon: CubeTransparentIcon,
    title: "Programmable asset state",
    copy: "Financeable facilities can become standardized primitives for tokenization and downstream capital access.",
  },
];

const HomePage = () => (
  <div className="flex flex-1 justify-center px-4 py-8 sm:px-6 sm:py-12">
    <div className="w-full max-w-7xl space-y-10">
      <section className="overflow-hidden rounded-[2.25rem] border border-base-300 bg-base-100 shadow-xl shadow-base-300/40">
        <div className="grid gap-8 px-6 py-9 sm:px-9 sm:py-12 lg:grid-cols-[1.12fr_0.88fr] lg:px-12">
          <div className="space-y-7">
            <div className="space-y-4">
              <p className="text-sm font-semibold uppercase tracking-[0.32em] text-base-content/50">Roboshare</p>
              <h1 className="max-w-4xl text-4xl font-black tracking-tight text-base-content sm:text-6xl">
                Credit rails for productive assets.
              </h1>
              <p className="max-w-3xl text-lg leading-relaxed text-base-content/70">
                Roboshare starts where private credit still breaks down: operators need cleaner evidence, lenders need
                better packets, and markets need standardized financial objects before exposure can distribute.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <Link href="/products/robomata" className="btn btn-primary rounded-full sm:min-w-48">
                Explore Robomata
                <ArrowRightIcon className="h-4 w-4" />
              </Link>
              <Link href="/operator/submissions" className="btn btn-outline rounded-full sm:min-w-48">
                Launch App
              </Link>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {proofPoints.map(item => {
                const Icon = item.icon;

                return (
                  <div key={item.title} className="rounded-3xl border border-base-300 bg-base-200/60 p-4">
                    <Icon className="h-6 w-6 text-primary" />
                    <h2 className="mt-3 text-sm font-bold text-base-content">{item.title}</h2>
                    <p className="mt-2 text-sm leading-relaxed text-base-content/70">{item.copy}</p>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-[1.75rem] border border-base-300 bg-base-200/70 p-5 sm:p-6">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">System Flow</p>
            <div className="mt-5 space-y-4">
              {productFlow.map((item, index) => (
                <Link
                  key={item.label}
                  href={item.href}
                  className="group block rounded-2xl border border-base-300 bg-base-100/85 p-4 transition hover:border-primary/40 hover:bg-base-100"
                >
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-black text-primary">
                      {index + 1}
                    </div>
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/50">
                        {item.label}
                      </div>
                      <h3 className="mt-1 text-lg font-black tracking-tight text-base-content">{item.title}</h3>
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
            Create a repeatable financing workflow around receivables, asset evidence, exception handling, lender
            packets, and facility monitoring.
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
            Robolend will focus on reviewing lender-ready packets, monitoring evidence freshness, and organizing credit
            exposure. It is not live yet.
          </p>
          <Link href="/products/robolend" className="btn btn-ghost mt-5 rounded-full px-0 text-primary">
            Preview Robolend
            <ArrowRightIcon className="h-4 w-4" />
          </Link>
        </div>

        <div className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
          <ChartBarSquareIcon className="h-7 w-7 text-primary" />
          <h2 className="mt-4 text-2xl font-black tracking-tight text-base-content">For Markets</h2>
          <p className="mt-3 text-sm leading-relaxed text-base-content/70">
            Markets are the distribution layer after a facility is structured, committed, and tokenized. The public
            marketplace remains downstream from financeability.
          </p>
          <Link href="/markets" className="btn btn-ghost mt-5 rounded-full px-0 text-primary">
            View markets
            <ArrowRightIcon className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </div>
  </div>
);

export default HomePage;
