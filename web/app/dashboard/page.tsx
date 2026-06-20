import Link from "next/link";
import {
  ArrowRightIcon,
  BanknotesIcon,
  BuildingStorefrontIcon,
  ChartBarSquareIcon,
  ClipboardDocumentCheckIcon,
  Squares2X2Icon,
} from "@heroicons/react/24/outline";
import { isRobomataRentalHostOpsClientEnabled, isRobomataWorkflowEnabled } from "~~/lib/featureFlags";

const workspaceCards = [
  {
    title: "Robomata",
    eyebrow: "Capital readiness",
    description: "Prepare facility packages, evidence, borrowing-base runs, and lender packets.",
    href: "/robomata/submissions",
    icon: ClipboardDocumentCheckIcon,
    primary: true,
  },
  {
    title: "Rental operations",
    eyebrow: "Edge application",
    description: "Manage fleet inventory, bookings, trips, claims, and rental servicing workflows.",
    href: "/operator/rentals",
    icon: BuildingStorefrontIcon,
  },
  {
    title: "Operator portal",
    eyebrow: "Protocol operations",
    description: "Manage registered assets, token pools, earnings, settlement, and partner actions.",
    href: "/operator",
    icon: Squares2X2Icon,
  },
  {
    title: "Markets",
    eyebrow: "Distribution",
    description: "Review primary pools, secondary listings, holdings, and market activity.",
    href: "/markets",
    icon: ChartBarSquareIcon,
  },
  {
    title: "Robolend",
    eyebrow: "Future lender workspace",
    description: "Lender model review and tokenization approvals will live here as the capital-provider layer matures.",
    href: "/products/robolend",
    icon: BanknotesIcon,
  },
];

const DashboardPage = () => {
  const robomataEnabled = isRobomataWorkflowEnabled();
  const rentalOpsEnabled = isRobomataRentalHostOpsClientEnabled();

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
      <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30 sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Roboshare dashboard</p>
        <div className="mt-3 max-w-4xl">
          <h1 className="text-4xl font-black tracking-tight text-base-content sm:text-5xl">
            Choose the product space for the work in front of you.
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-base-content/70">
            Robomata prepares credit packages, rental operations service edge-app cash flows, Robolend will handle
            lender-side approvals, and Markets handles distribution.
          </p>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        {workspaceCards.map(card => {
          const Icon = card.icon;
          const disabled =
            (card.href === "/robomata/submissions" && !robomataEnabled) ||
            (card.href === "/operator/rentals" && !rentalOpsEnabled);
          const cardClassName = `group rounded-[1.5rem] border p-5 transition ${
            card.primary
              ? "border-primary/30 bg-primary/10 hover:border-primary/60"
              : "border-base-300 bg-base-100 hover:border-primary/40"
          } ${disabled ? "opacity-55" : "hover:shadow-md"}`;
          const cardContent = (
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-base-content/50">
                  <Icon className="h-4 w-4" />
                  {card.eyebrow}
                </div>
                <h2 className="mt-3 text-2xl font-black tracking-tight text-base-content">{card.title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-base-content/70">{card.description}</p>
                {disabled ? (
                  <div className="mt-4 text-sm font-semibold text-base-content/50">Not enabled in this environment</div>
                ) : (
                  <div className="mt-4 text-sm font-semibold text-primary">Open workspace</div>
                )}
              </div>
              <ArrowRightIcon className="h-5 w-5 shrink-0 text-primary transition group-hover:translate-x-0.5" />
            </div>
          );

          if (disabled) {
            return (
              <div key={card.title} className={cardClassName} aria-disabled="true">
                {cardContent}
              </div>
            );
          }

          return (
            <Link key={card.title} href={card.href} className={cardClassName}>
              {cardContent}
            </Link>
          );
        })}
      </section>
    </div>
  );
};

export default DashboardPage;
