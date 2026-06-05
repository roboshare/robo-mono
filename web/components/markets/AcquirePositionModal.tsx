"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { Address, encodeFunctionData, erc20Abi, formatUnits, parseEventLogs, parseUnits } from "viem";
import { usePublicClient, useReadContract } from "wagmi";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { AccountIdentityCard } from "~~/components/scaffold-eth";
import { ModalAuthActionButton } from "~~/components/scaffold-eth/ModalAuthActionButton";
import { calculateProtocolFee } from "~~/config/protocol";
import { useScaffoldReadContract, useScaffoldWriteContract, useSelectedNetwork } from "~~/hooks/scaffold-eth";
import { useAtomicCalls } from "~~/hooks/useAtomicCalls";
import { usePaymentToken } from "~~/hooks/usePaymentToken";
import { usePaymentTokenWriteContract } from "~~/hooks/usePaymentTokenWriteContract";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import { isPrivyEnabled } from "~~/services/web3/privyConfig";
import { getPrivyIdentityLabel } from "~~/services/web3/privyIdentity";
import { getDeployedContract } from "~~/utils/contracts";

interface SecondaryPurchaseTarget {
  kind: "secondary";
  listing: {
    id: string;
    tokenId: string;
    assetId: string;
    pricePerToken: string;
    amount: string;
    seller: string;
    buyerPaysFee?: boolean;
  };
}

interface PrimaryPurchaseTarget {
  kind: "primary";
  pool: {
    id: string;
    tokenId: string;
    assetId: string;
    pricePerToken: string;
    maxSupply: string;
    partner: string;
  };
  currentSupply?: string;
}

interface AcquirePositionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPurchaseComplete?: (id: string) => void;
  purchaseTarget: SecondaryPurchaseTarget | PrimaryPurchaseTarget;
  totalSupply?: string;
  vehicleName?: string;
  partnerName?: string;
  listedTokens?: string;
}

const PERCENTAGE_OPTIONS = [25, 50, 75, 100];

const calculateTotalPayment = (principal: bigint, buyerPaysFee: boolean) => {
  if (!buyerPaysFee || principal === 0n) {
    return principal;
  }
  return principal + calculateProtocolFee(principal);
};

const shortenAddress = (address: Address) => `${address.slice(0, 6)}...${address.slice(-4)}`;

