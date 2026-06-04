"use client";

import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { formatUnits } from "viem";
import { ASSET_REGISTRIES, AssetType } from "~~/config/assetTypes";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { usePaymentToken } from "~~/hooks/usePaymentToken";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import { isSettledAssetStatus } from "~~/utils/assetStatus";

const BP_PRECISION = 10000n;
const BENCHMARK_YIELD_BP = 1000n;

interface ListingCardProps {
  listing: {
    id: string;
    tokenId: string;
    assetId: string;
    pricePerToken: string;
    amount: string;
    amountSold?: string;
    expiresAt: string;
    seller: string;
    status?: string;
    isEnded?: boolean;
    endedAt?: string | null;
    createdAt?: string;
    soldOutAt?: string;
  };
  vehicle?: {
    id: string;
    make?: string;
    model?: string;
    year?: string;
    vin?: string;
    metadataURI?: string;
  };
  token?: {
    price: string;
    supply: string;
    createdAt?: string;
    maturityDate: string;
    targetYieldBP?: string;
  };
  earnings?: {
    totalEarnings: string;
    totalRevenue: string;
    lastDistributionAt: string;
  };
  partner?: {
    name: string;
    address: string;
  };
  imageUrl?: string;
  assetType?: AssetType;
  priority?: boolean;
  viewMode?: "list" | "grid";
  hasUserActiveListingForTokenId?: boolean;
  tokenTotalSoldAmount?: string;
  onBuyClick?: () => void;
  onClaimEarningsClick?: () => void;
  onClaimSettlementClick?: () => void;
  onListTokensClick?: (amount: string) => void;
  onEndListingClick?: () => void;
}

