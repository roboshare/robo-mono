"use client";

import { useEffect, useMemo, useState } from "react";
import { useEscClose } from "./useEscClose";
import { erc20Abi, parseUnits } from "viem";
import { useReadContract } from "wagmi";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { BP_PRECISION } from "~~/config/units";
import { useScaffoldReadContract, useScaffoldWriteContract, useSelectedNetwork } from "~~/hooks/scaffold-eth";
import { usePaymentToken } from "~~/hooks/usePaymentToken";
import { usePaymentTokenWriteContract } from "~~/hooks/usePaymentTokenWriteContract";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import { getDeployedContract } from "~~/utils/contracts";
import { formatTokenAmount } from "~~/utils/formatters";

interface DistributeEarningsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  assetId: string;
  assetName: string;
  maxSupply: bigint;
  immediateProceeds: boolean;
}

type RevenueBreakdown = {
  totalRevenue: bigint;
  investorPortion: bigint;
  partnerPortion: bigint;
  protocolFee: bigint;
  netToInvestors: bigint;
  collateralReleased: bigint;
  belowMinimumFee: boolean;
};

export const DistributeEarningsModal = ({
  isOpen,
  onClose,
  onSuccess,
  assetId,
  assetName,
  maxSupply,
  immediateProceeds,
}: DistributeEarningsModalProps) => {
  const { address: connectedAddress } = useTransactingAccount();
  const selectedNetwork = useSelectedNetwork();
  const chainId = selectedNetwork.id;
  const { address: paymentTokenAddress, symbol, decimals } = usePaymentToken();
  const [totalRevenue, setTotalRevenue] = useState(""); // Total revenue earned
  const [step, setStep] = useState<"idle" | "approving" | "submitting">("idle");
  const [submittedRevenueBreakdown, setSubmittedRevenueBreakdown] = useState<RevenueBreakdown | null>(null);
  const supportsAutoRelease = !immediateProceeds;
  const [autoRelease, setAutoRelease] = useState(supportsAutoRelease);
  const earningsManagerAddress = getDeployedContract(selectedNetwork.id, "EarningsManager")?.address;
  const isSubmitting = step !== "idle";

  useEffect(() => {
    setAutoRelease(supportsAutoRelease);
  }, [supportsAutoRelease]);

  useEffect(() => {
    if (!isOpen) {
      setStep("idle");
      setSubmittedRevenueBreakdown(null);
    }
  }, [isOpen]);

  useEscClose(isOpen && !isSubmitting, onClose);

  const { writeContractAsync: writeEarningsManager } = useScaffoldWriteContract({ contractName: "EarningsManager" });
  const { writeContractAsync: writePaymentToken } = usePaymentTokenWriteContract();
  // Get revenue token ID (assetId + 1)
  const revenueTokenId = BigInt(assetId) + 1n;

  // Get circulating supply of revenue tokens
  const { data: circulatingSupply } = useScaffoldReadContract({
    contractName: "RoboshareTokens",
    functionName: "getRevenueTokenSupply",
    args: [revenueTokenId],
    watch: true,
  });

  // Get partner's balance of revenue tokens
  const { data: partnerBalance } = useScaffoldReadContract({
    contractName: "RoboshareTokens",
    functionName: "balanceOf",
    args: [connectedAddress, revenueTokenId],
    watch: true,
  });

  // Check payment token allowance
  const { data: paymentTokenAllowance, refetch: refetchPaymentTokenAllowance } = useReadContract({
    chainId,
    address: paymentTokenAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: connectedAddress && earningsManagerAddress ? [connectedAddress, earningsManagerAddress] : undefined,
    query: { enabled: !!paymentTokenAddress && !!connectedAddress && !!earningsManagerAddress },
  });

  const parsedTotalRevenue = useMemo(() => {
    if (!totalRevenue) {
      return null;
    }

    try {
      return parseUnits(totalRevenue, decimals);
    } catch {
      return null;
    }
  }, [decimals, totalRevenue]);

  // Calculate token ownership breakdown (independent of revenue)
  const tokenOwnership = useMemo(() => {
    const currentCirculatingSupply = typeof circulatingSupply === "bigint" ? circulatingSupply : 0n;

    if (currentCirculatingSupply === 0n || maxSupply === 0n) {
      return null;
    }

    const partnerTokens = typeof partnerBalance === "bigint" ? partnerBalance : 0n;
    const investorTokens = currentCirculatingSupply > partnerTokens ? currentCirculatingSupply - partnerTokens : 0n;
    const investorPercentage = Number((investorTokens * BP_PRECISION) / maxSupply) / 100;
    const partnerPercentage = Number((partnerTokens * BP_PRECISION) / maxSupply) / 100;
    const circulatingPercentage = Number((currentCirculatingSupply * BP_PRECISION) / maxSupply) / 100;

    return {
      maxSupply,
      circulatingSupply: currentCirculatingSupply,
      partnerTokens,
      investorTokens,
      partnerPercentage,
      investorPercentage,
      circulatingPercentage,
    };
  }, [circulatingSupply, maxSupply, partnerBalance]);

  const { data: previewDistribution } = useScaffoldReadContract({
    contractName: "EarningsManager",
    functionName: "previewDistributeEarnings",
    args: [connectedAddress, BigInt(assetId), parsedTotalRevenue ?? 0n, supportsAutoRelease && autoRelease],
    watch: true,
    query: { enabled: !!connectedAddress && parsedTotalRevenue !== null && parsedTotalRevenue > 0n },
  });

  // Calculate revenue distribution breakdown (only when revenue is entered)
  const revenueBreakdown = useMemo<RevenueBreakdown | null>(() => {
    if (!tokenOwnership || parsedTotalRevenue === null) {
      return null;
    }

    const previewTuple = previewDistribution as readonly [bigint, bigint, bigint, bigint] | undefined;
    const investorPortion = previewTuple?.[0] ?? 0n;
    const protocolFee = previewTuple?.[1] ?? 0n;
    const netToInvestors = previewTuple?.[2] ?? 0n;
    const collateralReleased = previewTuple?.[3] ?? 0n;
    const partnerPortion = parsedTotalRevenue > investorPortion ? parsedTotalRevenue - investorPortion : 0n;

    return {
      totalRevenue: parsedTotalRevenue,
      investorPortion,
      partnerPortion,
      protocolFee,
      netToInvestors,
      collateralReleased,
      belowMinimumFee: investorPortion > 0n && protocolFee === 0n && netToInvestors === 0n,
    };
  }, [parsedTotalRevenue, previewDistribution, tokenOwnership]);

  const estimatedRelease = useMemo(() => {
    if (!autoRelease) return 0n;
    return (submittedRevenueBreakdown ?? revenueBreakdown)?.collateralReleased ?? 0n;
  }, [autoRelease, revenueBreakdown, submittedRevenueBreakdown]);
  const displayedRevenueBreakdown = submittedRevenueBreakdown ?? revenueBreakdown;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!earningsManagerAddress || !revenueBreakdown) return;

    setSubmittedRevenueBreakdown(revenueBreakdown);
    try {
      // Approval safety: approve up to total revenue so tx won't fail if on-chain rounding/denominator differs.
      const amountToApprove = revenueBreakdown.totalRevenue;

      // Approve if needed
      if (!paymentTokenAllowance || paymentTokenAllowance < amountToApprove) {
        setStep("approving");
        await writePaymentToken({
          functionName: "approve",
          args: [earningsManagerAddress, amountToApprove],
        });
        await refetchPaymentTokenAllowance();
      }

      // Distribute earnings (totalRevenue only; investor amount is computed on-chain)
      setStep("submitting");
      await writeEarningsManager({
        functionName: "distributeEarnings",
        args: [BigInt(assetId), revenueBreakdown.totalRevenue, supportsAutoRelease && autoRelease],
      });

      setTotalRevenue("");
      onSuccess?.();
      onClose();
    } catch (e) {
      console.error("Error distributing earnings:", e);
      setSubmittedRevenueBreakdown(null);
      setStep("idle");
    } finally {
      if (!isOpen) {
        setStep("idle");
      }
    }
  };

  if (!isOpen) return null;

  const hasExternalHolders = tokenOwnership && tokenOwnership.investorTokens > 0n;
  const isEligibleDistribution =
    !!revenueBreakdown && revenueBreakdown.investorPortion > 0n && !revenueBreakdown.belowMinimumFee;
  return (
    <div className="modal modal-open">
      <div
        className="modal-backdrop bg-black/50 backdrop-blur-sm hidden sm:block"
        onClick={isSubmitting ? undefined : onClose}
      />
      <div className="modal-box relative w-full h-full max-h-full sm:h-auto sm:max-h-[90vh] sm:max-w-xl sm:rounded-2xl rounded-none flex flex-col p-0">
        <form onSubmit={handleSubmit} className="flex flex-col h-full w-full">
          {/* Close Button */}
          <button
            type="button"
            className="btn btn-sm btn-circle btn-ghost absolute right-4 top-4 z-10"
            onClick={onClose}
            disabled={isSubmitting}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>

          {/* Header */}
          <div className="p-4 border-b border-base-200 shrink-0">
            <h3 className="font-bold text-xl">Send Payout</h3>
            <p className="text-sm opacity-60 mt-1">
              Send payouts from <span className="font-bold">{assetName}</span> to current holders.
            </p>
          </div>

          {/* Scrollable Content */}
          <div className="flex-1 overflow-y-auto p-4">
            <div className="flex flex-col gap-3">
              {/* Token Ownership Breakdown */}
              <div className="bg-base-200 p-4 rounded-lg">
                <div className="text-xs uppercase opacity-50 font-bold mb-3">Holder Breakdown</div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs opacity-50">Your Claim Units</div>
                    <div className="font-bold">
                      {partnerBalance?.toLocaleString() || "0"}
                      <span className="text-xs opacity-50 ml-1">
                        ({tokenOwnership?.partnerPercentage.toFixed(1) || 0}%)
                      </span>
                    </div>
                  </div>
                  <div>
                    <div className="text-xs opacity-50">External Holder Claim Units</div>
                    <div className="font-bold">
                      {tokenOwnership?.investorTokens.toLocaleString() || "0"}
                      <span className="text-xs opacity-50 ml-1">
                        ({tokenOwnership?.investorPercentage.toFixed(1) || 0}%)
                      </span>
                    </div>
                  </div>
                  <div>
                    <div className="text-xs opacity-50">Total Claim Units</div>
                    <div className="font-bold">{tokenOwnership?.maxSupply.toLocaleString() || "0"}</div>
                    <div className="text-[11px] opacity-50 mt-0.5">
                      Issued: {tokenOwnership?.circulatingSupply.toLocaleString() || "0"} (
                      {tokenOwnership?.circulatingPercentage.toFixed(1) || 0}%)
                    </div>
                  </div>
                </div>
              </div>

              {!hasExternalHolders && circulatingSupply && circulatingSupply > 0n && (
                <div className="bg-warning/10 p-3 rounded-lg text-xs">
                  <p className="text-warning font-bold">No external token holders</p>
                  <p className="opacity-80 mt-1">
                    You currently hold all claim units. There are no outside holders to send payouts to.
                  </p>
                </div>
              )}

              {/* Revenue Input */}
              <div className="divider text-xs opacity-50 my-0">Payout Details</div>

              <div className="form-control">
                <label className="label py-0">
                  <span className="label-text text-xs font-bold uppercase opacity-60">
                    Total Amount to Distribute ({symbol})
                  </span>
                </label>
                <div className="flex w-full rounded-full border-2 border-base-300 bg-base-100 text-accent">
                  <input
                    type="number"
                    step="0.000001"
                    min="0"
                    className="input input-ghost input-sm h-[2.2rem] min-h-[2.2rem] w-full border-0 px-4 font-medium text-base-content/70 placeholder:text-accent/70 focus:bg-transparent focus:outline-hidden focus-within:border-transparent focus:text-base-content/70"
                    value={totalRevenue}
                    onChange={e => setTotalRevenue(e.target.value)}
                    placeholder="e.g. 1000.00"
                    required
                    disabled={!hasExternalHolders}
                  />
                  <span className="mr-1 flex items-center self-center rounded-full bg-base-300 px-3 py-1 text-xs font-medium text-base-content/80">
                    {symbol}
                  </span>
                </div>
                <p className="text-xs opacity-50 mt-1">
                  Enter the total amount to distribute. Payouts are split based on current holdings.
                </p>
              </div>

              {/* Distribution Breakdown */}
              {displayedRevenueBreakdown && hasExternalHolders && totalRevenue && (
                <div className="bg-success/10 p-4 rounded-lg border border-success/30">
                  <div className="text-xs uppercase opacity-50 font-bold mb-3">Distribution Breakdown</div>

                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="opacity-70">Your share (kept)</span>
                      <span className="font-semibold">
                        {formatTokenAmount(displayedRevenueBreakdown.partnerPortion, decimals)} {symbol}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="opacity-70">Investor share</span>
                      <span className="font-semibold">
                        {formatTokenAmount(displayedRevenueBreakdown.investorPortion, decimals)} {symbol}
                      </span>
                    </div>
                    <div className="border-t border-success/30 pt-2 mt-2">
                      <div className="flex justify-between text-xs">
                        <span className="opacity-50">Protocol fee (2.5%)</span>
                        <span className="opacity-50">
                          -{formatTokenAmount(displayedRevenueBreakdown.protocolFee, decimals)} {symbol}
                        </span>
                      </div>
                      <div className="flex justify-between font-bold text-success mt-1">
                        <span>Net to investors</span>
                        <span>
                          {formatTokenAmount(displayedRevenueBreakdown.netToInvestors, decimals)} {symbol}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {displayedRevenueBreakdown?.belowMinimumFee && (
                <div className="bg-warning/10 p-3 rounded-lg text-xs">
                  <p className="text-warning font-bold">Distribution amount too small</p>
                  <p className="opacity-80 mt-1">
                    The investor portion is below the minimum 1 {symbol} protocol fee. Increase the payout amount to
                    submit this distribution.
                  </p>
                </div>
              )}

              {/* Auto-release Proceeds Toggle (gradual release only) */}
              {supportsAutoRelease && displayedRevenueBreakdown && hasExternalHolders && totalRevenue && (
                <div className="form-control w-full">
                  <label className="label cursor-pointer flex justify-between w-full py-2">
                    <div>
                      <span className="label-text font-medium">Automatically unlock proceeds</span>
                      <p className="text-xs opacity-50 mt-0.5">
                        Unlock available proceeds proportionally as you send payouts
                      </p>
                      {autoRelease && (
                        <p className="text-xs mt-1 font-medium text-success">
                          Estimated release: {formatTokenAmount(estimatedRelease, decimals)} {symbol}
                        </p>
                      )}
                    </div>
                    <input
                      type="checkbox"
                      className="toggle toggle-success"
                      checked={autoRelease}
                      onChange={e => setAutoRelease(e.target.checked)}
                      disabled={isSubmitting}
                    />
                  </label>
                </div>
              )}

              {/* Info Box */}
              <div className="bg-info/10 p-3 rounded-lg text-xs">
                <p className="opacity-80">
                  You deposit only the investor portion (capped by the revenue share setting). Your share stays with
                  you. Minimum protocol fee is 1 {symbol}.
                </p>
              </div>
            </div>
          </div>

          {/* Sticky Footer */}
          <div className="shrink-0 border-t border-base-200 bg-base-100 p-4">
            <div className="flex gap-3 justify-end">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={isSubmitting}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-success"
                disabled={isSubmitting || !totalRevenue || !hasExternalHolders || !isEligibleDistribution}
              >
                {step === "approving" ? (
                  <>
                    <span className="loading loading-spinner loading-sm"></span>
                    Approving...
                  </>
                ) : step === "submitting" ? (
                  <>
                    <span className="loading loading-spinner loading-sm"></span>
                    Processing...
                  </>
                ) : (
                  `Distribute ${displayedRevenueBreakdown ? formatTokenAmount(displayedRevenueBreakdown.investorPortion, decimals) : "0"} ${symbol}`
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
