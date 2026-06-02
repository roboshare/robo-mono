"use client";

import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { formatUnits } from "viem";
import { ASSET_REGISTRIES, AssetType } from "~~/config/assetTypes";
import { usePaymentToken } from "~~/hooks/usePaymentToken";

const BENCHMARK_YIELD_BP = 1000n;
const BP_PRECISION = 10000n;
const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;

interface PrimaryPoolCardProps {
  pool: {
    id: string;
    tokenId: string;
    assetId: string;
    partner: string;
    pricePerToken: string;
    maxSupply: string;
    immediateProceeds: boolean;
    protectionEnabled: boolean;
    isPaused: boolean;
    isClosed: boolean;
    createdAt: string;
  };
  vehicle?: {
    id: string;
    make?: string;
    model?: string;
    year?: string;
    vin?: string;
  };
  token?: {
    price: string;
    supply: string;
    maturityDate: string;
    targetYieldBP?: string;
  };
  earnings?: {
    totalEarnings: string;
    lastDistributionAt: string;
  };
  partner?: {
    name: string;
    address: string;
  };
  imageUrl?: string;
  viewMode?: "list" | "grid";
  primaryActionLabel: string;
  primaryActionDisabled?: boolean;
  primaryActionOnClick?: () => void;
  secondaryActions?: { label: string; onClick?: () => void }[];
  showNewPoolBadge?: boolean;
}

