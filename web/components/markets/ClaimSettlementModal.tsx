"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { useReadContract } from "wagmi";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { ModalAuthActionButton } from "~~/components/scaffold-eth/ModalAuthActionButton";
import { useScaffoldReadContract, useScaffoldWriteContract, useSelectedNetwork } from "~~/hooks/scaffold-eth";
import { usePaymentToken } from "~~/hooks/usePaymentToken";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import { getDeployedContract } from "~~/utils/contracts";

interface ClaimSettlementModalProps {
  isOpen: boolean;
  onClose: () => void;
  assetId: string;
  vehicleName: string;
  autoWithdraw?: boolean;
}

export const ClaimSettlementModal = ({
  isOpen,
  onClose,
  assetId,
  vehicleName,
  autoWithdraw = true,
}: ClaimSettlementModalProps) => {
  const { address } = useTransactingAccount();
  const selectedNetwork = useSelectedNetwork();
  const [autoClaimEarnings, setAutoClaimEarnings] = useState(false);
  const [step, setStep] = useState<"idle" | "claiming" | "withdrawing">("idle");
  const [submittedSnapshot, setSubmittedSnapshot] = useState<{
    claimableAmount: bigint;
    claimableEarnings: bigint;
    autoClaimEarnings: boolean;
  } | null>(null);
  const { symbol: paymentSymbol, decimals: paymentDecimals } = usePaymentToken();
  const treasuryAddress = getDeployedContract(selectedNetwork.id, "Treasury")?.address;
  const { writeContractAsync: writeRouter, isPending } = useScaffoldWriteContract({
    contractName: "RegistryRouter",
  });
  const { writeContractAsync: writeTreasury } = useScaffoldWriteContract({
    contractName: "Treasury",
  });
  const isBusy = step !== "idle" || isPending;
  const { data: previewSettlementAmount } = useReadContract({
    address: treasuryAddress,
    abi: [
      {
        type: "function",
        name: "previewSettlementClaim",
        stateMutability: "view",
        inputs: [
          { name: "assetId", type: "uint256" },
          { name: "holder", type: "address" },
        ],
        outputs: [{ name: "", type: "uint256" }],
      },
    ] as const,
    functionName: "previewSettlementClaim",
    args: address ? [BigInt(assetId), address] : undefined,
    query: { enabled: isOpen && !!address && !!treasuryAddress },
  });
  const { data: previewEarningsAmount } = useScaffoldReadContract({
    contractName: "EarningsManager",
    functionName: "previewClaimEarnings",
    args: [BigInt(assetId), address],
    query: { enabled: isOpen && !!address },
  });
  const claimableAmount = submittedSnapshot?.claimableAmount ?? previewSettlementAmount ?? 0n;
  const claimableEarnings = submittedSnapshot?.claimableEarnings ?? previewEarningsAmount ?? 0n;
  const effectiveAutoClaimEarnings = submittedSnapshot?.autoClaimEarnings ?? autoClaimEarnings;
  const totalIfAutoClaim = claimableAmount + claimableEarnings;
  const requiresAuth = !address;
  const claimableDisplay = useMemo(() => {
    const formatted = formatUnits(claimableAmount, paymentDecimals);
    return Number(formatted).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }, [claimableAmount, paymentDecimals]);
  const claimableEarningsDisplay = useMemo(() => {
    const formatted = formatUnits(claimableEarnings, paymentDecimals);
    return Number(formatted).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }, [claimableEarnings, paymentDecimals]);
  const totalIfAutoClaimDisplay = useMemo(() => {
    const formatted = formatUnits(totalIfAutoClaim, paymentDecimals);
    return Number(formatted).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }, [totalIfAutoClaim, paymentDecimals]);

  useEffect(() => {
    if (!isOpen) {
      setAutoClaimEarnings(false);
      setStep("idle");
      setSubmittedSnapshot(null);
    }
  }, [isOpen]);

  const handleClaim = async () => {
    if (claimableAmount === 0n || !address || isBusy) return;
    try {
      setSubmittedSnapshot({
        claimableAmount,
        claimableEarnings,
        autoClaimEarnings,
      });
      setStep("claiming");
      await writeRouter({
        functionName: "claimSettlement",
        args: [BigInt(assetId), autoClaimEarnings],
      });
      if (autoWithdraw) {
        setStep("withdrawing");
        await writeTreasury({
          functionName: "processWithdrawal",
        });
      }
      onClose();
    } catch (e) {
      console.error("Error claiming settlement:", e);
      setSubmittedSnapshot(null);
      setStep("idle");
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal modal-open">
      <div
        className="modal-backdrop bg-black/50 backdrop-blur-sm hidden sm:block"
        onClick={isBusy ? undefined : onClose}
      />
      <div className="modal-box relative w-full h-full max-h-full sm:h-auto sm:max-h-[90vh] sm:max-w-xl sm:rounded-2xl rounded-none flex flex-col p-0">
        <button
          className="btn btn-sm btn-circle btn-ghost absolute right-4 top-4 z-10"
          onClick={onClose}
          disabled={isBusy}
        >
          <XMarkIcon className="h-5 w-5" />
        </button>

        <div className="p-4 border-b border-base-200 shrink-0">
          <h3 className="font-bold text-xl text-primary">Claim Final Payout</h3>
          <p className="text-sm opacity-60 mt-1">{vehicleName}</p>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {requiresAuth ? (
            <div className="alert border border-base-300 bg-base-200/70 text-base-content">
              <span className="text-sm">
                Log in to preview your final payout and submit the settlement claim from this modal.
              </span>
            </div>
          ) : (
            <>
              <div className="bg-base-200 rounded-xl p-4">
                <p className="text-sm opacity-70 mb-2">Available Final Payout</p>
                <p className="text-2xl font-bold text-primary">
                  {claimableDisplay} <span className="text-base font-semibold opacity-80">{paymentSymbol}</span>
                </p>
                <p className="text-sm opacity-70 mt-3">
                  {autoWithdraw
                    ? "Claim your final payout and process the resulting withdrawal back to your wallet."
                    : "Claim your final payout into pending withdrawals so you can withdraw after claiming other assets."}
                </p>
                <div className="mt-4 space-y-1 text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="opacity-70">Final payout</span>
                    <span className="font-medium">
                      {claimableDisplay} {paymentSymbol}
                    </span>
                  </div>
                  {effectiveAutoClaimEarnings && (
                    <div className="flex justify-between gap-3">
                      <span className="opacity-70">Available unpaid payouts</span>
                      <span className="font-medium">
                        {claimableEarningsDisplay} {paymentSymbol}
                      </span>
                    </div>
                  )}
                  {effectiveAutoClaimEarnings && (
                    <div className="flex justify-between gap-3 border-t border-base-300 pt-2 mt-2 font-semibold text-success">
                      <span>Total this transaction</span>
                      <span>
                        {totalIfAutoClaimDisplay} {paymentSymbol}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div className="form-control w-full mt-2">
                <label className="label cursor-pointer flex justify-between w-full py-2">
                  <div>
                    <span className="label-text font-medium">Also claim unpaid payouts</span>
                    <p className="text-xs opacity-50 mt-0.5">
                      Include any unpaid payouts in the same final payout transaction.
                    </p>
                    {autoClaimEarnings && (
                      <p className="text-xs mt-1 font-medium text-success">
                        Estimated additional payout: {claimableEarningsDisplay} {paymentSymbol}
                      </p>
                    )}
                  </div>
                  <input
                    type="checkbox"
                    className="toggle toggle-success"
                    checked={autoClaimEarnings}
                    onChange={e => setAutoClaimEarnings(e.target.checked)}
                    disabled={isBusy || !!submittedSnapshot}
                  />
                </label>
              </div>
            </>
          )}
        </div>

        <div className="shrink-0 border-t border-base-200 bg-base-100 p-4">
          {requiresAuth ? (
            <ModalAuthActionButton className="btn btn-primary btn-block" />
          ) : (
            <button
              className="btn btn-primary btn-block"
              onClick={handleClaim}
              disabled={isBusy || claimableAmount === 0n}
            >
              {step === "claiming" ? (
                <>
                  <span className="loading loading-spinner loading-sm" />
                  Processing...
                </>
              ) : step === "withdrawing" ? (
                <>
                  <span className="loading loading-spinner loading-sm" />
                  Withdrawing...
                </>
              ) : autoWithdraw ? (
                "Claim Final Payout"
              ) : (
                "Claim Final Payout to Pending Withdrawals"
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
