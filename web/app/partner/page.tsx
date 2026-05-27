"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { NextPage } from "next";
import { formatUnits } from "viem";
import { useBlock, useChains, useReadContract, useReadContracts, useSwitchChain } from "wagmi";
import { Bars4Icon, ChevronDownIcon, CurrencyDollarIcon, Squares2X2Icon } from "@heroicons/react/24/outline";
import { CreateRevenueTokenPoolModal } from "~~/components/partner/CreateRevenueTokenPoolModal";
import { CreateSecondaryListingModal } from "~~/components/partner/CreateSecondaryListingModal";
import { DistributeEarningsModal } from "~~/components/partner/DistributeEarningsModal";
import { EnableProceedsModal } from "~~/components/partner/EnableProceedsModal";
import { EndSecondaryListingModal } from "~~/components/partner/EndSecondaryListingModal";
import { ExtendListingModal } from "~~/components/partner/ExtendListingModal";
import { RegisterAssetModal } from "~~/components/partner/RegisterAssetModal";
import { SettleAssetModal } from "~~/components/partner/SettleAssetModal";
import { WithdrawProceedsModal } from "~~/components/partner/WithdrawProceedsModal";
import { ASSET_REGISTRIES, AssetType } from "~~/config/assetTypes";
import { useScaffoldWriteContract, useSelectedNetwork } from "~~/hooks/scaffold-eth";
import { usePaymentToken } from "~~/hooks/usePaymentToken";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import { getDeployedContract } from "~~/utils/contracts";
import { fetchIpfsMetadata, mergeVehicleMetadata } from "~~/utils/ipfsGateway";
import { normalizeVehicleMetadata } from "~~/utils/protocolState";
import { getTargetNetworks, notification } from "~~/utils/scaffold-eth";
import { getSubgraphQueryUrl } from "~~/utils/subgraph";

// Unified Asset Interface for Dashboard logic
interface DashboardAsset {
  id: string;
  vin?: string;
  make?: string;
  model?: string;
  year?: string | bigint;
  assetValue?: string;
  partner: string;
  blockNumber: string;
  type: AssetType;
  supply?: bigint;
  metadataURI?: string;
  imageUrl?: string;
  assetStatus?: number; // 0=Pending, 1=Active, 2=Earning, 3=Suspended, 4=Expired, 5=Retired
}

// Listing interface from subgraph
interface SubgraphListing {
  id: string;
  tokenId: string;
  assetId: string;
  seller: string;
  amount: string;
  amountSold: string;
  pricePerToken: string;
  expiresAt: string;
  status: string;
  createdAt: string;
}

const isSameListings = (a: SubgraphListing[], b: SubgraphListing[]) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      left.id !== right.id ||
      left.tokenId !== right.tokenId ||
      left.assetId !== right.assetId ||
      left.seller !== right.seller ||
      left.amount !== right.amount ||
      left.amountSold !== right.amountSold ||
      left.pricePerToken !== right.pricePerToken ||
      left.expiresAt !== right.expiresAt ||
      left.status !== right.status ||
      left.createdAt !== right.createdAt
    ) {
      return false;
    }
  }
  return true;
};

const isSameAssets = (a: DashboardAsset[], b: DashboardAsset[]) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      left.id !== right.id ||
      left.partner !== right.partner ||
      left.vin !== right.vin ||
      left.make !== right.make ||
      left.model !== right.model ||
      left.year !== right.year ||
      left.assetValue !== right.assetValue ||
      left.metadataURI !== right.metadataURI ||
      left.blockNumber !== right.blockNumber ||
      left.type !== right.type
    ) {
      return false;
    }
  }
  return true;
};

// Asset state enum for the 5 lifecycle states
type AssetState = "ACTIVE_FLEET" | "ACTIVE_LISTINGS" | "PENDING_LISTINGS" | "SETTLED";

interface CategorizedAsset extends DashboardAsset {
  state: AssetState;
  listings?: SubgraphListing[];
  totalSold?: bigint;
  totalClaimed?: bigint;
  partnerTokenBalance?: bigint;
  pricePerToken?: bigint;
  maxSupply?: bigint;
  hasPrimaryPool?: boolean;
  immediateProceeds?: boolean;
  protectionEnabled?: boolean;
  primaryPoolPaused?: boolean;
  primaryPoolClosed?: boolean;
  primaryInvestorLiquidity?: bigint;
  bufferFundingDue?: bigint;
}

type AssetAction = {
  label: string;
  onClick: () => void;
  className?: string;
  tone?: "default" | "danger";
};

const SUBGRAPH_REFRESH_DELAYS_MS = [1500, 5000, 12000, 25000];

const payoutGhostActionClass =
  "btn btn-primary border-0 bg-primary/15 text-primary hover:bg-primary/25 dark:bg-primary/25 dark:text-primary-content dark:hover:bg-primary/35";

