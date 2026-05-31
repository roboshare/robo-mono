"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NextPage } from "next";
import { formatUnits } from "viem";
import { useChainId, useChains, useReadContract, useReadContracts, useSwitchChain } from "wagmi";
import {
  AdjustmentsHorizontalIcon,
  ArrowsUpDownIcon,
  Bars4Icon,
  BriefcaseIcon,
  CurrencyDollarIcon,
  Squares2X2Icon,
} from "@heroicons/react/24/outline";
import { AcquirePositionModal } from "~~/components/markets/AcquirePositionModal";
import { ClaimEarningsModal } from "~~/components/markets/ClaimEarningsModal";
import { ClaimSettlementModal } from "~~/components/markets/ClaimSettlementModal";
import { ForceFinalPayoutModal } from "~~/components/markets/ForceFinalPayoutModal";
import { ListingCard } from "~~/components/markets/ListingCard";
import { PrimaryPoolCard } from "~~/components/markets/PrimaryPoolCard";
import { RedeemLiquidityModal } from "~~/components/markets/RedeemLiquidityModal";
import { CreateSecondaryListingModal } from "~~/components/partner/CreateSecondaryListingModal";
import { EndSecondaryListingModal } from "~~/components/partner/EndSecondaryListingModal";
import { WithdrawProceedsModal } from "~~/components/partner/WithdrawProceedsModal";
import { ASSET_REGISTRIES, AssetType } from "~~/config/assetTypes";
import { useScaffoldWriteContract, useSelectedNetwork } from "~~/hooks/scaffold-eth";
import { usePaymentToken } from "~~/hooks/usePaymentToken";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import { getDeployedContract } from "~~/utils/contracts";
import { fetchIpfsMetadata, mergeVehicleMetadata } from "~~/utils/ipfsGateway";
import {
  POSITION_MANAGER_PRIMARY_REDEMPTION_READER_ABI,
  ROBOSHARE_TOKENS_MANAGER_READER_ABI,
  normalizePositionManagerAddress,
  normalizePrimaryRedemptionPreview,
  normalizeVehicleMetadata,
} from "~~/utils/protocolState";
import { getTargetNetworks, notification } from "~~/utils/scaffold-eth";
import { getSubgraphQueryUrl } from "~~/utils/subgraph";

// Types for subgraph data
interface SubgraphListing {
  id: string;
  tokenId: string;
  assetId: string;
  seller: string;
  amount: string;
  amountSold: string;
  pricePerToken: string;
  expiresAt: string;
  buyerPaysFee: boolean;
  status: string;
  isEnded: boolean;
  endedAt?: string | null;
  createdAt: string;
}

interface SubgraphPrimaryPool {
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
  pausedAt?: string | null;
  closedAt?: string | null;
}

interface SubgraphVehicle {
  id: string;
  partner: string;
  vin: string;
  make?: string;
  model?: string;
  year?: string;
  metadataURI?: string;
  imageUrl?: string;
}

interface SubgraphToken {
  id: string;
  revenueTokenId: string;
  price: string;
  supply: string;
  createdAt: string;
  targetYieldBP?: string;
  maturityDate: string;
}

interface SubgraphAssetEarnings {
  id: string;
  assetId: string;
  totalEarnings: string;
  totalRevenue: string;
  distributionCount: string;
  firstDistributionAt: string;
  lastDistributionAt: string;
}

interface MarketPartner {
  id: string;
  name: string;
  address: string;
}

type SortOption = "apr_desc" | "apr_asc" | "earnings_desc" | "earnings_asc" | "newest" | "price_asc" | "price_desc";
type MarketTab = "pools" | "secondary";

// Protocol constants for APY calculation/sorting
const BENCHMARK_EARNINGS_BP = 1000n;
const BP_PRECISION = 10000n;
const NEW_POOL_BADGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MARKETS_PAGE_BATCH_SIZE = 12;
const METADATA_FETCH_MAX_ATTEMPTS = 3;
const MARKETS_PAGE_PREFS_KEY = "roboshare:markets-page-prefs";

