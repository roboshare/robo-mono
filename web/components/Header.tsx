"use client";

import React, { useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { hardhat } from "viem/chains";
import { Bars3Icon, BugAntIcon, ClipboardDocumentListIcon, HomeIcon } from "@heroicons/react/24/outline";
import { BuildingStorefrontIcon, MagnifyingGlassIcon, UserGroupIcon } from "@heroicons/react/24/outline";
import { FaucetButton, RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { useOutsideClick, useTargetNetwork } from "~~/hooks/scaffold-eth";
import { useIsAdmin } from "~~/hooks/useIsAdmin";
import { usePaymentToken } from "~~/hooks/usePaymentToken";

type HeaderMenuLink = {
  label: string;
  href: string;
  icon?: React.ReactNode;
  adminOnly?: boolean;
};

export const menuLinks: HeaderMenuLink[] = [
  {
    label: "Home",
    href: "/",
    icon: <HomeIcon className="h-4 w-4" />,
  },
  {
    label: "Markets",
    href: "/markets",
    icon: <BuildingStorefrontIcon className="h-4 w-4" />,
  },
  {
    label: "Robomata",
    href: "/robomata",
    icon: <ClipboardDocumentListIcon className="h-4 w-4" />,
  },
  {
    label: "Partners",
    href: "/partner",
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

export const HeaderMenuLinks = () => {
  const pathname = usePathname();
  const { isAdmin } = useIsAdmin();

  return (
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