const PrivyAvailableBalanceCard = ({
  address,
  formattedBalance,
  paymentTokenPillClass,
  symbol,
}: {
  address: Address;
  formattedBalance: string;
  paymentTokenPillClass: string;
  symbol: string;
}) => {
  const { user } = usePrivy();
  const shortAddress = shortenAddress(address);
  const accountLabel = getPrivyIdentityLabel({ address, user }) || shortAddress;

  return (
    <div className="space-y-1">
      <span className="text-sm opacity-70">Your Available Balance</span>
      <AccountIdentityCard
        address={address}
        primaryLabel={accountLabel}
        secondaryLabel={accountLabel !== shortAddress ? shortAddress : undefined}
        aside={
          <div className="flex items-center gap-2 font-mono">
            {Number(formattedBalance).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            <span className={paymentTokenPillClass}>{symbol}</span>
          </div>
        }
      />
    </div>
  );
};

const AvailableBalanceCard = ({
  address,
  formattedBalance,
  paymentTokenPillClass,
  symbol,
}: {
  address?: Address;
  formattedBalance: string;
  paymentTokenPillClass: string;
  symbol: string;
}) => {
  if (!address) {
    return (
      <div className="flex items-center justify-between rounded-xl border border-base-300 bg-base-100 px-4 py-3">
        <span className="text-sm opacity-70">Your Available Balance</span>
        <span className="flex items-center gap-2 font-mono">
          {Number(formattedBalance).toLocaleString(undefined, { minimumFractionDigits: 2 })}
          <span className={paymentTokenPillClass}>{symbol}</span>
        </span>
      </div>
    );
  }

  if (isPrivyEnabled()) {
    return (
      <PrivyAvailableBalanceCard
        address={address}
        formattedBalance={formattedBalance}
        paymentTokenPillClass={paymentTokenPillClass}
        symbol={symbol}
      />
    );
  }

  const shortAddress = shortenAddress(address);

  return (
    <div className="space-y-1">
      <span className="text-sm opacity-70">Your Available Balance</span>
      <AccountIdentityCard
        address={address}
        primaryLabel={shortAddress}
        aside={
          <div className="flex items-center gap-2 font-mono">
            {Number(formattedBalance).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            <span className={paymentTokenPillClass}>{symbol}</span>
          </div>
        }
      />
    </div>
  );
};

const getMaxAffordableTokenAmount = ({
  availableAmount,
  buyerPaysFee,
  paymentTokenBalance,
  unitPriceRaw,
}: {
  availableAmount: bigint;
  buyerPaysFee: boolean;
  paymentTokenBalance: bigint;
  unitPriceRaw: bigint;
}) => {
  if (availableAmount === 0n || paymentTokenBalance === 0n || unitPriceRaw === 0n) {
    return 0n;
  }

  let low = 0n;
  let high = availableAmount;

  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    const principal = mid * unitPriceRaw;
    const totalPayment = calculateTotalPayment(principal, buyerPaysFee);
    if (totalPayment > paymentTokenBalance) {
      high = mid - 1n;
    } else {
      low = mid;
    }
  }

  return low;
};

export function AcquirePositionModal({
  isOpen,
  onClose,
  onPurchaseComplete,
  purchaseTarget,
  totalSupply,
  vehicleName = "Asset",
  partnerName,
  listedTokens,
}: AcquirePositionModalProps) {
  const { address: connectedAddress } = useTransactingAccount();
  const selectedNetwork = useSelectedNetwork();
  const chainId = selectedNetwork.id;
  const { address: paymentTokenAddress, symbol, decimals } = usePaymentToken();
  const [inputAmount, setInputAmount] = useState("");
  const [step, setStep] = useState<"input" | "approving" | "purchasing" | "success" | "expired" | "error">("input");
  const [error, setError] = useState<string | null>(null);

  const marketplaceContract = getDeployedContract(chainId, "Marketplace");
  const marketplaceAddress = marketplaceContract?.address;
  const marketplaceAbi = marketplaceContract?.abi;
  const publicClient = usePublicClient({ chainId });

  const tokenId = purchaseTarget.kind === "secondary" ? purchaseTarget.listing.tokenId : purchaseTarget.pool.tokenId;
  const unitPrice =
    purchaseTarget.kind === "secondary" ? purchaseTarget.listing.pricePerToken : purchaseTarget.pool.pricePerToken;
  const unitPriceRaw = BigInt(unitPrice);
  const isPrimaryPurchase = purchaseTarget.kind === "primary";
  const availableAmount =
    purchaseTarget.kind === "secondary"
      ? BigInt(purchaseTarget.listing.amount)
      : (() => {
          const maxSupply = BigInt(purchaseTarget.pool.maxSupply);
          const currentSupply = BigInt(purchaseTarget.currentSupply || "0");
          return maxSupply > currentSupply ? maxSupply - currentSupply : 0n;
        })();
  const buyerPaysFee = purchaseTarget.kind === "secondary" ? (purchaseTarget.listing.buyerPaysFee ?? true) : true;
  const { isPending: isBatchPurchasing, sendAtomicCalls, supportsAtomicBatch, transactingAddress } = useAtomicCalls();
  const accountAddress = transactingAddress ?? connectedAddress;

  const { data: paymentTokenBalance } = useReadContract({
    chainId,
    address: paymentTokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: accountAddress ? [accountAddress] : undefined,
    query: { enabled: !!paymentTokenAddress && !!accountAddress },
  });

  const { data: userTokenBalance, refetch: refetchTokenBalance } = useScaffoldReadContract({
    contractName: "RoboshareTokens",
    functionName: "balanceOf",
    args: [accountAddress, BigInt(tokenId)],
    query: { enabled: !!accountAddress },
  });

  const totalUserTokens = userTokenBalance || 0n;
  const listedTokensCount = useMemo(() => {
    try {
      return listedTokens ? BigInt(listedTokens) : 0n;
    } catch {
      return 0n;
    }
  }, [listedTokens]);

  const { data: paymentTokenAllowance, refetch: refetchAllowance } = useReadContract({
    chainId,
    address: paymentTokenAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: accountAddress && marketplaceAddress ? [accountAddress, marketplaceAddress] : undefined,
    query: { enabled: !!paymentTokenAddress && !!accountAddress && !!marketplaceAddress },
  });

  const secondaryInputAmount = useMemo(() => {
    if (!inputAmount || !/^\d+$/.test(inputAmount)) return 0n;
    try {
      return BigInt(inputAmount);
    } catch {
      return 0n;
    }
  }, [inputAmount]);

  const secondaryPurchasePreview = useScaffoldReadContract({
    contractName: "Marketplace",
    functionName: "previewSecondaryPurchase",
    args: purchaseTarget.kind === "secondary" ? [BigInt(purchaseTarget.listing.id), secondaryInputAmount] : [0n, 0n],
    query: { enabled: purchaseTarget.kind === "secondary" },
  });

  const { writeContractAsync: approvePaymentToken, isPending: isApproving } = usePaymentTokenWriteContract();

  const { writeContractAsync: submitPurchase, isPending: isPurchasing } = useScaffoldWriteContract({
    contractName: "Marketplace",
  });

  const maxTokens = useMemo(() => {
    if (!paymentTokenBalance) return 0n;
    return getMaxAffordableTokenAmount({
      availableAmount,
      buyerPaysFee,
      paymentTokenBalance,
      unitPriceRaw,
    });
  }, [availableAmount, buyerPaysFee, paymentTokenBalance, unitPriceRaw]);

  const maxPrimaryContributionRaw = useMemo(() => {
    if (!isPrimaryPurchase) return 0n;
    return maxTokens * unitPriceRaw;
  }, [isPrimaryPurchase, maxTokens, unitPriceRaw]);

  const primaryContributionRaw = useMemo(() => {
    if (!isPrimaryPurchase || !inputAmount) return 0n;
    try {
      return parseUnits(inputAmount, decimals);
    } catch {
      return 0n;
    }
  }, [decimals, inputAmount, isPrimaryPurchase]);

  const purchaseAmount = useMemo(() => {
    if (!inputAmount) return 0n;
    if (!isPrimaryPurchase) return secondaryInputAmount;
    if (unitPriceRaw === 0n) return 0n;
    return primaryContributionRaw / unitPriceRaw;
  }, [inputAmount, isPrimaryPurchase, primaryContributionRaw, secondaryInputAmount, unitPriceRaw]);

  const primaryPurchasePreview = useScaffoldReadContract({
    contractName: "Marketplace",
    functionName: "previewPrimaryPurchase",
    args: [BigInt(tokenId), purchaseAmount],
    query: { enabled: isPrimaryPurchase },
  });

  const totalCost = (isPrimaryPurchase ? primaryPurchasePreview.data?.[0] : secondaryPurchasePreview.data?.[0]) ?? 0n;
  const protocolFee = (isPrimaryPurchase ? primaryPurchasePreview.data?.[1] : secondaryPurchasePreview.data?.[1]) ?? 0n;
  const expectedPayment =
    purchaseTarget.kind === "secondary"
      ? (secondaryPurchasePreview.data?.[2] ?? 0n)
      : (primaryPurchasePreview.data?.[0] ?? 0n);
  const principalAmount = isPrimaryPurchase ? purchaseAmount * unitPriceRaw : totalCost;
  const formattedPrincipal = formatUnits(principalAmount, decimals);

  const needsApproval = useMemo(() => {
    if (!paymentTokenAllowance || !expectedPayment) return true;
    return paymentTokenAllowance < expectedPayment;
  }, [paymentTokenAllowance, expectedPayment]);

  const formattedBalance = paymentTokenBalance ? formatUnits(paymentTokenBalance, decimals) : "0";
  const formattedCost = formatUnits(totalCost, decimals);
  const formattedFee = formatUnits(protocolFee, decimals);
  const formattedTotal = formatUnits(expectedPayment, decimals);
  const pricePerTokenDisplay = formatUnits(BigInt(unitPrice), decimals);
  const formattedContribution = formatUnits(primaryContributionRaw, decimals);
  const maxContributionRaw = isPrimaryPurchase ? maxPrimaryContributionRaw : maxTokens * unitPriceRaw;
  const maxContributionDisplay = formatUnits(maxContributionRaw, decimals);
  const paymentTokenPillClass =
    "inline-flex items-center rounded-full border border-base-300 bg-base-100 px-2 py-0.5 text-[11px] font-semibold text-base-content/75";

  const handlePercentageSelect = useCallback(
    (percentage: number) => {
      if (isPrimaryPurchase) {
        const contribution = (maxContributionRaw * BigInt(percentage)) / 100n;
        setInputAmount(formatUnits(contribution, decimals));
        return;
      }
      const tokens = (maxTokens * BigInt(percentage)) / 100n;
      setInputAmount(tokens.toString());
    },
    [decimals, isPrimaryPurchase, maxContributionRaw, maxTokens],
  );

  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const percentage = parseInt(e.target.value);
      if (isPrimaryPurchase) {
        const contribution = (maxContributionRaw * BigInt(percentage)) / 100n;
        setInputAmount(formatUnits(contribution, decimals));
        return;
      }
      const tokens = (maxTokens * BigInt(percentage)) / 100n;
      setInputAmount(tokens.toString());
    },
    [decimals, isPrimaryPurchase, maxContributionRaw, maxTokens],
  );

  const currentPercentage = useMemo(() => {
    if (!inputAmount) return 0;
    if (isPrimaryPurchase) {
      if (maxContributionRaw === 0n || primaryContributionRaw === 0n) return 0;
      return Number((primaryContributionRaw * 100n) / maxContributionRaw);
    }
    if (maxTokens === 0n) return 0;
    return Number((secondaryInputAmount * 100n) / maxTokens);
  }, [inputAmount, isPrimaryPurchase, maxContributionRaw, maxTokens, primaryContributionRaw, secondaryInputAmount]);

  const handleBuy = async () => {
    if (!inputAmount || purchaseAmount === 0n) return;
    if (!marketplaceAddress) {
      setError("Marketplace address not found");
      return;
    }
    if (expectedPayment === 0n) {
      setError("Calculating payment amount...");
      return;
    }
    if (!paymentTokenAddress) {
      setError("Payment token not configured");
      return;
    }
    if (!marketplaceAbi) {
      setError("Marketplace ABI not found");
      return;
    }

    setError(null);

    try {
      const purchaseFunctionName =
        purchaseTarget.kind === "secondary" ? "buyFromSecondaryListing" : "buyFromPrimaryPool";
      const purchaseArgs =
        purchaseTarget.kind === "secondary"
          ? ([BigInt(purchaseTarget.listing.id), purchaseAmount] as const)
          : ([BigInt(purchaseTarget.pool.tokenId), purchaseAmount] as const);

      if (supportsAtomicBatch) {
        setStep("purchasing");
        const batchedCalls = [
          ...(needsApproval
            ? [
                {
                  data: encodeFunctionData({
                    abi: erc20Abi,
                    functionName: "approve",
                    args: [marketplaceAddress, expectedPayment],
                  }),
                  to: paymentTokenAddress,
                },
              ]
            : []),
          {
            data: encodeFunctionData({
              abi: marketplaceAbi,
              functionName: purchaseFunctionName,
              args: purchaseArgs,
            }),
            to: marketplaceAddress,
          },
        ] as const;

        const batchStatus = await sendAtomicCalls({ calls: batchedCalls });
        if (batchStatus.status !== "success") {
          throw new Error("Atomic purchase bundle failed");
        }

        if (purchaseTarget.kind === "secondary") {
          const logs = batchStatus.receipts?.flatMap(receipt => receipt.logs) ?? [];
          const tradeLogs = parseEventLogs({
            abi: marketplaceAbi,
            logs: logs as never,
            eventName: "RevenueTokensTraded",
            strict: false,
          });

          if (tradeLogs.length === 0) {
            const endedLogs = parseEventLogs({
              abi: marketplaceAbi,
              logs: logs as never,
              eventName: "ListingEnded",
              strict: false,
            });

            if (endedLogs.length > 0) {
              setStep("expired");
              await refetchTokenBalance();
              onPurchaseComplete?.("");
              return;
            }
          }
        }
      } else {
        if (needsApproval) {
          setStep("approving");
          await approvePaymentToken({ functionName: "approve", args: [marketplaceAddress, expectedPayment] });
          await refetchAllowance();
        }

        setStep("purchasing");
        if (purchaseTarget.kind === "secondary") {
          const txHash = await submitPurchase({
            functionName: "buyFromSecondaryListing",
            args: [BigInt(purchaseTarget.listing.id), purchaseAmount],
          });
          if (!txHash || !publicClient) {
            throw new Error("Could not verify purchase result");
          }

          const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
          const tradeLogs = parseEventLogs({
            abi: marketplaceAbi,
            logs: receipt.logs,
            eventName: "RevenueTokensTraded",
            strict: false,
          });

          if (tradeLogs.length === 0) {
            const endedLogs = parseEventLogs({
              abi: marketplaceAbi,
              logs: receipt.logs,
              eventName: "ListingEnded",
              strict: false,
            });

            if (endedLogs.length > 0) {
              setStep("expired");
              await refetchTokenBalance();
              onPurchaseComplete?.("");
              return;
            }
          }
        } else {
          await submitPurchase({
            functionName: "buyFromPrimaryPool",
            args: [BigInt(purchaseTarget.pool.tokenId), purchaseAmount],
          });
        }
      }

      setStep("success");
      await refetchTokenBalance();
      onPurchaseComplete?.(purchaseTarget.kind === "secondary" ? purchaseTarget.listing.id : purchaseTarget.pool.id);
    } catch (e: any) {
      const message = e.message || e.shortMessage || "Transaction failed";
      setError(message);
      setStep("error");
    }
  };

  useEffect(() => {
    if (!isOpen) {
      setInputAmount("");
      setStep("input");
      setError(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const hasValidAmount = purchaseAmount > 0n && purchaseAmount <= availableAmount;
  const hasInsufficientBalance = expectedPayment > (paymentTokenBalance ?? 0n);
  const successOwnershipBase = totalSupply ? BigInt(totalSupply) : 0n;
  const isBusy = step === "approving" || step === "purchasing" || isApproving || isPurchasing || isBatchPurchasing;
  const isSponsoredProcessing = supportsAtomicBatch && step === "purchasing";
  const requiresAuth = !accountAddress;

  return (
    <div className="modal modal-open">
      <div className="modal-backdrop bg-black/50 hidden sm:block" onClick={onClose} />
      <div className="modal-box relative w-full h-full max-h-full sm:h-auto sm:max-h-[90vh] sm:max-w-xl sm:rounded-2xl rounded-none flex flex-col p-0">
        <button
          className="btn btn-sm btn-circle btn-ghost absolute right-4 top-4 z-10"
          onClick={onClose}
          disabled={isBusy}
        >
          <XMarkIcon className="w-5 h-5" />
        </button>

        <div className="p-4 border-b border-base-200 shrink-0">
          <h3 className="font-bold text-xl">{purchaseTarget.kind === "primary" ? "Deposit" : "Buy Claim Units"}</h3>
          <p className="text-sm opacity-60 mt-1">{vehicleName}</p>
          {partnerName && <p className="text-xs opacity-50">by {partnerName}</p>}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {step === "success" ? (
            <div className="text-center text-base-content">
              <div className="text-6xl mb-4">🎉</div>
              <h4 className="text-xl font-bold text-success mb-2">
                {isPrimaryPurchase ? "Deposit Complete" : "Purchase Complete!"}
              </h4>
              <div className="alert text-sm mb-4 text-left bg-base-200/70 text-base-content border border-base-300">
                <span>
                  {isPrimaryPurchase
                    ? "Your deposit settled immediately. Your position in this offering is now active."
                    : "Your claim units settled immediately. They are now in your wallet and available for use or resale."}
                </span>
              </div>
              <p className="text-base-content/80 mb-4">
                {isPrimaryPurchase ? (
                  <>
                    You&apos;ve added{" "}
                    <span className="font-bold">
                      {Number(formattedContribution).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </span>{" "}
                    <span className={paymentTokenPillClass}>{symbol}</span> to the {vehicleName} offering.
                  </>
                ) : (
                  <>
                    You&apos;ve acquired <span className="font-bold">{purchaseAmount.toLocaleString()}</span> claim
                    units for {vehicleName}.
                  </>
                )}
              </p>
              {successOwnershipBase > 0n && (
                <div className="bg-base-100/70 dark:bg-base-100/15 border border-base-300/60 rounded-lg p-4 mb-4 text-base-content">
                  <div className="text-sm text-base-content/70 mb-1">
                    {isPrimaryPurchase ? "Position Added" : "This Purchase"}
                  </div>
                  <div className="text-2xl font-bold text-base-content">
                    {((Number(purchaseAmount) / Number(successOwnershipBase)) * 100).toFixed(2)}%
                  </div>
                  <div className="text-xs text-base-content/60">
                    of {purchaseTarget.kind === "primary" ? "this offering" : "total claim units"}
                  </div>
                </div>
              )}
              {successOwnershipBase > 0n && (
                <div className="bg-success/20 dark:bg-success/15 border border-success/30 rounded-lg p-4 text-base-content">
                  <div className="text-sm text-base-content/70 mb-1">
                    {isPrimaryPurchase ? "Your Total Position" : "Your Cumulative Holdings"}
                  </div>
                  <div className="text-2xl font-bold text-success">
                    {((Number(totalUserTokens + listedTokensCount) / Number(successOwnershipBase)) * 100).toFixed(2)}%
                  </div>
                  {isPrimaryPurchase ? (
                    <div className="text-xs text-base-content/60">of this offering&apos;s total claim units</div>
                  ) : (
                    <div className="text-xs text-base-content/60">
                      {Number(totalUserTokens + listedTokensCount).toLocaleString()} claim units
                    </div>
                  )}
                  {!isPrimaryPurchase && listedTokensCount > 0n && (
                    <div className="text-xs text-base-content/50">
                      {Number(listedTokensCount).toLocaleString()} listed claim units
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : step === "expired" ? (
            <div className="text-center text-base-content">
              <div className="text-6xl mb-4">⌛</div>
              <h4 className="text-xl font-bold text-warning mb-2">Listing Expired</h4>
              <div className="alert text-sm mb-4 text-left bg-base-200/70 text-base-content border border-base-300">
                <span>
                  The listing expired before your buy could execute. This transaction only cleaned up the listing.
                </span>
              </div>
              <p className="text-base-content/80 mb-4">
                No claim units were purchased and no buyer payment was collected.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {requiresAuth && (
                <div className="alert border border-base-300 bg-base-200/70 text-base-content">
                  <span className="text-sm">
                    Log in to load your wallet balance and continue with this
                    {isPrimaryPurchase ? " deposit" : " purchase"} without leaving the modal.
                  </span>
                </div>
              )}

              <div className="rounded-xl border border-base-300 bg-base-200 p-4">
                <div className="flex justify-between text-sm">
                  <span className="opacity-70">Price per Claim Unit:</span>
                  <span className="flex items-center gap-2 font-bold">
                    {Number(pricePerTokenDisplay).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    <span className={paymentTokenPillClass}>{symbol}</span>
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="opacity-70">Available:</span>
                  <span>{availableAmount.toLocaleString()} claim units</span>
                </div>
                {purchaseTarget.kind === "primary" && (
                  <div className="flex justify-between text-sm">
                    <span className="opacity-70">Issued Claim Units:</span>
                    <span>{BigInt(purchaseTarget.currentSupply || "0").toLocaleString()} claim units</span>
                  </div>
                )}
              </div>

              <AvailableBalanceCard
                address={accountAddress as Address | undefined}
                formattedBalance={formattedBalance}
                paymentTokenPillClass={paymentTokenPillClass}
                symbol={symbol}
              />

              <div className="form-control">
                <label className="label py-1">
                  <span className="label-text text-xs font-bold uppercase opacity-60">
                    {isPrimaryPurchase ? "Contribution" : "Amount to Buy"}
                  </span>
                  <span className="label-text-alt">
                    Max:{" "}
                    {isPrimaryPurchase
                      ? Number(maxContributionDisplay).toLocaleString(undefined, { minimumFractionDigits: 2 })
                      : maxTokens.toString()}
                  </span>
                </label>
                {isPrimaryPurchase ? (
                  <div className="flex w-full rounded-full border-2 border-base-300 bg-base-100 text-accent">
                    <input
                      type="number"
                      className="input input-ghost h-[2.2rem] min-h-[2.2rem] w-full border-0 px-4 font-medium text-base-content/70 placeholder:text-accent/70 focus:bg-transparent focus:outline-hidden focus-within:border-transparent focus:text-base-content/70"
                      placeholder="0.00"
                      value={inputAmount}
                      onChange={e => setInputAmount(e.target.value)}
                      max={maxContributionDisplay}
                      min="0"
                      step="0.01"
                      disabled={isBusy}
                    />
                    <span className="mr-1 flex items-center self-center rounded-full bg-base-300 px-3 py-1 text-xs font-medium text-base-content/80">
                      {symbol}
                    </span>
                  </div>
                ) : (
                  <input
                    type="number"
                    className="input input-bordered w-full rounded-full border-2 border-base-300 bg-base-100 font-medium text-base-content/70 placeholder:text-accent/70"
                    placeholder="0"
                    value={inputAmount}
                    onChange={e => setInputAmount(e.target.value)}
                    max={maxTokens.toString()}
                    min="0"
                    step="1"
                    disabled={isBusy}
                  />
                )}
              </div>

              {isPrimaryPurchase && (
                <div className="flex items-center justify-between rounded-xl border border-base-300 bg-base-100 px-4 py-3 text-sm">
                  <span className="opacity-70">Position Received</span>
                  <span className="font-mono">{purchaseAmount.toLocaleString()} claim units</span>
                </div>
              )}

              <div className="flex gap-2">
                {PERCENTAGE_OPTIONS.map(pct => (
                  <button
                    key={pct}
                    className={`btn btn-sm flex-1 ${currentPercentage === pct ? "btn-primary" : "btn-outline"}`}
                    onClick={() => handlePercentageSelect(pct)}
                    disabled={isBusy || maxTokens === 0n}
                  >
                    {pct}%
                  </button>
                ))}
              </div>

              <div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={currentPercentage}
                  onChange={handleSliderChange}
                  className="range range-primary range-sm w-full"
                  disabled={isBusy || maxTokens === 0n}
                />
                <div className="flex justify-between text-xs opacity-50 mt-1">
                  <span>0%</span>
                  <span>50%</span>
                  <span>100%</span>
                </div>
              </div>

              {hasValidAmount && (
                <div className="rounded-xl border border-base-300 bg-base-200 p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>{isPrimaryPurchase ? "Contribution" : "Subtotal"}</span>
                    <span className="flex items-center gap-2">
                      {Number(isPrimaryPurchase ? formattedPrincipal : formattedCost).toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                      })}
                      <span className={paymentTokenPillClass}>{symbol}</span>
                    </span>
                  </div>
                  <div className="flex justify-between text-sm opacity-70">
                    <span>Protocol Fee</span>
                    <span className="flex items-center gap-2">
                      {Number(formattedFee).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      <span className={paymentTokenPillClass}>{symbol}</span>
                    </span>
                  </div>
                  <div className="divider my-1"></div>
                  <div className="flex justify-between font-bold">
                    <span>Total</span>
                    <span className={`flex items-center gap-2 ${hasInsufficientBalance ? "text-error" : ""}`}>
                      {Number(formattedTotal).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      <span className={paymentTokenPillClass}>{symbol}</span>
                    </span>
                  </div>
                  {hasInsufficientBalance && (
                    <div className="text-xs text-error mt-1">Insufficient {symbol} balance</div>
                  )}
                </div>
              )}

              {error && (
                <div className="alert alert-error">
                  <span className="text-sm">{error}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-base-200 bg-base-100 p-4">
          <div className="flex gap-3">
            {step === "success" || step === "expired" ? (
              <button className="btn btn-primary flex-1" onClick={onClose}>
                Done
              </button>
            ) : (
              <>
                <button className="btn btn-ghost flex-1" onClick={onClose} disabled={isBusy}>
                  Cancel
                </button>
                {requiresAuth ? (
                  <ModalAuthActionButton className="btn btn-primary flex-1" />
                ) : (
                  <button
                    className="btn btn-primary flex-1"
                    onClick={handleBuy}
                    disabled={Boolean(isBusy || !hasValidAmount || hasInsufficientBalance)}
                  >
                    {isApproving ? (
                      <>
                        <span className="loading loading-spinner loading-sm"></span>Approving...
                      </>
                    ) : isSponsoredProcessing ? (
                      <>
                        <span className="loading loading-spinner loading-sm"></span>Processing...
                      </>
                    ) : isPurchasing ? (
                      <>
                        <span className="loading loading-spinner loading-sm"></span>Completing...
                      </>
                    ) : needsApproval ? (
                      isPrimaryPurchase ? (
                        "Approve & Deposit"
                      ) : (
                        "Approve & Buy"
                      )
                    ) : purchaseTarget.kind === "primary" ? (
                      "Deposit"
                    ) : (
                      "Buy Claim Units"
                    )}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