const MarketsPage: NextPage = () => {
  const { address } = useTransactingAccount();
  // State
  const [listings, setListings] = useState<SubgraphListing[]>([]);
  const [primaryPools, setPrimaryPools] = useState<SubgraphPrimaryPool[]>([]);
  const [vehicles, setVehicles] = useState<SubgraphVehicle[]>([]);
  const [tokens, setTokens] = useState<SubgraphToken[]>([]);
  const [assetEarnings, setAssetEarnings] = useState<SubgraphAssetEarnings[]>([]);
  const [recentPrimaryPoolPurchases, setRecentPrimaryPoolPurchases] = useState<Set<string>>(new Set());
  const [soldOutAtByListing, setSoldOutAtByListing] = useState<Record<string, string>>({});
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [vehicleMetadataOverrides, setVehicleMetadataOverrides] = useState<Record<string, Partial<SubgraphVehicle>>>(
    {},
  );
  const metadataFetchAttempts = useRef<Map<string, number>>(new Map());
  const [metadataFetchRetryNonce, setMetadataFetchRetryNonce] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters & Sorting
  const [filterType, setFilterType] = useState<AssetType | "ALL">("ALL");
  const [sortBy, setSortBy] = useState<SortOption>("apr_desc");
  const [showOnlyHoldings, setShowOnlyHoldings] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "grid">("grid");
  const [marketTab, setMarketTab] = useState<MarketTab>("pools");
  const [hasRestoredPreferences, setHasRestoredPreferences] = useState(false);
  const [visiblePrimaryPoolCount, setVisiblePrimaryPoolCount] = useState(MARKETS_PAGE_BATCH_SIZE);
  const [visibleListingCount, setVisibleListingCount] = useState(MARKETS_PAGE_BATCH_SIZE);

  useEffect(() => {
    const enforceGridOnMobile = () => {
      if (window.innerWidth < 1024) {
        setViewMode("grid");
      }
    };

    window.addEventListener("resize", enforceGridOnMobile);
    return () => window.removeEventListener("resize", enforceGridOnMobile);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const raw = window.localStorage.getItem(MARKETS_PAGE_PREFS_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw) as Partial<{
        filterType: AssetType | "ALL";
        sortBy: SortOption;
        showOnlyHoldings: boolean;
        viewMode: "list" | "grid";
        marketTab: MarketTab;
      }>;

      if (parsed.filterType) setFilterType(parsed.filterType);
      if (parsed.sortBy) setSortBy(parsed.sortBy);
      if (typeof parsed.showOnlyHoldings === "boolean") setShowOnlyHoldings(parsed.showOnlyHoldings);
      if (parsed.viewMode) setViewMode(parsed.viewMode);
      if (parsed.marketTab) setMarketTab(parsed.marketTab);
    } catch (error) {
      console.error("Failed to restore markets page preferences:", error);
    } finally {
      setHasRestoredPreferences(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !hasRestoredPreferences) return;

    try {
      window.localStorage.setItem(
        MARKETS_PAGE_PREFS_KEY,
        JSON.stringify({
          filterType,
          sortBy,
          showOnlyHoldings,
          viewMode,
          marketTab,
        }),
      );
    } catch (error) {
      console.error("Failed to persist markets page preferences:", error);
    }
  }, [filterType, hasRestoredPreferences, marketTab, showOnlyHoldings, sortBy, viewMode]);

  // Modal states
  const [selectedListing, setSelectedListing] = useState<SubgraphListing | null>(null);
  const [selectedPool, setSelectedPool] = useState<SubgraphPrimaryPool | null>(null);
  const [selectedRedeemPool, setSelectedRedeemPool] = useState<SubgraphPrimaryPool | null>(null);
  const [selectedLiquidationPool, setSelectedLiquidationPool] = useState<SubgraphPrimaryPool | null>(null);
  const [isBuyModalOpen, setIsBuyModalOpen] = useState(false);
  const [isClaimEarningsOpen, setIsClaimEarningsOpen] = useState(false);
  const [isClaimSettlementOpen, setIsClaimSettlementOpen] = useState(false);
  const [isListTokensOpen, setIsListTokensOpen] = useState(false);
  const [isEndListingOpen, setIsEndListingOpen] = useState(false);
  const [isWithdrawProceedsOpen, setIsWithdrawProceedsOpen] = useState(false);
  const [isBatchClaimPayoutsPending, setIsBatchClaimPayoutsPending] = useState(false);
  const [prefillListAmount, setPrefillListAmount] = useState<string | undefined>(undefined);

  // Network info
  const walletChainId = useChainId();
  const selectedNetwork = useSelectedNetwork(walletChainId);
  const chainId = selectedNetwork.id;
  const chains = useChains();
  const currentChain = chains.find(c => c.id === chainId);
  const networkName = currentChain?.name || selectedNetwork.name || "Localhost";
  const { switchChain } = useSwitchChain();
  const targetNetworks = getTargetNetworks();
  const subgraphUrl = getSubgraphQueryUrl(chainId);
  const roboshareTokensContract = getDeployedContract(chainId, "RoboshareTokens");
  const partnerManagerContract = getDeployedContract(chainId, "PartnerManager");
  const marketplaceContract = getDeployedContract(chainId, "Marketplace");
  const treasuryContract = getDeployedContract(chainId, "Treasury");
  const registryRouterContract = getDeployedContract(chainId, "RegistryRouter");
  const vehicleRegistryContract = getDeployedContract(chainId, "VehicleRegistry");
  const earningsManagerContract = getDeployedContract(chainId, "EarningsManager");
  const { symbol, decimals } = usePaymentToken();
  const { writeContractAsync: writeTreasury } = useScaffoldWriteContract({ contractName: "Treasury" });
  const { writeContractAsync: writeEarningsManager } = useScaffoldWriteContract({ contractName: "EarningsManager" });
  const { data: positionManagerAddressData } = useReadContract({
    address: roboshareTokensContract?.address,
    abi: ROBOSHARE_TOKENS_MANAGER_READER_ABI,
    functionName: "positionManager",
    query: { enabled: !!roboshareTokensContract },
  });
  const positionManagerAddress = normalizePositionManagerAddress(positionManagerAddressData);

  const getVehicleImageKey = useCallback(
    (vehicle: Pick<SubgraphVehicle, "id" | "metadataURI">) => `${chainId}:${vehicle.id}:${vehicle.metadataURI || ""}`,
    [chainId],
  );
  const getVehicleMetadataKey = useCallback(
    (vehicle: Pick<SubgraphVehicle, "id" | "metadataURI">) => `${chainId}:${vehicle.id}:${vehicle.metadataURI || ""}`,
    [chainId],
  );

  const { data: pendingWithdrawal, refetch: refetchPendingWithdrawal } = useReadContract({
    address: treasuryContract?.address,
    abi: treasuryContract?.abi,
    functionName: "pendingWithdrawals",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!treasuryContract },
  });
  const hasPendingWithdrawal = !!pendingWithdrawal && (pendingWithdrawal as bigint) > 0n;
  const pendingWithdrawalDisplay = pendingWithdrawal ? formatUnits(pendingWithdrawal as bigint, decimals) : "0";

  const { data: vehicleInfoData } = useReadContracts({
    allowFailure: true,
    contracts: vehicleRegistryContract
      ? vehicles.map(vehicle => ({
          address: vehicleRegistryContract.address,
          abi: vehicleRegistryContract.abi,
          functionName: "getVehicleInfo",
          args: [BigInt(vehicle.id)],
        }))
      : ([] as any),
    query: { enabled: !!vehicleRegistryContract && vehicles.length > 0 },
  });

  const marketVehicles = useMemo(() => {
    const results = vehicleInfoData as Array<{ result?: readonly unknown[]; status: string }> | undefined;

    return vehicles.map((vehicle, index) => {
      const result = results?.[index];
      const normalizedVehicle =
        result?.status === "success" && result.result !== undefined
          ? normalizeVehicleMetadata(result.result, vehicle)
          : vehicle;
      return {
        ...normalizedVehicle,
        ...vehicleMetadataOverrides[getVehicleMetadataKey(vehicle)],
      };
    });
  }, [getVehicleMetadataKey, vehicleInfoData, vehicleMetadataOverrides, vehicles]);

  const { data: targetYieldData } = useReadContracts({
    allowFailure: true,
    contracts: roboshareTokensContract
      ? tokens.map(token => ({
          address: roboshareTokensContract.address,
          abi: roboshareTokensContract.abi,
          functionName: "getTargetYieldBP",
          args: [BigInt(token.revenueTokenId)],
        }))
      : ([] as any),
    query: { enabled: !!roboshareTokensContract && tokens.length > 0 },
  });

  const marketTokens = useMemo(() => {
    const results = targetYieldData as Array<{ result?: bigint; status: string }> | undefined;

    return tokens.map((token, index) => {
      const result = results?.[index];
      if (result?.status !== "success" || result.result === undefined) {
        return token;
      }

      return {
        ...token,
        targetYieldBP: String(result.result),
      };
    });
  }, [targetYieldData, tokens]);

  const partnerAddresses = useMemo(() => {
    const uniquePartners = new Set<string>();

    vehicles.forEach(vehicle => {
      if (vehicle.partner) uniquePartners.add(vehicle.partner);
    });

    primaryPools.forEach(pool => {
      if (pool.partner) uniquePartners.add(pool.partner);
    });

    return Array.from(uniquePartners);
  }, [primaryPools, vehicles]);

  const { data: partnerNameData } = useReadContracts({
    allowFailure: true,
    contracts: partnerManagerContract
      ? partnerAddresses.map(partnerAddress => ({
          address: partnerManagerContract.address,
          abi: partnerManagerContract.abi,
          functionName: "getPartnerName",
          args: [partnerAddress],
        }))
      : ([] as any),
    query: { enabled: !!partnerManagerContract && partnerAddresses.length > 0 },
  });

  const marketPartners = useMemo(() => {
    const results = partnerNameData as Array<{ result?: string; status: string }> | undefined;

    return partnerAddresses.map((partnerAddress, index) => {
      const result = results?.[index];
      return {
        id: partnerAddress.toLowerCase(),
        address: partnerAddress,
        name:
          result?.status === "success" && result.result !== undefined && result.result.length > 0
            ? result.result
            : partnerAddress,
      } satisfies MarketPartner;
    });
  }, [partnerAddresses, partnerNameData]);

  // Fetch data from subgraph
  const fetchData = useCallback(
    async (showLoading = true) => {
      if (showLoading) setLoading(true);
      setError(null);

      try {
        if (!subgraphUrl) {
          throw new Error(`No subgraph endpoint configured for chain ${chainId}.`);
        }

        const response = await fetch(subgraphUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `
            query GetMarketsPageData {
              listings(first: 100, orderBy: createdAt, orderDirection: desc) {
                id
                tokenId
                assetId
                seller
                amount
                amountSold
                pricePerToken
                expiresAt
                buyerPaysFee
                status
                isEnded
                endedAt
                createdAt
              }
              primaryPools(first: 100, orderBy: createdAt, orderDirection: desc) {
                id
                tokenId
                assetId
                partner
                pricePerToken
                maxSupply
                immediateProceeds
                protectionEnabled
                isPaused
                isClosed
                createdAt
                pausedAt
                closedAt
              }
              vehicles(first: 100) {
                id
                partner
                vin
                make
                model
                year
                metadataURI
              }
              roboshareTokens(first: 100) {
                id
                revenueTokenId
                price
                supply
                createdAt
                targetYieldBP
                maturityDate
              }
              assetEarnings(first: 100) {
                id
                assetId
                totalRevenue
                totalEarnings
                distributionCount
                firstDistributionAt
                lastDistributionAt
              }
            }
          `,
          }),
        });

        if (!response.ok) {
          throw new Error(`Subgraph fetch failed: ${response.statusText}`);
        }

        const { data, errors } = await response.json();

        if (errors) {
          console.warn("Subgraph query warnings:", errors);
        }

        setListings(prev => {
          const incoming = (data?.listings || []) as SubgraphListing[];
          const prevById = new Map(prev.map(l => [l.id, l]));
          return incoming.map(listing => {
            const prevListing = prevById.get(listing.id);
            if (!prevListing) return listing;

            // Protect optimistic terminal transitions from stale subgraph snapshots.
            const hasOptimisticTerminal = prevListing.isEnded;
            const incomingIsTerminal = listing.isEnded;
            if (hasOptimisticTerminal && !incomingIsTerminal) {
              return {
                ...listing,
                isEnded: prevListing.isEnded,
                status: prevListing.status,
              };
            }
            return listing;
          });
        });
        setVehicles(data?.vehicles || []);
        setPrimaryPools(data?.primaryPools || []);
        setTokens(data?.roboshareTokens || []);
        setAssetEarnings(data?.assetEarnings || []);
      } catch (e: any) {
        console.error("Error fetching market data:", e);
        setError(e.message || "Failed to fetch market data");
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [chainId, subgraphUrl],
  );

  // Fetch current wallet holdings for "Your Holdings"
  const {
    data: holdingsData,
    isLoading: isLoadingHoldings,
    refetch: refetchHoldings,
  } = useReadContracts({
    contracts: roboshareTokensContract
      ? listings.map(l => ({
          address: roboshareTokensContract.address,
          abi: roboshareTokensContract.abi,
          functionName: "balanceOf",
          args: [address, BigInt(l.tokenId)],
        }))
      : ([] as any),
    // Also used for action-priority sorting and CTA visibility heuristics, not just the holdings-only filter.
    query: { enabled: !!address && !!roboshareTokensContract && listings.length > 0 },
  });

  const {
    data: primaryPoolHoldingsData,
    isLoading: isLoadingPrimaryPoolHoldings,
    refetch: refetchPrimaryPoolHoldings,
  } = useReadContracts({
    contracts: roboshareTokensContract
      ? primaryPools.map(pool => ({
          address: roboshareTokensContract.address,
          abi: roboshareTokensContract.abi,
          functionName: "balanceOf",
          args: [address, BigInt(pool.tokenId)],
        }))
      : ([] as any),
    query: { enabled: !!address && !!roboshareTokensContract && primaryPools.length > 0 },
  });

  const {
    data: primaryPoolSupplyData,
    isLoading: isLoadingPrimaryPoolSupply,
    refetch: refetchPrimaryPoolSupply,
  } = useReadContracts({
    contracts: roboshareTokensContract
      ? primaryPools.map(pool => ({
          address: roboshareTokensContract.address,
          abi: roboshareTokensContract.abi,
          functionName: "getRevenueTokenSupply",
          args: [BigInt(pool.tokenId)],
        }))
      : ([] as any),
    query: { enabled: !!roboshareTokensContract && primaryPools.length > 0 },
  });

  const { data: primaryPoolEligibleRedemptionData, refetch: refetchPrimaryPoolEligibleRedemptionBalances } =
    useReadContracts({
      contracts: positionManagerAddress
        ? primaryPools.map(pool => ({
            address: positionManagerAddress,
            abi: POSITION_MANAGER_PRIMARY_REDEMPTION_READER_ABI,
            functionName: "getPrimaryRedemptionEligibleBalance",
            args: [address, BigInt(pool.tokenId)],
          }))
        : ([] as any),
      query: { enabled: !!address && !!positionManagerAddress && primaryPools.length > 0 },
    });

  const { data: primaryPoolRedemptionPreviewData, refetch: refetchPrimaryPoolRedemptionPreviews } = useReadContracts({
    allowFailure: true,
    contracts: marketplaceContract
      ? primaryPools.map((pool, index) => {
          const eligibleResult = primaryPoolEligibleRedemptionData?.[index];
          const eligibleBalance =
            eligibleResult?.status === "success" && eligibleResult.result !== undefined
              ? (eligibleResult.result as bigint)
              : 0n;
          return {
            address: marketplaceContract.address,
            abi: marketplaceContract.abi,
            functionName: "previewPrimaryRedemption",
            args: [BigInt(pool.tokenId), address, eligibleBalance],
          };
        })
      : ([] as any),
    query: {
      enabled: !!address && !!marketplaceContract && primaryPools.length > 0 && !!primaryPoolEligibleRedemptionData,
    },
  });

  // Fetch actionability previews (claimable earnings/settlement) for sorting heuristics.
  const uniqueAssetIds = useMemo(() => {
    return Array.from(new Set([...listings.map(l => l.assetId), ...primaryPools.map(p => p.assetId)]));
  }, [listings, primaryPools]);

  const { data: actionPreviewData, refetch: refetchActionPreviewData } = useReadContracts({
    allowFailure: true,
    contracts:
      treasuryContract && earningsManagerContract
        ? uniqueAssetIds.flatMap(assetId => [
            {
              address: earningsManagerContract.address,
              abi: earningsManagerContract.abi,
              functionName: "previewClaimEarnings",
              args: [BigInt(assetId), address],
            },
            {
              address: treasuryContract.address,
              abi: treasuryContract.abi,
              functionName: "previewSettlementClaim",
              args: [BigInt(assetId), address],
            },
          ])
        : ([] as any),
    query: { enabled: !!address && !!treasuryContract && !!earningsManagerContract && uniqueAssetIds.length > 0 },
  });
  const { data: assetStatusPreviewData } = useReadContracts({
    allowFailure: true,
    contracts: registryRouterContract
      ? uniqueAssetIds.map(assetId => ({
          address: registryRouterContract.address,
          abi: registryRouterContract.abi,
          functionName: "getAssetStatus",
          args: [BigInt(assetId)],
        }))
      : ([] as any),
    query: { enabled: !!registryRouterContract && uniqueAssetIds.length > 0 },
  });
  const { data: liquidationPreviewData, refetch: refetchLiquidationPreviewData } = useReadContracts({
    allowFailure: true,
    contracts: registryRouterContract
      ? uniqueAssetIds.map(assetId => ({
          address: registryRouterContract.address,
          abi: registryRouterContract.abi,
          functionName: "previewLiquidationEligibility",
          args: [BigInt(assetId)],
        }))
      : ([] as any),
    query: { enabled: !!registryRouterContract && uniqueAssetIds.length > 0 },
  });

  // Initial fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (listings.length === 0) return;
    setSoldOutAtByListing(prev => {
      const next = { ...prev };
      let changed = false;
      const nowSec = Math.floor(Date.now() / 1000).toString();
      for (const listing of listings) {
        const isActive = !listing.isEnded && listing.status !== "expired";
        const isSoldOut = listing.amount === "0";
        if (isActive && isSoldOut && !next[listing.id]) {
          next[listing.id] = nowSec;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [listings]);

  // Refetch holdings when the account or holdings filter changes
  useEffect(() => {
    if (showOnlyHoldings && address) {
      refetchHoldings?.();
    }
  }, [address, showOnlyHoldings, refetchHoldings]);

  // Extract listing IDs where the connected account currently holds tokens.
  const userHoldingsIds = useMemo(() => {
    const ids = new Set<string>();
    if (holdingsData) {
      listings.forEach((listing, index) => {
        const walletResult = holdingsData[index];
        const hasWallet = walletResult?.status === "success" && (walletResult.result as bigint) > 0n;
        if (hasWallet) {
          ids.add(listing.id);
        }
      });
    }
    return ids;
  }, [holdingsData, listings]);

  const userPrimaryPoolTokenIds = useMemo(() => {
    const ids = new Set<string>();
    if (!primaryPoolHoldingsData) return ids;
    primaryPools.forEach((pool, index) => {
      const result = primaryPoolHoldingsData[index];
      const hasWallet = result?.status === "success" && (result.result as bigint) > 0n;
      if (hasWallet) ids.add(pool.tokenId);
    });
    return ids;
  }, [primaryPoolHoldingsData, primaryPools]);

  const primaryPoolSupplyByTokenId = useMemo(() => {
    const byTokenId = new Map<string, string>();
    primaryPools.forEach((pool, index) => {
      const result = primaryPoolSupplyData?.[index];
      const currentSupply =
        result?.status === "success" && result.result !== undefined ? String(result.result as bigint) : "0";
      byTokenId.set(pool.tokenId, currentSupply);
    });
    return byTokenId;
  }, [primaryPools, primaryPoolSupplyData]);

  const primaryPoolCreatedAtByTokenId = useMemo(() => {
    const byTokenId = new Map<string, string>();
    primaryPools.forEach(pool => {
      byTokenId.set(pool.tokenId, pool.createdAt);
    });
    return byTokenId;
  }, [primaryPools]);

  const primaryPoolHoldingsByTokenId = useMemo(() => {
    const byTokenId = new Map<string, bigint>();
    primaryPools.forEach((pool, index) => {
      const result = primaryPoolHoldingsData?.[index];
      const holding = result?.status === "success" && result.result !== undefined ? (result.result as bigint) : 0n;
      byTokenId.set(pool.tokenId, holding);
    });
    return byTokenId;
  }, [primaryPools, primaryPoolHoldingsData]);

  const arePrimaryPoolHoldingsReady = useMemo(() => {
    if (!address) return true;
    if (isLoadingPrimaryPoolHoldings) return false;
    if (primaryPools.length === 0) return true;
    if (!primaryPoolHoldingsData) return false;
    return primaryPoolHoldingsData.length === primaryPools.length;
  }, [address, isLoadingPrimaryPoolHoldings, primaryPoolHoldingsData, primaryPools.length]);

  const primaryPoolRedemptionByTokenId = useMemo(() => {
    const byTokenId = new Map<
      string,
      { payout: bigint; liquidity: bigint; redemptionSupply: bigint; eligibleBalance: bigint }
    >();
    primaryPools.forEach((pool, index) => {
      const result = primaryPoolRedemptionPreviewData?.[index];
      const eligibleResult = primaryPoolEligibleRedemptionData?.[index];
      const eligibleBalance =
        eligibleResult?.status === "success" && eligibleResult.result !== undefined
          ? (eligibleResult.result as bigint)
          : 0n;
      const preview =
        result?.status === "success"
          ? normalizePrimaryRedemptionPreview(result.result, eligibleBalance)
          : normalizePrimaryRedemptionPreview(undefined, eligibleBalance);
      byTokenId.set(pool.tokenId, preview);
    });
    return byTokenId;
  }, [primaryPoolEligibleRedemptionData, primaryPools, primaryPoolRedemptionPreviewData]);

  const assetActionPreview = useMemo(() => {
    const byAssetId = new Map<string, { claimableEarnings: bigint; claimableSettlement: bigint }>();
    if (!actionPreviewData) return byAssetId;

    uniqueAssetIds.forEach((assetId, index) => {
      const earningsResult = actionPreviewData[index * 2];
      const settlementResult = actionPreviewData[index * 2 + 1];
      const claimableEarnings =
        earningsResult?.status === "success" ? ((earningsResult.result as bigint | undefined) ?? 0n) : 0n;
      const claimableSettlement =
        settlementResult?.status === "success" ? ((settlementResult.result as bigint | undefined) ?? 0n) : 0n;
      byAssetId.set(assetId, { claimableEarnings, claimableSettlement });
    });

    return byAssetId;
  }, [actionPreviewData, uniqueAssetIds]);

  const assetStatusById = useMemo(() => {
    const byAssetId = new Map<string, number>();
    if (!assetStatusPreviewData) return byAssetId;

    uniqueAssetIds.forEach((assetId, index) => {
      const result = assetStatusPreviewData[index];
      const status =
        result?.status === "success" && result.result !== undefined ? Number(result.result as bigint | number) : -1;
      byAssetId.set(assetId, status);
    });

    return byAssetId;
  }, [assetStatusPreviewData, uniqueAssetIds]);

  const liquidationPreviewByAssetId = useMemo(() => {
    const byAssetId = new Map<string, { eligible: boolean; reason: number }>();
    if (!liquidationPreviewData) return byAssetId;

    uniqueAssetIds.forEach((assetId, index) => {
      const result = liquidationPreviewData[index];
      if (result?.status === "success" && Array.isArray(result.result)) {
        const [eligible, reason] = result.result as [boolean, number | bigint];
        byAssetId.set(assetId, { eligible, reason: Number(reason) });
        return;
      }

      byAssetId.set(assetId, { eligible: false, reason: 3 });
    });

    return byAssetId;
  }, [liquidationPreviewData, uniqueAssetIds]);

  // Fetch IPFS images
  useEffect(() => {
    let retryTimeoutId: number | undefined;

    const fetchImages = async () => {
      const vehiclesNeedingMetadata = marketVehicles.filter(vehicle => {
        if (!vehicle.metadataURI) return false;

        const metadataKey = getVehicleMetadataKey(vehicle);
        const attempts = metadataFetchAttempts.current.get(metadataKey) ?? 0;
        if (attempts >= METADATA_FETCH_MAX_ATTEMPTS) return false;

        return (
          !imageUrls[getVehicleImageKey(vehicle)] || !vehicle.vin || !vehicle.make || !vehicle.model || !vehicle.year
        );
      });
      if (vehiclesNeedingMetadata.length === 0) return;

      const newImageUrls: Record<string, string> = { ...imageUrls };
      const metadataOverrides: Record<string, Partial<SubgraphVehicle>> = {};
      const retryDelaysMs: number[] = [];

      await Promise.all(
        vehiclesNeedingMetadata.map(async vehicle => {
          if (!vehicle.metadataURI) return;
          const metadataKey = getVehicleMetadataKey(vehicle);

          try {
            const metadata = await fetchIpfsMetadata(vehicle.metadataURI);
            if (metadata) {
              const hydratedVehicle = mergeVehicleMetadata(vehicle, metadata);
              metadataOverrides[metadataKey] = {
                vin: hydratedVehicle.vin,
                make: hydratedVehicle.make,
                model: hydratedVehicle.model,
                year: hydratedVehicle.year,
              };
              if (hydratedVehicle.imageUrl) {
                newImageUrls[getVehicleImageKey(vehicle)] = hydratedVehicle.imageUrl;
              }
              metadataFetchAttempts.current.set(metadataKey, METADATA_FETCH_MAX_ATTEMPTS);
              return;
            }
          } catch (err) {
            console.error(`Error fetching metadata for vehicle ${vehicle.id}:`, err);
          }

          const nextAttempts = (metadataFetchAttempts.current.get(metadataKey) ?? 0) + 1;
          metadataFetchAttempts.current.set(metadataKey, nextAttempts);
          if (nextAttempts < METADATA_FETCH_MAX_ATTEMPTS) {
            retryDelaysMs.push(2000 * nextAttempts);
          }
        }),
      );

      const imageUrlsChanged = Object.keys(newImageUrls).some(key => newImageUrls[key] !== imageUrls[key]);
      if (imageUrlsChanged) {
        setImageUrls(newImageUrls);
      }
      if (Object.keys(metadataOverrides).length > 0) {
        setVehicleMetadataOverrides(prev => ({ ...prev, ...metadataOverrides }));
      }
      if (retryDelaysMs.length > 0) {
        const retryDelayMs = Math.min(...retryDelaysMs);
        retryTimeoutId = window.setTimeout(() => {
          setMetadataFetchRetryNonce(n => n + 1);
        }, retryDelayMs);
      }
    };

    void fetchImages();

    return () => {
      if (retryTimeoutId !== undefined) {
        window.clearTimeout(retryTimeoutId);
      }
    };
  }, [getVehicleImageKey, getVehicleMetadataKey, imageUrls, marketVehicles, metadataFetchRetryNonce]);

  const tokenSoldTotals = useMemo(() => {
    const totals = new Map<string, bigint>();
    for (const listing of listings) {
      const sold = listing.amountSold ? BigInt(listing.amountSold) : 0n;
      if (sold <= 0n) continue;
      totals.set(listing.tokenId, (totals.get(listing.tokenId) ?? 0n) + sold);
    }
    return totals;
  }, [listings]);

  // Helper to calculate listing APY for sorting (match card display logic)
  const calculateListingApy = useCallback(
    (listing: SubgraphListing): number => {
      const token = marketTokens.find(t => t.revenueTokenId === listing.tokenId);
      const earning = assetEarnings.find(e => e.assetId === listing.assetId);

      if (!token) return Number(BENCHMARK_EARNINGS_BP) / 100;

      const tokenSupply = BigInt(primaryPoolSupplyByTokenId.get(listing.tokenId) || token.supply);
      const tokenPrice = BigInt(token.price);
      const totalValue = tokenPrice * tokenSupply;

      if (earning && earning.totalEarnings !== "0" && totalValue > 0n) {
        const durationStart = BigInt(token.createdAt || primaryPoolCreatedAtByTokenId.get(listing.tokenId) || "0");
        const lastDistAt = BigInt(earning.lastDistributionAt || "0");
        const totalEarnings = BigInt(earning.totalEarnings);
        const duration = durationStart > 0n && lastDistAt > durationStart ? lastDistAt - durationStart : 0n;

        if (duration > 0n && totalEarnings > 0n) {
          const secondsPerYear = 365n * 24n * 60n * 60n;
          const annualizedEarnings = (totalEarnings * secondsPerYear) / duration;
          const aprBps = (annualizedEarnings * BP_PRECISION) / totalValue;
          return Number(aprBps) / 100;
        }
      }

      const targetYieldBp = token.targetYieldBP ? Number(token.targetYieldBP) : Number(BENCHMARK_EARNINGS_BP);
      return targetYieldBp / 100;
    },
    [assetEarnings, marketTokens, primaryPoolCreatedAtByTokenId, primaryPoolSupplyByTokenId],
  );

  const calculatePrimaryPoolApy = useCallback(
    (pool: SubgraphPrimaryPool): number => {
      const token = marketTokens.find(t => t.revenueTokenId === pool.tokenId);
      const earning = assetEarnings.find(e => e.assetId === pool.assetId);

      if (!token) return Number(BENCHMARK_EARNINGS_BP) / 100;

      const issuedSupply = BigInt(primaryPoolSupplyByTokenId.get(pool.tokenId) || token.supply);
      const totalValue = BigInt(pool.pricePerToken) * issuedSupply;
      const durationStart = BigInt(pool.createdAt || "0");
      const lastDistAt = BigInt(earning?.lastDistributionAt || "0");
      const totalEarnings = BigInt(earning?.totalEarnings || "0");

      if (totalEarnings > 0n && totalValue > 0n && durationStart > 0n && lastDistAt > durationStart) {
        const duration = lastDistAt - durationStart;
        const secondsPerYear = 365n * 24n * 60n * 60n;
        const annualizedEarnings = (totalEarnings * secondsPerYear) / duration;
        const aprBps = (annualizedEarnings * BP_PRECISION) / totalValue;
        return Number(aprBps) / 100;
      }

      const targetYieldBp = token.targetYieldBP ? Number(token.targetYieldBP) : Number(BENCHMARK_EARNINGS_BP);
      return targetYieldBp / 100;
    },
    [assetEarnings, marketTokens, primaryPoolSupplyByTokenId],
  );

  const hasLikelyAction = useCallback(
    (listing: SubgraphListing): boolean => {
      // Generic actionable state for any user (e.g. buyable active listings).
      const isEndedOrExpired = listing.isEnded || listing.status === "expired";
      const hasAvailableTokens = BigInt(listing.amount) > 0n;
      if (!isEndedOrExpired && hasAvailableTokens) return true;

      if (!address) return false;

      const isSeller = listing.seller.toLowerCase() === address.toLowerCase();
      const hasTokensForListing = userHoldingsIds.has(listing.id);
      const preview = assetActionPreview.get(listing.assetId);
      const assetStatus = assetStatusById.get(listing.assetId) ?? -1;
      const isAssetSettled = assetStatus === 3 || assetStatus === 4;
      const hasClaimableEarnings = (preview?.claimableEarnings ?? 0n) > 0n;
      const hasClaimableSettlement = (preview?.claimableSettlement ?? 0n) > 0n;

      // Seller-managed listings are often actionable while the listing is live/expired.
      // Ended seller listings can still be actionable while the underlying asset remains unsettled
      // (e.g. Distribute Earnings / Settle Asset on primary listings).
      if (isSeller && (!listing.isEnded || !isAssetSettled)) return true;

      // Current holders can still expose claim/list actions even when generic availability is zero.
      if (!listing.isEnded && hasTokensForListing) return true;

      // Holder actions that the card can actually surface.
      if (hasTokensForListing && hasClaimableEarnings) return true;
      if (hasTokensForListing && hasClaimableSettlement) return true;

      // Conservative fallback: do not prioritize based on holdings/history alone.
      return false;
    },
    [address, assetActionPreview, assetStatusById, userHoldingsIds],
  );

  // Filter and sort listings
  const displayListings = useMemo(() => {
    let filtered = [...listings];

    // Filter by asset type
    if (filterType !== "ALL") {
      if (filterType !== AssetType.VEHICLE) {
        filtered = [];
      }
    }

    // Filter by current holdings only.
    if (showOnlyHoldings) {
      if (!address) return [];
      filtered = filtered.filter(l => userHoldingsIds.has(l.id));
    }

    // Sort (active listings first)
    filtered.sort((a, b) => {
      // Surface listings that likely have user actions first.
      const aHasAction = hasLikelyAction(a);
      const bHasAction = hasLikelyAction(b);
      if (aHasAction !== bHasAction) return aHasAction ? -1 : 1;

      // Then prefer active listings over ended/expired listings.
      const aEndedOrExpired = a.isEnded || a.status === "expired";
      const bEndedOrExpired = b.isEnded || b.status === "expired";
      if (aEndedOrExpired !== bEndedOrExpired) return aEndedOrExpired ? 1 : -1;

      switch (sortBy) {
        case "apr_desc":
          return calculateListingApy(b) - calculateListingApy(a);
        case "apr_asc":
          return calculateListingApy(a) - calculateListingApy(b);
        case "earnings_desc": {
          const earningsA = BigInt(assetEarnings.find(e => e.assetId === a.assetId)?.totalEarnings || "0");
          const earningsB = BigInt(assetEarnings.find(e => e.assetId === b.assetId)?.totalEarnings || "0");
          return earningsB > earningsA ? 1 : earningsB < earningsA ? -1 : 0;
        }
        case "earnings_asc": {
          const earningsA = BigInt(assetEarnings.find(e => e.assetId === a.assetId)?.totalEarnings || "0");
          const earningsB = BigInt(assetEarnings.find(e => e.assetId === b.assetId)?.totalEarnings || "0");
          return earningsA > earningsB ? 1 : earningsA < earningsB ? -1 : 0;
        }
        case "newest":
          return Number(b.createdAt) - Number(a.createdAt);
        case "price_asc":
          return Number(a.pricePerToken) - Number(b.pricePerToken);
        case "price_desc":
          return Number(b.pricePerToken) - Number(a.pricePerToken);
        default:
          return 0;
      }
    });

    return filtered;
  }, [
    listings,
    filterType,
    sortBy,
    assetEarnings,
    calculateListingApy,
    showOnlyHoldings,
    userHoldingsIds,
    address,
    hasLikelyAction,
  ]);

  const displayPrimaryPools = useMemo(() => {
    let filtered = [...primaryPools];

    if (filterType !== "ALL" && filterType !== AssetType.VEHICLE) {
      filtered = [];
    }

    if (showOnlyHoldings) {
      if (!address) return [];
      filtered = filtered.filter(pool => userPrimaryPoolTokenIds.has(pool.tokenId));
    }

    filtered.sort((a, b) => {
      switch (sortBy) {
        case "price_asc":
          return Number(a.pricePerToken) - Number(b.pricePerToken);
        case "price_desc":
          return Number(b.pricePerToken) - Number(a.pricePerToken);
        case "newest":
          return Number(b.createdAt) - Number(a.createdAt);
        case "apr_desc": {
          return calculatePrimaryPoolApy(b) - calculatePrimaryPoolApy(a);
        }
        case "apr_asc": {
          return calculatePrimaryPoolApy(a) - calculatePrimaryPoolApy(b);
        }
        case "earnings_desc":
        case "earnings_asc": {
          const aEarnings = BigInt(assetEarnings.find(e => e.assetId === a.assetId)?.totalEarnings || "0");
          const bEarnings = BigInt(assetEarnings.find(e => e.assetId === b.assetId)?.totalEarnings || "0");
          if (sortBy === "earnings_desc") return bEarnings > aEarnings ? 1 : bEarnings < aEarnings ? -1 : 0;
          return aEarnings > bEarnings ? 1 : aEarnings < bEarnings ? -1 : 0;
        }
        default:
          return 0;
      }
    });

    return filtered;
  }, [
    primaryPools,
    filterType,
    showOnlyHoldings,
    address,
    sortBy,
    assetEarnings,
    userPrimaryPoolTokenIds,
    calculatePrimaryPoolApy,
  ]);

  useEffect(() => {
    setVisiblePrimaryPoolCount(MARKETS_PAGE_BATCH_SIZE);
  }, [marketTab, filterType, sortBy, showOnlyHoldings, address, displayPrimaryPools.length]);

  useEffect(() => {
    setVisibleListingCount(MARKETS_PAGE_BATCH_SIZE);
  }, [marketTab, filterType, sortBy, showOnlyHoldings, address, displayListings.length]);

  const visiblePrimaryPools = useMemo(
    () => displayPrimaryPools.slice(0, visiblePrimaryPoolCount),
    [displayPrimaryPools, visiblePrimaryPoolCount],
  );

  const visibleListings = useMemo(
    () => displayListings.slice(0, visibleListingCount),
    [displayListings, visibleListingCount],
  );

  const holdingsAssetIds = useMemo(() => {
    if (!showOnlyHoldings || !address) return [];
    const ids = new Set<string>();
    displayPrimaryPools.forEach(pool => ids.add(pool.assetId));
    displayListings.forEach(listing => ids.add(listing.assetId));
    return Array.from(ids);
  }, [address, displayListings, displayPrimaryPools, showOnlyHoldings]);

  const hasActualHoldingsInView = useMemo(() => {
    if (!showOnlyHoldings || !address) return false;

    if (displayPrimaryPools.length > 0) return true;

    return displayListings.some(listing => userHoldingsIds.has(listing.id));
  }, [address, displayListings, displayPrimaryPools, showOnlyHoldings, userHoldingsIds]);

  const claimableSettlementAssetIds = useMemo(
    () =>
      holdingsAssetIds.filter(assetId => {
        const preview = assetActionPreview.get(assetId);
        return (preview?.claimableSettlement ?? 0n) > 0n;
      }),
    [assetActionPreview, holdingsAssetIds],
  );

  const claimableEarningsOnlyAssetIds = useMemo(
    () =>
      holdingsAssetIds.filter(assetId => {
        const preview = assetActionPreview.get(assetId);
        return (preview?.claimableSettlement ?? 0n) === 0n && (preview?.claimableEarnings ?? 0n) > 0n;
      }),
    [assetActionPreview, holdingsAssetIds],
  );

  const claimablePayoutAssetIds = useMemo(
    () =>
      holdingsAssetIds.filter(assetId => {
        const preview = assetActionPreview.get(assetId);
        return (preview?.claimableEarnings ?? 0n) > 0n;
      }),
    [assetActionPreview, holdingsAssetIds],
  );

  const totalClaimableHoldingsAssets = claimableSettlementAssetIds.length + claimableEarningsOnlyAssetIds.length;
  const shouldAutoWithdrawSingleClaim = !showOnlyHoldings || totalClaimableHoldingsAssets <= 1;

  const refreshHoldingsActions = useCallback(async () => {
    await fetchData(false);
    refetchHoldings?.();
    refetchPrimaryPoolHoldings?.();
    refetchPrimaryPoolEligibleRedemptionBalances?.();
    refetchPrimaryPoolSupply?.();
    refetchPrimaryPoolRedemptionPreviews?.();
    refetchActionPreviewData();
    refetchLiquidationPreviewData();
    refetchPendingWithdrawal();
  }, [
    fetchData,
    refetchActionPreviewData,
    refetchHoldings,
    refetchLiquidationPreviewData,
    refetchPendingWithdrawal,
    refetchPrimaryPoolEligibleRedemptionBalances,
    refetchPrimaryPoolHoldings,
    refetchPrimaryPoolRedemptionPreviews,
    refetchPrimaryPoolSupply,
  ]);

  const handleBatchClaimPayouts = useCallback(async () => {
    if (!address || claimablePayoutAssetIds.length === 0) return;

    setIsBatchClaimPayoutsPending(true);
    try {
      for (const assetId of claimablePayoutAssetIds) {
        await writeEarningsManager({
          functionName: "claimEarnings",
          args: [BigInt(assetId)],
        });
      }

      await writeTreasury({
        functionName: "processWithdrawal",
      });

      notification.success("Payout claims processed and withdrawn to your wallet.");
      await refreshHoldingsActions();
    } catch (e) {
      console.error("Error claiming payouts across holdings:", e);
      notification.error(e instanceof Error ? e.message : "Claim all payouts failed");
    } finally {
      setIsBatchClaimPayoutsPending(false);
    }
  }, [address, claimablePayoutAssetIds, refreshHoldingsActions, writeEarningsManager, writeTreasury]);

  const shouldShowNewPoolBadge = useCallback(
    (pool: SubgraphPrimaryPool) => {
      if (!arePrimaryPoolHoldingsReady) return false;
      if (pool.isPaused || pool.isClosed) return false;
      if (recentPrimaryPoolPurchases.has(pool.id)) return false;
      if ((primaryPoolHoldingsByTokenId.get(pool.tokenId) ?? 0n) > 0n) return false;

      const poolCreatedAtMs = Number(pool.createdAt) * 1000;
      if (!Number.isFinite(poolCreatedAtMs) || poolCreatedAtMs <= 0) return false;
      return Date.now() - poolCreatedAtMs < NEW_POOL_BADGE_TTL_MS;
    },
    [arePrimaryPoolHoldingsReady, primaryPoolHoldingsByTokenId, recentPrimaryPoolPurchases],
  );

  const activeSellerTokenIdCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!address) return counts;
    const lower = address.toLowerCase();
    for (const listing of listings) {
      const isActive = !listing.isEnded && listing.status !== "expired";
      if (!isActive) continue;
      if (listing.seller.toLowerCase() !== lower) continue;
      counts.set(listing.tokenId, (counts.get(listing.tokenId) ?? 0) + 1);
    }
    return counts;
  }, [address, listings]);

  const poolUserActionStateByTokenId = useMemo(() => {
    const byTokenId = new Map<
      string,
      {
        primaryLabel: string;
        primaryDisabled: boolean;
        primaryAction: "buy" | "redeem" | "list" | "claim_earnings" | "claim_settlement" | "force_final_payout" | null;
        secondaryActions: Array<{
          label: string;
          action: "buy" | "redeem" | "list" | "claim_earnings" | "claim_settlement" | "force_final_payout";
        }>;
      }
    >();

    for (const pool of primaryPools) {
      const currentSupply = BigInt(primaryPoolSupplyByTokenId.get(pool.tokenId) || "0");
      const maxSupply = BigInt(pool.maxSupply);
      const remainingSupply = maxSupply > currentSupply ? maxSupply - currentSupply : 0n;
      const holding = primaryPoolHoldingsByTokenId.get(pool.tokenId) ?? 0n;
      const hasHolding = holding > 0n;
      const hasActiveListing = (activeSellerTokenIdCounts.get(pool.tokenId) ?? 0) > 0;
      const redemption = primaryPoolRedemptionByTokenId.get(pool.tokenId) ?? {
        payout: 0n,
        liquidity: 0n,
        redemptionSupply: 0n,
        eligibleBalance: 0n,
      };
      const canRedeem = redemption.eligibleBalance > 0n && redemption.payout > 0n;
      const canAddMore = !pool.isClosed && !pool.isPaused && remainingSupply > 0n;
      const canList = hasHolding;
      const claimableEarnings = assetActionPreview.get(pool.assetId)?.claimableEarnings ?? 0n;
      const claimableSettlement = assetActionPreview.get(pool.assetId)?.claimableSettlement ?? 0n;
      const canClaimEarnings = hasHolding && claimableEarnings > 0n;
      const canClaimSettlement = hasHolding && claimableSettlement > 0n;
      const liquidationPreview = liquidationPreviewByAssetId.get(pool.assetId);
      const canForceFinalPayout =
        liquidationPreview?.eligible && (liquidationPreview.reason === 0 || liquidationPreview.reason === 1);
      const liquidationActionLabel = liquidationPreview?.reason === 1 ? "Force Final Payout" : "Finalize at Maturity";

      if (canForceFinalPayout) {
        byTokenId.set(pool.tokenId, {
          primaryLabel: liquidationActionLabel,
          primaryDisabled: false,
          primaryAction: "force_final_payout",
          secondaryActions: [
            ...(canClaimSettlement ? [{ label: "Claim Final Payout", action: "claim_settlement" as const }] : []),
            ...(canClaimEarnings ? [{ label: "Claim Payout", action: "claim_earnings" as const }] : []),
            ...(canRedeem ? [{ label: "Withdraw", action: "redeem" as const }] : []),
            ...(canList
              ? [{ label: hasActiveListing ? "List More for Sale" : "List for Sale", action: "list" as const }]
              : []),
            ...(canAddMore ? [{ label: "Deposit More", action: "buy" as const }] : []),
          ],
        });
        continue;
      }

      if (canClaimSettlement) {
        byTokenId.set(pool.tokenId, {
          primaryLabel: "Claim Final Payout",
          primaryDisabled: false,
          primaryAction: "claim_settlement",
          secondaryActions: [
            ...(canClaimEarnings ? [{ label: "Claim Payout", action: "claim_earnings" as const }] : []),
            ...(canRedeem ? [{ label: "Withdraw", action: "redeem" as const }] : []),
            ...(canList
              ? [{ label: hasActiveListing ? "List More for Sale" : "List for Sale", action: "list" as const }]
              : []),
          ],
        });
        continue;
      }

      if (canClaimEarnings) {
        byTokenId.set(pool.tokenId, {
          primaryLabel: "Claim Payout",
          primaryDisabled: false,
          primaryAction: "claim_earnings",
          secondaryActions: [
            ...(canRedeem ? [{ label: "Withdraw", action: "redeem" as const }] : []),
            ...(canList
              ? [{ label: hasActiveListing ? "List More for Sale" : "List for Sale", action: "list" as const }]
              : []),
            ...(canAddMore ? [{ label: "Deposit More", action: "buy" as const }] : []),
          ],
        });
        continue;
      }

      if (canRedeem) {
        byTokenId.set(pool.tokenId, {
          primaryLabel: "Withdraw",
          primaryDisabled: false,
          primaryAction: "redeem",
          secondaryActions: [
            ...(canList
              ? [{ label: hasActiveListing ? "List More for Sale" : "List for Sale", action: "list" as const }]
              : []),
            ...(canAddMore ? [{ label: "Deposit More", action: "buy" as const }] : []),
          ],
        });
        continue;
      }

      if (canList) {
        byTokenId.set(pool.tokenId, {
          primaryLabel: hasActiveListing ? "List More for Sale" : "List for Sale",
          primaryDisabled: false,
          primaryAction: "list",
          secondaryActions: [...(canAddMore ? [{ label: "Deposit More", action: "buy" as const }] : [])],
        });
        continue;
      }

      byTokenId.set(pool.tokenId, {
        primaryLabel: "Deposit",
        primaryDisabled: !canAddMore,
        primaryAction: canAddMore ? "buy" : null,
        secondaryActions: [],
      });
    }

    return byTokenId;
  }, [
    activeSellerTokenIdCounts,
    assetActionPreview,
    liquidationPreviewByAssetId,
    primaryPoolHoldingsByTokenId,
    primaryPoolRedemptionByTokenId,
    primaryPoolSupplyByTokenId,
    primaryPools,
  ]);

  const openBuyModalForPool = useCallback((pool: SubgraphPrimaryPool) => {
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    window.requestAnimationFrame(() => {
      setSelectedPool(pool);
      setSelectedListing(null);
      setIsBuyModalOpen(true);
    });
  }, []);

  const openBuyModalForListing = useCallback((listing: SubgraphListing) => {
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    window.requestAnimationFrame(() => {
      setSelectedListing(listing);
      setSelectedPool(null);
      setIsBuyModalOpen(true);
    });
  }, []);

  const refreshMarketsAfterSuccess = useCallback(
    (opts?: { skipImmediateFetch?: boolean }) => {
      if (!opts?.skipImmediateFetch) {
        fetchData(false);
      }
      refetchPendingWithdrawal();
      refetchHoldings?.();
      // Subgraph/indexing can lag by a few seconds; retry refresh to reflect latest listing state.
      window.setTimeout(() => fetchData(false), 1200);
      window.setTimeout(() => fetchData(false), 3500);
      refetchPrimaryPoolHoldings?.();
      refetchPrimaryPoolEligibleRedemptionBalances?.();
      refetchPrimaryPoolSupply?.();
      refetchPrimaryPoolRedemptionPreviews?.();
    },
    [
      fetchData,
      refetchHoldings,
      refetchPendingWithdrawal,
      refetchPrimaryPoolEligibleRedemptionBalances,
      refetchPrimaryPoolHoldings,
      refetchPrimaryPoolRedemptionPreviews,
      refetchPrimaryPoolSupply,
    ],
  );

  const applyListingActionSuccess = useCallback(
    (listingId: string, updates: Partial<SubgraphListing>) => {
      setListings(prev => prev.map(l => (l.id === listingId ? { ...l, ...updates } : l)));
      // Keep optimistic UI until indexers catch up; avoid immediate stale overwrite.
      refreshMarketsAfterSuccess({ skipImmediateFetch: true });
    },
    [refreshMarketsAfterSuccess],
  );

  // Get active registries for filter tabs
  const activeRegistries = Object.entries(ASSET_REGISTRIES).filter(([, r]) => r.active);

  return (
    <div className="flex flex-col gap-8 py-8 px-4 sm:px-6 lg:px-8 w-full max-w-full lg:max-w-[75%] 2xl:max-w-[80%] mx-auto overflow-x-hidden">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl lg:text-4xl font-bold">Explore Markets</h1>
            <div className="dropdown dropdown-end">
              <div
                tabIndex={0}
                role="button"
                className="flex items-center gap-2 text-sm opacity-70 px-2 py-1 rounded-full border border-base-300 hover:border-base-400 transition-colors"
              >
                <span className="w-2.5 h-2.5 rounded-full bg-success animate-pulse"></span>
                <span>{networkName}</span>
                <span className="ml-1">▾</span>
              </div>
              <ul tabIndex={0} className="dropdown-content z-[10] menu p-2 shadow bg-base-100 rounded-box w-56 mt-2">
                {targetNetworks
                  .filter(net => net.id !== chainId)
                  .map(net => (
                    <li key={net.id}>
                      <button
                        type="button"
                        className="menu-item btn-sm rounded-xl flex gap-3 py-3 whitespace-nowrap"
                        onClick={() => switchChain?.({ chainId: net.id })}
                      >
                        Switch to {net.name}
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          </div>
          <p className="text-lg opacity-70 mt-2">
            Discover offerings and secondary listings for tokenized revenue streams
          </p>
        </div>

        {/* Filters & Sort */}
        <div className="flex flex-col lg:flex-row lg:items-center gap-4 p-4 bg-base-200 rounded-xl overflow-hidden">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex bg-base-100 rounded-lg p-1 gap-1 overflow-x-auto scrollbar-hide">
              <button
                className={`btn btn-sm shrink-0 ${marketTab === "pools" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setMarketTab("pools")}
              >
                Offerings
              </button>
              <button
                className={`btn btn-sm shrink-0 ${marketTab === "secondary" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setMarketTab("secondary")}
              >
                Secondary Listings
              </button>
            </div>
          </div>

          {/* Asset Type Filter */}
          {activeRegistries.length > 1 ? (
            <div className="flex items-center gap-3 min-w-0">
              <AdjustmentsHorizontalIcon className="w-5 h-5 opacity-50 shrink-0" />
              <div className="flex bg-base-100 rounded-lg p-1 gap-1 overflow-x-auto scrollbar-hide">
                <button
                  className={`btn btn-sm shrink-0 ${filterType === "ALL" ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setFilterType("ALL")}
                >
                  All Markets
                </button>
                {activeRegistries.map(([key, registry]) => (
                  <button
                    key={key}
                    className={`btn btn-sm shrink-0 ${filterType === key ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setFilterType(key as AssetType)}
                  >
                    {registry.icon} {registry.pluralName}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Right Side Controls */}
          <div className="flex items-center gap-4">
            {/* Holdings Toggle */}
            <div className="flex items-center gap-3">
              <BriefcaseIcon className="w-5 h-5 opacity-50" />
              <label className="label cursor-pointer gap-2 bg-base-100 px-3 py-1.5 rounded-lg border border-base-200 hover:border-base-300 transition-colors h-8">
                <input
                  type="checkbox"
                  className="checkbox checkbox-xs checkbox-primary"
                  checked={showOnlyHoldings}
                  onChange={e => setShowOnlyHoldings(e.target.checked)}
                />
                <span className="label-text text-sm font-medium">Your Holdings</span>
              </label>
            </div>

            {/* Sort Dropdown */}
            <div className="flex items-center gap-3">
              <ArrowsUpDownIcon className="w-5 h-5 opacity-50" />
              <select
                className="select select-bordered select-sm bg-base-100"
                value={sortBy}
                onChange={e => setSortBy(e.target.value as SortOption)}
              >
                <option value="apr_desc">Highest APY</option>
                <option value="apr_asc">Lowest APY</option>
                <option value="earnings_desc">Most Earnings</option>
                <option value="earnings_asc">Least Earnings</option>
                <option value="newest">Newest</option>
                <option value="price_asc">Lowest Price</option>
                <option value="price_desc">Highest Price</option>
              </select>
            </div>

            {/* View Mode Switcher - Hidden on mobile */}
            <div className="hidden lg:flex items-center gap-2 bg-base-100 p-1 rounded-lg border border-base-200">
              <button
                className={`btn btn-sm btn-square ${viewMode === "list" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setViewMode("list")}
                title="List View"
              >
                <Bars4Icon className="w-5 h-5" />
              </button>
              <button
                className={`btn btn-sm btn-square ${viewMode === "grid" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setViewMode("grid")}
                title="Grid View"
              >
                <Squares2X2Icon className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {hasPendingWithdrawal && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-5 rounded-2xl bg-gradient-to-br from-success/5 to-success/10 border border-success/20 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-white shadow-sm flex items-center justify-center shrink-0 text-success border border-success/10">
              <CurrencyDollarIcon className="w-6 h-6" />
            </div>
            <div>
              <div className="text-sm font-medium opacity-60">Pending Withdrawal</div>
              <div className="text-2xl font-bold flex items-baseline gap-1.5">
                {Number(pendingWithdrawalDisplay).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
                <span className="text-base font-semibold text-success">({symbol})</span>
              </div>
              <p className="text-sm opacity-70 mt-1">Claimable proceeds are ready to move back to your wallet.</p>
            </div>
          </div>
          <button
            className="btn btn-success text-white w-full sm:w-auto px-6 shadow-md shadow-success/20 hover:shadow-lg hover:shadow-success/30 transition-all rounded-xl"
            onClick={() => setIsWithdrawProceedsOpen(true)}
          >
            Withdraw Now
          </button>
        </div>
      )}

      {showOnlyHoldings && hasActualHoldingsInView && claimablePayoutAssetIds.length > 1 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-5 rounded-2xl bg-gradient-to-br from-success/5 to-success/10 border border-success/20 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-white shadow-sm flex items-center justify-center shrink-0 text-success border border-success/10">
              <CurrencyDollarIcon className="w-6 h-6" />
            </div>
            <div>
              <div className="text-sm font-medium opacity-60">Claimable Payouts</div>
              <div className="text-lg font-semibold">
                {claimablePayoutAssetIds.length} holdings have payouts ready to claim.
              </div>
              <p className="text-sm opacity-70 mt-1">This claims each payout, then withdraws the funds once.</p>
            </div>
          </div>
          <button
            className="btn btn-success text-white w-full sm:w-auto px-6 shadow-md shadow-success/20 hover:shadow-lg hover:shadow-success/30 transition-all rounded-xl"
            onClick={() => void handleBatchClaimPayouts()}
            disabled={isBatchClaimPayoutsPending}
          >
            {isBatchClaimPayoutsPending ? (
              <>
                <span className="loading loading-spinner loading-sm" />
                Claiming...
              </>
            ) : (
              "Claim All Payouts"
            )}
          </button>
        </div>
      )}

      {/* Content */}
      {!hasRestoredPreferences ||
      loading ||
      isLoadingPrimaryPoolSupply ||
      (showOnlyHoldings && (isLoadingHoldings || isLoadingPrimaryPoolHoldings)) ? (
        <div className="flex justify-center py-20">
          <span className="loading loading-spinner loading-lg text-primary"></span>
        </div>
      ) : error ? (
        <div className="alert alert-error">
          <span>{error}</span>
        </div>
      ) : marketTab === "pools" ? (
        displayPrimaryPools.length === 0 ? (
          <div className="hero bg-base-200 rounded-2xl py-16">
            <div className="hero-content text-center">
              <div className="max-w-md">
                <h2 className="text-2xl font-bold">No Offerings Found</h2>
                <p className="py-4 opacity-70">There are currently no offerings matching your filters.</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-8">
            <div
              className={`grid gap-6 items-stretch ${
                viewMode === "grid" ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" : "grid-cols-1"
              }`}
            >
              {visiblePrimaryPools.map(pool => {
                const vehicle = marketVehicles.find(v => v.id === pool.assetId);
                const token = marketTokens.find(t => t.revenueTokenId === pool.tokenId);
                const partner = marketPartners.find(p => p.address.toLowerCase() === pool.partner.toLowerCase());

                return (
                  <PrimaryPoolCard
                    key={pool.id}
                    pool={pool}
                    vehicle={vehicle}
                    token={
                      token
                        ? { ...token, supply: primaryPoolSupplyByTokenId.get(pool.tokenId) || token.supply }
                        : undefined
                    }
                    earnings={assetEarnings.find(e => e.assetId === pool.assetId)}
                    partner={partner}
                    imageUrl={vehicle ? imageUrls[getVehicleImageKey(vehicle)] : undefined}
                    viewMode={viewMode}
                    showNewPoolBadge={shouldShowNewPoolBadge(pool)}
                    primaryActionLabel={poolUserActionStateByTokenId.get(pool.tokenId)?.primaryLabel || "Deposit"}
                    primaryActionDisabled={poolUserActionStateByTokenId.get(pool.tokenId)?.primaryDisabled ?? true}
                    primaryActionOnClick={() => {
                      const action = poolUserActionStateByTokenId.get(pool.tokenId)?.primaryAction;
                      if (action === "claim_earnings") {
                        setSelectedPool(pool);
                        setSelectedListing(null);
                        setIsClaimEarningsOpen(true);
                        return;
                      }
                      if (action === "force_final_payout") {
                        setSelectedLiquidationPool(pool);
                        setSelectedListing(null);
                        setSelectedPool(null);
                        return;
                      }
                      if (action === "claim_settlement") {
                        setSelectedPool(pool);
                        setSelectedListing(null);
                        setIsClaimSettlementOpen(true);
                        return;
                      }
                      if (action === "redeem") {
                        setSelectedRedeemPool(pool);
                        setSelectedListing(null);
                        setSelectedPool(null);
                        return;
                      }
                      if (action === "list") {
                        setSelectedPool(pool);
                        setSelectedListing(null);
                        setPrefillListAmount((primaryPoolHoldingsByTokenId.get(pool.tokenId) ?? 0n).toString());
                        setIsListTokensOpen(true);
                        return;
                      }
                      if (action === "buy") {
                        openBuyModalForPool(pool);
                      }
                    }}
                    secondaryActions={(poolUserActionStateByTokenId.get(pool.tokenId)?.secondaryActions || []).map(
                      action => ({
                        label: action.label,
                        onClick: () => {
                          if (action.action === "claim_earnings") {
                            setSelectedPool(pool);
                            setSelectedListing(null);
                            setIsClaimEarningsOpen(true);
                            return;
                          }
                          if (action.action === "force_final_payout") {
                            setSelectedLiquidationPool(pool);
                            setSelectedListing(null);
                            setSelectedPool(null);
                            return;
                          }
                          if (action.action === "claim_settlement") {
                            setSelectedPool(pool);
                            setSelectedListing(null);
                            setIsClaimSettlementOpen(true);
                            return;
                          }
                          if (action.action === "redeem") {
                            setSelectedRedeemPool(pool);
                            setSelectedListing(null);
                            setSelectedPool(null);
                            return;
                          }
                          if (action.action === "list") {
                            setSelectedPool(pool);
                            setSelectedListing(null);
                            setPrefillListAmount((primaryPoolHoldingsByTokenId.get(pool.tokenId) ?? 0n).toString());
                            setIsListTokensOpen(true);
                            return;
                          }
                          openBuyModalForPool(pool);
                        },
                      }),
                    )}
                  />
                );
              })}
            </div>
            {displayPrimaryPools.length > visiblePrimaryPoolCount && (
              <div className="flex justify-center">
                <button
                  className="btn btn-outline px-8 rounded-xl"
                  onClick={() => setVisiblePrimaryPoolCount(count => count + MARKETS_PAGE_BATCH_SIZE)}
                >
                  Load More Offerings
                </button>
              </div>
            )}
          </div>
        )
      ) : displayListings.length === 0 ? (
        <div className="hero bg-base-200 rounded-2xl py-16">
          <div className="hero-content text-center">
            <div className="max-w-md">
              <h2 className="text-2xl font-bold">No Secondary Listings Found</h2>
              <p className="py-4 opacity-70">There are currently no secondary listings matching your filters.</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          <div
            className={`grid gap-6 items-stretch ${
              viewMode === "grid" ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" : "grid-cols-1"
            }`}
          >
            {visibleListings.map((listing, index) => {
              const vehicle = marketVehicles.find(v => v.id === listing.assetId);
              const rawToken = marketTokens.find(t => t.revenueTokenId === listing.tokenId);
              const token = rawToken
                ? { ...rawToken, supply: primaryPoolSupplyByTokenId.get(listing.tokenId) || rawToken.supply }
                : undefined;
              const earning = assetEarnings.find(e => e.assetId === listing.assetId);
              const partner = vehicle
                ? marketPartners.find(p => p.address.toLowerCase() === vehicle.partner.toLowerCase())
                : undefined;

              return (
                <ListingCard
                  key={listing.id}
                  listing={{ ...listing, soldOutAt: soldOutAtByListing[listing.id] }}
                  vehicle={vehicle}
                  token={token}
                  earnings={earning}
                  partner={partner}
                  imageUrl={vehicle ? imageUrls[getVehicleImageKey(vehicle)] : undefined}
                  assetType={AssetType.VEHICLE}
                  priority={index < 4}
                  viewMode={viewMode}
                  hasUserActiveListingForTokenId={(activeSellerTokenIdCounts.get(listing.tokenId) ?? 0) > 0}
                  tokenTotalSoldAmount={(tokenSoldTotals.get(listing.tokenId) ?? 0n).toString()}
                  onBuyClick={() => {
                    openBuyModalForListing(listing);
                  }}
                  onClaimEarningsClick={() => {
                    setSelectedListing(listing);
                    setIsClaimEarningsOpen(true);
                  }}
                  onClaimSettlementClick={() => {
                    setSelectedListing(listing);
                    setIsClaimSettlementOpen(true);
                  }}
                  onListTokensClick={amount => {
                    setSelectedListing(listing);
                    setPrefillListAmount(amount);
                    setIsListTokensOpen(true);
                  }}
                  onEndListingClick={() => {
                    setSelectedListing(listing);
                    setIsEndListingOpen(true);
                  }}
                />
              );
            })}
          </div>
          {displayListings.length > visibleListingCount && (
            <div className="flex justify-center">
              <button
                className="btn btn-outline px-8 rounded-xl"
                onClick={() => setVisibleListingCount(count => count + MARKETS_PAGE_BATCH_SIZE)}
              >
                Load More Listings
              </button>
            </div>
          )}
        </div>
      )}

      {selectedRedeemPool && (
        <RedeemLiquidityModal
          isOpen={!!selectedRedeemPool}
          onSuccess={() => {
            refreshMarketsAfterSuccess();
          }}
          onClose={() => {
            setSelectedRedeemPool(null);
            refreshMarketsAfterSuccess();
          }}
          tokenId={selectedRedeemPool.tokenId}
          vehicleName={(() => {
            const vehicle = marketVehicles.find(v => v.id === selectedRedeemPool.assetId);
            return vehicle
              ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`
              : `Asset #${selectedRedeemPool.assetId}`;
          })()}
          totalPositionAmount={(primaryPoolHoldingsByTokenId.get(selectedRedeemPool.tokenId) ?? 0n).toString()}
          maxRedeemableAmount={(
            primaryPoolRedemptionByTokenId.get(selectedRedeemPool.tokenId)?.eligibleBalance ?? 0n
          ).toString()}
          pricePerToken={selectedRedeemPool.pricePerToken}
        />
      )}

      {selectedLiquidationPool && (
        <ForceFinalPayoutModal
          isOpen={!!selectedLiquidationPool}
          onClose={() => {
            setSelectedLiquidationPool(null);
            refreshHoldingsActions();
          }}
          onSuccess={() => {
            refreshHoldingsActions();
          }}
          assetId={selectedLiquidationPool.assetId}
          liquidationReason={liquidationPreviewByAssetId.get(selectedLiquidationPool.assetId)?.reason}
          vehicleName={(() => {
            const vehicle = marketVehicles.find(v => v.id === selectedLiquidationPool.assetId);
            return vehicle
              ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`
              : `Asset #${selectedLiquidationPool.assetId}`;
          })()}
        />
      )}

      {/* Stats Footer */}
      {!loading && !error && (marketTab === "pools" ? displayPrimaryPools.length > 0 : displayListings.length > 0) && (
        <div className="stats shadow bg-base-200 w-full">
          <div className="stat">
            <div className="stat-title">
              {showOnlyHoldings ? "Your Holdings" : marketTab === "pools" ? "Offerings" : "Secondary Listings"}
            </div>
            <div className="stat-value text-success">
              {marketTab === "pools" ? displayPrimaryPools.length : displayListings.length}
            </div>
          </div>
          <div className="stat">
            <div className="stat-title">Total Assets</div>
            <div className="stat-value">{marketVehicles.length}</div>
          </div>
          <div className="stat">
            <div className="stat-title">Partners</div>
            <div className="stat-value">{marketPartners.length}</div>
          </div>
        </div>
      )}

      {/* Buy Tokens Modal */}
      {(selectedListing || selectedPool) && (
        <AcquirePositionModal
          isOpen={isBuyModalOpen}
          onClose={() => {
            setIsBuyModalOpen(false);
            setSelectedListing(null);
            setSelectedPool(null);
            // Refresh data to update cards with any changes
            fetchData(false);
            refetchHoldings?.();
            refetchPrimaryPoolHoldings?.();
            refetchPrimaryPoolEligibleRedemptionBalances?.();
            refetchPrimaryPoolSupply?.();
          }}
          onPurchaseComplete={id => {
            if (selectedPool && id) {
              setRecentPrimaryPoolPurchases(prev => new Set(prev).add(id));
            }
            // Refetch data after purchase (without showing loading spinner)
            fetchData(false);
            refetchHoldings?.();
            refetchPrimaryPoolHoldings?.();
            refetchPrimaryPoolEligibleRedemptionBalances?.();
            refetchPrimaryPoolSupply?.();
          }}
          purchaseTarget={
            selectedListing
              ? {
                  kind: "secondary" as const,
                  listing: selectedListing,
                }
              : {
                  kind: "primary" as const,
                  pool: selectedPool!,
                  currentSupply: primaryPoolSupplyByTokenId.get(selectedPool!.tokenId) || "0",
                }
          }
          listedTokens={(() => {
            if (!selectedListing || !address) return "0";
            const tokenId = selectedListing.tokenId;
            const sellerListings = listings.filter(l => {
              const isActive = !l.isEnded && l.status !== "expired";
              return isActive && l.tokenId === tokenId && l.seller.toLowerCase() === address.toLowerCase();
            });
            const total = sellerListings.reduce((sum, l) => sum + BigInt(l.amount), 0n);
            return total.toString();
          })()}
          vehicleName={(() => {
            const targetAssetId = selectedListing?.assetId || selectedPool?.assetId;
            const vehicle = targetAssetId ? marketVehicles.find(v => v.id === targetAssetId) : undefined;
            if (vehicle?.make && vehicle?.model && vehicle?.year) {
              return `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
            }
            return `Asset #${targetAssetId}`;
          })()}
          partnerName={(() => {
            const targetAssetId = selectedListing?.assetId || selectedPool?.assetId;
            const vehicle = targetAssetId ? marketVehicles.find(v => v.id === targetAssetId) : undefined;
            if (vehicle) {
              const partner = marketPartners.find(p => p.address.toLowerCase() === vehicle.partner.toLowerCase());
              return partner?.name;
            }
            return undefined;
          })()}
          totalSupply={(() => {
            if (selectedPool) return selectedPool.maxSupply;
            const tokenId = (BigInt(selectedListing!.assetId) + 1n).toString();
            const token = marketTokens.find(t => t.revenueTokenId === tokenId);
            return token?.supply;
          })()}
        />
      )}

      {/* Claim Modals */}
      {(selectedListing || selectedPool) && (
        <>
          <ClaimEarningsModal
            isOpen={isClaimEarningsOpen}
            onClose={() => {
              setIsClaimEarningsOpen(false);
              setSelectedListing(null);
              setSelectedPool(null);
              refreshHoldingsActions();
            }}
            assetId={selectedListing?.assetId || selectedPool!.assetId}
            vehicleName={(() => {
              const assetId = selectedListing?.assetId || selectedPool?.assetId;
              const vehicle = assetId ? marketVehicles.find(v => v.id === assetId) : undefined;
              return vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : `Asset #${assetId}`;
            })()}
          />
          {(selectedListing || selectedPool) && (
            <ClaimSettlementModal
              isOpen={isClaimSettlementOpen}
              onClose={() => {
                setIsClaimSettlementOpen(false);
                setSelectedListing(null);
                setSelectedPool(null);
                refreshHoldingsActions();
              }}
              assetId={selectedListing?.assetId || selectedPool!.assetId}
              vehicleName={(() => {
                const assetId = selectedListing?.assetId || selectedPool?.assetId;
                const vehicle = assetId ? marketVehicles.find(v => v.id === assetId) : undefined;
                return vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : `Asset #${assetId}`;
              })()}
              autoWithdraw={shouldAutoWithdrawSingleClaim}
            />
          )}
        </>
      )}

      {(selectedListing || selectedPool) && isListTokensOpen && (
        <CreateSecondaryListingModal
          isOpen={isListTokensOpen}
          onSuccess={() => {
            refreshMarketsAfterSuccess();
          }}
          onClose={() => {
            setIsListTokensOpen(false);
            setSelectedListing(null);
            setSelectedPool(null);
            setPrefillListAmount(undefined);
          }}
          vehicleId={selectedListing?.assetId || selectedPool!.assetId}
          vin={(() => {
            const assetId = selectedListing?.assetId || selectedPool!.assetId;
            const vehicle = marketVehicles.find(v => v.id === assetId);
            return vehicle?.vin || "";
          })()}
          assetName={(() => {
            const assetId = selectedListing?.assetId || selectedPool!.assetId;
            const vehicle = marketVehicles.find(v => v.id === assetId);
            return vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : `Asset #${assetId}`;
          })()}
          prefillAmount={prefillListAmount}
          listingFlow="secondary"
        />
      )}

      {selectedListing && (
        <EndSecondaryListingModal
          isOpen={isEndListingOpen}
          onSuccess={() => {
            applyListingActionSuccess(selectedListing.id, { isEnded: true, status: "ended" });
          }}
          onClose={() => {
            setIsEndListingOpen(false);
            setSelectedListing(null);
          }}
          listingId={selectedListing.id}
          tokenAmount={selectedListing.amount}
        />
      )}

      <WithdrawProceedsModal
        isOpen={isWithdrawProceedsOpen}
        onClose={() => {
          setIsWithdrawProceedsOpen(false);
          refetchPendingWithdrawal();
          fetchData(false);
          refetchHoldings?.();
          refetchPrimaryPoolHoldings?.();
          refetchActionPreviewData();
        }}
      />
    </div>
  );
};

export default MarketsPage;
