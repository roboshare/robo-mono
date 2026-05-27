"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { encodeAbiParameters, parseAbiParameters, parseUnits } from "viem";
import { useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { usePaymentToken } from "~~/hooks/usePaymentToken";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import { formatTokenAmount } from "~~/utils/formatters";
import { uploadToIpfs } from "~~/utils/ipfs";
import { calculatePrimaryPoolBuffers } from "~~/utils/primaryPoolBuffers";
import { notification } from "~~/utils/scaffold-eth";

interface RegisterVehicleFormProps {
  onClose: () => void;
  onSuccess?: () => void;
  maxStep: 1 | 3;
  onBack: () => void;
}

const STEP_TITLES = {
  1: "Vehicle Details",
  2: "Financial Terms",
  3: "Offering Review",
};

const MILE_REGIONS = new Set(["US", "GB", "UK", "LR", "MM"]);
const MILE_TIMEZONES = new Set([
  "Europe/London",
  "Africa/Monrovia",
  "Asia/Yangon",
  "Asia/Rangoon",
  "America/New_York",
  "America/Detroit",
  "America/Kentucky/Louisville",
  "America/Kentucky/Monticello",
  "America/Indiana/Indianapolis",
  "America/Indiana/Vincennes",
  "America/Indiana/Winamac",
  "America/Indiana/Marengo",
  "America/Indiana/Petersburg",
  "America/Indiana/Vevay",
  "America/Chicago",
  "America/Menominee",
  "America/North_Dakota/Center",
  "America/North_Dakota/New_Salem",
  "America/North_Dakota/Beulah",
  "America/Denver",
  "America/Boise",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Juneau",
  "America/Sitka",
  "America/Metlakatla",
  "America/Yakutat",
  "America/Nome",
  "America/Adak",
  "Pacific/Honolulu",
]);

const getRegionFromLocale = (locale: string): string | null => {
  if (!locale) return null;

  try {
    if (typeof Intl !== "undefined" && "Locale" in Intl) {
      const region = new Intl.Locale(locale).region;
      if (region) return region.toUpperCase();
    }
  } catch {
    // Fall through to simple parsing.
  }

  const match = locale.match(/[-_](\w{2})\b/);
  return match?.[1]?.toUpperCase() ?? null;
};

const getRegionFromTimeZone = (timeZone: string): string | null => {
  if (!timeZone) return null;

  if (MILE_TIMEZONES.has(timeZone)) {
    if (timeZone === "Europe/London") return "GB";
    if (timeZone === "Africa/Monrovia") return "LR";
    if (timeZone === "Asia/Yangon" || timeZone === "Asia/Rangoon") return "MM";
    return "US";
  }

  return null;
};

const getDefaultOdometerUnit = (): "mi" | "km" => {
  if (typeof navigator === "undefined") return "km";

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const regionFromTimeZone = getRegionFromTimeZone(timeZone);
  if (regionFromTimeZone) {
    return MILE_REGIONS.has(regionFromTimeZone) ? "mi" : "km";
  }

  const locales = [...(navigator.languages ?? []), navigator.language].filter(Boolean);
  for (const locale of locales) {
    const region = getRegionFromLocale(locale);
    if (!region) continue;
    return MILE_REGIONS.has(region) ? "mi" : "km";
  }

  return "km";
};

export const RegisterVehicleForm = ({ onClose, onSuccess, maxStep, onBack }: RegisterVehicleFormProps) => {
  const { address: accountAddress } = useTransactingAccount();
  const { symbol, decimals } = usePaymentToken();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [currentStep, setCurrentStep] = useState(1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAwaitingSignature, setIsAwaitingSignature] = useState(false);
  const [busyAction, setBusyAction] = useState<"registerOnly" | "continue" | "primary" | null>(null);
  const [processedData, setProcessedData] = useState<{ encodedVehicleData: `0x${string}` } | null>(null);
  const [processedFingerprint, setProcessedFingerprint] = useState<string | null>(null);
  const [allowMintList, setAllowMintList] = useState(false);
  const [draftData, setDraftData] = useState<any | null>(null);
  const [showDraftPrompt, setShowDraftPrompt] = useState(false);
  const [touchedFields, setTouchedFields] = useState<Record<string, boolean>>({});
  const [showValidation, setShowValidation] = useState(false);

  const [formData, setFormData] = useState({
    // Step 1: Vehicle Details
    vin: "",
    make: "",
    model: "",
    year: new Date().getFullYear().toString(),
    manufacturerId: "1",
    optionCodes: "",
    odometer: "",
    odometerUnit: getDefaultOdometerUnit(),
    // Step 2: Financial Terms
    maturityMonths: "36",
    tokenPrice: "",
    assetValue: "",
    revenueShareBP: "",
    targetYieldBP: "",
    immediateProceeds: false,
    protectionEnabled: false,
  });

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageName, setImageName] = useState<string | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [imageThumbnail, setImageThumbnail] = useState<string | null>(null);

  const {
    writeContractAsync: writeVehicleRegistry,
    isMining: isWritingVehicleRegistry,
    isPending: isVehicleWritePending,
  } = useScaffoldWriteContract({
    contractName: "VehicleRegistry",
  });
  const tokenPriceBigInt = formData.tokenPrice ? parseUnits(formData.tokenPrice, 6) : 0n;
  const assetValueBigInt = formData.assetValue ? parseUnits(formData.assetValue, 6) : 0n;
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

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    const nextValue = e.target instanceof HTMLInputElement && e.target.type === "checkbox" ? e.target.checked : value;
    setFormData(prev => ({ ...prev, [name]: nextValue }));
  };

  const handleFieldBlur = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name } = e.target;
    setTouchedFields(prev => ({ ...prev, [name]: true }));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setImageFile(file);
      setImageName(file.name);
      setProcessedData(null);
      setProcessedFingerprint(null);
      setImageThumbnail(null);
      const previewUrl = URL.createObjectURL(file);
      setImagePreviewUrl(previewUrl);
      void createThumbnail(file)
        .then(thumbnail => {
          if (thumbnail) {
            setImageThumbnail(thumbnail);
            setImagePreviewUrl(thumbnail);
          }
        })
        .finally(() => {
          URL.revokeObjectURL(previewUrl);
        });
    }
  };

  const clearImage = () => {
    setImageFile(null);
    setImageName(null);
    setFileInputKey(prev => prev + 1);
    setProcessedData(null);
    setProcessedFingerprint(null);
    setImagePreviewUrl(null);
    setImageThumbnail(null);
  };

  const draftKey = useMemo(
    () => `roboshare:registerVehicleDraft:${accountAddress?.toLowerCase() || "guest"}`,
    [accountAddress],
  );

  const createThumbnail = async (file: File, maxSize = 160): Promise<string> => {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(maxSize / bitmap.width, maxSize / bitmap.height, 1);
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        bitmap.close();
        return "";
      }
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      return canvas.toDataURL("image/jpeg", 0.8);
    }
    return await new Promise((resolve, reject) => {
      const img = new window.Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          URL.revokeObjectURL(url);
          resolve("");
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Thumbnail load failed"));
      };
      img.src = url;
    });
  };
  const getFingerprint = useCallback(
    (data: typeof formData) =>
      [
        data.vin,
        data.make,
        data.model,
        data.year,
        data.manufacturerId,
        data.optionCodes,
        data.odometer,
        data.odometerUnit,
        imageName || "",
      ].join("|"),
    [imageName],
  );

  useEffect(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed?.formData) return;
      setDraftData(parsed);
      setShowDraftPrompt(true);
    } catch {
      // ignore malformed drafts
    }
  }, [draftKey]);

  useEffect(() => {
    const fingerprint = getFingerprint(formData);
    if (processedFingerprint && processedFingerprint !== fingerprint) {
      setProcessedData(null);
      setProcessedFingerprint(null);
    }
  }, [formData, processedFingerprint, getFingerprint]);

  useEffect(() => {
    const hasMeaningfulInput =
      formData.vin.trim() ||
      formData.make.trim() ||
      formData.model.trim() ||
      formData.assetValue.trim() ||
      formData.tokenPrice.trim() ||
      !!imageName ||
      !!imageThumbnail;

    if (!hasMeaningfulInput) return;

    const payload = {
      formData,
      currentStep,
      allowMintList,
      processedData,
      processedFingerprint,
      imageName,
      imageThumbnail,
    };
    try {
      localStorage.setItem(draftKey, JSON.stringify(payload));
    } catch {
      // ignore storage failures
    }
  }, [formData, currentStep, allowMintList, processedData, processedFingerprint, imageName, imageThumbnail, draftKey]);

  const clearDraft = () => {
    try {
      localStorage.removeItem(draftKey);
    } catch {
      // ignore
    }
    setDraftData(null);
    setShowDraftPrompt(false);
    setProcessedData(null);
    setProcessedFingerprint(null);
    setAllowMintList(false);
    setImageFile(null);
    setImageName(null);
    setFileInputKey(prev => prev + 1);
    setImagePreviewUrl(null);
    setImageThumbnail(null);
  };

  const loadDraft = () => {
    if (!draftData) return;
    if (draftData.formData) setFormData(draftData.formData);
    if (draftData.processedData) setProcessedData(draftData.processedData);
    if (draftData.processedFingerprint) setProcessedFingerprint(draftData.processedFingerprint);
    if (draftData.allowMintList !== undefined) setAllowMintList(draftData.allowMintList);
    if (draftData.currentStep) setCurrentStep(draftData.currentStep);
    if (draftData.imageName) setImageName(draftData.imageName);
    if (draftData.imageThumbnail) {
      setImageThumbnail(draftData.imageThumbnail);
      setImagePreviewUrl(draftData.imageThumbnail);
    }
    setShowDraftPrompt(false);
  };

  // Step 1 action: Register only
  const handleRegisterOnly = async () => {
    setBusyAction("registerOnly");
    setIsProcessing(true);
    setIsAwaitingSignature(true);
    try {
      const encodedData = processedData?.encodedVehicleData ?? (await processVehicleData());
      if (!encodedData) throw new Error("Failed to encode vehicle data");

      await writeVehicleRegistry({
        functionName: "registerAsset",
        args: [encodedData, assetValueBigInt],
      });
      onSuccess?.();
      clearDraft();
      onClose();
    } catch (e) {
      console.error("Error:", e);
      notification.error(`Registration failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setIsAwaitingSignature(false);
      setIsProcessing(false);
      setBusyAction(null);
    }
  };

  // Process IPFS upload and encode vehicle data (done when moving past Step 1)
  const processVehicleData = async () => {
    try {
      let imageUri = "";
      if (imageFile) {
        imageUri = await uploadToIpfs(imageFile);
      }

      const metadata = {
        vin: formData.vin,
        make: formData.make,
        model: formData.model,
        year: parseInt(formData.year),
        image: imageUri,
        optionCodes: formData.optionCodes
          .split(",")
          .map(s => s.trim())
          .filter(Boolean),
        odometer: formData.odometer ? parseInt(formData.odometer) : 0,
        odometerUnit: formData.odometerUnit,
      };

      // Upload metadata JSON to IPFS (uploadToIpfs handles object->blob conversion)
      const metadataUri = await uploadToIpfs(metadata);

      // The contract boundary now stores VIN plus explicit asset/revenue-token metadata pointers.
      // The current partner flow only uploads one metadata document, so reuse it for both token URIs.
      const encodedVehicleData = encodeAbiParameters(
        parseAbiParameters("string vin, string assetMetadataURI, string revenueTokenMetadataURI"),
        [formData.vin, metadataUri, metadataUri],
      );

      setProcessedData({ encodedVehicleData });
      setProcessedFingerprint(getFingerprint(formData));
      return encodedVehicleData;
    } catch (e) {
      console.error("Error processing vehicle data:", e);
      notification.error(`IPFS upload failed: ${e instanceof Error ? e.message : "Unknown error"}`);
      throw e;
    } finally {
      // callers manage processing state
    }
  };

  // Step 3 action: Register and create the primary pool.
  const handleRegisterAndCreatePrimaryPool = async () => {
    setBusyAction("primary");
    setIsProcessing(true);
    setIsAwaitingSignature(true);
    try {
      const encodedData = processedData?.encodedVehicleData ?? (await processVehicleData());
      if (!encodedData) throw new Error("Failed to encode vehicle data");

      const maturityTimestamp = BigInt(
        Math.floor(Date.now() / 1000) + parseInt(formData.maturityMonths) * 30 * 24 * 60 * 60,
      );

      await writeVehicleRegistry({
        functionName: "registerAssetAndCreateRevenueTokenPool",
        args: [
          encodedData,
          assetValueBigInt,
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
      clearDraft();
      onClose();
    } catch (e) {
      console.error("Error:", e);
      notification.error(`Transaction failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setIsAwaitingSignature(false);
      setIsProcessing(false);
      setBusyAction(null);
    }
  };

  const handleNext = async () => {
    if (!isStepValid) {
      notification.error("Please complete the required fields before continuing.");
      return;
    }
    if (currentStep === 1 && !processedData) {
      try {
        setBusyAction("continue");
        setIsProcessing(true);
        await processVehicleData();
      } catch (e) {
        console.error("Failed to process vehicle data:", e);
        return; // Don't proceed if IPFS upload failed
      } finally {
        setIsProcessing(false);
        setBusyAction(null);
      }
    }
    setCurrentStep(prev => Math.min(prev + 1, 3));
  };

  const handleBack = () => {
    if (currentStep === 1) {
      onBack();
    } else {
      setCurrentStep(prev => prev - 1);
    }
  };

  const isRegisterOnly = maxStep === 1 && !allowMintList;
  const isTxPending = isWritingVehicleRegistry || isVehicleWritePending;
  const isBusy = isProcessing || isTxPending || isAwaitingSignature;
  const isRegisterOnlyBusy = busyAction === "registerOnly" && isBusy;
  const isContinueBusy = busyAction === "continue" && isBusy;
  const isPrimaryBusy = busyAction === "primary" && isBusy;
  const isLastStep = currentStep === 3;
  const primaryLabel = isRegisterOnly ? "Register" : isLastStep ? "Create Offering" : "Continue →";
  const primaryAction = isRegisterOnly
    ? handleRegisterOnly
    : isLastStep
      ? handleRegisterAndCreatePrimaryPool
      : handleNext;
  const isMissing = (field: keyof typeof formData) => {
    const value = formData[field];
    return (showValidation || touchedFields[field as string]) && typeof value === "string" && !value.trim();
  };
  const pillInputClass =
    "input input-bordered w-full rounded-full border-2 border-base-300 bg-base-100 font-medium text-base-content/70 placeholder:text-accent/70";
  const pillSelectClass =
    "select select-bordered w-full rounded-full border-2 border-base-300 bg-base-100 font-medium text-base-content/70";
  const requiredPillInputClass = (field: keyof typeof formData) =>
    `${pillInputClass} ${isMissing(field) ? "!border-error" : ""}`;
  const requiredPillSelectClass = (field: keyof typeof formData) =>
    `${pillSelectClass} ${isMissing(field) ? "!border-error select-error" : ""}`;
  const markRequiredForStep = () => {
    const requiredFields =
      currentStep === 1
        ? ["assetValue", "vin", "make", "model", "year"]
        : currentStep === 2
          ? ["tokenPrice", "revenueShareBP", "targetYieldBP", "maturityMonths"]
          : [];
    const nextTouched: Record<string, boolean> = {};
    requiredFields.forEach(field => {
      nextTouched[field] = true;
    });
    setTouchedFields(prev => ({ ...prev, ...nextTouched }));
    setShowValidation(true);
  };
  const isStepValid = (() => {
    if (currentStep === 1) {
      return (
        formData.assetValue.trim() &&
        formData.vin.trim() &&
        formData.make.trim() &&
        formData.model.trim() &&
        formData.year.trim()
      );
    }
    if (currentStep === 2) {
      return (
        formData.tokenPrice.trim() &&
        formData.revenueShareBP.trim() &&
        formData.targetYieldBP.trim() &&
        formData.maturityMonths.trim()
      );
    }
    if (currentStep === 3) {
      return true;
    }
    return true;
  })();

  const runIfStepValid = (callback: () => void | Promise<void>) => {
    if (!isStepValid) {
      markRequiredForStep();
      notification.error("Please complete the required fields before continuing.");
      return;
    }

    void callback();
  };
  const footerButtonDisabledClass =
    "disabled:!bg-base-300 disabled:!text-base-content/40 disabled:!border-base-300 disabled:!shadow-none disabled:opacity-100";
  const footerGhostDisabledClass =
    "disabled:!bg-transparent disabled:!text-base-content/40 disabled:!border-transparent disabled:!shadow-none disabled:opacity-100";

  useLayoutEffect(() => {
    const modalEl = contentRef.current?.closest(".modal-box") as HTMLDivElement | null;
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
  }, [currentStep]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center px-4 py-3 border-b border-base-200 shrink-0">
        <h3 className="font-bold text-lg flex items-center gap-2">
          <button type="button" className="btn btn-xs btn-ghost btn-circle" onClick={handleBack}>
            ←
          </button>
          {STEP_TITLES[currentStep as keyof typeof STEP_TITLES]}
        </h3>
      </div>

      {/* Step indicator */}
      <div className="flex justify-center items-center gap-2 py-2 border-b border-base-200 shrink-0">
        {[1, 2, 3].map(step => (
          <div key={step} className="flex items-center gap-2">
            <div
              className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                step <= currentStep ? "bg-primary text-primary-content" : "bg-base-300 text-base-content/50"
              }`}
            >
              {step}
            </div>
            {step < 3 && <div className={`w-8 h-0.5 ${step < currentStep ? "bg-primary" : "bg-base-300"}`} />}
          </div>
        ))}
      </div>

      {/* Scrollable content */}
      <div key={currentStep} ref={contentRef} className="flex-1 overflow-y-auto p-5">
        {!isStepValid && (
          <div className="mb-3 flex items-center justify-between gap-3 text-xs text-base-content/60">
            <span>Required fields are missing.</span>
            <button
              type="button"
              className="btn btn-ghost btn-xs h-auto min-h-0 rounded-full px-3 py-1 text-xs font-medium"
              onClick={markRequiredForStep}
            >
              Review
            </button>
          </div>
        )}
        {showDraftPrompt && (
          <div className="mb-4 rounded-xl border border-base-300 bg-base-200 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="text-sm">
              <div className="font-semibold">Resume your draft?</div>
              <div className="opacity-70">You have a saved draft for this asset.</div>
            </div>
            <div className="flex gap-2">
              <button type="button" className="btn btn-sm btn-ghost" onClick={clearDraft}>
                Discard
              </button>
              <button type="button" className="btn btn-sm btn-primary" onClick={loadDraft}>
                Resume
              </button>
            </div>
          </div>
        )}
        {/* Step 1: Vehicle Details */}
        {currentStep === 1 && (
          <div className="flex flex-col justify-between h-full gap-3">
            {/* Image Upload Section */}
            <div className="bg-base-200 border border-base-300 rounded-xl p-4">
              <label className="block text-sm font-medium mb-2">Vehicle Image</label>
              <input
                key={fileInputKey}
                type="file"
                className="file-input file-input-bordered w-full"
                onChange={handleFileChange}
                accept="image/*"
              />
              {imageName && (
                <div className="mt-3 flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-10 w-10 rounded-lg bg-base-300 overflow-hidden flex items-center justify-center">
                      {imagePreviewUrl ? (
                        <Image
                          src={imagePreviewUrl}
                          alt={imageName}
                          width={40}
                          height={40}
                          className="h-full w-full object-cover"
                          unoptimized
                        />
                      ) : (
                        <span className="text-[10px] opacity-60">Image</span>
                      )}
                    </div>
                    <span className="opacity-70 truncate">
                      Selected image: <span className="font-medium">{imageName}</span>
                    </span>
                  </div>
                  <button type="button" className="btn btn-ghost btn-xs text-error" onClick={clearImage}>
                    Remove
                  </button>
                </div>
              )}
              <p className="text-xs opacity-60 mt-2">Upload a photo of your vehicle (optional)</p>
            </div>

            {/* Vehicle Identification */}
            <div className="bg-base-200 border border-base-300 rounded-xl p-4 space-y-4">
              <h4 className="font-semibold text-sm uppercase tracking-wide opacity-70">Asset Information</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="form-control">
                  <label className="label pb-1">
                    <span className="label-text font-medium">Asset Value ({symbol})</span>
                    {isMissing("assetValue") && <span className="label-text-alt text-error">Required</span>}
                  </label>
                  <div
                    className={`flex w-full rounded-full border-2 bg-base-100 text-accent ${
                      isMissing("assetValue") ? "border-error" : "border-base-300"
                    }`}
                  >
                    <input
                      type="number"
                      name="assetValue"
                      className="input input-ghost h-[2.2rem] min-h-[2.2rem] w-full border-0 px-4 font-medium text-base-content/70 placeholder:text-accent/70 focus:bg-transparent focus:outline-hidden focus-within:border-transparent focus:text-base-content/70"
                      value={formData.assetValue}
                      onChange={handleInputChange}
                      onBlur={handleFieldBlur}
                      placeholder="e.g. 50000"
                      step="0.01"
                      required
                    />
                    <span className="mr-1 flex items-center self-center rounded-full bg-base-300 px-3 py-1 text-xs font-medium text-base-content/80">
                      {symbol}
                    </span>
                  </div>
                </div>
                <div className="form-control">
                  <label className="label pb-1">
                    <span className="label-text font-medium">VIN</span>
                    {isMissing("vin") && <span className="label-text-alt text-error">Required</span>}
                  </label>
                  <input
                    type="text"
                    name="vin"
                    className={requiredPillInputClass("vin")}
                    value={formData.vin}
                    onChange={handleInputChange}
                    onBlur={handleFieldBlur}
                    placeholder="Enter 17-character VIN"
                    required
                  />
                </div>
              </div>
            </div>

            {/* Vehicle Details */}
            <div className="bg-base-200 border border-base-300 rounded-xl p-4 space-y-4">
              <h4 className="font-semibold text-sm uppercase tracking-wide opacity-70">Vehicle Details</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="form-control">
                  <label className="label pb-1">
                    <span className="label-text font-medium">Make</span>
                    {isMissing("make") && <span className="label-text-alt text-error">Required</span>}
                  </label>
                  <input
                    type="text"
                    name="make"
                    className={requiredPillInputClass("make")}
                    value={formData.make}
                    onChange={handleInputChange}
                    onBlur={handleFieldBlur}
                    placeholder="e.g. Tesla"
                    required
                  />
                </div>
                <div className="form-control">
                  <label className="label pb-1">
                    <span className="label-text font-medium">Model</span>
                    {isMissing("model") && <span className="label-text-alt text-error">Required</span>}
                  </label>
                  <input
                    type="text"
                    name="model"
                    className={requiredPillInputClass("model")}
                    value={formData.model}
                    onChange={handleInputChange}
                    onBlur={handleFieldBlur}
                    placeholder="e.g. Model 3"
                    required
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="form-control">
                  <label className="label pb-1">
                    <span className="label-text font-medium">Year</span>
                    {isMissing("year") && <span className="label-text-alt text-error">Required</span>}
                  </label>
                  <input
                    type="number"
                    name="year"
                    className={requiredPillInputClass("year")}
                    value={formData.year}
                    onChange={handleInputChange}
                    onBlur={handleFieldBlur}
                    required
                  />
                </div>
                <div className="form-control">
                  <label className="label pb-1">
                    <span className="label-text font-medium">Odometer</span>
                    <span className="label-text-alt opacity-50">Optional</span>
                  </label>
                  <div className="join w-full">
                    <input
                      type="number"
                      name="odometer"
                      className="input input-bordered join-item w-full rounded-full border-2 border-base-300 bg-base-100 font-medium text-base-content/70 placeholder:text-accent/70"
                      value={formData.odometer}
                      onChange={handleInputChange}
                      placeholder="Current mileage"
                    />
                    <select
                      name="odometerUnit"
                      className="select select-bordered join-item rounded-full border-2 border-base-300 bg-base-100 font-medium text-base-content/70"
                      value={formData.odometerUnit}
                      onChange={handleInputChange}
                    >
                      <option value="mi">mi</option>
                      <option value="km">km</option>
                    </select>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="form-control">
                  <label className="label pb-1">
                    <span className="label-text font-medium">Manufacturer ID</span>
                    <span className="label-text-alt opacity-50">Optional</span>
                  </label>
                  <input
                    type="number"
                    name="manufacturerId"
                    className={pillInputClass}
                    value={formData.manufacturerId}
                    onChange={handleInputChange}
                    placeholder="e.g. 1"
                  />
                </div>
                <div className="form-control">
                  <label className="label pb-1">
                    <span className="label-text font-medium">Option Codes</span>
                    <span className="label-text-alt opacity-50">Optional</span>
                  </label>
                  <input
                    type="text"
                    name="optionCodes"
                    className={pillInputClass}
                    value={formData.optionCodes}
                    onChange={handleInputChange}
                    placeholder="e.g. AD15,PMNG"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Financial Terms */}
        {currentStep === 2 && (
          <div className="flex flex-col justify-between h-full gap-3">
            {/* Token Configuration */}
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
                      className="input input-ghost h-[2.2rem] min-h-[2.2rem] w-full border-0 px-4 font-medium text-base-content/70 placeholder:text-accent/70 focus:bg-transparent focus:outline-hidden focus-within:border-transparent focus:text-base-content/70"
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
                    className={requiredPillInputClass("revenueShareBP")}
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
                    className={requiredPillInputClass("targetYieldBP")}
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
                    className={requiredPillSelectClass("maturityMonths")}
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

        {/* Step 3: Primary Pool Review */}
        {currentStep === 3 && (
          <div className="flex flex-col justify-between h-full gap-3">
            {/* Primary Pool Summary */}
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
                    {formData.assetValue ? `${Number(formData.assetValue).toLocaleString()} ${symbol}` : "—"}
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

      {/* Sticky Footer */}
      <div className="shrink-0 border-t border-base-200 bg-base-100/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-base-100/85">
        {maxStep === 1 && currentStep === 1 && isRegisterOnly ? (
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              className={`btn btn-ghost min-h-11 rounded-full ${footerGhostDisabledClass}`}
              onClick={() =>
                runIfStepValid(async () => {
                  await handleRegisterOnly();
                })
              }
              disabled={isBusy || !isStepValid}
            >
              {isRegisterOnlyBusy ? <span className="loading loading-spinner loading-xs"></span> : null}
              {isRegisterOnlyBusy ? "Processing..." : "Register Only"}
            </button>
            <button
              type="button"
              className={`btn btn-primary min-h-11 rounded-full ${footerButtonDisabledClass}`}
              onClick={() =>
                runIfStepValid(async () => {
                  setAllowMintList(true);
                  await handleNext();
                })
              }
              disabled={isBusy || !isStepValid}
            >
              {isContinueBusy ? <span className="loading loading-spinner loading-xs"></span> : null}
              {isContinueBusy ? "Processing..." : "Continue"}
            </button>
          </div>
        ) : !isRegisterOnly && currentStep === 1 ? (
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              className={`btn btn-ghost min-h-11 rounded-full ${footerGhostDisabledClass}`}
              onClick={() =>
                runIfStepValid(async () => {
                  await handleRegisterOnly();
                })
              }
              disabled={isBusy || !isStepValid}
            >
              {isRegisterOnlyBusy ? <span className="loading loading-spinner loading-xs"></span> : null}
              {isRegisterOnlyBusy ? "Processing..." : "Register Only"}
            </button>
            <button
              type="button"
              className={`btn btn-primary min-h-11 rounded-full ${footerButtonDisabledClass}`}
              onClick={() =>
                runIfStepValid(async () => {
                  await primaryAction();
                })
              }
              disabled={isBusy || !isStepValid}
            >
              {isContinueBusy ? <span className="loading loading-spinner loading-xs"></span> : null}
              {isContinueBusy ? "Processing..." : "Continue"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={`btn btn-primary w-full min-h-11 rounded-full ${footerButtonDisabledClass}`}
            onClick={() =>
              runIfStepValid(async () => {
                await primaryAction();
              })
            }
            disabled={isBusy || !isStepValid}
          >
            {isPrimaryBusy ? <span className="loading loading-spinner loading-xs"></span> : null}
            {isPrimaryBusy ? "Processing..." : primaryLabel}
          </button>
        )}
      </div>
    </div>
  );
};
