import type { PlatformVehicleId, ProtocolAssetId, RentalVehicleRecord } from "~~/lib/robomata/rentalInventory";

export type RentalMarketplaceListingStatus = "available" | "unavailable";

export type RentalMarketplaceSearchInput = {
  city?: string;
  country?: string;
  dateFrom?: string;
  dateTo?: string;
  deliveryAvailable?: boolean;
  evOnly?: boolean;
  facilityAssetId?: ProtocolAssetId;
  instantBookEnabled?: boolean;
  maxDailyRateCents?: number;
  minDailyRateCents?: number;
  minSeats?: number;
  platformVehicleId?: PlatformVehicleId;
  region?: string;
  vehicleType?: string;
};

export type RentalMarketplaceFeeEstimate = {
  label: string;
  amountCents: number;
};

export type RentalMarketplaceTripEstimate = {
  baseAmountCents: number;
  currency: "USD";
  discountAmountCents: number;
  fees: RentalMarketplaceFeeEstimate[];
  subtotalCents: number;
  totalBeforeTaxesCents: number;
  tripDays: number;
};

export type RentalMarketplaceListing = {
  platformVehicleId: PlatformVehicleId;
  facilityAssetId: ProtocolAssetId;
  vehicleAssetId?: ProtocolAssetId;
  inventoryManifestDigest: `0x${string}`;
  status: RentalMarketplaceListingStatus;
  title: string;
  description?: string;
  images: string[];
  host: {
    displayName: string;
    facilityName?: string;
  };
  location?: {
    addressLabel?: string;
    city?: string;
    region?: string;
    country?: string;
    deliveryAvailable?: boolean;
  };
  vehicle: {
    make?: string;
    model?: string;
    year?: number;
    trim?: string;
    bodyType?: string;
    seats?: number;
    fuelType?: string;
    transmission?: string;
  };
  pricing?: {
    currency: "USD";
    dailyRateCents: number;
    minimumTripDays?: number;
    monthlyDiscountBps?: number;
    weeklyDiscountBps?: number;
  };
  availability?: {
    advanceNoticeHours?: number;
    instantBookEnabled?: boolean;
    minimumLeadTimeHours?: number;
    timezone?: string;
  };
  rules?: {
    additionalRules?: string;
    mileageLimitPerDay?: number;
    petsAllowed?: boolean;
    smokingAllowed?: boolean;
  };
  tripEstimate?: RentalMarketplaceTripEstimate;
  updatedAt: string;
};

function normalized(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || undefined;
}

function dateRangeTripDays(dateFrom: string | undefined, dateTo: string | undefined): number {
  if (!dateFrom || !dateTo) return 1;
  const start = Date.parse(dateFrom);
  const end = Date.parse(dateTo);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error("dateFrom and dateTo must be valid dates with dateTo after dateFrom.");
  }
  return Math.max(1, Math.ceil((end - start) / (24 * 60 * 60 * 1_000)));
}

function dateRangeOverlaps(search: RentalMarketplaceSearchInput, range: { startsAt: string; endsAt: string }): boolean {
  if (!search.dateFrom || !search.dateTo) return false;
  const requestedStart = Date.parse(search.dateFrom);
  const requestedEnd = Date.parse(search.dateTo);
  const rangeStart = Date.parse(range.startsAt);
  const rangeEnd = Date.parse(range.endsAt);
  if (![requestedStart, requestedEnd, rangeStart, rangeEnd].every(Number.isFinite)) return false;
  return requestedStart < rangeEnd && rangeStart < requestedEnd;
}

function isBlockedForSearchDates(vehicle: RentalVehicleRecord, search: RentalMarketplaceSearchInput): boolean {
  const controls = vehicle.hostControls;
  if (!controls) return false;
  return (
    controls.blackoutRanges.some(range => dateRangeOverlaps(search, range)) ||
    controls.maintenanceHolds.some(range => dateRangeOverlaps(search, range))
  );
}

function discountAmountCents(subtotalCents: number, tripDays: number, vehicle: RentalVehicleRecord): number {
  const pricing = vehicle.hostControls?.pricing ?? vehicle.hostSetup?.pricing;
  const discountBps =
    tripDays >= 30 ? pricing?.monthlyDiscountBps : tripDays >= 7 ? pricing?.weeklyDiscountBps : undefined;
  if (!discountBps || discountBps <= 0) return 0;
  return Math.floor((subtotalCents * discountBps) / 10_000);
}

function buildTripEstimate(
  vehicle: RentalVehicleRecord,
  search: RentalMarketplaceSearchInput,
): RentalMarketplaceTripEstimate | undefined {
  const pricing = vehicle.hostControls?.pricing ?? vehicle.hostSetup?.pricing;
  const dailyRateCents = pricing?.dailyRateCents;
  if (!dailyRateCents) return undefined;

  const tripDays = Math.max(dateRangeTripDays(search.dateFrom, search.dateTo), pricing?.minimumTripDays ?? 1);
  const baseAmountCents = dailyRateCents * tripDays;
  const discount = discountAmountCents(baseAmountCents, tripDays, vehicle);
  const fees: RentalMarketplaceFeeEstimate[] = [];
  const subtotalCents = baseAmountCents - discount;

  return {
    baseAmountCents,
    currency: pricing?.currency ?? "USD",
    discountAmountCents: discount,
    fees,
    subtotalCents,
    totalBeforeTaxesCents: subtotalCents + fees.reduce((total, fee) => total + fee.amountCents, 0),
    tripDays,
  };
}