const PartnerDashboard: NextPage = () => {
  const { address: accountAddress, chainId: accountChainId } = useTransactingAccount();
  const { data: latestBlock } = useBlock({ watch: true });
  const selectedNetwork = useSelectedNetwork(accountChainId);
  const chainId = selectedNetwork.id;
  const chains = useChains();
  const currentChain = chains.find(c => c.id === chainId);
  const networkName = currentChain?.name || selectedNetwork.name || "Localhost";
  const { switchChain } = useSwitchChain();
  const { symbol, decimals } = usePaymentToken();
  const targetNetworks = getTargetNetworks();
  const subgraphUrl = getSubgraphQueryUrl(chainId);
  const partnerManagerContract = getDeployedContract(chainId, "PartnerManager");
  const roboshareTokensContract = getDeployedContract(chainId, "RoboshareTokens");
  const vehicleRegistryContract = getDeployedContract(chainId, "VehicleRegistry");
  const registryRouterContract = getDeployedContract(chainId, "RegistryRouter");
  const marketplaceContract = getDeployedContract(chainId, "Marketplace");
  const treasuryContract = getDeployedContract(chainId, "Treasury");
  const [allAssets, setAllAssets] = useState<DashboardAsset[]>([]);
  const [listings, setListings] = useState<SubgraphListing[]>([]);
  const [filterType, setFilterType] = useState<AssetType | "ALL">("ALL");
  const [filterState, setFilterState] = useState<AssetState | "ALL">("ALL");

  const { data: isAuthorizedPartner, isLoading: isCheckingPartner } = useReadContract({
    address: partnerManagerContract?.address,
    abi: partnerManagerContract?.abi,
    functionName: "isAuthorizedPartner",
    args: [accountAddress as string],
    query: { enabled: !!accountAddress && !!partnerManagerContract },
  });

  // Modal States
  const [isRegisterOpen, setIsRegisterOpen] = useState(false);
  const [maxStep, setMaxStep] = useState<1 | 3>(3);
  const [selectedAsset, setSelectedAsset] = useState<DashboardAsset | null>(null);
  const [selectedCategorizedAsset, setSelectedCategorizedAsset] = useState<CategorizedAsset | null>(null);
  const [createSecondaryListingModalOpen, setCreateSecondaryListingModalOpen] = useState(false);
  const [listPrefillAmount, setListPrefillAmount] = useState<string | undefined>(undefined);
  const [createRevenueTokenPoolModalOpen, setCreateRevenueTokenPoolModalOpen] = useState(false);
  const [selectedListing, setSelectedListing] = useState<SubgraphListing | null>(null);
  const [distributeEarningsModalOpen, setDistributeEarningsModalOpen] = useState(false);
  const [enableProceedsModalOpen, setEnableProceedsModalOpen] = useState(false);
  const [settleAssetModalOpen, setSettleAssetModalOpen] = useState(false);
  const [extendListingModalOpen, setExtendListingModalOpen] = useState(false);
  const [endSecondaryListingModalOpen, setEndSecondaryListingModalOpen] = useState(false);
  const [withdrawProceedsModalOpen, setWithdrawProceedsModalOpen] = useState(false);
  const [refreshCounter, setRefreshCounter] = useState(0);
  const skipNextCloseRefreshRef = useRef(false);
  const { writeContractAsync: writeMarketplace } = useScaffoldWriteContract({ contractName: "Marketplace" });

  // Trigger a data refresh with delay to allow subgraph to index
  const triggerRefresh = (delayMs = 2000) => {
    setTimeout(() => {
      setRefreshCounter(c => c + 1);
    }, delayMs);
  };

  const refreshPartnerAfterSuccess = () => {
    // Immediate refresh attempt, then delayed retries for subgraph indexing lag on slower networks.
    setRefreshCounter(c => c + 1);
    refetchPending?.();
    SUBGRAPH_REFRESH_DELAYS_MS.forEach(delayMs => {
      setTimeout(() => {
        setRefreshCounter(c => c + 1);
        refetchPending?.();
      }, delayMs);
    });
  };

  const refreshOnModalClose = () => {
    if (skipNextCloseRefreshRef.current) {
      skipNextCloseRefreshRef.current = false;
      return;
    }
    triggerRefresh();
  };

  const handleFlowSuccess = () => {
    skipNextCloseRefreshRef.current = true;
    refreshPartnerAfterSuccess();
  };

  // Dynamic Labels (Global)
  const activeRegistries = Object.values(ASSET_REGISTRIES).filter(r => r.active);
  const isSingleAssetType = activeRegistries.length === 1;

  const dashboardSubtitle = isSingleAssetType
    ? `Manage your ${activeRegistries[0].name.toLowerCase()} ${activeRegistries[0].collectiveNoun} and claim units`
    : "Manage your registered assets and claim units";

  // Fetch assets and listings
  useEffect(() => {
    const fetchData = async () => {
      if (!accountAddress) return;

      const assets: DashboardAsset[] = [];

      try {
        // Fetch vehicles and listings in one query
        if (ASSET_REGISTRIES[AssetType.VEHICLE].active) {
          if (!subgraphUrl) {
            console.error(`No subgraph endpoint configured for chain ${chainId}.`);
            return;
          }

          const response = await fetch(subgraphUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: `
                query GetPartnerData {
                  vehicles(first: 100, orderBy: blockTimestamp, orderDirection: desc) {
                    id
                    partner
                    vin
                    make
                    model
                    year
                    assetValue
                    metadataURI
                    blockNumber
                    blockTimestamp
                    transactionHash
                  }
                  listings(first: 100, orderBy: createdAt, orderDirection: desc) {
                    id
                    tokenId
                    assetId
                    seller
                    amount
                    amountSold
                    pricePerToken
                    expiresAt
                    status
                    createdAt
                  }
                }
              `,
            }),
          });

          if (!response.ok) throw new Error(`Subgraph fetch failed: ${response.statusText}`);

          const responseJson = await response.json();
          const { data } = responseJson;

          // Filter vehicles for this partner
          const myVehicles = (data?.vehicles || []).filter(
            (v: any) => v.partner.toLowerCase() === accountAddress.toLowerCase(),
          );

          const normalizedVehicles: DashboardAsset[] = myVehicles.map((v: any) => ({
            ...v,
            type: AssetType.VEHICLE,
          }));
          assets.push(...normalizedVehicles);

          // Filter listings for this partner
          const myListings = (data?.listings || []).filter(
            (l: any) => l.seller.toLowerCase() === accountAddress.toLowerCase(),
          );
          setListings(prev => (isSameListings(prev, myListings) ? prev : myListings));
        }

        setAllAssets(prev => (isSameAssets(prev, assets) ? prev : assets));
      } catch (e) {
        console.error("Error fetching data:", e);
      }
    };
    fetchData();
  }, [accountAddress, chainId, refreshCounter, subgraphUrl]);

  const { data: assetMetadataData, refetch: refetchAssetMetadata } = useReadContracts({
    allowFailure: true,
    contracts: vehicleRegistryContract
      ? allAssets.map(asset => ({
          address: vehicleRegistryContract.address,
          abi: vehicleRegistryContract.abi,
          functionName: "getVehicleInfo",
          args: [BigInt(asset.id)],
        }))
      : [],
    query: { enabled: !!vehicleRegistryContract && allAssets.length > 0 },
  });

  const hydratedAssets = useMemo(() => {
    const results = assetMetadataData as Array<{ result?: readonly unknown[]; status: string }> | undefined;

    return allAssets.map((asset, index) => {
      const result = results?.[index];
      if (result?.status !== "success" || result.result === undefined) {
        return asset;
      }

      return normalizeVehicleMetadata(result.result, asset);
    });
  }, [allAssets, assetMetadataData]);

  const assetRecords = hydratedAssets;

  // Fetch image URLs from IPFS metadata
  useEffect(() => {
    const fetchImageUrls = async () => {
      const assetsNeedingMetadata = assetRecords.filter(
        a => a.metadataURI && (!a.imageUrl || !a.vin || !a.make || !a.model || !a.year),
      );
      if (assetsNeedingMetadata.length === 0) return;

      const updatedAssets = await Promise.all(
        assetRecords.map(async asset => {
          const needsHydration = !asset.imageUrl || !asset.vin || !asset.make || !asset.model || !asset.year;
          if (!needsHydration || !asset.metadataURI) return asset;

          try {
            const metadata = await fetchIpfsMetadata(asset.metadataURI);
            if (metadata) {
              return mergeVehicleMetadata(asset, metadata);
            }
          } catch (error) {
            console.error(`Error fetching metadata for asset ${asset.id}:`, error);
          }
          return asset;
        }),
      );

      const hasMetadataChanges = updatedAssets.some((asset, index) => {
        const previous = assetRecords[index];
        return (
          asset.imageUrl !== previous.imageUrl ||
          asset.vin !== previous.vin ||
          asset.make !== previous.make ||
          asset.model !== previous.model ||
          asset.year !== previous.year
        );
      });
      if (hasMetadataChanges) {
        setAllAssets(updatedAssets);
      }
    };

    fetchImageUrls();
  }, [assetRecords]);

  // Fetch Token Supplies
  const contractConfig = {
    address: roboshareTokensContract?.address,
    abi: roboshareTokensContract?.abi,
  } as const;

  // Type for useReadContracts result item
  type ContractResult<T> = { result?: T; status: string; error?: Error };

  const { data: suppliesData, refetch: refetchSupplies } = useReadContracts({
    contracts: assetRecords.map(asset => ({
      ...contractConfig,
      functionName: "getRevenueTokenSupply",
      args: [BigInt(asset.id) + 1n],
    })),
    query: { enabled: !!roboshareTokensContract && assetRecords.length > 0 },
  });
  // Cast to break deep type inference
  const supplies = suppliesData as ContractResult<bigint>[] | undefined;

  const { data: tokenPricesData, refetch: refetchTokenPrices } = useReadContracts({
    contracts: assetRecords.map(asset => ({
      ...contractConfig,
      functionName: "getTokenPrice",
      args: [BigInt(asset.id) + 1n],
    })),
    query: { enabled: !!roboshareTokensContract && assetRecords.length > 0 },
  });
  const tokenPrices = tokenPricesData as ContractResult<bigint>[] | undefined;

  const { data: maxSuppliesData, refetch: refetchMaxSupplies } = useReadContracts({
    contracts: assetRecords.map(asset => ({
      ...contractConfig,
      functionName: "getRevenueTokenMaxSupply",
      args: [BigInt(asset.id) + 1n],
    })),
    query: { enabled: !!roboshareTokensContract && assetRecords.length > 0 },
  });
  const maxSupplies = maxSuppliesData as ContractResult<bigint>[] | undefined;

  const { data: partnerTokenBalancesData, refetch: refetchPartnerTokenBalances } = useReadContracts({
    contracts: accountAddress
      ? assetRecords.map(asset => ({
          ...contractConfig,
          functionName: "balanceOf",
          args: [accountAddress, BigInt(asset.id) + 1n],
        }))
      : [],
    query: { enabled: !!accountAddress && !!roboshareTokensContract && assetRecords.length > 0 },
  });
  const partnerTokenBalances = partnerTokenBalancesData as ContractResult<bigint>[] | undefined;

  const { data: maturityDatesData, refetch: refetchMaturityDates } = useReadContracts({
    contracts: assetRecords.map(asset => ({
      address: roboshareTokensContract?.address,
      abi: roboshareTokensContract?.abi,
      functionName: "getTokenMaturityDate",
      args: [BigInt(asset.id) + 1n],
    })),
    query: { enabled: !!roboshareTokensContract && assetRecords.length > 0 },
  });
  const tokenMaturityDates = maturityDatesData as ContractResult<bigint>[] | undefined;

  const { data: immediateProceedsData, refetch: refetchImmediateProceeds } = useReadContracts({
    contracts: assetRecords.map(asset => ({
      address: roboshareTokensContract?.address,
      abi: roboshareTokensContract?.abi,
      functionName: "getRevenueTokenImmediateProceedsEnabled",
      args: [BigInt(asset.id) + 1n],
    })),
    query: { enabled: !!roboshareTokensContract && assetRecords.length > 0 },
  });
  const immediateProceedsFlags = immediateProceedsData as ContractResult<boolean>[] | undefined;

  const { data: protectionEnabledData, refetch: refetchProtectionEnabled } = useReadContracts({
    contracts: assetRecords.map(asset => ({
      address: roboshareTokensContract?.address,
      abi: roboshareTokensContract?.abi,
      functionName: "getRevenueTokenProtectionEnabled",
      args: [BigInt(asset.id) + 1n],
    })),
    query: { enabled: !!roboshareTokensContract && assetRecords.length > 0 },
  });
  const protectionEnabledFlags = protectionEnabledData as ContractResult<boolean>[] | undefined;

  // Fetch Asset Statuses from RegistryRouter
  const routerConfig = {
    address: registryRouterContract?.address,
    abi: registryRouterContract?.abi,
  } as const;

  const { data: statusesData, refetch: refetchStatuses } = useReadContracts({
    contracts: assetRecords.map(asset => ({
      ...routerConfig,
      functionName: "getAssetStatus",
      args: [BigInt(asset.id)],
    })),
    query: { enabled: !!registryRouterContract && assetRecords.length > 0 },
  });
  // Cast to break deep type inference
  const assetStatuses = statusesData as ContractResult<number>[] | undefined;

  const marketplaceConfig = {
    address: marketplaceContract?.address,
    abi: marketplaceContract?.abi,
  } as const;

  const { data: primaryPoolCreatedData, refetch: refetchPrimaryPoolCreated } = useReadContracts({
    contracts: assetRecords.map(asset => ({
      ...marketplaceConfig,
      functionName: "primaryPoolCreated",
      args: [BigInt(asset.id) + 1n],
    })),
    query: { enabled: !!marketplaceContract && assetRecords.length > 0 },
  });
  const primaryPoolCreated = primaryPoolCreatedData as ContractResult<boolean>[] | undefined;

  const { data: primaryPoolDetailsData, refetch: refetchPrimaryPoolDetails } = useReadContracts({
    contracts: assetRecords.map(asset => ({
      ...marketplaceConfig,
      functionName: "getPrimaryPool",
      args: [BigInt(asset.id) + 1n],
    })),
    query: { enabled: !!marketplaceContract && assetRecords.length > 0 },
    allowFailure: true,
  });
  const primaryPoolDetails = primaryPoolDetailsData as
    | Array<{ result?: any; status: string; error?: Error }>
    | undefined;

  const treasuryConfig = {
    address: treasuryContract?.address,
    abi: treasuryContract?.abi,
  } as const;

  const { data: collateralInfoData, refetch: refetchCollateralInfo } = useReadContracts({
    contracts: assetRecords.map(asset => ({
      ...treasuryConfig,
      functionName: "assetCollateral",
      args: [BigInt(asset.id)],
    })),
    query: { enabled: !!treasuryContract && assetRecords.length > 0 },
    allowFailure: true,
  });
  const collateralInfo = collateralInfoData as Array<{ result?: any; status: string; error?: Error }> | undefined;

  const { data: primaryPoolBufferRequirementsData, refetch: refetchPrimaryPoolBufferRequirements } = useReadContracts({
    contracts: assetRecords.map((asset, index) => ({
      ...marketplaceConfig,
      functionName: "previewPrimaryPoolBufferRequirements",
      args: [
        BigInt(asset.id) + 1n,
        (() => {
          const collateral = collateralInfo?.[index]?.result as
            | {
                baseCollateral?: bigint;
                releasedProtectedBase?: bigint;
              }
            | readonly unknown[]
            | undefined;
          const collateralObject = !Array.isArray(collateral)
            ? (collateral as { baseCollateral?: bigint; releasedProtectedBase?: bigint } | undefined)
            : undefined;
          const currentBaseLiquidity = Array.isArray(collateral)
            ? ((collateral[1] as bigint | undefined) ?? 0n)
            : (collateralObject?.baseCollateral ?? 0n);
          const releasedProtectedBase = Array.isArray(collateral)
            ? ((collateral[9] as bigint | undefined) ?? 0n)
            : (collateralObject?.releasedProtectedBase ?? 0n);
          const immediateProceeds = (immediateProceedsFlags?.[index]?.result as boolean | undefined) ?? false;
          return immediateProceeds ? currentBaseLiquidity + releasedProtectedBase : currentBaseLiquidity;
        })(),
      ],
    })),
    query: {
      enabled:
        !!marketplaceContract &&
        assetRecords.length > 0 &&
        !!collateralInfo &&
        collateralInfo.length === assetRecords.length,
    },
    allowFailure: true,
  });
  const primaryPoolBufferRequirements = primaryPoolBufferRequirementsData as
    | Array<{ result?: any; status: string; error?: Error }>
    | undefined;

  // Store refetch functions in refs to avoid deep type instantiation in useCallback deps
  const refetchSuppliesRef = useRef(refetchSupplies);
  const refetchTokenPricesRef = useRef(refetchTokenPrices);
  const refetchMaxSuppliesRef = useRef(refetchMaxSupplies);
  const refetchStatusesRef = useRef(refetchStatuses);
  const refetchMaturityDatesRef = useRef(refetchMaturityDates);
  const refetchImmediateProceedsRef = useRef(refetchImmediateProceeds);
  const refetchProtectionEnabledRef = useRef(refetchProtectionEnabled);
  const refetchAssetMetadataRef = useRef(refetchAssetMetadata);
  const refetchPrimaryPoolCreatedRef = useRef(refetchPrimaryPoolCreated);
  const refetchPrimaryPoolDetailsRef = useRef(refetchPrimaryPoolDetails);
  const refetchCollateralInfoRef = useRef(refetchCollateralInfo);
  const refetchPrimaryPoolBufferRequirementsRef = useRef(refetchPrimaryPoolBufferRequirements);
  const refetchPartnerTokenBalancesRef = useRef(refetchPartnerTokenBalances);
  refetchSuppliesRef.current = refetchSupplies;
  refetchTokenPricesRef.current = refetchTokenPrices;
  refetchMaxSuppliesRef.current = refetchMaxSupplies;
  refetchStatusesRef.current = refetchStatuses;
  refetchMaturityDatesRef.current = refetchMaturityDates;
  refetchImmediateProceedsRef.current = refetchImmediateProceeds;
  refetchProtectionEnabledRef.current = refetchProtectionEnabled;
  refetchAssetMetadataRef.current = refetchAssetMetadata;
  refetchPrimaryPoolCreatedRef.current = refetchPrimaryPoolCreated;
  refetchPrimaryPoolDetailsRef.current = refetchPrimaryPoolDetails;
  refetchCollateralInfoRef.current = refetchCollateralInfo;
  refetchPrimaryPoolBufferRequirementsRef.current = refetchPrimaryPoolBufferRequirements;
  refetchPartnerTokenBalancesRef.current = refetchPartnerTokenBalances;

  // Refetch supplies and statuses when refreshCounter changes
  useEffect(() => {
    if (refreshCounter > 0 && assetRecords.length > 0) {
      void refetchSuppliesRef.current();
      void refetchTokenPricesRef.current();
      void refetchMaxSuppliesRef.current();
      void refetchStatusesRef.current();
      void refetchMaturityDatesRef.current();
      void refetchImmediateProceedsRef.current();
      void refetchProtectionEnabledRef.current();
      void refetchAssetMetadataRef.current();
      void refetchPrimaryPoolCreatedRef.current();
      void refetchPrimaryPoolDetailsRef.current();
      void refetchCollateralInfoRef.current();
      void refetchPrimaryPoolBufferRequirementsRef.current();
      void refetchPartnerTokenBalancesRef.current();
    }
  }, [assetRecords.length, refreshCounter]);

  const chainNowSec = latestBlock?.timestamp ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);
  const assetMaturityDateById = new Map<string, bigint>(
    assetRecords.map((asset, index) => [asset.id, (tokenMaturityDates?.[index]?.result as bigint | undefined) ?? 0n]),
  );

  // View/Display Mode State
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");

  // Fetch pending withdrawal amount for seller
  const { data: pendingWithdrawal, refetch: refetchPending } = useReadContract({
    address: treasuryContract?.address,
    abi: treasuryContract?.abi,
    functionName: "pendingWithdrawals",
    args: accountAddress ? [accountAddress] : undefined,
    query: { enabled: !!accountAddress && !!treasuryContract },
  });
  const hasPendingWithdrawal = !!pendingWithdrawal && (pendingWithdrawal as bigint) > 0n;
  const pendingWithdrawalDisplay = pendingWithdrawal ? formatUnits(pendingWithdrawal as bigint, decimals) : "0";

  // Categorize assets into 5 states
  const categorizeAssets = (): {
    activeFleet: CategorizedAsset[];
    activeListings: CategorizedAsset[];
    pendingListings: CategorizedAsset[];
    settledAssets: CategorizedAsset[];
  } => {
    const activeFleet: CategorizedAsset[] = [];
    const activeListings: CategorizedAsset[] = [];
    const pendingListings: CategorizedAsset[] = [];
    const settledAssets: CategorizedAsset[] = [];

    assetRecords.forEach((asset, index) => {
      // Filter by asset type if needed
      if (!ASSET_REGISTRIES[asset.type].active) return;
      if (filterType !== "ALL" && filterType !== asset.type) return;

      const supply = supplies?.[index]?.result as bigint | undefined;
      const tokenPrice = tokenPrices?.[index]?.result as bigint | undefined;
      const revenueTokenMaxSupply = maxSupplies?.[index]?.result as bigint | undefined;
      const partnerTokenBalance = partnerTokenBalances?.[index]?.result as bigint | undefined;
      const status = assetStatuses?.[index]?.result as number | undefined;
      const hasPrimaryPool = (primaryPoolCreated?.[index]?.result as boolean | undefined) ?? false;
      const primaryPoolDetail = primaryPoolDetails?.[index]?.result as
        | {
            pricePerToken?: bigint;
            maxSupply?: bigint;
            immediateProceeds?: boolean;
            protectionEnabled?: boolean;
            isPaused?: boolean;
            isClosed?: boolean;
          }
        | any[]
        | undefined;
      const primaryPoolPaused =
        (primaryPoolDetail && !Array.isArray(primaryPoolDetail)
          ? primaryPoolDetail.isPaused
          : primaryPoolDetail?.[6]) ?? false;
      const primaryPoolClosed =
        (primaryPoolDetail && !Array.isArray(primaryPoolDetail)
          ? primaryPoolDetail.isClosed
          : primaryPoolDetail?.[7]) ?? false;
      const immediateProceeds = (immediateProceedsFlags?.[index]?.result as boolean | undefined) ?? false;
      const maxSupply = revenueTokenMaxSupply ?? 0n;
      const poolPricePerToken = tokenPrice ?? 0n;
      const protectionEnabled = (protectionEnabledFlags?.[index]?.result as boolean | undefined) ?? false;
      const collateral = collateralInfo?.[index]?.result as
        | {
            baseCollateral?: bigint;
            earningsBuffer?: bigint;
            protocolBuffer?: bigint;
            releasedProtectedBase?: bigint;
          }
        | readonly unknown[]
        | undefined;
      const bufferPreview = primaryPoolBufferRequirements?.[index]?.result as readonly unknown[] | undefined;
      const requiredProtocolBuffer = (bufferPreview?.[0] as bigint | undefined) ?? 0n;
      const requiredProtectionBuffer = (bufferPreview?.[1] as bigint | undefined) ?? 0n;
      const collateralObject = !Array.isArray(collateral)
        ? (collateral as
            | {
                baseCollateral?: bigint;
                earningsBuffer?: bigint;
                protocolBuffer?: bigint;
                releasedProtectedBase?: bigint;
              }
            | undefined)
        : undefined;
      const investorLiquidity = Array.isArray(collateral)
        ? ((collateral[1] as bigint | undefined) ?? 0n)
        : (collateralObject?.baseCollateral ?? 0n);
      const currentProtocolBuffer = Array.isArray(collateral)
        ? ((collateral[3] as bigint | undefined) ?? 0n)
        : (collateralObject?.protocolBuffer ?? 0n);
      const currentProtectionBuffer = Array.isArray(collateral)
        ? ((collateral[2] as bigint | undefined) ?? 0n)
        : (collateralObject?.earningsBuffer ?? 0n);
      const protocolBufferDue =
        requiredProtocolBuffer > currentProtocolBuffer ? requiredProtocolBuffer - currentProtocolBuffer : 0n;
      const protectionBufferDue =
        requiredProtectionBuffer > currentProtectionBuffer ? requiredProtectionBuffer - currentProtectionBuffer : 0n;
      const bufferFundingDue = protocolBufferDue + protectionBufferDue;
      const assetListings = listings.filter(l => l.assetId === asset.id);
      const activeAssetListings = assetListings.filter(l => l.status === "active");
      const totalSold = assetListings
        .filter(l => l.status !== "ended") // Exclude ended listings from total sold
        .reduce((acc, l) => acc + BigInt(l.amountSold || "0"), 0n);
      const totalClaimed = totalSold;

      const categorizedAsset: CategorizedAsset = {
        ...asset,
        supply,
        assetStatus: status,
        listings: assetListings,
        totalSold,
        totalClaimed,
        partnerTokenBalance,
        pricePerToken: poolPricePerToken,
        maxSupply,
        hasPrimaryPool,
        immediateProceeds,
        protectionEnabled,
        primaryPoolPaused,
        primaryPoolClosed,
        primaryInvestorLiquidity: investorLiquidity,
        bufferFundingDue,
        state: "PENDING_LISTINGS",
      };

      // State determination logic:
      // 0. Check if asset is settled (status 4=Expired or 5=Retired) - takes priority
      // 1. Active secondary listing = ACTIVE_LISTINGS
      // 2. Live primary pool = ACTIVE_FLEET, even before any buys
      // 3. No live primary pool yet = PENDING_LISTINGS

      if (status === 4 || status === 5) {
        // Expired (4) or Retired (5) = SETTLED
        categorizedAsset.state = "SETTLED";
        settledAssets.push(categorizedAsset);
      } else if (activeAssetListings.length > 0) {
        categorizedAsset.state = "ACTIVE_LISTINGS";
        activeListings.push(categorizedAsset);
      } else if (hasPrimaryPool) {
        categorizedAsset.state = "ACTIVE_FLEET";
        activeFleet.push(categorizedAsset);
      } else {
        categorizedAsset.state = "PENDING_LISTINGS";
        pendingListings.push(categorizedAsset);
      }
    });

    return { activeFleet, activeListings, pendingListings, settledAssets };
  };

  const { activeFleet, activeListings: activeListingsAssets, pendingListings, settledAssets } = categorizeAssets();
  const totalAssets = activeFleet.length + activeListingsAssets.length + pendingListings.length + settledAssets.length;

  // Helper functions
  const getAssetDisplayName = (asset: DashboardAsset) => {
    if (asset.make) return `${asset.year} ${asset.make} ${asset.model}`;
    if (asset.vin) return asset.vin;
    return `Asset #${asset.id}`;
  };

  const openListModal = (asset: DashboardAsset, prefillAmount?: string) => {
    setSelectedAsset(asset);
    setListPrefillAmount(prefillAmount);
    setCreateSecondaryListingModalOpen(true);
  };

  const openCreateRevenueTokenPoolModal = (asset: DashboardAsset) => {
    setSelectedAsset(asset);
    setCreateRevenueTokenPoolModalOpen(true);
  };

  const updatePrimaryPoolState = async (
    tokenId: bigint,
    action: "pausePrimaryPool" | "unpausePrimaryPool" | "closePrimaryPool",
  ) => {
    try {
      const txHash = await writeMarketplace({
        functionName: action,
        args: [tokenId],
      });
      if (!txHash) {
        notification.error("Transaction was not submitted. Please try again.");
        return;
      }
      refreshPartnerAfterSuccess();
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Pool update failed");
    }
  };

  if (!accountAddress) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center py-20 text-xl opacity-70">Please log in to access the dashboard.</div>
      </div>
    );
  }

  if (isCheckingPartner) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <span className="loading loading-spinner loading-lg text-primary"></span>
      </div>
    );
  }

  if (!isAuthorizedPartner) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center py-16 px-6 max-w-xl">
          <h2 className="text-2xl font-bold">Partner Access Required</h2>
          <p className="mt-3 opacity-70">
            This dashboard is only available to authorized partners. If you believe this is an error, please contact the
            Roboshare team.
          </p>
        </div>
      </div>
    );
  }

  // Asset Card Component
  const AssetCard = ({
    asset,
    borderColor,
    primaryAction,
    secondaryActions,
    isGrid = false,
  }: {
    asset: CategorizedAsset;
    borderColor: string;
    primaryAction?: AssetAction;
    secondaryActions?: AssetAction[];
    isGrid?: boolean;
  }) => {
    const dropdownRef = useRef<HTMLDivElement | null>(null);
    const visibleSecondaryActions = (secondaryActions ?? []).filter((action, idx, arr) => {
      if (primaryAction && action.label === primaryAction.label) return false;
      return arr.findIndex(candidate => candidate.label === action.label) === idx;
    });
    const nonDestructiveActions = visibleSecondaryActions.filter(action => action.tone === undefined);
    const destructiveActions = visibleSecondaryActions.filter(action => action.tone === "danger");
    const circulatingSupply = asset.supply ?? 0n;
    const hasMaxSupply = (asset.maxSupply ?? 0n) > 0n;
    const availableSupply =
      hasMaxSupply && asset.maxSupply! > circulatingSupply ? asset.maxSupply! - circulatingSupply : 0n;
    const formattedPricePerToken =
      asset.pricePerToken && asset.pricePerToken > 0n
        ? `${Number(formatUnits(asset.pricePerToken, decimals)).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })} ${symbol}`
        : "—";

    return (
      <div
        className={`card bg-base-100 shadow-sm border-l-4 ${borderColor} ${
          isGrid ? "p-4 sm:p-6" : "p-0"
        } hover:shadow-md transition-shadow h-full overflow-visible`}
      >
        <div className={`flex flex-col ${isGrid ? "gap-4 h-full" : "sm:flex-row sm:items-stretch gap-0"}`}>
          {/* Asset Image */}
          <div
            className={`relative w-full aspect-video ${
              isGrid
                ? "sm:aspect-video sm:w-full sm:h-auto rounded-lg"
                : "sm:basis-56 sm:w-56 sm:min-w-56 sm:max-w-56 sm:self-stretch sm:aspect-auto rounded-none sm:rounded-l-2xl sm:rounded-r-none"
            } flex-shrink-0 bg-base-200 overflow-hidden`}
          >
            {asset.imageUrl ? (
              <Image src={asset.imageUrl} alt={getAssetDisplayName(asset)} fill className="object-cover" unoptimized />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-base-content/30">
                <span className="text-2xl sm:text-3xl">{ASSET_REGISTRIES[asset.type].icon}</span>
              </div>
            )}
          </div>

          {/* Asset Info */}
          <div className={`flex-1 min-w-0 ${isGrid ? "" : "p-4 sm:py-6 sm:pl-6 sm:pr-2"}`}>
            <div className="flex items-center gap-2">
              <div className="text-xs sm:text-sm opacity-50 uppercase tracking-widest font-semibold">{asset.type}</div>
              {asset.assetStatus === 3 && <span className="badge badge-sm badge-warning">Suspended</span>}
              {asset.assetStatus === 4 && <span className="badge badge-sm badge-warning">Expired</span>}
              {asset.assetStatus === 5 && <span className="badge badge-sm badge-ghost">Retired</span>}
            </div>
            <div
              className={`font-bold text-lg sm:text-xl ${
                isGrid ? "line-clamp-2 min-h-[3.75rem] leading-tight" : "truncate"
              }`}
            >
              {getAssetDisplayName(asset)}
            </div>
            {isGrid ? (
              <div className="space-y-3">
                <div className="text-xs opacity-60 space-y-1">
                  {asset.vin && <div className="truncate">{`VIN: ${asset.vin}`}</div>}
                  {!asset.hasPrimaryPool && <div className="truncate">Setup pending</div>}
                </div>
                {asset.hasPrimaryPool && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-base-200 px-3 py-2">
                      <div className="text-[10px] uppercase tracking-wide opacity-60">Circulating</div>
                      <div className="text-sm font-semibold">{circulatingSupply.toLocaleString()}</div>
                    </div>
                    <div className="rounded-lg bg-base-200 px-3 py-2">
                      <div className="text-[10px] uppercase tracking-wide opacity-60">Max Supply</div>
                      <div className="text-sm font-semibold">
                        {hasMaxSupply ? asset.maxSupply!.toLocaleString() : "—"}
                      </div>
                    </div>
                    <div className="rounded-lg bg-base-200 px-3 py-2">
                      <div className="text-[10px] uppercase tracking-wide opacity-60">Available</div>
                      <div className="text-sm font-semibold">
                        {hasMaxSupply ? availableSupply.toLocaleString() : "—"}
                      </div>
                    </div>
                    <div className="rounded-lg bg-base-200 px-3 py-2">
                      <div className="text-[10px] uppercase tracking-wide opacity-60">Price</div>
                      <div className="text-sm font-semibold">{formattedPricePerToken}</div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-xs opacity-60 truncate">
                  {asset.vin ? `VIN: ${asset.vin}` : ""}
                  {!asset.hasPrimaryPool ? `${asset.vin ? " • " : ""}Setup pending` : ""}
                </div>
                {asset.hasPrimaryPool && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="rounded-lg bg-base-200 px-2.5 py-1.5">
                      <div className="text-[10px] uppercase tracking-wide opacity-60">Circulating</div>
                      <div className="text-xs font-semibold">{circulatingSupply.toLocaleString()}</div>
                    </div>
                    <div className="rounded-lg bg-base-200 px-2.5 py-1.5">
                      <div className="text-[10px] uppercase tracking-wide opacity-60">Max Supply</div>
                      <div className="text-xs font-semibold">
                        {hasMaxSupply ? asset.maxSupply!.toLocaleString() : "—"}
                      </div>
                    </div>
                    <div className="rounded-lg bg-base-200 px-2.5 py-1.5">
                      <div className="text-[10px] uppercase tracking-wide opacity-60">Available</div>
                      <div className="text-xs font-semibold">
                        {hasMaxSupply ? availableSupply.toLocaleString() : "—"}
                      </div>
                    </div>
                    <div className="rounded-lg bg-base-200 px-2.5 py-1.5">
                      <div className="text-[10px] uppercase tracking-wide opacity-60">Price</div>
                      <div className="text-xs font-semibold">{formattedPricePerToken}</div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Actions - only render if primaryAction is provided */}
          {primaryAction && (
            <div
              className={`flex-shrink-0 flex gap-2 ${
                isGrid ? "mt-auto w-full" : "px-4 pb-4 sm:px-0 sm:pb-0 sm:pr-6 sm:pl-2 mt-2 sm:mt-0 sm:self-center"
              }`}
            >
              {visibleSecondaryActions.length > 0 ? (
                <div className={`flex items-stretch ${isGrid ? "w-full" : "w-full sm:w-auto"}`}>
                  <button
                    className={`${primaryAction.className} rounded-r-none border-r-base-100 ${isGrid ? "flex-1" : "flex-1 sm:flex-none"}`}
                    onClick={primaryAction.onClick}
                  >
                    {primaryAction.label}
                  </button>
                  <div ref={dropdownRef} className="dropdown dropdown-end">
                    <div
                      tabIndex={0}
                      role="button"
                      className={`${primaryAction.className} rounded-l-none px-2 flex items-center`}
                    >
                      <ChevronDownIcon className="h-5 w-5" />
                    </div>
                    <ul
                      tabIndex={0}
                      className="dropdown-content z-[50] menu p-2 shadow bg-base-100 rounded-2xl border border-base-300 w-56 mt-2"
                    >
                      {nonDestructiveActions.map((action, idx) => (
                        <li key={`normal-${idx}`}>
                          <a onClick={action.onClick} className="rounded-xl text-sm font-medium">
                            {action.label}
                          </a>
                        </li>
                      ))}
                      {destructiveActions.length > 0 && (
                        <>
                          {nonDestructiveActions.length > 0 && (
                            <li className="menu-title px-0 py-1">
                              <span className="divider my-0 opacity-40" />
                            </li>
                          )}
                          <li className="menu-title px-3 pb-1 pt-2">
                            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-base-content/45">
                              Destructive
                            </span>
                          </li>
                          {destructiveActions.map((action, idx) => (
                            <li key={`destructive-${idx}`}>
                              <a
                                onClick={action.onClick}
                                className="rounded-xl text-sm font-medium text-error hover:bg-error/10 focus:bg-error/10"
                              >
                                {action.label}
                              </a>
                            </li>
                          ))}
                        </>
                      )}
                    </ul>
                  </div>
                </div>
              ) : (
                <button className={`${primaryAction.className} w-full sm:w-auto`} onClick={primaryAction.onClick}>
                  {primaryAction.label}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  // Section Component
  const Section = ({
    title,
    count,
    badgeClass,
    borderClass,
    children,
    viewMode,
  }: {
    title: string;
    count: number;
    badgeClass: string;
    borderClass: string;
    children: React.ReactNode;
    viewMode: "list" | "grid";
  }) => (
    <section className="space-y-4 sm:space-y-6">
      <h2 className={`text-xl sm:text-2xl font-bold border-b ${borderClass} pb-3 flex items-center gap-3`}>
        {title} <span className={`badge ${badgeClass} badge-md`}>{count}</span>
      </h2>
      <div
        className={`grid gap-3 sm:gap-4 w-full ${
          viewMode === "grid" ? "grid-cols-1 md:grid-cols-2 xl:grid-cols-3" : "grid-cols-1"
        }`}
      >
        {children}
      </div>
    </section>
  );

  return (
    <div className="flex flex-col gap-8 py-8 px-4 sm:px-6 lg:px-8 w-full max-w-full lg:max-w-[75%] 2xl:max-w-[80%] mx-auto">
      {/* Header & Global Actions */}
      <div className="flex flex-col gap-3 sm:gap-4">
        {/* Title row with CTA */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold">Partner Dashboard</h1>
              <div className="dropdown dropdown-end">
                <div
                  tabIndex={0}
                  role="button"
                  className="flex items-center gap-2 text-sm opacity-70 px-2 py-1 rounded-full border border-base-300 hover:border-base-400 transition-colors"
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-success"></span>
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
            <p className="opacity-70 text-lg mt-2">{dashboardSubtitle}</p>
          </div>

          <div className="flex">
            <button
              className="btn btn-primary rounded-r-none border-r-base-100"
              onClick={() => {
                setIsRegisterOpen(true);
                setMaxStep(3);
              }}
            >
              Launch Offering
            </button>
            <div className="dropdown sm:dropdown-end">
              <div tabIndex={0} role="button" className="btn btn-primary rounded-l-none px-2 min-h-0 h-full">
                <ChevronDownIcon className="h-5 w-5" />
              </div>
              <ul tabIndex={0} className="dropdown-content z-[1] menu p-2 shadow bg-base-100 rounded-box w-52 mt-2">
                <li>
                  <a
                    onClick={() => {
                      setIsRegisterOpen(true);
                      setMaxStep(1);
                    }}
                  >
                    Register Only
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* Filters container - stacked on mobile, inline on desktop, wraps if needed */}
        <div className="flex flex-col gap-3 bg-base-200 rounded-xl p-4">
          <div className="flex flex-col lg:flex-row lg:flex-wrap lg:items-center lg:justify-between gap-3 lg:gap-6">
            {/* Asset Type Filter */}
            {!isSingleAssetType && (
              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <span className="text-xs font-bold uppercase opacity-50 lg:hidden">Asset Type</span>
                <div className="join bg-base-200 p-1 rounded-lg flex-wrap">
                  <button
                    className={`btn btn-sm join-item ${filterType === "ALL" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setFilterType("ALL")}
                  >
                    All
                  </button>
                  {Object.entries(ASSET_REGISTRIES)
                    .filter(([, r]) => r.active)
                    .map(([key, registry]) => (
                      <button
                        key={key}
                        className={`btn btn-sm join-item ${filterType === key ? "btn-primary" : "btn-ghost"}`}
                        onClick={() => setFilterType(key as AssetType)}
                      >
                        {registry.pluralName}
                      </button>
                    ))}
                </div>
              </div>
            )}

            {/* Separator - desktop only */}
            {!isSingleAssetType && <div className="hidden lg:block w-px h-6 bg-base-300" />}

            {/* Section State Filter */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 lg:ml-auto">
              <span className="text-xs font-bold uppercase opacity-50 lg:hidden">Status</span>
              <div className="join w-full bg-base-200 p-1 rounded-lg sm:w-auto">
                <button
                  className={`btn btn-xs sm:btn-sm join-item flex-1 sm:flex-none px-2 sm:px-3 text-[11px] sm:text-sm ${
                    filterState === "ALL" ? "btn-primary" : "btn-ghost"
                  }`}
                  onClick={() => setFilterState("ALL")}
                >
                  All
                </button>
                <button
                  className={`btn btn-xs sm:btn-sm join-item flex-1 sm:flex-none px-2 sm:px-3 text-[11px] sm:text-sm ${
                    filterState === "PENDING_LISTINGS" ? "btn-primary" : "btn-ghost"
                  }`}
                  onClick={() => setFilterState("PENDING_LISTINGS")}
                >
                  <span className="sm:hidden">Setup</span>
                  <span className="hidden sm:inline">Needs Setup</span>
                </button>
                <button
                  className={`btn btn-xs sm:btn-sm join-item flex-1 sm:flex-none px-2 sm:px-3 text-[11px] sm:text-sm ${
                    filterState === "ACTIVE_FLEET" ? "btn-primary" : "btn-ghost"
                  }`}
                  onClick={() => setFilterState("ACTIVE_FLEET")}
                >
                  <span className="sm:hidden">Offers</span>
                  <span className="hidden sm:inline">Offerings</span>
                </button>
                <button
                  className={`btn btn-xs sm:btn-sm join-item flex-1 sm:flex-none px-2 sm:px-3 text-[11px] sm:text-sm ${
                    filterState === "ACTIVE_LISTINGS" ? "btn-primary" : "btn-ghost"
                  }`}
                  onClick={() => setFilterState("ACTIVE_LISTINGS")}
                >
                  <span className="sm:hidden">Listings</span>
                  <span className="hidden sm:inline">Secondary</span>
                </button>
                <button
                  className={`btn btn-xs sm:btn-sm join-item flex-1 sm:flex-none px-2 sm:px-3 text-[11px] sm:text-sm ${
                    filterState === "SETTLED" ? "btn-primary" : "btn-ghost"
                  }`}
                  onClick={() => setFilterState("SETTLED")}
                >
                  Settled
                </button>
              </div>
            </div>

            {/* View Mode Switcher - Hidden on mobile */}
            <div className="hidden lg:flex items-center gap-2 bg-base-200 p-1 rounded-lg">
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

      {/* Pending Proceeds Banner */}
      {hasPendingWithdrawal && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-5 rounded-2xl bg-gradient-to-br from-success/5 to-success/10 border border-success/20 mb-8 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-white shadow-sm flex items-center justify-center shrink-0 text-success border border-success/10">
              <CurrencyDollarIcon className="w-6 h-6" />
            </div>
            <div>
              <div className="text-sm font-medium opacity-60">Pending Sales Proceeds</div>
              <div className="text-2xl font-bold flex items-baseline gap-1.5">
                {Number(pendingWithdrawalDisplay).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
                <span className="text-base font-semibold text-success">({symbol})</span>
              </div>
            </div>
          </div>
          <button
            className="btn btn-success text-white w-full sm:w-auto px-6 shadow-md shadow-success/20 hover:shadow-lg hover:shadow-success/30 transition-all rounded-xl"
            onClick={() => setWithdrawProceedsModalOpen(true)}
          >
            Withdraw Now
          </button>
        </div>
      )}

      {/* Main Content Area */}
      {totalAssets === 0 ? (
        /* EMPTY STATE */
        <div className="hero bg-base-200 rounded-2xl sm:rounded-3xl py-12 sm:py-20 px-6 sm:px-10 border-2 border-dashed border-base-300">
          <div className="hero-content text-center">
            <div className="max-w-md">
              <h2 className="text-2xl sm:text-3xl font-bold">
                {isSingleAssetType
                  ? `Start Your ${activeRegistries[0].name} ${activeRegistries[0].collectiveNoun.charAt(0).toUpperCase() + activeRegistries[0].collectiveNoun.slice(1)}`
                  : "Start Your Asset Portfolio"}
              </h2>
              <p className="py-4 sm:py-6 text-base sm:text-lg opacity-80">
                {isSingleAssetType
                  ? `You haven't registered any ${activeRegistries[0].pluralName.toLowerCase()} yet.`
                  : "You haven't registered any assets yet. Register an asset and create an offering to start issuing claim units."}
              </p>
              <div className="flex justify-center">
                <button
                  className="btn btn-primary sm:btn-lg rounded-r-none border-r-base-100"
                  onClick={() => {
                    setIsRegisterOpen(true);
                    setMaxStep(3);
                  }}
                >
                  Launch Your First Offering
                </button>
                <div className="dropdown sm:dropdown-end">
                  <div
                    tabIndex={0}
                    role="button"
                    className="btn btn-primary sm:btn-lg rounded-l-none px-2 sm:px-3 min-h-0 h-full"
                  >
                    <ChevronDownIcon className="h-5 w-5" />
                  </div>
                  <ul tabIndex={0} className="dropdown-content z-[1] menu p-2 shadow bg-base-100 rounded-box w-52 mt-2">
                    <li>
                      <a
                        onClick={() => {
                          setIsRegisterOpen(true);
                          setMaxStep(1);
                        }}
                      >
                        Register Only
                      </a>
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-8 sm:gap-12">
          {/* LIVE OFFERINGS - Assets with a primary pool */}
          {activeFleet.length > 0 && (filterState === "ALL" || filterState === "ACTIVE_FLEET") && (
            <Section
              title="Live Offerings"
              count={activeFleet.length}
              badgeClass="badge-success"
              borderClass="border-success/30"
              viewMode={viewMode}
            >
              {activeFleet.map(asset =>
                (() => {
                  const maturityDate = assetMaturityDateById.get(asset.id) ?? 0n;
                  const isMaturedByTime = maturityDate > 0n && Number(maturityDate) <= chainNowSec;
                  const isMatured = isMaturedByTime;
                  const tokenId = BigInt(asset.id) + 1n;
                  const isPoolPaused = !!asset.primaryPoolPaused;
                  const isPoolClosed = !!asset.primaryPoolClosed;
                  const isEarningEnabled = asset.assetStatus === 2;
                  const bufferFundingDue = asset.bufferFundingDue ?? 0n;
                  const partnerTokenBalance = asset.partnerTokenBalance ?? 0n;
                  const distributeAction = {
                    label: "Send Payout",
                    onClick: () => {
                      setSelectedCategorizedAsset(asset);
                      setDistributeEarningsModalOpen(true);
                    },
                    className: payoutGhostActionClass,
                  };
                  const enableProceedsAction = {
                    label: "Unlock Proceeds",
                    onClick: () => {
                      setSelectedCategorizedAsset(asset);
                      setEnableProceedsModalOpen(true);
                    },
                    className:
                      "btn bg-primary/10 text-primary border border-primary/20 hover:bg-primary/15 dark:bg-white/15 dark:text-white dark:border-white/20 dark:hover:bg-white/25",
                  };
                  const settleAction = {
                    label: "Begin Final Payout",
                    onClick: () => {
                      setSelectedCategorizedAsset(asset);
                      setSettleAssetModalOpen(true);
                    },
                    className: isMatured
                      ? "btn btn-primary bg-primary/10 text-primary border border-primary/20 hover:bg-primary/15 dark:bg-white/15 dark:text-white dark:border-white/20 dark:hover:bg-white/25"
                      : "btn btn-error",
                  };
                  const canEnableProceeds =
                    bufferFundingDue > 0n || (!!asset.immediateProceeds && (asset.primaryInvestorLiquidity ?? 0n) > 0n);
                  const pausePoolAction = {
                    label: "Pause Offering",
                    onClick: () => void updatePrimaryPoolState(tokenId, "pausePrimaryPool"),
                    className:
                      "btn bg-primary/10 text-primary border border-primary/20 hover:bg-primary/15 dark:bg-white/15 dark:text-white dark:border-white/20 dark:hover:bg-white/25",
                  };
                  const unpausePoolAction = {
                    label: "Resume Offering",
                    onClick: () => void updatePrimaryPoolState(tokenId, "unpausePrimaryPool"),
                    className:
                      "btn bg-primary/10 text-primary border border-primary/20 hover:bg-primary/15 dark:bg-white/15 dark:text-white dark:border-white/20 dark:hover:bg-white/25",
                  };
                  const closePoolAction = {
                    label: "Close Offering",
                    onClick: () => void updatePrimaryPoolState(tokenId, "closePrimaryPool"),
                    tone: "danger" as const,
                  };
                  const primaryAction = isMatured
                    ? settleAction
                    : canEnableProceeds
                      ? enableProceedsAction
                      : isEarningEnabled
                        ? distributeAction
                        : isPoolPaused
                          ? unpausePoolAction
                          : isPoolClosed
                            ? undefined
                            : pausePoolAction;
                  const secondaryActions = [
                    ...(partnerTokenBalance > 0n
                      ? [
                          {
                            label: "List for Sale",
                            onClick: () => openListModal(asset, partnerTokenBalance.toString()),
                          },
                        ]
                      : []),
                    ...(isEarningEnabled ? [{ ...distributeAction }] : []),
                    ...(canEnableProceeds ? [{ ...enableProceedsAction }] : []),
                    ...(!isPoolClosed ? [isPoolPaused ? unpausePoolAction : pausePoolAction, closePoolAction] : []),
                    ...(!isMatured ? [{ ...settleAction, tone: "danger" as const }] : []),
                  ];

                  return (
                    <AssetCard
                      key={asset.id}
                      asset={asset}
                      borderColor="border-success"
                      isGrid={viewMode === "grid"}
                      primaryAction={primaryAction}
                      secondaryActions={secondaryActions}
                    />
                  );
                })(),
              )}
            </Section>
          )}

          {/* LISTED FOR SALE - Listed on marketplace */}
          {activeListingsAssets.length > 0 && (filterState === "ALL" || filterState === "ACTIVE_LISTINGS") && (
            <Section
              title="Listed for Sale"
              count={activeListingsAssets.length}
              badgeClass="badge-info"
              borderClass="border-info/30"
              viewMode={viewMode}
            >
              {activeListingsAssets.map(asset => {
                // Determine actions based on listing state
                const listing = asset.listings && asset.listings.length > 0 ? asset.listings[0] : null;
                if (!listing) return null;

                const isSoldOut = listing.amount === "0";
                const isExpired = Number(listing.expiresAt) * 1000 < Date.now();
                const isUnsold = !listing.amountSold || listing.amountSold === "0";
                const hasClaimedTokens = (asset.totalClaimed ?? 0n) > 0n;

                let primaryAction;
                const secondaryActions = [];

                // Helper to set selected and open modal
                const openModal = (modalSetter: (open: boolean) => void) => {
                  setSelectedCategorizedAsset(asset);
                  setSelectedListing(listing);
                  modalSetter(true);
                };

                // Action definitions
                const actionEnd = { label: "End Listing", onClick: () => openModal(setEndSecondaryListingModalOpen) };
                const actionExtend = { label: "Extend Listing", onClick: () => openModal(setExtendListingModalOpen) };
                const actionDistribute = {
                  label: "Send Payout",
                  onClick: () => {
                    setSelectedCategorizedAsset(asset);
                    setDistributeEarningsModalOpen(true);
                  },
                  className: payoutGhostActionClass,
                };

                if (isSoldOut || isExpired) {
                  // Case 1: Sold Out or Expired -> Priority is to Settle/Finalize
                  primaryAction = {
                    ...actionEnd,
                    className: "btn btn-primary",
                  };
                  secondaryActions.push(actionEnd);
                } else {
                  // Case 2: Active (regardless of sales) -> Priority is Extend Listing
                  primaryAction = {
                    ...actionExtend,
                    className:
                      "btn bg-primary/10 text-primary border border-primary/20 hover:bg-primary/15 " +
                      "dark:bg-white/15 dark:text-white dark:border-white/20 dark:hover:bg-white/25",
                  };

                  if (hasClaimedTokens) {
                    secondaryActions.push(actionDistribute);
                  }
                  if (isUnsold) {
                    // No sales: End
                    secondaryActions.push(actionEnd);
                  } else {
                    // Partial sales: End
                    secondaryActions.push(actionEnd);
                  }
                }

                return (
                  <AssetCard
                    key={asset.id}
                    asset={asset}
                    borderColor="border-info"
                    isGrid={viewMode === "grid"}
                    primaryAction={primaryAction}
                    secondaryActions={secondaryActions}
                  />
                );
              })}
            </Section>
          )}

          {/* NEEDS SETUP - Registered assets without a live primary pool */}
          {pendingListings.length > 0 && (filterState === "ALL" || filterState === "PENDING_LISTINGS") && (
            <Section
              title="Needs Setup"
              count={pendingListings.length}
              badgeClass="badge-warning"
              borderClass="border-warning/30"
              viewMode={viewMode}
            >
              {pendingListings.map(asset => (
                <AssetCard
                  key={asset.id}
                  asset={asset}
                  borderColor="border-warning"
                  isGrid={viewMode === "grid"}
                  primaryAction={
                    asset.supply && asset.supply > 0n
                      ? {
                          label: "List for Sale",
                          onClick: () => openListModal(asset, asset.supply?.toString()),
                          className:
                            "btn bg-primary/10 text-primary border border-primary/20 hover:bg-primary/15 dark:bg-white/15 dark:text-white dark:border-white/20 dark:hover:bg-white/25",
                        }
                      : {
                          label: "Launch Offering",
                          onClick: () => openCreateRevenueTokenPoolModal(asset),
                          className:
                            "btn bg-primary/10 text-primary border border-primary/20 hover:bg-primary/15 dark:bg-white/15 dark:text-white dark:border-white/20 dark:hover:bg-white/25",
                        }
                  }
                />
              ))}
            </Section>
          )}

          {/* SETTLED - Assets that have been retired or settled */}
          {settledAssets.length > 0 && (filterState === "ALL" || filterState === "SETTLED") && (
            <Section
              title="Settled Assets"
              count={settledAssets.length}
              badgeClass="badge-ghost"
              borderClass="border-base-300"
              viewMode={viewMode}
            >
              {settledAssets.map(asset => (
                <AssetCard key={asset.id} asset={asset} borderColor="border-base-300" isGrid={viewMode === "grid"} />
              ))}
            </Section>
          )}
        </div>
      )}

      {/* Modals */}
      <RegisterAssetModal
        isOpen={isRegisterOpen}
        onSuccess={handleFlowSuccess}
        onClose={() => {
          setIsRegisterOpen(false);
          refreshOnModalClose();
        }}
        maxStep={maxStep}
      />

      {selectedAsset && selectedAsset.type === AssetType.VEHICLE && (
        <CreateRevenueTokenPoolModal
          isOpen={createRevenueTokenPoolModalOpen}
          onSuccess={handleFlowSuccess}
          onClose={() => {
            setCreateRevenueTokenPoolModalOpen(false);
            refreshOnModalClose();
          }}
          vehicleId={selectedAsset.id}
          assetValue={selectedAsset.assetValue || "0"}
        />
      )}

      {selectedAsset && selectedAsset.type === AssetType.VEHICLE && (
        <CreateSecondaryListingModal
          isOpen={createSecondaryListingModalOpen}
          onSuccess={handleFlowSuccess}
          onClose={() => {
            setCreateSecondaryListingModalOpen(false);
            setListPrefillAmount(undefined);
            refreshOnModalClose();
          }}
          vehicleId={selectedAsset.id}
          vin={selectedAsset.vin || ""}
          assetName={getAssetDisplayName(selectedAsset)}
          prefillAmount={listPrefillAmount}
        />
      )}

      {/* New Lifecycle Modals */}
      {selectedCategorizedAsset && (
        <>
          <DistributeEarningsModal
            isOpen={distributeEarningsModalOpen}
            onSuccess={() => {
              refetchPending();
              // Extra refresh for eventual consistency after collateral auto-release accounting updates.
              setTimeout(() => {
                refetchPending();
              }, 1500);
            }}
            onClose={() => {
              setDistributeEarningsModalOpen(false);
              triggerRefresh();
            }}
            assetId={selectedCategorizedAsset.id}
            assetName={getAssetDisplayName(selectedCategorizedAsset)}
            maxSupply={selectedCategorizedAsset.maxSupply ?? 0n}
            immediateProceeds={!!selectedCategorizedAsset.immediateProceeds}
          />
          <EnableProceedsModal
            isOpen={enableProceedsModalOpen}
            onSuccess={handleFlowSuccess}
            onClose={() => {
              setEnableProceedsModalOpen(false);
              refreshOnModalClose();
            }}
            assetId={selectedCategorizedAsset.id}
            assetName={getAssetDisplayName(selectedCategorizedAsset)}
            immediateProceeds={!!selectedCategorizedAsset.immediateProceeds}
            protectionEnabled={!!selectedCategorizedAsset.protectionEnabled}
          />
          <SettleAssetModal
            isOpen={settleAssetModalOpen}
            onClose={() => {
              setSettleAssetModalOpen(false);
              triggerRefresh();
            }}
            assetId={selectedCategorizedAsset.id}
            assetName={getAssetDisplayName(selectedCategorizedAsset)}
          />
        </>
      )}

      {selectedListing && (
        <>
          <ExtendListingModal
            isOpen={extendListingModalOpen}
            onClose={() => {
              setExtendListingModalOpen(false);
              triggerRefresh();
            }}
            listingId={selectedListing.id}
            currentExpiresAt={BigInt(selectedListing.expiresAt)}
          />
          <EndSecondaryListingModal
            isOpen={endSecondaryListingModalOpen}
            onClose={() => {
              setEndSecondaryListingModalOpen(false);
              refetchPending();
              triggerRefresh();
            }}
            listingId={selectedListing.id}
            tokenAmount={selectedListing.amount}
          />
        </>
      )}

      <WithdrawProceedsModal
        isOpen={withdrawProceedsModalOpen}
        onClose={() => {
          setWithdrawProceedsModalOpen(false);
          refetchPending();
        }}
      />
    </div>
  );
};

export default PartnerDashboard;
