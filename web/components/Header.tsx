"use client";

import React, { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { hardhat } from "viem/chains";
import { Bars3Icon, BugAntIcon, RocketLaunchIcon } from "@heroicons/react/24/outline";
import { CubeTransparentIcon, MagnifyingGlassIcon, UserGroupIcon } from "@heroicons/react/24/outline";
import { FaucetButton, RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { useOutsideClick, useTargetNetwork } from "~~/hooks/scaffold-eth";
import { useIsAdmin } from "~~/hooks/useIsAdmin";
import { usePaymentToken } from "~~/hooks/usePaymentToken";
import { isRobomataWorkflowEnabled } from "~~/lib/featureFlags";

type HeaderMenuLink = {
  label: string;
  href: string;
  icon?: React.ReactNode;
  adminOnly?: boolean;
};

const DEFAULT_APP_HOST = "app.roboshare.finance";

const getConfiguredAppHost = () => process.env.NEXT_PUBLIC_ROBOSHARE_APP_HOST?.trim().toLowerCase() || DEFAULT_APP_HOST;

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
            <Link href="/products/robomata" className="justify-between gap-4 rounded-xl text-sm">
              <span>Robomata</span>
              <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.12em] text-primary">
                Active
              </span>
            </Link>
          </li>
          <li>
            <Link href="/products/robomarkets" className="justify-between gap-4 rounded-xl text-sm">
              <span>Robomarkets</span>
            </Link>
          </li>
          <li>
            <Link href="/products/robolend" className="justify-between gap-4 rounded-xl text-sm">
              <span>Robolend</span>
              <span className="whitespace-nowrap rounded-full bg-amber-100 px-2.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.12em] text-amber-700">
                Soon
              </span>
            </Link>
          </li>
        </ul>
      </details>
    </li>
  );
};

export const HeaderMenuLinks = () => {
  const pathname = usePathname();
  const { isAdmin } = useIsAdmin();
  const [isAppHost, setIsAppHost] = useState(false);
  const [isHostResolved, setIsHostResolved] = useState(false);
  const launchAppHref = isRobomataWorkflowEnabled() ? "/operator/submissions" : "/operator";
  const isOperatorPath =
    pathname === "/operator" ||
    pathname?.startsWith("/operator/") ||
    pathname === "/partner" ||
    pathname?.startsWith("/partner/");
  const showLaunchApp = isHostResolved && !isAppHost && !isOperatorPath;

  useEffect(() => {
    setIsAppHost(window.location.hostname.toLowerCase() === getConfiguredAppHost());
    setIsHostResolved(true);
  }, []);

  return (
    <>
      <HeaderProductsMenu />
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
      {showLaunchApp ? (
        <li>
          <Link
            href={launchAppHref}
            passHref
            className="grid grid-flow-col gap-2 rounded-full border border-primary/70 bg-primary px-3 py-1.5 text-sm font-semibold text-primary-content shadow-md shadow-primary/20 hover:bg-primary/90 focus:!bg-primary active:!text-primary-content"
          >
            <RocketLaunchIcon className="h-4 w-4" />
            <span>Launch App</span>
          </Link>
        </li>
      ) : null}
    </>
  );
};

/**
 * Site header
 */
export const Header = () => {
  const { targetNetwork } = useTargetNetwork();
  const isLocalNetwork = targetNetwork.id === hardhat.id;
  const { isMockToken } = usePaymentToken();
  const showFaucet = isLocalNetwork || isMockToken;

  const burgerMenuRef = useRef<HTMLDetailsElement>(null);
  useOutsideClick(burgerMenuRef, () => {
    burgerMenuRef?.current?.removeAttribute("open");
  });

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
        <Link href="/" passHref className="hidden lg:flex items-center gap-2 ml-4 mr-6 shrink-0">
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
            <span className="pl-12 text-xs dark:text-base-content/80">Tokenized revenue streams</span>
          </div>
        </Link>
        <ul className="hidden lg:flex lg:flex-nowrap menu menu-horizontal px-1 gap-2">
          <HeaderMenuLinks />
        </ul>
      </div>
      <div className="navbar-end grow mr-4">
        <RainbowKitCustomConnectButton />
        {showFaucet && <FaucetButton />}
      </div>
    </div>
  );
};