export function ListingCard({
  listing,
  vehicle,
  token,
  earnings,
  partner,
  imageUrl,
  assetType = AssetType.VEHICLE,
  priority,
  viewMode = "grid",
  hasUserActiveListingForTokenId = false,
  tokenTotalSoldAmount,
  onBuyClick,
  onClaimEarningsClick,
  onClaimSettlementClick,
  onListTokensClick,
  onEndListingClick,
}: ListingCardProps) {
  const { address } = useTransactingAccount();
  const { symbol: paymentSymbol, decimals: paymentDecimals } = usePaymentToken();
  const actionDropdownRef = useRef<HTMLDivElement>(null);
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const { data: walletTokenBalance } = useScaffoldReadContract({
    contractName: "RoboshareTokens",
    functionName: "balanceOf",
    args: [address, BigInt(listing.tokenId)],
  });
  const { data: previewClaimAmount } = useScaffoldReadContract({
    contractName: "EarningsManager",
    functionName: "previewClaimEarnings",
    args: [BigInt(listing.assetId), address],
    query: { enabled: !!address },
  });
  const { data: assetStatus } = useScaffoldReadContract({
    contractName: "RegistryRouter",
    functionName: "getAssetStatus",
    args: [BigInt(listing.assetId)],
  });
  const hasAvailableTokens = BigInt(listing.amount) > 0n;
  const hasEarnings = Boolean(earnings && earnings.totalEarnings !== "0");
  const hasHoldings = (walletTokenBalance || 0n) > 0n;
  const canClaimEarnings = (previewClaimAmount || 0n) > 0n;
  const canClaimEarningsOnThisListing = canClaimEarnings && hasHoldings;
  const isAssetSettled = isSettledAssetStatus(Number(assetStatus ?? -1));
  const canClaimSettlement = hasHoldings && isAssetSettled;
  const listingSoldAmount = useMemo(() => {
    if (listing.amountSold && listing.amountSold !== "0") return BigInt(listing.amountSold);
    if (token?.supply) {
      const derived = BigInt(token.supply) - BigInt(listing.amount);
      return derived > 0n ? derived : 0n;
    }
    return 0n;
  }, [listing.amount, listing.amountSold, token?.supply]);

  const soldSupplyForAllocation = useMemo(() => {
    if (tokenTotalSoldAmount && tokenTotalSoldAmount !== "0") return BigInt(tokenTotalSoldAmount);
    return listingSoldAmount;
  }, [tokenTotalSoldAmount, listingSoldAmount]);

  const listingActualEarnings = useMemo(() => {
    if (!earnings || earnings.totalEarnings === "0") return 0n;
    if (listingSoldAmount <= 0n || soldSupplyForAllocation <= 0n) return 0n;
    return (BigInt(earnings.totalEarnings) * listingSoldAmount) / soldSupplyForAllocation;
  }, [earnings, listingSoldAmount, soldSupplyForAllocation]);

  // Calculate display values
  const displayName = useMemo(() => {
    if (vehicle?.make && vehicle?.model && vehicle?.year) {
      return `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
    }
    if (vehicle?.vin) return vehicle.vin;
    return `Asset #${listing.assetId}`;
  }, [vehicle, listing.assetId]);

  // Calculate APY - use token-level realized earnings if available, otherwise target yield
  const apyDisplay = useMemo(() => {
    if (!token) {
      return `${(Number(BENCHMARK_YIELD_BP) / 100).toFixed(2)}%`;
    }

    const tokenPrice = BigInt(token.price);
    const tokenSupply = BigInt(token.supply);
    const totalValue = tokenPrice * tokenSupply;

    if (earnings && earnings.totalEarnings !== "0" && totalValue > 0n) {
      const durationStart = BigInt(token.createdAt || "0");
      const lastDistAt = BigInt(earnings.lastDistributionAt || "0");
      const totalEarnings = BigInt(earnings.totalEarnings);
      const duration = durationStart > 0n && lastDistAt > durationStart ? lastDistAt - durationStart : 0n;

      if (duration > 0n && totalEarnings > 0n) {
        const secondsPerYear = 365n * 24n * 60n * 60n;
        const annualizedEarnings = (totalEarnings * secondsPerYear) / duration;
        const aprBps = (annualizedEarnings * BP_PRECISION) / totalValue;
        const aprPercent = Number(aprBps) / 100;
        return `${aprPercent.toFixed(2)}%`;
      }
    }

    // Fallback to target yield APY (or benchmark if unavailable)
    const targetYieldBps = token.targetYieldBP ? Number(token.targetYieldBP) : Number(BENCHMARK_YIELD_BP);
    const targetYieldPercent = targetYieldBps / 100;
    return `${targetYieldPercent.toFixed(2)}%`;
  }, [earnings, token]);

  // Format listing-scoped actual earnings (numeric value only — symbol rendered separately)
  const actualEarningsDisplay = useMemo(() => {
    if (listingActualEarnings === 0n) return "0.00";
    const amount = formatUnits(listingActualEarnings, paymentDecimals);
    return Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }, [listingActualEarnings, paymentDecimals]);

  // Calculate projected annual earnings
  const projectedEarningsPerYear = useMemo(() => {
    if (!token) return "—";
    const tokenPrice = BigInt(token.price);
    const listingAmountForProjection =
      listing.isEnded || !hasAvailableTokens ? listingSoldAmount : BigInt(listing.amount);
    const totalValue = tokenPrice * listingAmountForProjection;
    if (totalValue === 0n) return "0.00";

    const targetYieldBps = token.targetYieldBP ? BigInt(token.targetYieldBP) : BENCHMARK_YIELD_BP;
    const earningsPerYear = (totalValue * targetYieldBps) / BP_PRECISION;

    return Number(formatUnits(earningsPerYear, paymentDecimals)).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }, [token, listing.amount, listing.isEnded, hasAvailableTokens, listingSoldAmount, paymentDecimals]);

  // Format price per token (numeric value only — symbol rendered separately)
  const priceDisplay = useMemo(() => {
    const amount = formatUnits(BigInt(listing.pricePerToken), paymentDecimals);
    return Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }, [listing.pricePerToken, paymentDecimals]);

  // Format number compactly (e.g., 64000 -> "64K")
  const formatCompact = (num: number): string => {
    if (num >= 1000000) {
      return `${(num / 1000000).toFixed(num % 1000000 === 0 ? 0 : 1)}M`;
    }
    if (num >= 1000) {
      return `${(num / 1000).toFixed(num % 1000 === 0 ? 0 : 1)}K`;
    }
    return num.toLocaleString();
  };

  const formatDuration = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  };

  // Format available tokens (available/total)
  const availableTokensDisplay = useMemo(() => {
    const availableNum = Number(listing.amount);
    // Use explicit amountSold if available, otherwise assume remaining vs supply (which might be inaccurate if burn happened)
    // Actually, listing.amountSold is from subgraph which is accurate.
    const historicalSoldNum = listing.amountSold
      ? Number(listing.amountSold)
      : token
        ? Number(token.supply) - availableNum
        : 0;

    const displayAvailableNum = listing.isEnded ? 0 : availableNum;
    const soldNum = historicalSoldNum;
    const totalNum = listing.isEnded ? availableNum + historicalSoldNum : availableNum + soldNum;
    const soldPercentage = totalNum > 0 ? Math.round((soldNum / totalNum) * 100) : 0;
    return {
      available: formatCompact(displayAvailableNum),
      total: formatCompact(totalNum),
      soldPercentage,
    };
  }, [listing.amount, listing.amountSold, listing.isEnded, token]);

  // Check statuses
  const isExpired = useMemo(() => {
    return Number(listing.expiresAt) * 1000 < Date.now();
  }, [listing.expiresAt]);

  const isEnded = listing.isEnded;
  const statusLabel = isEnded ? "Ended" : isExpired ? "Expired" : "Open";
  const statusClass = isEnded
    ? "bg-base-300 text-base-content/70"
    : isExpired
      ? "bg-warning/15 text-warning"
      : "bg-success/15 text-success";

  const isInactive = isEnded || isExpired;
  const soldOutDurationLabel = useMemo(() => {
    if (hasAvailableTokens) return null;
    if (!listing.createdAt || !listing.soldOutAt) return "Sold Out";
    const createdAt = Number(listing.createdAt);
    const soldOutAt = Number(listing.soldOutAt);
    if (!Number.isFinite(createdAt) || !Number.isFinite(soldOutAt) || createdAt <= 0 || soldOutAt <= 0) {
      return "Sold Out";
    }
    const durationSec = Math.max(0, Math.floor(soldOutAt - createdAt));
    return `Sold Out In ${formatDuration(durationSec)}`;
  }, [hasAvailableTokens, listing.createdAt, listing.soldOutAt]);
  const isNewlyListed = hasAvailableTokens && !isEnded && !hasEarnings;
  const isSellerOfListing = Boolean(address && listing.seller.toLowerCase() === address.toLowerCase());
  const showSecondaryListingBadge = !isInactive;
  const listableTokensAmount = walletTokenBalance || 0n;
  const canListTokens = listableTokensAmount > 0n;

  const registry = ASSET_REGISTRIES[assetType];
  const showInvestedBadge = !isSellerOfListing && hasHoldings;
  const actionState = useMemo(() => {
    type CandidateAction = { label: string; onClick?: () => void; className?: string };

    const listTokensLabel =
      hasUserActiveListingForTokenId || isSellerOfListing ? "List More for Sale" : "List for Sale";
    const hasClaimedTokens = hasHoldings;
    const canManageOwnListing = isSellerOfListing && !isInactive;
    const sellerManagementActions: CandidateAction[] = [];
    const actionCandidates: CandidateAction[] = [];

    const successGhostClass =
      "btn bg-success/15 border-0 text-success hover:bg-success/25 dark:bg-success/35 dark:!text-base-content dark:hover:bg-success/45";
    const payoutGhostClass =
      "btn btn-primary border-0 bg-primary/15 text-primary hover:bg-primary/25 dark:bg-primary/25 dark:text-primary-content dark:hover:bg-primary/35";
    const primaryGhostClass = "btn-primary bg-primary/15 border-0 text-primary hover:bg-primary/25";

    const pushAction = (action: CandidateAction) => {
      if (!action.onClick) return;
      actionCandidates.push(action);
    };

    const resolvePrimaryClass = (action: CandidateAction): string => {
      if (action.label === "Claim Final Payout") return successGhostClass;
      if (action.label === "Send Payout") return payoutGhostClass;
      if (action.label === "Claim Payout" || action.label === "Claim Tokens") {
        return successGhostClass;
      }
      if (
        action.label === "List for Sale" ||
        action.label === "List More for Sale" ||
        action.label === "End Listing" ||
        action.label === "Buy Claim Units"
      ) {
        return primaryGhostClass;
      }
      return action.className || "btn-primary";
    };

    if (canManageOwnListing) {
      if (onEndListingClick) sellerManagementActions.push({ label: "End Listing", onClick: onEndListingClick });
      if (canListTokens) {
        sellerManagementActions.push({
          label: listTokensLabel,
          onClick: () => onListTokensClick?.(listableTokensAmount.toString()),
        });
      }
    }

    if (sellerManagementActions.length > 0) {
      sellerManagementActions.forEach(pushAction);
    } else if (canClaimEarningsOnThisListing) {
      pushAction({ label: "Claim Payout", onClick: onClaimEarningsClick });
      if (canClaimSettlement) {
        pushAction({ label: "Claim Final Payout", onClick: onClaimSettlementClick });
      } else if (canListTokens) {
        pushAction({
          label: listTokensLabel,
          onClick: () => onListTokensClick?.(listableTokensAmount.toString()),
        });
      }
    } else if (!isSellerOfListing && !isInactive) {
      if (hasAvailableTokens) {
        pushAction({ label: "Buy Claim Units", onClick: onBuyClick });
      }
      if (canListTokens) {
        pushAction({
          label: listTokensLabel,
          onClick: () => onListTokensClick?.(listableTokensAmount.toString()),
        });
      }
    } else if (hasClaimedTokens) {
      if (canClaimSettlement) {
        pushAction({ label: "Claim Final Payout", onClick: onClaimSettlementClick });
      } else {
        pushAction({
          label: listTokensLabel,
          onClick: () => onListTokensClick?.(listableTokensAmount.toString()),
        });
      }
    }

    const primaryAction = actionCandidates[0];
    if (primaryAction) {
      return {
        primaryLabel: primaryAction.label,
        primaryClass: resolvePrimaryClass(primaryAction),
        primaryDisabled: false,
        primaryOnClick: primaryAction.onClick,
        secondaryActions: actionCandidates.slice(1),
      };
    }

    const defaultLabel =
      !isSellerOfListing && !isInactive && !hasAvailableTokens
        ? soldOutDurationLabel || "Sold Out"
        : isEnded
          ? "Ended"
          : isExpired
            ? "Expired"
            : "Buy Claim Units";
    return {
      primaryLabel: defaultLabel,
      primaryClass: defaultLabel === "Buy Claim Units" ? primaryGhostClass : "btn-primary",
      primaryDisabled: true,
      primaryOnClick: undefined,
      secondaryActions: [],
    };
  }, [
    canClaimSettlement,
    canClaimEarningsOnThisListing,
    hasAvailableTokens,
    soldOutDurationLabel,
    hasUserActiveListingForTokenId,
    isEnded,
    isExpired,
    isInactive,
    isSellerOfListing,
    listableTokensAmount,
    canListTokens,
    onBuyClick,
    onClaimEarningsClick,
    onClaimSettlementClick,
    onEndListingClick,
    onListTokensClick,
    hasHoldings,
  ]);

  const isCardPressable = Boolean(actionState.primaryOnClick) && !actionState.primaryDisabled;
  const hasAvailableActions = isCardPressable || actionState.secondaryActions.some(action => Boolean(action.onClick));
  const primaryButtonClass = actionState.primaryDisabled
    ? `${actionState.primaryClass} !bg-base-200 !text-base-content/45 !border-base-300 !shadow-none opacity-100`
    : actionState.primaryClass;
  const isListMode = viewMode === "list";
  const triggerPrimaryAction = () => {
    if (!isCardPressable) return;
    actionState.primaryOnClick?.();
  };
  const handleCardClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!isCardPressable) return;
    const target = event.target as HTMLElement;
    const interactiveAncestor = target.closest("button, a, input, select, textarea, [role='button']");
    if (interactiveAncestor && interactiveAncestor !== event.currentTarget) return;
    triggerPrimaryAction();
  };
  const handleCardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isCardPressable) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    triggerPrimaryAction();
  };

  useEffect(() => {
    if (actionState.secondaryActions.length === 0) {
      setIsActionMenuOpen(false);
    }
  }, [actionState.secondaryActions.length]);

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

  if (isListMode) {
    return (
      <article
        className={`relative overflow-hidden rounded-2xl border border-base-300 bg-base-100 shadow-sm transition-all duration-200 ${
          hasAvailableActions ? "hover:shadow-md" : "opacity-70 saturate-50"
        } ${isCardPressable ? "cursor-pointer" : ""}`}
        onClick={handleCardClick}
        onKeyDown={handleCardKeyDown}
        role={isCardPressable ? "button" : undefined}
        tabIndex={isCardPressable ? 0 : undefined}
        aria-label={isCardPressable ? actionState.primaryLabel : undefined}
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
            {showSecondaryListingBadge && (
              <div className="absolute inset-x-4 top-4 flex items-start justify-start">
                <span className="rounded-full bg-base-100/90 px-3 py-1 text-xs font-semibold text-base-content/70 shadow-md backdrop-blur-sm">
                  Secondary Listing
                </span>
              </div>
            )}
            <div className="absolute inset-x-4 bottom-4 flex items-end justify-end">
              <span className="rounded-full bg-base-100/90 px-3 py-1 text-xs font-bold text-success shadow-md backdrop-blur-sm">
                {apyDisplay} APY
              </span>
            </div>
            {/* Status Overlays */}
            {isEnded && !hasAvailableActions && (
              <div className="absolute inset-0 bg-base-300/80 flex items-center justify-center z-10">
                <span className="badge badge-neutral badge-sm font-bold shadow-lg uppercase">Sale Ended</span>
              </div>
            )}
            {isExpired && !isEnded && !hasAvailableActions && (
              <div className="absolute inset-0 bg-warning/80 flex items-center justify-center z-10">
                <span className="badge badge-warning badge-sm font-bold shadow-lg uppercase">Expired</span>
              </div>
            )}
          </div>

          <div className="flex flex-1 flex-col gap-3 p-4 sm:p-5">
            <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:gap-4">
              <div className="min-w-0 lg:w-[32%]">
                <div className="min-h-[4rem]">
                  <span className="text-xs font-semibold uppercase tracking-wider text-base-content/50">
                    {assetType}
                  </span>
                  <div className="line-clamp-2 break-words text-lg font-bold leading-tight mt-1" title={displayName}>
                    {displayName}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {partner && <span className="truncate text-sm text-base-content/60">by {partner.name}</span>}
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusClass}`}>
                      {statusLabel}
                    </span>
                  </div>
                </div>
                <div className="mt-2 flex min-h-[4.5rem] flex-wrap content-start items-start gap-2">
                  {showInvestedBadge && (
                    <span className="badge badge-primary px-3 py-3 text-xs font-bold">💼 Invested</span>
                  )}
                  {isNewlyListed && <span className="badge badge-success px-3 py-3 text-xs font-bold">✨ New</span>}
                </div>
              </div>

              <div className="grid flex-1 grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3 lg:w-[42%]">
                <div>
                  <div className="text-[10px] uppercase tracking-wide opacity-50">
                    {hasEarnings ? "Earnings" : "Est. / Year"}
                  </div>
                  <div className="font-semibold leading-tight text-success">
                    {hasEarnings ? actualEarningsDisplay : projectedEarningsPerYear}
                  </div>
                  <div className="text-[11px] opacity-60">{paymentSymbol}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide opacity-50">Available</div>
                  <div className="font-semibold leading-tight">
                    {availableTokensDisplay.available}
                    <span className="opacity-50 text-[11px]"> / {availableTokensDisplay.total}</span>
                  </div>
                  <div className="text-[11px] opacity-60">units</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide opacity-50">Price</div>
                  <div className="font-semibold leading-tight">{priceDisplay}</div>
                  <div className="text-[11px] opacity-60">{paymentSymbol}</div>
                </div>
                <div className="col-span-2 sm:col-span-3">
                  <div className="mb-1 flex justify-between text-[10px] uppercase tracking-wide opacity-50">
                    <span>Sold</span>
                    <span className="font-semibold opacity-100">{availableTokensDisplay.soldPercentage}%</span>
                  </div>
                  <progress
                    className="progress h-1.5 w-full progress-primary"
                    value={availableTokensDisplay.soldPercentage}
                    max="100"
                  ></progress>
                </div>
              </div>

              <div className="w-full lg:w-[220px]">
                {actionState.secondaryActions.length > 0 ? (
                  <div ref={actionDropdownRef} className="dropdown dropdown-end w-full">
                    <div className="flex w-full">
                      <button
                        type="button"
                        className={`btn ${primaryButtonClass} rounded-r-none flex-1 shadow-none`}
                        onClick={() => {
                          setIsActionMenuOpen(false);
                          actionState.primaryOnClick?.();
                        }}
                        disabled={actionState.primaryDisabled}
                      >
                        {actionState.primaryLabel}
                      </button>
                      <button
                        type="button"
                        className={`btn ${primaryButtonClass} rounded-l-none px-2 border-l border-current/15 shadow-none`}
                        aria-expanded={isActionMenuOpen}
                        aria-haspopup="menu"
                        onClick={() => setIsActionMenuOpen(prev => !prev)}
                        disabled={actionState.primaryDisabled && actionState.secondaryActions.length === 0}
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
                      <ul className="dropdown-content z-[50] menu p-2 shadow bg-base-100 rounded-box w-52 mt-2">
                        {actionState.secondaryActions.map(action => (
                          <li key={action.label}>
                            <button
                              type="button"
                              onClick={() => {
                                setIsActionMenuOpen(false);
                                action.onClick?.();
                              }}
                              className={action.className ?? ""}
                            >
                              {action.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : (
                  <button
                    className={`btn ${primaryButtonClass} w-full shadow-none`}
                    onClick={actionState.primaryOnClick}
                    disabled={actionState.primaryDisabled}
                  >
                    {actionState.primaryLabel}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article
      className={`relative rounded-2xl border border-base-300 bg-base-100 shadow-lg transition-all duration-300 overflow-hidden flex flex-col group ${
        hasAvailableActions ? "hover:shadow-xl" : "opacity-70 saturate-50"
      } ${isCardPressable ? "cursor-pointer hover:-translate-y-1 active:translate-y-0 active:scale-[0.995]" : ""}`}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      role={isCardPressable ? "button" : undefined}
      tabIndex={isCardPressable ? 0 : undefined}
      aria-label={isCardPressable ? actionState.primaryLabel : undefined}
    >
      {showInvestedBadge ? (
        <div className="absolute top-0 left-0 right-0 z-20 bg-primary py-2 text-center text-sm font-bold tracking-wide text-primary-content rounded-t-2xl">
          💼 Invested
        </div>
      ) : isNewlyListed ? (
        <div className="absolute top-0 left-0 right-0 z-20 bg-success py-2 text-center text-sm font-bold tracking-wide text-success-content rounded-t-2xl">
          ✨ Newly Listed
        </div>
      ) : null}

      {/* Image Section */}
      <div className="relative aspect-[16/10] bg-base-200 overflow-hidden rounded-t-2xl [clip-path:inset(0_round_1rem_1rem_0_0)]">
        {imageUrl ? (
          <Image
            src={imageUrl}
            alt={displayName}
            fill
            priority={priority}
            className="object-cover group-hover:scale-105 transition-transform duration-500"
            unoptimized
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-6xl opacity-30">{registry.icon}</span>
          </div>
        )}

        {/* Badges */}
        {showSecondaryListingBadge && (
          <div className="absolute inset-x-4 top-4 flex items-start justify-start">
            <span className="rounded-full bg-base-100/90 px-3 py-1 text-xs font-semibold text-base-content/70 shadow-md backdrop-blur-sm">
              Secondary Listing
            </span>
          </div>
        )}
        <div className="absolute inset-x-4 bottom-4 flex items-end justify-end">
          <span className="rounded-full bg-base-100/90 px-3 py-1 text-xs font-bold text-success shadow-md backdrop-blur-sm">
            {apyDisplay} APY
          </span>
        </div>

        {/* Status Overlays */}
        {isEnded && !hasAvailableActions && (
          <div className="absolute inset-0 bg-base-300/80 flex items-center justify-center z-10">
            <span className="badge badge-neutral badge-lg font-bold shadow-lg uppercase">Sale Ended</span>
          </div>
        )}
        {isExpired && !isEnded && !hasAvailableActions && (
          <div className="absolute inset-0 bg-warning/80 flex items-center justify-center z-10">
            <span className="badge badge-warning badge-lg font-bold shadow-lg uppercase">Expired</span>
          </div>
        )}
      </div>

      {/* Content Section */}
      <div className="grid flex-1 grid-rows-[7.5rem_auto_auto_auto] gap-4 p-5">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_auto_auto] items-start gap-x-3 gap-y-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-base-content/50">{assetType}</span>
          <span
            className={`row-span-3 rounded-full px-3 py-1 text-xs font-semibold shrink-0 self-start ${statusClass}`}
          >
            {statusLabel}
          </span>
          <h3 className="line-clamp-2 text-xl font-bold leading-tight min-h-[2.8rem]" title={displayName}>
            {displayName}
          </h3>
          {partner && <div className="text-sm text-base-content/60 truncate mt-0.5">by {partner.name}</div>}
        </div>

        <div className="rounded-xl bg-base-200 p-4">
          <div className="flex items-end justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide opacity-50">Sold</div>
              <div className="mt-1 text-lg font-bold">{availableTokensDisplay.soldPercentage}%</div>
            </div>
            <div className="text-right">
              <div className="text-xs uppercase tracking-wide opacity-50">Available</div>
              <div className="mt-1 font-semibold">
                {availableTokensDisplay.available} / {availableTokensDisplay.total}
              </div>
            </div>
          </div>
          <progress
            className="progress w-full h-2 progress-primary mt-3"
            value={availableTokensDisplay.soldPercentage}
            max="100"
          ></progress>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-xl bg-base-200 p-3">
            <div className="text-base-content/60 truncate uppercase text-[10px] tracking-wide font-semibold">
              {hasEarnings ? "Earnings" : "Est. / Year"}
            </div>
            <div className="mt-1 text-2xl font-bold leading-none">
              {hasEarnings ? actualEarningsDisplay : projectedEarningsPerYear}
            </div>
            <div className="mt-1 text-base-content/70 font-semibold">{paymentSymbol}</div>
          </div>
          <div className="rounded-xl bg-base-200 p-3">
            <div className="text-base-content/60 truncate uppercase text-[10px] tracking-wide font-semibold">Price</div>
            <div className="mt-1 text-2xl font-bold leading-none">{priceDisplay}</div>
            <div className="mt-1 text-base-content/70 font-semibold">{paymentSymbol}</div>
          </div>
        </div>

        {/* Action Button */}
        <div className="flex flex-col gap-2 self-end">
          <div className="w-full">
            {actionState.secondaryActions.length > 0 ? (
              <div ref={actionDropdownRef} className="dropdown dropdown-end w-full">
                <div className="flex w-full">
                  <button
                    type="button"
                    className={`btn ${primaryButtonClass} rounded-r-none flex-1 shadow-none`}
                    onClick={() => {
                      setIsActionMenuOpen(false);
                      actionState.primaryOnClick?.();
                    }}
                    disabled={actionState.primaryDisabled}
                  >
                    {actionState.primaryLabel}
                  </button>
                  <button
                    type="button"
                    className={`btn ${primaryButtonClass} rounded-l-none px-3 border-l border-current/15 shadow-none`}
                    aria-expanded={isActionMenuOpen}
                    aria-haspopup="menu"
                    onClick={() => setIsActionMenuOpen(prev => !prev)}
                    disabled={actionState.primaryDisabled && actionState.secondaryActions.length === 0}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth="1.5"
                      stroke="currentColor"
                      aria-hidden="true"
                      className="h-5 w-5"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                    </svg>
                  </button>
                </div>
                {isActionMenuOpen && (
                  <ul className="dropdown-content z-[50] menu p-2 shadow bg-base-100 rounded-box w-52 mb-2 bottom-full">
                    {actionState.secondaryActions.map(action => (
                      <li key={action.label}>
                        <button
                          type="button"
                          onClick={() => {
                            setIsActionMenuOpen(false);
                            action.onClick?.();
                          }}
                          className={action.className ?? ""}
                        >
                          {action.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <button
                className={`btn ${primaryButtonClass} btn-block shadow-none`}
                onClick={actionState.primaryOnClick}
                disabled={actionState.primaryDisabled}
              >
                {actionState.primaryLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
