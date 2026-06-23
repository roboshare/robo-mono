import Link from "next/link";
import {
  ArrowRightIcon,
  BanknotesIcon,
  ClipboardDocumentListIcon,
  CloudArrowUpIcon,
  DocumentMagnifyingGlassIcon,
  ServerStackIcon,
  TruckIcon,
} from "@heroicons/react/24/outline";
import { isRobomataWorkflowEnabled } from "~~/lib/featureFlags";

const partnerCategories = [
  {
    title: "Telematics and utilization",
    copy: "Vehicle activity, mileage, uptime, and servicing signals that support fleet receivable quality.",
    icon: TruckIcon,
  },
  {
    title: "Lockbox and bank reporting",
    copy: "Collection controls and cash-mapping evidence that ties borrower payments to borrowing-base availability.",
    icon: BanknotesIcon,
  },
  {
    title: "Insurance, title, lien, and UCC",
    copy: "Collateral-control evidence operators need before a lender can rely on the asset and receivable package.",
    icon: DocumentMagnifyingGlassIcon,
  },
  {
    title: "Accounting and servicing data",
    copy: "Receivables aging, obligor status, servicing actions, and exception data from systems operators already use.",
    icon: ClipboardDocumentListIcon,
  },
];

const PartnersPage = () => {
  const launchAppHref = isRobomataWorkflowEnabled() ? "/operator/submissions" : "/operator";

  return (
    <div className="flex flex-1 justify-center px-4 py-8 sm:px-6 sm:py-10">
      <div className="w-full max-w-7xl space-y-8">
        <section className="overflow-hidden rounded-[2rem] border border-base-300 bg-base-100 shadow-xl shadow-base-300/40">
          <div className="grid gap-8 px-6 py-8 sm:px-8 sm:py-10 lg:grid-cols-[1.08fr_0.92fr] lg:px-10">
            <div className="space-y-7">
              <div className="space-y-4">
                <p className="text-sm font-semibold uppercase tracking-[0.3em] text-base-content/50">
                  Integration Partners
                </p>
                <h1 className="max-w-4xl text-4xl font-black tracking-tight text-base-content sm:text-5xl lg:text-6xl">
                  Bring real operating evidence into credit workflows.
                </h1>
                <p className="max-w-3xl text-lg leading-relaxed text-base-content/70">
                  Roboshare partners with data, servicing, and infrastructure providers that help operators prove their
                  receivables are eligible, monitored, and lender-ready.
                </p>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <Link href="/products/robomata" className="btn btn-primary rounded-full sm:min-w-48">
                  See Robomata
                  <ArrowRightIcon className="h-4 w-4" />
                </Link>
                <Link href={launchAppHref} className="btn btn-outline rounded-full sm:min-w-48">
                  Launch App
                </Link>
              </div>
            </div>

            <div className="rounded-[1.75rem] border border-base-300 bg-base-200/70 p-5 sm:p-6">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Why Integrate</p>
              <div className="mt-5 space-y-4">
                <div className="rounded-2xl border border-base-300 bg-base-100/80 p-4">
                  <CloudArrowUpIcon className="h-6 w-6 text-primary" />
                  <h2 className="mt-3 text-lg font-black tracking-tight text-base-content">Fewer diligence gaps</h2>
                  <p className="mt-2 text-sm leading-relaxed text-base-content/70">
                    Operators can attach evidence with clear source metadata instead of rebuilding the same lender
                    packet by email each month.
                  </p>
                </div>
                <div className="rounded-2xl border border-base-300 bg-base-100/80 p-4">
                  <ServerStackIcon className="h-6 w-6 text-primary" />
                  <h2 className="mt-3 text-lg font-black tracking-tight text-base-content">
                    Evidence rails, not portals
                  </h2>
                  <p className="mt-2 text-sm leading-relaxed text-base-content/70">
                    The integration role is to make trusted evidence available to the operator workflow, not to replace
                    provider systems of record.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-5 md:grid-cols-2">
          {partnerCategories.map(item => {
            const Icon = item.icon;

            return (
              <div key={item.title} className="rounded-[1.5rem] border border-base-300 bg-base-100 p-5 shadow-md">
                <Icon className="h-6 w-6 text-primary" />
                <h2 className="mt-4 text-xl font-black tracking-tight text-base-content">{item.title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-base-content/70">{item.copy}</p>
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
};

export default PartnersPage;