function listingTitle(vehicle: RentalVehicleRecord): string {
  const parts = [vehicle.display.year, vehicle.display.make, vehicle.display.model, vehicle.display.trim].filter(
    Boolean,
  );
  return parts.length > 0 ? parts.join(" ") : vehicle.platformVehicleId;
}

export function rentalMarketplaceListingFromVehicle(
  vehicle: RentalVehicleRecord,
  search: RentalMarketplaceSearchInput = {},
): RentalMarketplaceListing {
  const setup = vehicle.hostSetup;
  const controls = vehicle.hostControls;
  const pricing = controls?.pricing ?? setup?.pricing;
  const availability = controls?.availability ?? setup?.availability;
  const rules = setup?.rules;
  const blockedForSearchDates = isBlockedForSearchDates(vehicle, search);
  return {
    platformVehicleId: vehicle.platformVehicleId,
    facilityAssetId: vehicle.facilityAssetId,
    vehicleAssetId: vehicle.vehicleAssetId,
    inventoryManifestDigest: vehicle.inventoryManifestDigest,
    status: vehicle.operationalStatus === "listed" && !blockedForSearchDates ? "available" : "unavailable",
    title: listingTitle(vehicle),
    description: setup?.publicDescription,
    images: setup?.photoUris.length ? setup.photoUris : (vehicle.display.imageUris ?? []),
    host: {
      displayName: vehicle.operatorName ?? vehicle.facilityName ?? `Facility ${vehicle.facilityAssetId}`,
      facilityName: vehicle.facilityName,
    },
    location: setup?.pickupDropoff,
    vehicle: {
      make: vehicle.display.make,
      model: vehicle.display.model,
      year: vehicle.display.year,
      trim: vehicle.display.trim,
      bodyType: vehicle.display.bodyType,
      seats: vehicle.display.seats,
      fuelType: vehicle.display.fuelType,
      transmission: vehicle.display.transmission,
    },
    pricing: pricing?.dailyRateCents
      ? {
          currency: pricing.currency ?? "USD",
          dailyRateCents: pricing.dailyRateCents,
          minimumTripDays: pricing.minimumTripDays,
          monthlyDiscountBps: pricing.monthlyDiscountBps,
          weeklyDiscountBps: pricing.weeklyDiscountBps,
        }
      : undefined,
    availability,
    rules,
    tripEstimate: buildTripEstimate(vehicle, search),
    updatedAt: vehicle.updatedAt,
  };
}

export function rentalMarketplaceListingMatchesSearch(
  listing: RentalMarketplaceListing,
  search: RentalMarketplaceSearchInput,
): boolean {
  if (listing.status !== "available") return false;
  if (search.platformVehicleId && listing.platformVehicleId !== search.platformVehicleId) return false;
  if (search.facilityAssetId && listing.facilityAssetId !== search.facilityAssetId) return false;
  if (normalized(search.city) && normalized(listing.location?.city) !== normalized(search.city)) return false;
  if (normalized(search.region) && normalized(listing.location?.region) !== normalized(search.region)) return false;
  if (normalized(search.country) && normalized(listing.location?.country) !== normalized(search.country)) return false;
  if (search.deliveryAvailable !== undefined && listing.location?.deliveryAvailable !== search.deliveryAvailable) {
    return false;
  }
  if (
    search.instantBookEnabled !== undefined &&
    listing.availability?.instantBookEnabled !== search.instantBookEnabled
  ) {
    return false;
  }
  if (search.evOnly && listing.vehicle.fuelType !== "electric") return false;
  if (search.minSeats !== undefined && (listing.vehicle.seats ?? 0) < search.minSeats) return false;
  if (normalized(search.vehicleType) && normalized(listing.vehicle.bodyType) !== normalized(search.vehicleType)) {
    return false;
  }
  if (search.minDailyRateCents !== undefined && (listing.pricing?.dailyRateCents ?? 0) < search.minDailyRateCents) {
    return false;
  }
  if (
    search.maxDailyRateCents !== undefined &&
    (listing.pricing?.dailyRateCents ?? Infinity) > search.maxDailyRateCents
  ) {
    return false;
  }
  return true;
}

export function buildRentalMarketplaceListings(
  vehicles: RentalVehicleRecord[],
  search: RentalMarketplaceSearchInput = {},
): RentalMarketplaceListing[] {
  return vehicles
    .map(vehicle => rentalMarketplaceListingFromVehicle(vehicle, search))
    .filter(listing => rentalMarketplaceListingMatchesSearch(listing, search));
}
