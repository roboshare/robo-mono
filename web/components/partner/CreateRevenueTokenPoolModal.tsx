"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useEscClose } from "./useEscClose";
import { parseUnits } from "viem";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { usePaymentToken } from "~~/hooks/usePaymentToken";
import { formatTokenAmount } from "~~/utils/formatters";
import { calculatePrimaryPoolBuffers } from "~~/utils/primaryPoolBuffers";
import { notification } from "~~/utils/scaffold-eth";

interface CreateRevenueTokenPoolModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  vehicleId: string;
  assetValue: string;
}

export const CreateRevenueTokenPoolModal = ({
  isOpen,
  onClose,
  onSuccess,
  vehicleId,
  assetValue,
}: CreateRevenueTokenPoolModalProps) => {
  const { symbol, decimals } = usePaymentToken();
  const modalBoxRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [currentStep, setCurrentStep] = useState(1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [touchedFields, setTouchedFields] = useState<Record<string, boolean>>({});
  const [showValidation, setShowValidation] = useState(false);
  const [formData, setFormData] = useState({
    maturityMonths: "36",
    tokenPrice: "",
    revenueShareBP: "",
    targetYieldBP: "",
    immediateProceeds: false,
    protectionEnabled: false,
  });

  const assetValueBigInt = assetValue ? BigInt(assetValue) : 0n;
  const tokenPriceBigInt = formData.tokenPrice ? parseUnits(formData.tokenPrice, 6) : 0n;
  const toBasisPoints = (value: string) => {
    const numeric = parseFloat(value);
    if (!Number.isFinite(numeric)) return 0n;
    return BigInt(Math.round(numeric * 100));
  };
  const revenueShareBP = toBasisPoints(formData.revenueShareBP);
  const targetYieldBP = toBasisPoints(formData.targetYieldBP);
  const proceedsProfileLabel = formData.immediateProceeds ? "Earlier Proceeds Access" : "Gradual Proceeds Access";
  const protectionLabel = formData.protectionEnabled ? "Enabled" : "Disabled";
  const bufferQuote = calculatePrimaryPoolBuffers(assetValueBigInt, targetYieldBP, formData.protectionEnabled);
  const displayedBufferLabel = formData.protectionEnabled ? "Required Total Buffer" : "Required Protocol Buffer";
  const displayedBufferAmount = formData.protectionEnabled ? bufferQuote.totalBuffer : bufferQuote.protocolBuffer;
  const requestedSupply = tokenPriceBigInt > 0n ? assetValueBigInt / tokenPriceBigInt : 0n;

  const { writeContractAsync: writeVehicleRegistry } = useScaffoldWriteContract({ contractName: "VehicleRegistry" });

  useEscClose(isOpen, onClose);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const modalEl = modalBoxRef.current;
    if (modalEl) {
      modalEl.scrollTop = 0;
    }
    const contentEl = contentRef.current;
    if (!contentEl) return;
    contentEl.scrollTop = 0;
    requestAnimationFrame(() => {
      if (modalEl) {
        modalEl.scrollTop = 0;
      }
      contentEl.scrollTop = 0;
    });
  }, [currentStep, isOpen]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    const nextValue = e.target instanceof HTMLInputElement && e.target.type === "checkbox" ? e.target.checked : value;
    setFormData(prev => ({ ...prev, [name]: nextValue }));
  };

  const handleFieldBlur = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name } = e.target;
    setTouchedFields(prev => ({ ...prev, [name]: true }));
  };

  const isStepValid = (() => {
    if (currentStep === 1) {
      return (
        formData.tokenPrice.trim() &&
        formData.revenueShareBP.trim() &&
        formData.targetYieldBP.trim() &&
        formData.maturityMonths.trim()
      );
    }
    return true;
  })();

  const isMissing = (field: keyof typeof formData) => {
    const value = formData[field];
    return (showValidation || touchedFields[field as string]) && typeof value === "string" && !value.trim();
  };
  const inputClass = (base: string, field: keyof typeof formData) => `${base} ${isMissing(field) ? "input-error" : ""}`;
  const markRequiredForStep = () => {
    const requiredFields = ["tokenPrice", "revenueShareBP", "targetYieldBP", "maturityMonths"];
    const nextTouched: Record<string, boolean> = {};
    requiredFields.forEach(field => {
      nextTouched[field] = true;
    });
    setTouchedFields(prev => ({ ...prev, ...nextTouched }));
    setShowValidation(true);
  };

  const handleNext = () => {
    if (!isStepValid) {
      markRequiredForStep();
      notification.error("Please complete the required fields before continuing.");
      return;
    }
    setCurrentStep(prev => Math.min(prev + 1, 2));
  };

  const handleBack = () => {
    if (currentStep === 1) {
      onClose();
    } else {
      setCurrentStep(prev => prev - 1);
    }
  };

  const handleCreatePrimaryPool = async () => {
    setIsProcessing(true);
    try {
      const maturityTimestamp = BigInt(
        Math.floor(Date.now() / 1000) + parseInt(formData.maturityMonths) * 30 * 24 * 60 * 60,
      );

      await writeVehicleRegistry({
        functionName: "createRevenueTokenPool",
        args: [
          BigInt(vehicleId),
          tokenPriceBigInt,
          maturityTimestamp,
          revenueShareBP,
          targetYieldBP,
          requestedSupply,
          formData.immediateProceeds,
          formData.protectionEnabled,
        ],
      });
      onSuccess?.();
      onClose();
    } catch (e) {
      console.error("Error:", e);
      notification.error(`Offering creation failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setIsProcessing(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal modal-open">
      <div className="modal-backdrop bg-black/50 backdrop-blur-sm hidden sm:block" onClick={onClose} />
      <div
        ref={modalBoxRef}
        className="modal-box relative w-full h-full max-h-full sm:max-h-[90vh] sm:max-w-xl sm:rounded-2xl rounded-none flex flex-col p-0 overflow-hidden"
      >
        <button className="btn btn-sm btn-circle btn-ghost absolute right-3 top-3 z-10" onClick={onClose}>
          <XMarkIcon className="h-5 w-5" />
        </button>

        <div className="flex items-center px-4 py-3 border-b border-base-200 shrink-0">
          <h3 className="font-bold text-lg flex items-center gap-2">
            <button type="button" className="btn btn-xs btn-ghost btn-circle" onClick={handleBack}>
              ←
            </button>
            {currentStep === 1 ? "Financial Terms" : "Offering Review"}
          </h3>
        </div>

        <div className="flex justify-center items-center gap-2 py-2 border-b border-base-200 shrink-0">
          {[1, 2].map(step => (
            <div key={step} className="flex items-center gap-2">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                  step <= currentStep ? "bg-primary text-primary-content" : "bg-base-300 text-base-content/50"
                }`}
              >
                {step}
              </div>
              {step < 2 && <div className={`w-8 h-0.5 ${step < currentStep ? "bg-primary" : "bg-base-300"}`} />}
            </div>
          ))}
        </div>

        <div key={currentStep} ref={contentRef} className="flex-1 overflow-y-auto p-5">
          {currentStep === 1 && (
            <div className="flex flex-col justify-between h-full gap-3">
              <div className="bg-base-200 border border-base-300 rounded-xl p-4 space-y-4">
                <h4 className="font-semibold text-sm uppercase tracking-wide opacity-70">Token Configuration</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="form-control">
                    <label className="label pb-1">
                      <span className="label-text font-medium">Token Price ({symbol})</span>
                      {isMissing("tokenPrice") && <span className="label-text-alt text-error">Required</span>}
                    </label>
                    <div
                      className={`flex w-full rounded-full border-2 bg-base-100 text-accent ${
                        isMissing("tokenPrice") ? "border-error" : "border-base-300"
                      }`}
                    >
                      <input
                        type="number"
                        name="tokenPrice"
                        className={inputClass(
                          "input input-ghost h-[2.2rem] min-h-[2.2rem] w-full border-0 px-4 font-medium text-base-content/70 placeholder:text-accent/70 focus:bg-transparent focus:outline-hidden focus-within:border-transparent focus:text-base-content/70",
                          "tokenPrice",
                        )}
                        value={formData.tokenPrice}
                        onChange={handleInputChange}
                        onBlur={handleFieldBlur}
                        placeholder="e.g. 100"
                        step="0.01"
                        required
                      />
                      <span className="mr-1 flex items-center self-center rounded-full bg-base-300 px-3 py-1 text-xs font-medium text-base-content/80">
                        {symbol}
                      </span>
                    </div>
                  </div>
                  <div className="bg-primary/10 dark:bg-white/10 border border-base-300 rounded-lg p-2 text-center w-full self-end min-h-[88px] flex flex-col items-center justify-center">
                    <span className="text-[10px] uppercase opacity-60 font-bold block">Projected Supply</span>
                    <span className="text-md font-bold text-base-content dark:text-white">
                      {tokenPriceBigInt > 0n ? (assetValueBigInt / tokenPriceBigInt).toLocaleString() : "0"} Tokens
                    </span>
                  </div>
                  <div className="form-control">
                    <label className="label pb-1">
                      <span className="label-text font-medium">Revenue Share Cap (%)</span>
                      {isMissing("revenueShareBP") && <span className="label-text-alt text-error">Required</span>}
                    </label>
                    <input
                      type="number"
                      name="revenueShareBP"
                      className={inputClass(
                        "input input-bordered w-full rounded-full border-2 border-base-300 bg-base-100 font-medium text-base-content/70 placeholder:text-accent/70",
                        "revenueShareBP",
                      )}
                      value={formData.revenueShareBP}
                      onChange={handleInputChange}
                      onBlur={handleFieldBlur}
                      placeholder="e.g. 50"
                      required
                    />
                  </div>
                  <div className="form-control">
                    <label className="label pb-1">
                      <span className="label-text font-medium">Target Yield (%)</span>
                      {isMissing("targetYieldBP") && <span className="label-text-alt text-error">Required</span>}
                    </label>
                    <input
                      type="number"
                      name="targetYieldBP"
                      className={inputClass(
                        "input input-bordered w-full rounded-full border-2 border-base-300 bg-base-100 font-medium text-base-content/70 placeholder:text-accent/70",
                        "targetYieldBP",
                      )}
                      value={formData.targetYieldBP}
                      onChange={handleInputChange}
                      onBlur={handleFieldBlur}
                      placeholder="e.g. 10"
                      required
                    />
                  </div>
                  <div className="form-control sm:col-span-2">
                    <label className="label pb-1">
                      <span className="label-text font-medium">Maturity Duration</span>
                      {isMissing("maturityMonths") && <span className="label-text-alt text-error">Required</span>}
                    </label>
                    <select
                      name="maturityMonths"
                      className={`select select-bordered w-full rounded-full border-2 bg-base-100 font-medium text-base-content/70 ${
                        isMissing("maturityMonths") ? "border-error select-error" : "border-base-300"
                      }`}
                      value={formData.maturityMonths}
                      onChange={handleInputChange}
                      onBlur={handleFieldBlur}
                    >
                      <option value="36">36 Months (3 years)</option>
                      <option value="48">48 Months (4 years)</option>
                      <option value="60">60 Months (5 years)</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="bg-base-200 border border-base-300 rounded-xl p-4 space-y-4">
                <h4 className="font-semibold text-sm uppercase tracking-wide opacity-70">Pool Preferences</h4>
                <div className="space-y-4">
                  <div className="form-control gap-2">
                    <label className="label pb-0">
                      <span className="label-text font-medium">Proceeds Access</span>
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <button
                        type="button"
                        className={`rounded-[1.75rem] border px-5 py-4 text-left transition ${
                          !formData.immediateProceeds
                            ? "border-primary bg-primary/20 shadow-[inset_0_0_0_2px_rgba(96,165,250,0.45)]"
                            : "border-base-300 bg-base-100 hover:border-base-content/30"
                        }`}
                        onClick={() => setFormData(prev => ({ ...prev, immediateProceeds: false }))}
                      >
                        <span className="block text-left">
                          <span className="block font-semibold">Gradual Proceeds Access</span>
                          <span className="mt-1 block text-xs opacity-80">
                            Your proceeds become available over time after the required reserves are funded.
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`rounded-[1.75rem] border px-5 py-4 text-left transition ${
                          formData.immediateProceeds
                            ? "border-primary bg-primary/20 shadow-[inset_0_0_0_2px_rgba(96,165,250,0.45)]"
                            : "border-base-300 bg-base-100 hover:border-base-content/30"
                        }`}
                        onClick={() => setFormData(prev => ({ ...prev, immediateProceeds: true }))}
                      >
                        <span className="block text-left">
                          <span className="block font-semibold">Earlier Proceeds Access</span>
                          <span className="mt-1 block text-xs opacity-80">
                            Your proceeds become available sooner once the required reserves are funded.
                          </span>
                        </span>
                      </button>
                    </div>
                  </div>

                  <label className="flex items-start gap-3 rounded-lg border border-base-300 bg-base-100 px-4 py-3 cursor-pointer">
                    <input
                      type="checkbox"
                      name="protectionEnabled"
                      className="checkbox checkbox-sm mt-0.5"
                      checked={formData.protectionEnabled}
                      onChange={handleInputChange}
                    />
                    <span>
                      <span className="block font-medium">Add Protection</span>
                      <span className="block text-xs opacity-70">
                        Adds optional partner-funded protection on top of the required reserve.
                      </span>
                    </span>
                  </label>

                  <div className="rounded-lg border border-base-300 bg-primary/10 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-bold uppercase opacity-60">{displayedBufferLabel}</span>
                      <span className="text-sm font-semibold text-base-content dark:text-white">
                        {formatTokenAmount(displayedBufferAmount, decimals)} {symbol}
                      </span>
                    </div>
                    <p className="mt-2 text-xs opacity-75">
                      {formData.protectionEnabled
                        ? "Total reserve includes the required reserve plus the optional protection reserve."
                        : "Includes only the required reserve. Protection can be added on top."}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {currentStep === 2 && (
            <div className="flex flex-col justify-between h-full gap-3">
              <div className="bg-gradient-to-br from-primary/10 to-primary/5 dark:from-white/10 dark:to-white/5 rounded-xl p-4 border border-base-300">
                <h4 className="font-semibold text-xs uppercase tracking-wide opacity-70 dark:text-white/70 mb-4">
                  Offering Summary
                </h4>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="opacity-70 dark:text-white/70">Total Claim Units</span>
                    <span className="font-bold text-lg text-base-content dark:text-white">
                      {tokenPriceBigInt > 0n ? (assetValueBigInt / tokenPriceBigInt).toLocaleString() : "—"} Claim Units
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="opacity-70 dark:text-white/70">Price per Claim Unit</span>
                    <span className="font-bold text-lg text-base-content dark:text-white">
                      {formData.tokenPrice ? `${Number(formData.tokenPrice).toLocaleString()} ${symbol}` : "—"}
                    </span>
                  </div>
                  <div className="divider my-1 opacity-20"></div>
                  <div className="flex justify-between items-center">
                    <span className="font-normal dark:text-white/80">Offering Size</span>
                    <span className="font-bold text-success text-xl">
                      {assetValue ? `${formatTokenAmount(assetValueBigInt, decimals)} ${symbol}` : "—"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="bg-primary/10 border border-base-300 rounded-xl p-4">
                <div className="flex justify-between items-center">
                  <span className="text-xs uppercase opacity-60 font-bold">{displayedBufferLabel}</span>
                  <span className="font-bold text-base-content dark:text-white">
                    {formatTokenAmount(displayedBufferAmount, decimals)} {symbol}
                  </span>
                </div>
                <p className="text-xs opacity-80 mt-2">
                  {formData.protectionEnabled
                    ? "Total reserve includes the required reserve plus the optional protection reserve at full subscription."
                    : "Required partner-funded reserve at full subscription. Buyer funds are not used to fund reserves."}
                </p>
              </div>

              <div className="bg-base-200 border border-base-300 rounded-xl p-4 space-y-4">
                <h4 className="font-semibold text-xs uppercase tracking-wide opacity-70">Offering Settings</h4>
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between items-center">
                    <span className="opacity-70">Proceeds Access</span>
                    <span className="font-semibold">{proceedsProfileLabel}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="opacity-70">Protection</span>
                    <span className="font-semibold">{protectionLabel}</span>
                  </div>
                </div>
              </div>

              <div className="bg-info/10 border border-base-300 rounded-xl p-4 text-xs">
                <p className="opacity-80 mt-1 mb-1">
                  This creates a continuous offering. Claim units are issued to buyers as purchases happen.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-base-200 bg-base-100 p-4 space-y-2">
          <div
            onClick={() => {
              if (!isStepValid && !isProcessing) {
                markRequiredForStep();
                notification.error("Please complete the required fields before continuing.");
              }
            }}
          >
            <button
              type="button"
              className="btn btn-primary w-full"
              onClick={currentStep === 2 ? handleCreatePrimaryPool : handleNext}
              disabled={isProcessing || !isStepValid}
            >
              {isProcessing ? <span className="loading loading-spinner loading-xs"></span> : null}
              {isProcessing ? "Processing..." : currentStep === 2 ? "Create Offering" : "Continue →"}
            </button>
          </div>
          {!isStepValid && (
            <button
              type="button"
              className="btn btn-link btn-xs w-full shadow-none !shadow-none bg-transparent border-0 hover:bg-transparent"
              onClick={markRequiredForStep}
            >
              Review required fields
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
