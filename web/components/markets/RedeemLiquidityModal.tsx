"use client";

import { useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { Address, formatUnits, parseUnits } from "viem";
import { useReadContract } from "wagmi";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { AccountIdentityCard } from "~~/components/scaffold-eth";
import { ModalAuthActionButton } from "~~/components/scaffold-eth/ModalAuthActionButton";
import { useScaffoldWriteContract, useSelectedNetwork } from "~~/hooks/scaffold-eth";
import { usePaymentToken } from "~~/hooks/usePaymentToken";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import { isPrivyEnabled } from "~~/services/web3/privyConfig";
import { getPrivyIdentityLabel } from "~~/services/web3/privyIdentity";
import { getDeployedContract } from "~~/utils/contracts";
import { normalizePrimaryRedemptionPreview } from "~~/utils/protocolState";

interface RedeemLiquidityModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  tokenId: string;
  vehicleName: string;
  totalPositionAmount: string;
  maxRedeemableAmount: string;
  pricePerToken: string;
}

const PERCENTAGE_OPTIONS = [25, 50, 75, 100];

const formatTokenInput = (amount: bigint, decimals: number) => {
  const formatted = formatUnits(amount, decimals);
  if (!formatted.includes(".")) return formatted;
  return formatted.replace(/\.?0+$/, "");
};

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

const paymentTokenPillClass =
  "inline-flex items-center rounded-full border border-base-300 bg-base-100 px-2 py-0.5 text-[11px] font-semibold text-base-content/75";
const paymentTokenInputShellClass = "flex w-full rounded-full border-2 border-base-300 bg-base-100 text-accent";
const paymentTokenInputClass =
  "input input-ghost h-[2.2rem] min-h-[2.2rem] w-full border-0 px-4 font-medium text-base-content/70 placeholder:text-accent/70 focus:bg-transparent focus:outline-hidden focus-within:border-transparent focus:text-base-content/70";
const shortenAddress = (address: Address) => `${address.slice(0, 6)}...${address.slice(-4)}`;

const WithdrawAccountSummaryAside = ({
  formattedAvailableNow,
  formattedPositionValue,
  symbol,
}: {
  formattedAvailableNow: string;
  formattedPositionValue: string;
  symbol: string;
}) => (
  <div className="min-w-[12rem] space-y-1 text-right">
    <div className="flex items-center justify-end gap-2 text-sm">
      <span className="text-base-content/60">Available now</span>
      <span className="font-semibold">
        {Number(formattedAvailableNow).toLocaleString(undefined, { minimumFractionDigits: 2 })}
      </span>
      <span className={paymentTokenPillClass}>{symbol}</span>
    </div>
    <div className="flex items-center justify-end gap-2 text-xs text-base-content/60">
      <span>Position value</span>
      <span className="font-medium text-base-content/80">
        {Number(formattedPositionValue).toLocaleString(undefined, { minimumFractionDigits: 2 })}
      </span>
      <span className={paymentTokenPillClass}>{symbol}</span>
    </div>
  </div>
);

const PrivyWithdrawAccountSummaryCard = ({
  address,
  formattedAvailableNow,
  formattedPositionValue,
  symbol,
}: {
  address: Address;
  formattedAvailableNow: string;
  formattedPositionValue: string;
  symbol: string;
}) => {
  const { user } = usePrivy();
  const shortAddress = shortenAddress(address);
  const accountLabel = getPrivyIdentityLabel({ address, user }) || shortAddress;

  return (
    <div className="space-y-1">
      <span className="text-sm opacity-70">Your Account</span>
      <AccountIdentityCard
        address={address}
        primaryLabel={accountLabel}
        secondaryLabel={accountLabel !== shortAddress ? shortAddress : undefined}
        aside={
          <WithdrawAccountSummaryAside
            formattedAvailableNow={formattedAvailableNow}
            formattedPositionValue={formattedPositionValue}
            symbol={symbol}
          />
        }
      />
    </div>
  );
};

