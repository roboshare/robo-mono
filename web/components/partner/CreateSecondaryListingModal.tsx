"use client";

import { useEffect, useState } from "react";
import { useEscClose } from "./useEscClose";
import { formatUnits, parseUnits } from "viem";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { BP_PRECISION } from "~~/config/units";
import { useScaffoldReadContract, useScaffoldWriteContract, useSelectedNetwork } from "~~/hooks/scaffold-eth";
import { usePaymentToken } from "~~/hooks/usePaymentToken";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import { getDeployedContract } from "~~/utils/contracts";
import { formatTokenAmount } from "~~/utils/formatters";
import { getParsedError } from "~~/utils/scaffold-eth";

interface CreateSecondaryListingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  vehicleId: string;
  vin: string;
  assetName?: string;
  prefillAmount?: string;
  listingFlow?: "primary" | "secondary";
}

export const CreateSecondaryListingModal = ({
  isOpen,
  onClose,
  onSuccess,
  vehicleId,
  vin,
  assetName,
  prefillAmount,
  listingFlow,
}: CreateSecondaryListingModalProps) => {
  const { address: connectedAddress } = useTransactingAccount();
  const selectedNetwork = useSelectedNetwork();
  const { symbol, decimals } = usePaymentToken();
  const [formData, setFormData] = useState({
    amount: "",
    pricePerToken: "",
    durationDays: "30",
    buyerPaysFee: "buyer",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEscClose(isOpen, onClose);

  const { writeContractAsync: writeMarketplace } = useScaffoldWriteContract({ contractName: "Marketplace" });
  const { writeContractAsync: writeRoboshareTokens } = useScaffoldWriteContract({ contractName: "RoboshareTokens" });

  const marketplaceAddress = getDeployedContract(selectedNetwork.id, "Marketplace")?.address;

  const { data: isApproved } = useScaffoldReadContract({
    contractName: "RoboshareTokens",
    functionName: "isApprovedForAll",
    args: [connectedAddress, marketplaceAddress],
    watch: true,
  });

  const revenueTokenId = BigInt(vehicleId) + 1n;
  const { data: baseTokenPrice } = useScaffoldReadContract({
    contractName: "RoboshareTokens",
    functionName: "getTokenPrice",
    args: [revenueTokenId],
  });
  const { data: walletBalance } = useScaffoldReadContract({
    contractName: "RoboshareTokens",
    functionName: "balanceOf",
    args: [connectedAddress, revenueTokenId],
  });
  const { data: assetNftBalance } = useScaffoldReadContract({
    contractName: "RoboshareTokens",
    functionName: "balanceOf",
    args: [connectedAddress, BigInt(vehicleId)],
  });
  const inferredPrimaryFlow = ((assetNftBalance as bigint | undefined) ?? 0n) > 0n;
  const isPrimaryFlow = listingFlow ? listingFlow === "primary" : inferredPrimaryFlow;

  useEffect(() => {
    if (!prefillAmount) return;
    setFormData(prev => (prev.amount ? prev : { ...prev, amount: prefillAmount }));
  }, [prefillAmount]);

  useEffect(() => {
    if (!isOpen) setErrorMessage(null);
  }, [isOpen]);

  useEffect(() => {
    if (prefillAmount) return;
    if (walletBalance && walletBalance > 0n) {
      setFormData(prev => (prev.amount ? prev : { ...prev, amount: walletBalance.toString() }));
    }
  }, [prefillAmount, walletBalance]);

  useEffect(() => {
    if (!baseTokenPrice) return;
    setFormData(prev =>
      prev.pricePerToken
        ? prev
        : {
            ...prev,
            pricePerToken: formatUnits(baseTokenPrice, 6)
              .replace(/\.0+$/, "")
              .replace(/(\.\d*[1-9])0+$/, "$1"),
          },
    );
  }, [baseTokenPrice]);

  const setPriceFromDelta = (deltaBp: number) => {
    if (!baseTokenPrice) return;
    const multiplier = BP_PRECISION + BigInt(deltaBp);
    const nextPrice = (baseTokenPrice * multiplier) / BP_PRECISION;
    const formatted = formatUnits(nextPrice, 6);
    const trimmed = formatted.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
    setFormData(prev => ({ ...prev, pricePerToken: trimmed }));
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!marketplaceAddress) return;

    setIsSubmitting(true);
    try {
      setErrorMessage(null);
      const tokenId = BigInt(vehicleId) + 1n; // Revenue Token ID
      const durationSeconds = BigInt(parseInt(formData.durationDays) * 24 * 60 * 60);
      const priceBigInt = parseUnits(formData.pricePerToken, 6);

      // 1. Approve if needed
      if (!isApproved) {
        await writeRoboshareTokens({
          functionName: "setApprovalForAll",
          args: [marketplaceAddress, true],
        });
      }

      // 2. Create Listing
      const buyerPaysFee = isPrimaryFlow ? true : formData.buyerPaysFee === "buyer";

      const txHash = await writeMarketplace({
        functionName: "createListing",
        args: [tokenId, BigInt(formData.amount), priceBigInt, durationSeconds, buyerPaysFee],
      });
      if (!txHash) {
        setErrorMessage("Transaction was not submitted. Please try again.");
        return;
      }

      onSuccess?.();
      onClose();
    } catch (e) {
      setErrorMessage(getParsedError(e));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Calculate total value
  const totalValue =
    formData.amount && formData.pricePerToken ? parseUnits(formData.pricePerToken, 6) * BigInt(formData.amount) : 0n;
  const { data: estimatedBufferPreview } = useScaffoldReadContract({
    contractName: "Marketplace",
    functionName: "previewPrimaryPoolBufferRequirements",
    args: [revenueTokenId, totalValue],
    query: { enabled: isOpen && isPrimaryFlow && totalValue > 0n },
  });
  const estimatedBuffer =
    isPrimaryFlow && Array.isArray(estimatedBufferPreview)
      ? ((estimatedBufferPreview[2] as bigint | undefined) ?? 0n)
      : 0n;

  // Calculate expiry date
  const expiryDate = new Date(Date.now() + parseInt(formData.durationDays || "0") * 24 * 60 * 60 * 1000);
  const formatDate = (date: Date) =>
    date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  if (!isOpen) return null;

  return (
    <div className="modal modal-open">
      <div className="modal-backdrop bg-black/50 backdrop-blur-sm hidden sm:block" onClick={onClose} />
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
            <h3 className="font-bold text-xl">List Claim Units for Sale</h3>
            <p className="text-sm opacity-60 mt-1 mb-1">
              List claim units for <span className="font-semibold">{assetName || "this asset"}</span> (VIN{" "}
              <span className="font-mono font-bold">{vin}</span>) on the marketplace. Listed claim units stay in your
              wallet and are locked until sold, expired, or ended.
            </p>
          </div>

          {/* Scrollable Content */}
          <div className="flex-1 overflow-y-auto p-4">
            <div className="flex flex-col gap-3">
              {errorMessage && (
                <div className="alert alert-error text-sm">
                  <span>{errorMessage}</span>
                </div>
              )}

              <div className="bg-base-200 p-4 rounded-lg border border-base-300">
                {/* Row 1: Amount and Price */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                  <div className="form-control">
                    <label className="label py-0">
                      <span className="label-text text-xs font-bold uppercase opacity-60">Claim Units to List</span>
                    </label>
                    <input
                      type="number"
                      name="amount"
                      className="input input-bordered input-sm w-full rounded-full border-2 border-base-300 bg-base-100 font-medium text-base-content/70 placeholder:text-accent/70"
                      value={formData.amount}
                      onChange={handleInputChange}
                      placeholder="e.g. 1000"
                      required
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                      {[25, 50, 75, 100].map(pct => (
                        <button
                          key={pct}
                          type="button"
                          className="btn btn-xs btn-outline"
                          onClick={() => {
                            const base = prefillAmount ? BigInt(prefillAmount) : (walletBalance ?? 0n);
                            if (base === 0n) return;
                            const nextAmount = (base * BigInt(pct)) / 100n;
                            setFormData(prev => ({ ...prev, amount: nextAmount.toString() }));
                          }}
                        >
                          {pct}%
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="form-control">
                    <label className="label py-0">
                      <span className="label-text text-xs font-bold uppercase opacity-60">
                        Price per Claim Unit ({symbol})
                      </span>
                    </label>
                    <div className="flex w-full rounded-full border-2 border-base-300 bg-base-100 text-accent">
                      <input
                        type="number"
                        step="0.000001"
                        name="pricePerToken"
                        className="input input-ghost input-sm h-[2.2rem] min-h-[2.2rem] w-full border-0 px-4 font-medium text-base-content/70 placeholder:text-accent/70 focus:bg-transparent focus:outline-hidden focus-within:border-transparent focus:text-base-content/70"
                        value={formData.pricePerToken}
                        onChange={handleInputChange}
                        placeholder="e.g. 1.00"
                        required
                      />
                      <span className="mr-1 flex items-center self-center rounded-full bg-base-300 px-3 py-1 text-xs font-medium text-base-content/80">
                        {symbol}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {[
                        { label: "-10%", bp: -1000 },
                        { label: "-5%", bp: -500 },
                        { label: "0%", bp: 0 },
                        { label: "+5%", bp: 500 },
                      ].map(option => (
                        <button
                          key={option.label}
                          type="button"
                          className="btn btn-xs btn-outline"
                          onClick={() => setPriceFromDelta(option.bp)}
                          disabled={!baseTokenPrice}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Row 2: Fees + Duration */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">
                  {isPrimaryFlow ? (
                    <>
                      <div className="form-control">
                        <label className="label py-0">
                          <span className="label-text text-xs font-bold uppercase opacity-60">Listing Duration</span>
                        </label>
                        <select
                          name="durationDays"
                          className="select select-bordered select-sm w-full"
                          value={formData.durationDays}
                          onChange={handleInputChange}
                        >
                          <option value="7">7 Days</option>
                          <option value="14">14 Days</option>
                          <option value="30">30 Days</option>
                          <option value="60">60 Days</option>
                          <option value="90">90 Days</option>
                        </select>
                        <div className="flex flex-col items-end pt-2 text-right">
                          <span className="text-xs uppercase opacity-50 font-bold">Expires On</span>
                          <span className="text-sm font-bold text-base-content">{formatDate(expiryDate)}</span>
                        </div>
                      </div>
                      <div className="form-control">
                        <label className="label py-0">
                          <span className="label-text text-xs font-bold uppercase opacity-60">Fees</span>
                        </label>
                        <select className="select select-bordered select-sm w-full" disabled>
                          <option>Buyer pays protocol fee</option>
                        </select>
                      </div>
                    </>
                  ) : (
                    <div className="form-control">
                      <label className="label py-0">
                        <span className="label-text text-xs font-bold uppercase opacity-60">Fees</span>
                      </label>
                      <select
                        name="buyerPaysFee"
                        className="select select-bordered select-sm w-full"
                        value={formData.buyerPaysFee}
                        onChange={handleInputChange}
                      >
                        <option value="buyer">Buyer Pays</option>
                        <option value="seller">Seller Pays</option>
                      </select>
                    </div>
                  )}
                  {!isPrimaryFlow ? (
                    <div className="form-control">
                      <label className="label py-0">
                        <span className="label-text text-xs font-bold uppercase opacity-60">Listing Duration</span>
                      </label>
                      <select
                        name="durationDays"
                        className="select select-bordered select-sm w-full"
                        value={formData.durationDays}
                        onChange={handleInputChange}
                      >
                        <option value="7">7 Days</option>
                        <option value="14">14 Days</option>
                        <option value="30">30 Days</option>
                        <option value="60">60 Days</option>
                        <option value="90">90 Days</option>
                      </select>
                      <div className="flex flex-col items-end pt-2 text-right">
                        <span className="text-xs uppercase opacity-50 font-bold">Expires On</span>
                        <span className="text-sm font-bold text-base-content">{formatDate(expiryDate)}</span>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              {/* Listing Summary */}
              <div className="bg-gradient-to-br from-primary/10 to-primary/5 dark:from-white/10 dark:to-white/5 rounded-lg p-3 border border-base-300">
                <h4 className="font-semibold text-xs uppercase tracking-wide opacity-70 dark:text-white/70 mb-3">
                  Listing Summary
                </h4>
                <div className="flex justify-between items-center">
                  <span className="font-normal dark:text-white/80">Gross Listing Value</span>
                  <span className="font-bold text-success text-xl">
                    {formatTokenAmount(totalValue, decimals)} {symbol}
                  </span>
                </div>
              </div>

              {/* Buffer Terms (Primary only) */}
              {isPrimaryFlow && (
                <div className="bg-primary/10 border border-base-300 rounded-lg p-3 text-xs">
                  <div className="flex justify-between items-center">
                    <span className="text-xs uppercase opacity-60 font-bold">Estimated Buffer</span>
                    <span className="font-bold text-sm">
                      {formatTokenAmount((estimatedBuffer as bigint | undefined) ?? 0n, decimals)} {symbol}
                    </span>
                  </div>
                  <p className="opacity-80 mt-2">
                    💰 Estimated buffer if this listing fully sells. Actual funding is finalized at settlement based on
                    executed sales.
                  </p>
                </div>
              )}

              {/* Info Box */}
              <div className="bg-info/10 border border-base-300 rounded-xl p-4 text-xs">
                <p className="opacity-80 mt-1 mb-1">
                  {isPrimaryFlow
                    ? "This listing locks your tokens while active. Buyers can purchase partial amounts, and sold tokens transfer immediately to the buyer."
                    : "Creating a listing locks the selected tokens in your wallet. Buyers can purchase partial amounts, and any unsold balance unlocks when the listing ends or expires."}
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
              <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <span className="loading loading-spinner loading-sm"></span>
                    Processing...
                  </>
                ) : !isApproved ? (
                  "Approve & List"
                ) : (
                  "List for Sale"
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
