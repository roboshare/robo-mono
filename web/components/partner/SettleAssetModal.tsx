"use client";

import { useEffect, useMemo, useState } from "react";
import { useEscClose } from "./useEscClose";
import { erc20Abi, formatUnits, parseUnits } from "viem";
import { useReadContract } from "wagmi";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useScaffoldReadContract, useScaffoldWriteContract, useSelectedNetwork } from "~~/hooks/scaffold-eth";
import { usePaymentToken } from "~~/hooks/usePaymentToken";
import { usePaymentTokenWriteContract } from "~~/hooks/usePaymentTokenWriteContract";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import { getDeployedContract } from "~~/utils/contracts";

interface SettleAssetModalProps {
  isOpen: boolean;
  onClose: () => void;
  assetId: string;
  assetName: string;
  minimumTopUpAmount?: bigint;
  earningsBufferAmount?: bigint;
}

export const SettleAssetModal = ({
  isOpen,
  onClose,
  assetId,
  assetName,
  minimumTopUpAmount = 0n,
  earningsBufferAmount = 0n,
}: SettleAssetModalProps) => {
  const { address: connectedAddress } = useTransactingAccount();
  const selectedNetwork = useSelectedNetwork();
  const chainId = selectedNetwork.id;
  const { address: paymentTokenAddress, symbol, decimals } = usePaymentToken();
  const [topUpAmount, setTopUpAmount] = useState("");
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [pendingAction, setPendingAction] = useState<"approve" | "settle" | null>(null);

  const { writeContractAsync: writeVehicleRegistry, isPending } = useScaffoldWriteContract({
    contractName: "VehicleRegistry",
  });

  useEscClose(isOpen && !isPending && pendingAction === null, onClose);

  const treasuryAddress = getDeployedContract(selectedNetwork.id, "Treasury")?.address;

  const assetIdBigInt = BigInt(assetId);

  const { data: assetNftBalance } = useScaffoldReadContract({
    contractName: "RoboshareTokens",
    functionName: "balanceOf",
    args: [connectedAddress, assetIdBigInt],
    query: { enabled: isOpen && !!connectedAddress },
  });

  const { data: liquidationPreview } = useScaffoldReadContract({
    contractName: "RegistryRouter",
    functionName: "previewLiquidationEligibility",
    args: [assetIdBigInt],
    query: { enabled: isOpen },
  });

  const isAssetOwner = (assetNftBalance ?? 0n) > 0n;
  const liquidationEligible = liquidationPreview ? liquidationPreview[0] : false;
  const liquidationReason = liquidationPreview ? Number(liquidationPreview[1]) : 3;
  const isAlreadySettled = liquidationReason === 2;
  const hasSettleAction = isAssetOwner;
  const hasLiquidateAction = liquidationEligible;
  const showTopUpControls = hasSettleAction;
  const isSettlingPending = pendingAction === "settle" && isPending;
  const minimumTopUpDisplay = formatUnits(minimumTopUpAmount, decimals);
  const earningsBufferDisplay = formatUnits(earningsBufferAmount, decimals);

  // Check payment token allowance (settlement top-up path only)
  const { data: paymentTokenAllowance } = useReadContract({
    chainId,
    address: paymentTokenAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: connectedAddress && treasuryAddress ? [connectedAddress, treasuryAddress] : undefined,
    query: { enabled: isOpen && !!connectedAddress && !!treasuryAddress && hasSettleAction },
  });

  const { writeContractAsync: writePaymentToken } = usePaymentTokenWriteContract();

  useEffect(() => {
    if (!isOpen) {
      setTopUpAmount("");
      setIsConfirmed(false);
      setPendingAction(null);
    } else if (minimumTopUpAmount > 0n) {
      setTopUpAmount(formatUnits(minimumTopUpAmount, decimals));
    }
  }, [decimals, isOpen, minimumTopUpAmount]);

  const handleSettle = async () => {
    if (!treasuryAddress) return;
    if (!hasSettleAction || isAlreadySettled) return;

    try {
      const topUpBigInt = topUpAmount ? parseUnits(topUpAmount, decimals) : 0n;
      if (topUpBigInt < minimumTopUpAmount) {
        return;
      }

      // Approve if needed and top-up amount is provided
      if (topUpBigInt > 0n && (!paymentTokenAllowance || paymentTokenAllowance < topUpBigInt)) {
        setPendingAction("approve");
        await writePaymentToken({
          functionName: "approve",
          args: [treasuryAddress, topUpBigInt],
        });
      }

      // Settle the asset via VehicleRegistry
      setPendingAction("settle");
      await writeVehicleRegistry({
        functionName: "settleAsset",
        args: [assetIdBigInt, topUpBigInt],
      });

      setTopUpAmount("");
      setIsConfirmed(false);
      onClose();
    } catch (e) {
      console.error("Error settling asset:", e);
    } finally {
      setPendingAction(null);
    }
  };

  const liquidationReasonLabel = useMemo(() => {
    if (!hasLiquidateAction) return null;
    if (liquidationReason === 0) return "Eligible for final payout at term end";
    if (liquidationReason === 1) return "Eligible for forced final payout";
    return "Eligible";
  }, [hasLiquidateAction, liquidationReason]);

  const parsedTopUpAmount = useMemo(() => {
    if (!topUpAmount) return 0n;
    try {
      return parseUnits(topUpAmount, decimals);
    } catch {
      return 0n;
    }
  }, [decimals, topUpAmount]);

  const isBelowMinimumTopUp = parsedTopUpAmount < minimumTopUpAmount;
  const disableSettle =
    !isConfirmed || isPending || pendingAction !== null || !hasSettleAction || isAlreadySettled || isBelowMinimumTopUp;

  if (!isOpen) return null;

  return (
    <div className="modal modal-open">
      <div
        className="modal-backdrop bg-black/50 backdrop-blur-sm hidden sm:block"
        onClick={pendingAction !== null || isPending ? undefined : onClose}
      />
      <div className="modal-box relative w-full h-full max-h-full sm:h-auto sm:max-h-[90vh] sm:max-w-xl sm:rounded-2xl rounded-none flex flex-col p-0">
        <div className="flex flex-col h-full w-full">
          {/* Close Button */}
          <button
            type="button"
            className="btn btn-sm btn-circle btn-ghost absolute right-4 top-4 z-10"
            onClick={onClose}
            disabled={pendingAction !== null || isPending}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>

          {/* Header */}
          <div className="p-4 border-b border-base-200 shrink-0">
            <h3 className="font-bold text-xl">Begin Final Payout</h3>
            <p className="text-sm opacity-60 mt-1">End payouts and make final holder payouts available</p>
          </div>

          {/* Scrollable Content */}
          <div className="flex-1 overflow-y-auto p-4">
            <div className="flex flex-col gap-3">
              {/* Warning Alert */}
              <div className="alert alert-warning">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="stroke-current shrink-0 h-6 w-6"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
                <div>
                  <div className="font-semibold">This action is irreversible</div>
                  <div className="text-sm">
                    Starting final payout for <strong>{assetName}</strong> will end payouts and allow holders to claim
                    their final payout.
                  </div>
                </div>
              </div>

              {hasLiquidateAction && liquidationReasonLabel && (
                <div className="rounded-lg border border-base-300 bg-base-200 p-3 text-sm">
                  <div className="font-medium">{liquidationReasonLabel}</div>
                  <div className="opacity-75 mt-1">
                    {liquidationReason === 0
                      ? "This asset can be force closed because it has reached maturity."
                      : liquidationReason === 1
                        ? "This asset can be force closed due to insolvency after missed-payout shortfall accrual."
                        : "This asset can be force closed under the current rules."}{" "}
                    Forced final payout remains a public protocol action and is not managed from the partner dashboard.
                  </div>
                </div>
              )}

              {!hasSettleAction && (
                <div className="alert alert-info">
                  <span className="text-sm">Only the asset owner can begin final payout from this dashboard.</span>
                </div>
              )}

              {minimumTopUpAmount > 0n && (
                <div className="rounded-lg border border-error/30 bg-error/10 p-3 text-sm">
                  <div className="font-medium text-error">Early final payout requires partner funding</div>
                  <div className="mt-1 opacity-75">
                    This asset already released buyer liquidity to the partner. Add at least {minimumTopUpDisplay}{" "}
                    {symbol} so holders receive the remaining protected value.
                    {earningsBufferAmount > 0n
                      ? ` The ${earningsBufferDisplay} ${symbol} earnings buffer will be added to holder payouts.`
                      : ""}
                  </div>
                </div>
              )}

              {/* Top-Up Amount */}
              {showTopUpControls && (
                <div className="form-control">
                  <label className="label py-1">
                    <span className="label-text text-xs font-bold uppercase opacity-60">
                      Top-Up Amount {minimumTopUpAmount > 0n ? "(Required)" : "(Optional)"}
                    </span>
                  </label>
                  <div className="flex w-full rounded-full border-2 border-base-300 bg-base-100 text-accent">
                    <input
                      type="number"
                      step="0.000001"
                      min={minimumTopUpDisplay}
                      className="input input-ghost h-[2.2rem] min-h-[2.2rem] w-full border-0 px-4 font-medium text-base-content/70 placeholder:text-accent/70 focus:bg-transparent focus:outline-hidden focus-within:border-transparent focus:text-base-content/70"
                      value={topUpAmount}
                      onChange={e => setTopUpAmount(e.target.value)}
                      placeholder="0.00"
                      disabled={pendingAction !== null || isPending}
                    />
                    <span className="mr-1 flex items-center self-center rounded-full bg-base-300 px-3 py-1 text-xs font-medium text-base-content/80">
                      {symbol}
                    </span>
                  </div>
                  <label className="label py-1">
                    <span className="label-text-alt text-xs opacity-60">
                      {minimumTopUpAmount > 0n
                        ? `Minimum required: ${minimumTopUpDisplay} ${symbol}`
                        : `Add additional ${symbol} to increase the settlement pool for token holders`}
                    </span>
                  </label>
                </div>
              )}

              {/* Confirmation Checkbox */}
              <div className="form-control bg-base-200 p-4 rounded-lg">
                <label className="label cursor-pointer justify-start gap-3 p-0">
                  <input
                    type="checkbox"
                    checked={isConfirmed}
                    onChange={e => setIsConfirmed(e.target.checked)}
                    className="checkbox checkbox-error"
                    disabled={pendingAction !== null || isPending}
                  />
                  <span className="label-text">I understand this action cannot be undone</span>
                </label>
              </div>
            </div>
          </div>

          {/* Sticky Footer */}
          <div className="shrink-0 border-t border-base-200 bg-base-100 p-4">
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={onClose}
                disabled={pendingAction !== null || isPending}
              >
                Cancel
              </button>
              {hasSettleAction ? (
                <button type="button" className="btn btn-error" onClick={handleSettle} disabled={disableSettle}>
                  {pendingAction === "approve" ? (
                    <>
                      <span className="loading loading-spinner loading-sm"></span>
                      Approving...
                    </>
                  ) : pendingAction === "settle" && isSettlingPending ? (
                    <>
                      <span className="loading loading-spinner loading-sm"></span>
                      Processing...
                    </>
                  ) : (
                    "Begin Final Payout"
                  )}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
