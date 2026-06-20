"use client";

import React, { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { hardhat } from "viem/chains";
import {
  BanknotesIcon,
  Bars3Icon,
  BugAntIcon,
  ChartBarSquareIcon,
  ClipboardDocumentCheckIcon,
  KeyIcon,
  RocketLaunchIcon,
  Squares2X2Icon,
} from "@heroicons/react/24/outline";
import { CubeTransparentIcon, MagnifyingGlassIcon, UserGroupIcon } from "@heroicons/react/24/outline";
import { FaucetButton, RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { useOutsideClick, useTargetNetwork } from "~~/hooks/scaffold-eth";
import { useIsAdmin } from "~~/hooks/useIsAdmin";
import { usePaymentToken } from "~~/hooks/usePaymentToken";
import { getConfiguredAppHost, toConfiguredAppHref } from "~~/lib/appNavigation";
import {
  isRobomataRentalHostOpsClientEnabled,
  isRobomataRentalMarketplaceClientEnabled,
  isRobomataWorkflowEnabled,
} from "~~/lib/featureFlags";

type HeaderMenuLink = {
  label: string;
  href: string;
  icon?: React.ReactNode;
  adminOnly?: boolean;
};

const DEFAULT_MARKETING_HOSTS = ["roboshare.finance", "www.roboshare.finance"];
const configuredMarketingHosts = process.env.NEXT_PUBLIC_ROBOSHARE_MARKETING_HOSTS?.split(",")
  .map(host => host.trim().toLowerCase())
  .filter(Boolean);

const marketingHosts = configuredMarketingHosts?.length ? configuredMarketingHosts : DEFAULT_MARKETING_HOSTS;
const isMarketingHost = (host: string | null) => !!host && marketingHosts.includes(host);
const isLocalHost = (host: string | null) => host === "localhost" || host === "127.0.0.1" || host === "::1";
const shouldUseAppHostNavigation = (host: string | null) => !!host && !isLocalHost(host) && isMarketingHost(host);
const isMarketingContentPath = (pathname: string | null) =>
  pathname === "/" ||
  pathname === "/robomata" ||
  pathname?.startsWith("/products/") ||
  pathname === "/partners" ||
  pathname?.startsWith("/partners/");

const HeaderAppAnchor = ({
  children,
  className,
  href,
}: {
  children: React.ReactNode;
  className: string;
  href: string;
}) => (
  <a href={href} className={className}>
    {children}
  </a>
);

const launchAppButtonClassName =
  "grid grid-flow-col gap-2 rounded-full border border-primary/70 bg-primary px-3 py-1.5 text-sm font-semibold text-primary-content shadow-md shadow-primary/20 hover:bg-primary/90 focus:!bg-primary active:!text-primary-content";

export const menuLinks: HeaderMenuLink[] = [
  {
    label: "Partners",
    href: "/partners",
    icon: <UserGroupIcon className="h-4 w-4" />,
  },
  {
    label: "Subgraph",
    href: "/subgraph",
    icon: <MagnifyingGlassIcon className="h-4 w-4" />,
    adminOnly: true,
  },
  {
    label: "Debug Contracts",
    href: "/debug",
    icon: <BugAntIcon className="h-4 w-4" />,
    adminOnly: true,
  },
];

const HeaderProductsMenu = () => {
  const pathname = usePathname();
  const isActive = pathname?.startsWith("/products") || pathname === "/robomata";
  const productsMenuRef = useRef<HTMLDetailsElement>(null);

  useOutsideClick(productsMenuRef, () => {
    productsMenuRef?.current?.removeAttribute("open");
  });

  return (
    <li>
      <details className="dropdown" ref={productsMenuRef}>
        <summary
          onClick={event => {
            event.stopPropagation();
          }}
          className={`${
            isActive ? "bg-secondary shadow-md" : ""
          } hover:bg-secondary hover:shadow-md focus:!bg-secondary active:!text-neutral py-1.5 px-3 text-sm rounded-full gap-2 grid grid-flow-col`}
        >
          <CubeTransparentIcon className="h-4 w-4" />
          <span>Products</span>
        </summary>
        <ul
          className="rounded-box bg-base-100 p-2 shadow-lg"
          onClick={() => {
            productsMenuRef?.current?.removeAttribute("open");
          }}
        >
          <li>
            <a href="/products/robomata" className="justify-between gap-4 rounded-xl text-sm">
              <span>Robomata</span>
            </a>
          </li>
          <li>
            <a href="/products/robomarkets" className="justify-between gap-4 rounded-xl text-sm">
              <span>Robomarkets</span>
            </a>
          </li>
          <li>
            <a href="/products/robolend" className="justify-between gap-4 rounded-xl text-sm">
              <span>Robolend</span>
              <span className="whitespace-nowrap rounded-full bg-amber-100 px-2.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.12em] text-amber-700">
                Soon
              </span>
            </a>
          </li>
        </ul>
      </details>
    </li>
  );
};

const HeaderMenuLinkItems = ({ isAdmin = false, pathname }: { isAdmin?: boolean; pathname: string | null }) => (
  <>
    {menuLinks
      .filter(link => !link.adminOnly || isAdmin)
      .map(({ label, href, icon }) => {
        const isActive = pathname === href;
        return (
          <li key={href}>
            <Link
              href={href}
              passHref
              className={`${
                isActive ? "bg-secondary shadow-md" : ""
              } hover:bg-secondary hover:shadow-md focus:!bg-secondary active:!text-neutral py-1.5 px-3 text-sm rounded-full gap-2 grid grid-flow-col`}
            >
              {icon}
              <span>{label}</span>
            </Link>
          </li>
        );
      })}
  </>
);

const HeaderAdminMenuLinkItems = ({ pathname }: { pathname: string | null }) => {
  const { isAdmin } = useIsAdmin();

  return <HeaderMenuLinkItems isAdmin={isAdmin} pathname={pathname} />;
};

const getLaunchAppHref = () => (isRobomataWorkflowEnabled() ? "/dashboard" : "/operator");

const resolveAppHostHref = ({
  browserHost,
  href,
  isAppHost,
  isHostResolved,
}: {
  browserHost: string | null;
  href: string;
  isAppHost: boolean;
  isHostResolved: boolean;
}) =>
  isHostResolved && !isAppHost && shouldUseAppHostNavigation(browserHost)
    ? toConfiguredAppHref(href, { forceDefaultHost: true })
    : href;

const HeaderLaunchAppButton = ({ href }: { href: string }) => (
  <HeaderAppAnchor href={href} className={launchAppButtonClassName}>
    <RocketLaunchIcon className="h-4 w-4" />
    <span>Launch App</span>
  </HeaderAppAnchor>
);

export const HeaderMenuLinks = () => {
  const pathname = usePathname();
  const [isAppHost, setIsAppHost] = useState(false);
  const [isHostResolved, setIsHostResolved] = useState(false);
  const [browserHost, setBrowserHost] = useState<string | null>(null);
  const launchAppHref = getLaunchAppHref();
  const isMarketingContent = isMarketingContentPath(pathname);
  const isOperatorPath =
    pathname === "/operator" ||
    pathname?.startsWith("/operator/") ||
    pathname === "/partner" ||
    pathname?.startsWith("/partner/");
  const showLaunchApp = (!isMarketingContent || isLocalHost(browserHost)) && !isAppHost && !isOperatorPath;
  const showRentalMarketplace = isRobomataRentalMarketplaceClientEnabled();
  const showRentalHostOps = isRobomataRentalHostOpsClientEnabled();
  const showAdminLinks = !isMarketingContentPath(pathname);
  const resolvedLaunchAppHref = resolveAppHostHref({ browserHost, href: launchAppHref, isAppHost, isHostResolved });
  const resolvedRentalOpsHref = resolveAppHostHref({
    browserHost,
    href: "/operator/rentals",
    isAppHost,
    isHostResolved,
  });

  useEffect(() => {
    const host = window.location.hostname.toLowerCase();
    setBrowserHost(host);
    setIsAppHost(host === getConfiguredAppHost());
    setIsHostResolved(true);
  }, []);

  if (isHostResolved && isAppHost) {
    const robomataEnabled = isRobomataWorkflowEnabled();
    const appLinks: HeaderMenuLink[] = [
      {
        label: "Dashboard",
        href: launchAppHref,
        icon: <Squares2X2Icon className="h-4 w-4" />,
      },
      ...(robomataEnabled
        ? [
            {
              label: "Robomata",
              href: "/robomata/submissions",
              icon: <ClipboardDocumentCheckIcon className="h-4 w-4" />,
            },
          ]
        : []),
      {
        label: "Robolend",
        href: "/robolend",
        icon: <BanknotesIcon className="h-4 w-4" />,
      },
      {
        label: "Robomarkets",
        href: "/markets",
        icon: <ChartBarSquareIcon className="h-4 w-4" />,
      },
      ...(showRentalHostOps
        ? [
            {
              label: "Rental Ops",
              href: "/operator/rentals",
              icon: <KeyIcon className="h-4 w-4" />,
            },
          ]
        : []),
    ];

    return (
      <>
        {appLinks.map(({ label, href, icon }) => {
          const isActive = pathname === href || pathname?.startsWith(`${href}/`);

          return (
            <li key={href}>
              <Link
                href={href}
                passHref
                className={`${
                  isActive ? "bg-secondary shadow-md" : ""
                } hover:bg-secondary hover:shadow-md focus:!bg-secondary active:!text-neutral py-1.5 px-3 text-sm rounded-full gap-2 grid grid-flow-col`}
              >
                {icon}
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </>
    );
  }

  return (
    <>
      <HeaderProductsMenu />
      {showRentalMarketplace && (
        <li>
          <Link
            href="/rentals"
            passHref
            className={`${
              pathname === "/rentals" ? "bg-secondary shadow-md" : ""
            } hover:bg-secondary hover:shadow-md focus:!bg-secondary active:!text-neutral py-1.5 px-3 text-sm rounded-full gap-2 grid grid-flow-col`}
          >
            <KeyIcon className="h-4 w-4" />
            <span>Rentals</span>
          </Link>
        </li>
      )}
      {showAdminLinks ? <HeaderAdminMenuLinkItems pathname={pathname} /> : <HeaderMenuLinkItems pathname={pathname} />}
      {showRentalHostOps && (
        <li>
          <HeaderAppAnchor
            href={resolvedRentalOpsHref}
            className={`${
              pathname === "/operator/rentals" ? "bg-secondary shadow-md" : ""
            } hover:bg-secondary hover:shadow-md focus:!bg-secondary active:!text-neutral py-1.5 px-3 text-sm rounded-full gap-2 grid grid-flow-col`}
          >
            <UserGroupIcon className="h-4 w-4" />
            <span>Rental Ops</span>
          </HeaderAppAnchor>
        </li>
      )}
      {showLaunchApp ? (
        <li>
          <HeaderLaunchAppButton href={resolvedLaunchAppHref} />
        </li>
      ) : null}
    </>
  );
};

const HeaderNetworkActions = () => {
  const { targetNetwork } = useTargetNetwork();
  const isLocalNetwork = targetNetwork.id === hardhat.id;
  const { isMockToken } = usePaymentToken();
  const showFaucet = isLocalNetwork || isMockToken;

  return (
    <>
      <RainbowKitCustomConnectButton />
      {showFaucet && <FaucetButton />}
    </>
  );
};

const HeaderMarketingAction = () => {
  const [browserHost, setBrowserHost] = useState<string | null>(null);
  const [isAppHost, setIsAppHost] = useState(false);
  const [isHostResolved, setIsHostResolved] = useState(false);
  const href = resolveAppHostHref({
    browserHost,
    href: getLaunchAppHref(),
    isAppHost,
    isHostResolved,
  });

  useEffect(() => {
    const host = window.location.hostname.toLowerCase();
    setBrowserHost(host);
    setIsAppHost(host === getConfiguredAppHost());
    setIsHostResolved(true);
  }, []);

  return <HeaderLaunchAppButton href={href} />;
};

/**
 * Site header
 */
export const Header = () => {
  const pathname = usePathname();
  const [showNetworkActions, setShowNetworkActions] = useState(false);
  const showMarketingAction = isMarketingContentPath(pathname) && !showNetworkActions;
  const burgerMenuRef = useRef<HTMLDetailsElement>(null);
  useOutsideClick(burgerMenuRef, () => {
    burgerMenuRef?.current?.removeAttribute("open");
  });

  useEffect(() => {
    const host = window.location.hostname.toLowerCase();
    setShowNetworkActions(isLocalHost(host) || host === getConfiguredAppHost() || !isMarketingContentPath(pathname));
  }, [pathname]);

  return (
    <div className="sticky lg:static top-0 navbar bg-base-100 min-h-0 shrink-0 justify-between z-20 shadow-md shadow-secondary px-0 sm:px-2">
      <div className="navbar-start w-auto lg:w-1/2">
        <details className="dropdown" ref={burgerMenuRef}>
          <summary className="ml-1 btn btn-ghost lg:hidden hover:bg-transparent">
            <Bars3Icon className="h-1/2" />
          </summary>
          <ul
            className="menu menu-compact dropdown-content mt-3 p-2 shadow-sm bg-base-100 rounded-box w-52"
            onClick={() => {
              burgerMenuRef?.current?.removeAttribute("open");
            }}
          >
            <HeaderMenuLinks />
          </ul>
        </details>
        <Link
          href="/"
          aria-label="Roboshare home"
          prefetch={false}
          className="ml-1 flex h-10 w-10 items-center justify-center rounded-full text-base-content hover:bg-secondary lg:hidden"
        >
          <svg viewBox="0 0 40 40" aria-hidden="true" className="h-7 w-7" fill="none">
            <path
              d="m8.25 22.5 17.5-18.75-3.75 13.75h13.75L18.25 36.25 22 22.5H8.25Z"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2.5"
            />
          </svg>
        </Link>
        <Link href="/" prefetch={false} className="hidden lg:flex items-center gap-2 ml-4 mr-6 shrink-0">
          <div className="flex flex-col">
            <Image
              src="/logo.svg"
              alt="Roboshare"
              width={240}
              height={40}
              className="h-10 w-auto dark:hidden"
              priority
            />
            <Image
              src="/logo-dark.svg"
              alt="Roboshare"
              width={240}
              height={40}
              className="hidden h-10 w-auto dark:block"
              priority
            />
          </div>
        </Link>
        <ul className="hidden lg:flex lg:flex-nowrap menu menu-horizontal px-1 gap-2">
          <HeaderMenuLinks />
        </ul>
      </div>
      <div className="navbar-end grow mr-4">
        {showNetworkActions ? <HeaderNetworkActions /> : showMarketingAction ? <HeaderMarketingAction /> : null}
      </div>
    </div>
  );
};
