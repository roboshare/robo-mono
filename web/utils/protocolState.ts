import { type Address } from "viem";

export const ROBOSHARE_TOKENS_MANAGER_READER_ABI = [
  {
    type: "function",
    name: "positionManager",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export const POSITION_MANAGER_PRIMARY_REDEMPTION_READER_ABI = [
  {
    type: "function",
    name: "getPrimaryRedemptionEligibleBalance",
    stateMutability: "view",
    inputs: [
      { name: "holder", type: "address" },
      { name: "revenueTokenId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

type VehicleMetadataFallback = {
  vin?: string;
  make?: string;
  model?: string;
  year?: string | bigint;
  metadataURI?: string;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asDisplayYear = (value: unknown): string | undefined => {
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") {
    return String(value);
  }

  return undefined;
};

export const normalizeVehicleMetadata = <TFallback extends VehicleMetadataFallback>(
  result: readonly unknown[] | undefined,
  fallback: TFallback,
): TFallback => {
  if (!Array.isArray(result) || result.length === 0) {
    return fallback;
  }

  // New contract shape: [vinHash, assetMetadataURI, revenueTokenMetadataURI]
  if (result.length <= 3) {
    return {
      ...fallback,
      metadataURI: asString(result[1]) || fallback.metadataURI,
    } as TFallback;
  }

  // Legacy/generated helper shape kept here to tolerate stale frontend artifacts while the web app migrates.
  return {
    ...fallback,
    vin: asString(result[0]) || fallback.vin,
    make: asString(result[1]) || fallback.make,
    model: asString(result[2]) || fallback.model,
    year: asDisplayYear(result[3]) || fallback.year,
    metadataURI: asString(result[6]) || fallback.metadataURI,
  } as TFallback;
};

export const normalizePrimaryRedemptionPreview = (result: unknown, fallbackEligibleBalance = 0n) => {
  if (!Array.isArray(result)) {
    return {
      payout: 0n,
      liquidity: 0n,
      redemptionSupply: 0n,
      eligibleBalance: fallbackEligibleBalance,
    };
  }

  return {
    payout: (result[0] as bigint | undefined) ?? 0n,
    liquidity: (result[1] as bigint | undefined) ?? 0n,
    redemptionSupply: (result[2] as bigint | undefined) ?? 0n,
    eligibleBalance: (result[3] as bigint | undefined) ?? fallbackEligibleBalance,
  };
};

export const normalizePositionManagerAddress = (value: unknown): Address | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value as Address;
  return normalized === "0x0000000000000000000000000000000000000000" ? undefined : normalized;
};