const WithdrawAccountSummaryCard = ({
  address,
  formattedAvailableNow,
  formattedPositionValue,
  symbol,
}: {
  address?: Address;
  formattedAvailableNow: string;
  formattedPositionValue: string;
  symbol: string;
}) => {
  if (!address) {
    return (
      <div className="rounded-xl border border-base-300 bg-base-200 p-3">
        <div className="flex justify-between text-sm">
          <span className="opacity-70">Your Position Value</span>
          <span className="flex items-center gap-2 font-medium">
            {Number(formattedPositionValue).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            <span className={paymentTokenPillClass}>{symbol}</span>
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="opacity-70">Funds You Can Receive Now</span>
          <span className="flex items-center gap-2 font-medium">
            {Number(formattedAvailableNow).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            <span className={paymentTokenPillClass}>{symbol}</span>
          </span>
        </div>
      </div>
    );
  }

  if (isPrivyEnabled()) {
    return (
      <PrivyWithdrawAccountSummaryCard
        address={address}
        formattedAvailableNow={formattedAvailableNow}
        formattedPositionValue={formattedPositionValue}
        symbol={symbol}
      />
    );
  }

  const shortAddress = shortenAddress(address);

  return (
    <div className="space-y-1">
      <span className="text-sm opacity-70">Your Account</span>
      <AccountIdentityCard
        address={address}
        primaryLabel={shortAddress}
        aside={
          <WithdrawAccountSummaryAside
            formattedAvailableNow={formattedAvailableNow}
            formattedPositionValue={formattedPositionValue}
            symbol={symbol}
          />
        }
      />
    </div>
  );
};

export function RedeemLiquidityModal({
  isOpen,
  onClose,
  onSuccess,
  tokenId,
  vehicleName,
  totalPositionAmount,
  maxRedeemableAmount,
  pricePerToken,
}: RedeemLiquidityModalProps) {
  const { address } = useTransactingAccount();
  const selectedNetwork = useSelectedNetwork();
  const { symbol, decimals } = usePaymentToken();
  const [fundsInput, setFundsInput] = useState("");
  const [step, setStep] = useState<"input" | "redeeming" | "success" | "error">("input");
  const [error, setError] = useState<string | null>(null);
  const [successSnapshot, setSuccessSnapshot] = useState<{ redeemAmount: bigint; payout: bigint } | null>(null);
  const totalPosition = BigInt(totalPositionAmount || "0");
  const maxAmount = BigInt(maxRedeemableAmount || "0");
  const pricePerUnit = BigInt(pricePerToken || "0");

  const marketplaceContract = getDeployedContract(selectedNetwork.id, "Marketplace");
  const { data: fullPositionRedemptionPreview } = useReadContract({
    address: marketplaceContract?.address,
    abi: marketplaceContract?.abi,
    functionName: "previewPrimaryRedemption",
    args: address ? [BigInt(tokenId), address, maxAmount] : undefined,
    query: { enabled: isOpen && !!address && !!marketplaceContract },
  });

  const { writeContractAsync: writeMarketplace, isPending } = useScaffoldWriteContract({
    contractName: "Marketplace",
  });

  const fullPositionPreview = normalizePrimaryRedemptionPreview(fullPositionRedemptionPreview);
  const fullPositionPayout = fullPositionPreview.payout;
  const availableLiquidityNow = fullPositionPreview.liquidity;
  const withdrawableSupplyNow = fullPositionPreview.redemptionSupply;
  const maxFunds = fullPositionPayout;
  const totalPositionValue = totalPosition * pricePerUnit;
  const enteredFunds = useMemo(() => {
    if (!fundsInput.trim()) return 0n;
    try {
      return parseUnits(fundsInput, decimals);
    } catch {
      return 0n;
    }
  }, [decimals, fundsInput]);
  const redeemAmount = useMemo(() => {
    if (enteredFunds === 0n || maxFunds === 0n || maxAmount === 0n) return 0n;
    return ceilDiv(enteredFunds * maxAmount, maxFunds);
  }, [enteredFunds, maxAmount, maxFunds]);
  const { data: redemptionPreview, refetch: refetchPreview } = useReadContract({
    address: marketplaceContract?.address,
    abi: marketplaceContract?.abi,
    functionName: "previewPrimaryRedemption",
    args: address ? [BigInt(tokenId), address, redeemAmount] : undefined,
    query: { enabled: isOpen && !!address && !!marketplaceContract },
  });
  const payout = normalizePrimaryRedemptionPreview(redemptionPreview).payout;
  const formattedFullPositionPayout = formatUnits(fullPositionPayout, decimals);
  const formattedTotalPositionValue = formatUnits(totalPositionValue, decimals);
  const formattedAvailableLiquidityNow = formatUnits(availableLiquidityNow, decimals);
  const currentPercentage = useMemo(() => {
    if (enteredFunds === 0n || maxFunds === 0n) return 0;
    return Number((enteredFunds * 100n) / maxFunds);
  }, [enteredFunds, maxFunds]);
  const hasRestrictedWithdrawalWindow = maxAmount < totalPosition;

  useEffect(() => {
    if (!isOpen) {
      setFundsInput("");
      setStep("input");
      setError(null);
      setSuccessSnapshot(null);
    }
  }, [isOpen]);

  const isBusy = step === "redeeming" || isPending;

  const handlePercentageSelect = (percentage: number) => {
    if (maxFunds === 0n) return;
    const amount = (maxFunds * BigInt(percentage)) / 100n;
    setFundsInput(formatTokenInput(amount, decimals));
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const percentage = parseInt(e.target.value);
    handlePercentageSelect(percentage);
  };

  const handleRedeem = async () => {
    if (redeemAmount === 0n || !address) return;

    try {
      setError(null);
      setStep("redeeming");
      const submittedRedeemAmount = redeemAmount;
      const submittedPayout = payout;
      await writeMarketplace({
        functionName: "redeemPrimaryPool",
        args: [BigInt(tokenId), redeemAmount, payout],
      });
      setSuccessSnapshot({ redeemAmount: submittedRedeemAmount, payout: submittedPayout });
      setStep("success");
      onSuccess?.();
    } catch (e: any) {
      setError(e.message || e.shortMessage || "Redemption failed");
      setStep("error");
      await refetchPreview();
    }
  };

  if (!isOpen) return null;

  const hasValidAmount =
    enteredFunds > 0n && enteredFunds <= maxFunds && redeemAmount > 0n && redeemAmount <= maxAmount && payout > 0n;
  const successRedeemAmount = successSnapshot?.redeemAmount ?? 0n;
  const successPayout = successSnapshot?.payout ?? 0n;
  const formattedSuccessPayout = formatUnits(successPayout, decimals);
  const requiresAuth = !address;

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
          <XMarkIcon className="w-5 h-5" />
        </button>

        <div className="p-4 border-b border-base-200 shrink-0">
          <h3 className="font-bold text-xl">Withdraw</h3>
          <p className="text-sm opacity-60 mt-1">{vehicleName}</p>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {step === "success" ? (
            <div className="text-center text-base-content">
              <div className="text-6xl mb-4">💸</div>
              <h4 className="text-xl font-bold text-success mb-2">Withdrawal Complete</h4>
              <div className="alert text-sm mb-4 text-left bg-base-200/70 text-base-content border border-base-300">
                <span>Your withdrawal has been completed and the redeemed funds were sent to your wallet.</span>
              </div>
              <p className="text-base-content/80 mb-4">
                You redeemed <span className="font-bold">{successRedeemAmount.toLocaleString()}</span> units from this
                position for{" "}
                <span className="inline-flex items-center gap-2 font-bold">
                  {Number(formattedSuccessPayout).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  <span className={paymentTokenPillClass}>{symbol}</span>
                </span>
                .
              </p>
              <div className="bg-success/20 dark:bg-success/15 border border-success/30 rounded-lg p-4 text-base-content">
                <div className="text-sm text-base-content/70 mb-1">Funds Received</div>
                <div className="flex items-center justify-center gap-2 text-2xl font-bold text-success">
                  {Number(formattedSuccessPayout).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  <span className={paymentTokenPillClass}>{symbol}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {requiresAuth && (
                <div className="alert border border-base-300 bg-base-200/70 text-base-content">
                  <span className="text-sm">
                    Log in to preview your withdrawable balance and continue with this withdrawal from the same modal.
                  </span>
                </div>
              )}

              <WithdrawAccountSummaryCard
                address={address as Address | undefined}
                formattedAvailableNow={formattedFullPositionPayout}
                formattedPositionValue={formattedTotalPositionValue}
                symbol={symbol}
              />

              {hasRestrictedWithdrawalWindow && (
                <div className="alert text-sm bg-base-200/70 text-base-content border border-base-300">
                  <span>
                    Why can&apos;t you withdraw the full position? This pool releases proceeds immediately, so only the
                    units bought after the last proceeds release can be withdrawn here right now.
                  </span>
                </div>
              )}

              {hasRestrictedWithdrawalWindow && (
                <p className="text-xs opacity-60 px-1">
                  Pool status:{" "}
                  {Number(formattedAvailableLiquidityNow).toLocaleString(undefined, { minimumFractionDigits: 2 })}{" "}
                  <span className={paymentTokenPillClass}>{symbol}</span> backing{" "}
                  {withdrawableSupplyNow.toLocaleString()} currently withdrawable units.
                </p>
              )}

              <div className="form-control">
                <label className="label py-1">
                  <span className="label-text text-xs font-bold uppercase opacity-60">Funds to Receive</span>
                  <span className="label-text-alt">
                    Max: {Number(formattedFullPositionPayout).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </span>
                </label>
                <div className={paymentTokenInputShellClass}>
                  <input
                    type="number"
                    className={paymentTokenInputClass}
                    placeholder="0"
                    value={fundsInput}
                    onChange={e => setFundsInput(e.target.value)}
                    max={formattedFullPositionPayout}
                    min="0"
                    step="any"
                    disabled={isBusy}
                  />
                  <span className="mr-1 flex items-center self-center rounded-full bg-base-300 px-3 py-1 text-xs font-medium text-base-content/80">
                    {symbol}
                  </span>
                </div>
              </div>

              {hasValidAmount && (
                <div className="flex justify-between items-center text-sm">
                  <span className="opacity-70">Units That Will Be Redeemed</span>
                  <span className="font-mono">{redeemAmount.toLocaleString()} units</span>
                </div>
              )}

              <div className="flex gap-2">
                {PERCENTAGE_OPTIONS.map(pct => (
                  <button
                    key={pct}
                    className={`btn btn-sm flex-1 ${currentPercentage === pct ? "btn-primary" : "btn-outline"}`}
                    onClick={() => handlePercentageSelect(pct)}
                    disabled={isBusy || maxFunds === 0n}
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
                  disabled={isBusy || maxFunds === 0n}
                />
                <div className="flex justify-between text-xs opacity-50 mt-1">
                  <span>0%</span>
                  <span>50%</span>
                  <span>100%</span>
                </div>
              </div>

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
            {step === "success" ? (
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
                    onClick={handleRedeem}
                    disabled={Boolean(isBusy || !hasValidAmount || payout === 0n)}
                  >
                    {isBusy ? (
                      <>
                        <span className="loading loading-spinner loading-sm"></span>Withdrawing...
                      </>
                    ) : (
                      "Withdraw"
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