export function PrimaryPoolCard({
  pool,
  vehicle,
  token,
  earnings,
  partner,
  imageUrl,
  viewMode = "grid",
  primaryActionLabel,
  primaryActionDisabled = false,
  primaryActionOnClick,
  secondaryActions = [],
  showNewPoolBadge = false,
}: PrimaryPoolCardProps) {
  const { symbol, decimals } = usePaymentToken();
  const actionDropdownRef = useRef<HTMLDivElement>(null);
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const registry = ASSET_REGISTRIES[AssetType.VEHICLE];
  const displayName =
    vehicle?.make && vehicle?.model && vehicle?.year
      ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`
      : vehicle?.vin || `Asset #${pool.assetId}`;

  const currentSupply = token?.supply ? BigInt(token.supply) : 0n;
  const maxSupply = BigInt(pool.maxSupply);
  const remainingSupply = maxSupply > currentSupply ? maxSupply - currentSupply : 0n;
  const priceDisplay = Number(formatUnits(BigInt(pool.pricePerToken), decimals)).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const apyDisplay = useMemo(() => {
    if (!token) {
      return `${(Number(BENCHMARK_YIELD_BP) / 100).toFixed(2)}%`;
    }

    const currentIssuedSupply = token.supply ? BigInt(token.supply) : 0n;
    const totalValue = BigInt(pool.pricePerToken) * currentIssuedSupply;
    const durationStart = BigInt(pool.createdAt || "0");
    const lastDistributionAt = BigInt(earnings?.lastDistributionAt || "0");
    const totalEarnings = BigInt(earnings?.totalEarnings || "0");

    if (totalEarnings > 0n && totalValue > 0n && durationStart > 0n && lastDistributionAt > durationStart) {
      const duration = lastDistributionAt - durationStart;
      const annualizedEarnings = (totalEarnings * SECONDS_PER_YEAR) / duration;
      const aprBps = (annualizedEarnings * BP_PRECISION) / totalValue;
      return `${(Number(aprBps) / 100).toFixed(2)}%`;
    }

    const targetYieldBps = token.targetYieldBP ? Number(token.targetYieldBP) : Number(BENCHMARK_YIELD_BP);
    return `${(targetYieldBps / 100).toFixed(2)}%`;
  }, [earnings?.lastDistributionAt, earnings?.totalEarnings, pool.createdAt, pool.pricePerToken, token]);
  const statusLabel = pool.isClosed ? "Closed" : pool.isPaused ? "Paused" : "Open";
  const statusClass = pool.isClosed
    ? "bg-base-300 text-base-content/70"
    : pool.isPaused
      ? "bg-warning/15 text-warning"
      : "bg-success/15 text-success";
  const benefitLabel = pool.immediateProceeds ? "Gradual Liquidity" : "Earlier Liquidity";
  const benefitClass = pool.immediateProceeds
    ? "rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary dark:text-base-content"
    : "rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary dark:text-base-content";
  const protectionClass = pool.protectionEnabled
    ? "rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary dark:text-base-content"
    : "rounded-full bg-base-200 px-3 py-1 text-xs font-semibold text-base-content/70";
  const circulatingDisplay = currentSupply === 0n ? "--" : `${currentSupply.toLocaleString()} claim units`;
  const allocatedPercentage = maxSupply > 0n ? Number((currentSupply * 100n) / maxSupply) : 0;
  const isListMode = viewMode === "list";
  const hasSecondaryActions = secondaryActions.some(action => Boolean(action.onClick));
  const isCardPressable = Boolean(primaryActionOnClick) && !primaryActionDisabled;
  const hasAvailableActions = isCardPressable || hasSecondaryActions;
  const enabledPrimaryButtonClass =
    "btn btn-primary border-0 bg-primary/15 text-primary hover:bg-primary/25 dark:bg-primary/25 dark:text-primary-content dark:hover:bg-primary/35";
  const enabledSuccessButtonClass =
    "btn bg-success/15 border-0 text-success hover:bg-success/25 dark:bg-success/35 dark:!text-base-content dark:hover:bg-success/45";
  const enabledErrorButtonClass =
    "btn btn-error border-0 bg-error/15 text-error hover:bg-error/25 dark:bg-error/25 dark:text-error-content dark:hover:bg-error/35";
  const disabledPrimaryButtonClass =
    "btn btn-ghost border border-base-300 bg-base-200 text-base-content/45 hover:border-base-300 hover:bg-base-200 dark:border-base-300 dark:bg-base-200 dark:text-base-content/45";
  const isSuccessPrimary = primaryActionLabel === "Claim Payout" || primaryActionLabel === "Claim Final Payout";
  const isErrorPrimary = primaryActionLabel === "Force Final Payout";
  const activePrimaryButtonClass = isErrorPrimary
    ? enabledErrorButtonClass
    : isSuccessPrimary
      ? enabledSuccessButtonClass
      : enabledPrimaryButtonClass;

  const triggerPrimaryAction = () => {
    if (!isCardPressable) return;
    primaryActionOnClick?.();
  };

  const handleCardClick = (event: MouseEvent<HTMLElement>) => {
    if (!isCardPressable) return;
    const target = event.target as HTMLElement;
    const interactiveAncestor = target.closest("button, a, input, select, textarea, [role='button']");
    if (interactiveAncestor && interactiveAncestor !== event.currentTarget) return;
    triggerPrimaryAction();
  };

  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!isCardPressable) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target as HTMLElement;
    const interactiveAncestor = target.closest("button, a, input, select, textarea, [role='button']");
    if (interactiveAncestor && interactiveAncestor !== event.currentTarget) return;
    event.preventDefault();
    triggerPrimaryAction();
  };

  useEffect(() => {
    if (secondaryActions.length === 0) {
      setIsActionMenuOpen(false);
    }
  }, [secondaryActions.length]);

  useEffect(() => {
    if (!isActionMenuOpen) return;

    const closeIfOutside = (event: MouseEvent | globalThis.MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (actionDropdownRef.current?.contains(target)) return;
      setIsActionMenuOpen(false);
    };

    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setIsActionMenuOpen(false);
    };

    document.addEventListener("mousedown", closeIfOutside);
    document.addEventListener("touchstart", closeIfOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeIfOutside);
      document.removeEventListener("touchstart", closeIfOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isActionMenuOpen]);

  const stopActionEvent = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const renderActionButton = (menuPlacement: "top" | "bottom") => {
    if (!hasSecondaryActions) {
      return (
        <button
          className={`${primaryActionDisabled ? disabledPrimaryButtonClass : activePrimaryButtonClass} w-full shadow-none`}
          onClick={primaryActionOnClick}
          disabled={primaryActionDisabled}
        >
          {primaryActionLabel}
        </button>
      );
    }

    return (
      <div ref={actionDropdownRef} className="relative w-full">
        <div className="flex w-full">
          <button
            type="button"
            className={`${
              primaryActionDisabled ? disabledPrimaryButtonClass : activePrimaryButtonClass
            } rounded-r-none flex-1 shadow-none`}
            onClick={event => {
              stopActionEvent(event);
              setIsActionMenuOpen(false);
              primaryActionOnClick?.();
            }}
            disabled={primaryActionDisabled}
          >
            {primaryActionLabel}
          </button>
          <button
            type="button"
            className={`${activePrimaryButtonClass} rounded-l-none px-2 border-l border-current/15 shadow-none`}
            aria-expanded={isActionMenuOpen}
            aria-haspopup="menu"
            onClick={event => {
              stopActionEvent(event);
              setIsActionMenuOpen(prev => !prev);
            }}
            disabled={primaryActionDisabled && !hasSecondaryActions}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth="1.5"
              stroke="currentColor"
              aria-hidden="true"
              className="h-4 w-4"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
            </svg>
          </button>
        </div>
        {isActionMenuOpen && (
          <ul
            className={`absolute right-0 z-[60] menu rounded-box bg-base-100 p-2 shadow-lg border border-base-300 w-52 ${
              menuPlacement === "top" ? "bottom-full mb-2" : "top-full mt-2"
            }`}
            onClick={event => stopActionEvent(event)}
          >
            {secondaryActions.map(action => (
              <li key={action.label}>
                <button
                  type="button"
                  onClick={event => {
                    stopActionEvent(event);
                    setIsActionMenuOpen(false);
                    action.onClick?.();
                  }}
                >
                  {action.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  if (isListMode) {
    return (
      <article
        className={`overflow-hidden rounded-2xl border border-base-300 bg-base-100 shadow-sm transition-all duration-200 ${
          hasAvailableActions ? "hover:shadow-md" : "opacity-70 saturate-50"
        } ${isCardPressable ? "cursor-pointer" : ""}`}
        onClick={handleCardClick}
        onKeyDown={handleCardKeyDown}
        role={isCardPressable ? "button" : undefined}
        tabIndex={isCardPressable ? 0 : undefined}
        aria-label={isCardPressable ? primaryActionLabel : undefined}
      >
        <div className="flex flex-col lg:flex-row">
          <div className="relative h-40 shrink-0 overflow-hidden bg-base-200 lg:h-auto lg:w-60 xl:w-72">
            {imageUrl ? (
              <Image src={imageUrl} alt={displayName} fill className="object-cover" unoptimized />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <span className="text-6xl opacity-30">{registry.icon}</span>
              </div>
            )}
            {showNewPoolBadge && (
              <div className="absolute left-[-3.5rem] top-4 rotate-[-35deg] bg-success px-16 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-success-content shadow-md">
                New Offering
              </div>
            )}
            <div className="absolute inset-x-4 bottom-4 flex items-end justify-end">
              <span className="rounded-full bg-base-100/90 px-3 py-1 text-xs font-bold text-success shadow-md backdrop-blur-sm">
                {apyDisplay} APY
              </span>
            </div>
          </div>

          <div className="flex flex-1 flex-col gap-3 p-4 sm:p-5">
            <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:gap-4">
              <div className="min-w-0 lg:w-[32%]">
                <div className="min-h-[4rem]">
                  <span className="text-xs font-semibold uppercase tracking-wider text-base-content/50">Vehicle</span>
                  <div className="line-clamp-2 break-words text-lg font-bold leading-tight mt-1" title={displayName}>
                    {displayName}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm text-base-content/60">
                      by {partner?.name || partner?.address || pool.partner}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusClass}`}>
                      {statusLabel}
                    </span>
                  </div>
                </div>
                <div className="mt-2 flex min-h-[4.5rem] flex-wrap content-start items-start gap-2">
                  <span className={benefitClass}>{benefitLabel}</span>
                  <span className={protectionClass}>{pool.protectionEnabled ? "Protection On" : "Protection Off"}</span>
                </div>
              </div>

              <div className="grid flex-1 grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3 lg:w-[42%]">
                <div>
                  <div className="text-[10px] uppercase tracking-wide opacity-50">Issued</div>
                  <div className="font-semibold leading-tight">
                    {currentSupply === 0n ? "--" : currentSupply.toLocaleString()}
                  </div>
                  <div className="text-[11px] opacity-60">claim units</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide opacity-50">Available</div>
                  <div className="font-semibold leading-tight">{remainingSupply.toLocaleString()}</div>
                  <div className="text-[11px] opacity-60">claim units</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide opacity-50">Price</div>
                  <div className="font-semibold leading-tight">{priceDisplay}</div>
                  <div className="text-[11px] opacity-60">{symbol}</div>
                </div>
                <div className="col-span-2 sm:col-span-3">
                  <div className="mb-1 flex justify-between text-[10px] uppercase tracking-wide opacity-50">
                    <span>Allocated</span>
                    <span className="font-semibold opacity-100">{allocatedPercentage}%</span>
                  </div>
                  <progress
                    className="progress h-1.5 w-full progress-primary"
                    value={allocatedPercentage}
                    max="100"
                  ></progress>
                </div>
              </div>

              <div className="w-full lg:w-[220px]">
                {renderActionButton("bottom")}
                <div className="mt-2 text-center text-xs text-base-content/60">
                  Max supply {maxSupply.toLocaleString()} claim units
                </div>
              </div>
            </div>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article
      className={`relative rounded-2xl border border-base-300 bg-base-100 shadow-lg transition-all duration-300 overflow-visible flex flex-col group ${
        hasAvailableActions ? "hover:shadow-xl" : "opacity-70 saturate-50"
      } ${isCardPressable ? "cursor-pointer hover:-translate-y-1 active:translate-y-0 active:scale-[0.995]" : ""}`}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      role={isCardPressable ? "button" : undefined}
      tabIndex={isCardPressable ? 0 : undefined}
      aria-label={isCardPressable ? primaryActionLabel : undefined}
    >
      <div className="relative aspect-[16/10] overflow-hidden rounded-t-2xl bg-base-200 [clip-path:inset(0_round_1rem_1rem_0_0)]">
        {imageUrl ? (
          <Image
            src={imageUrl}
            alt={displayName}
            fill
            className="object-cover group-hover:scale-105 transition-transform duration-500"
            unoptimized
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-6xl opacity-30">{registry.icon}</span>
          </div>
        )}
        {showNewPoolBadge && (
          <div className="absolute inset-x-0 top-0 z-10 rounded-t-2xl bg-success py-2 text-center text-sm font-bold tracking-wide text-success-content">
            ✨ New Offering
          </div>
        )}
        <div className="absolute inset-x-4 bottom-4 flex items-end justify-end gap-3">
          <span className="rounded-full bg-base-100/90 px-3 py-1 text-xs font-bold text-success shadow-md backdrop-blur-sm">
            {apyDisplay} APY
          </span>
        </div>
      </div>

      <div className="grid flex-1 grid-rows-[7.5rem_auto_auto_auto_auto] gap-4 p-5">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_auto_auto] items-start gap-x-3 gap-y-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-base-content/50">Vehicle</span>
          <span
            className={`row-span-3 rounded-full px-3 py-1 text-xs font-semibold shrink-0 self-start ${statusClass}`}
          >
            {statusLabel}
          </span>
          <h3 className="line-clamp-2 text-xl font-bold leading-tight min-h-[2.8rem]" title={displayName}>
            {displayName}
          </h3>
          <div
            className="truncate text-sm text-base-content/60 mt-0.5"
            title={partner?.name || partner?.address || pool.partner}
          >
            by {partner?.name || partner?.address || pool.partner}
          </div>
        </div>

        <div className="flex flex-wrap content-start gap-2">
          <span className={benefitClass}>{benefitLabel}</span>
          <span className={protectionClass}>{pool.protectionEnabled ? "Protection On" : "Protection Off"}</span>
        </div>

        <div className="rounded-xl bg-base-200 p-4">
          <div className="flex items-end justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide opacity-50">Issued</div>
              <div className="mt-1 text-lg font-bold">{circulatingDisplay}</div>
            </div>
            <div className="text-right">
              <div className="text-xs uppercase tracking-wide opacity-50">Allocated</div>
              <div className="mt-1 font-semibold">{allocatedPercentage}%</div>
            </div>
          </div>
          <progress
            className="progress w-full h-2 progress-primary mt-3"
            value={allocatedPercentage}
            max="100"
          ></progress>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-xl bg-base-200 p-3">
            <div className="text-base-content/60">Available</div>
            <div className="mt-1 text-xl font-bold leading-none">{remainingSupply.toLocaleString()}</div>
            <div className="mt-1 text-sm text-base-content/70 font-semibold">claim units</div>
          </div>
          <div className="rounded-xl bg-base-200 p-3">
            <div className="text-base-content/60">Price</div>
            <div className="mt-1 text-xl font-bold leading-none">{priceDisplay}</div>
            <div className="mt-1 text-sm text-base-content/70 font-semibold">{symbol}</div>
          </div>
        </div>

        <div className="flex flex-col gap-2 self-end">
          <div className="w-full">{renderActionButton("top")}</div>
          <div className="text-center text-xs text-base-content/60">
            Max supply {maxSupply.toLocaleString()} claim units
          </div>
        </div>
      </div>
    </article>
  );
}
