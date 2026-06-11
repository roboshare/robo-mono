export const RENTAL_FACILITY_INVENTORY_MANIFEST_VERSION = "rental.facility_inventory.v1" as const;

export type RentalFacilityInventoryManifestVersion = typeof RENTAL_FACILITY_INVENTORY_MANIFEST_VERSION;

export type HexDigest = `0x${string}`;

export type ProtocolAssetId = string;

export type PlatformVehicleId = string;

export type RentalInventoryStorageBackend = "platform-db" | "ipfs" | "walrus" | "partner-system";

export type FacilityInventoryVehicleStatus = "pending_review" | "eligible" | "ineligible" | "removed";

export type RentalVehicleOperationalStatus =
  | "setup"
  | "ready"
  | "listed"
  | "reserved"
  | "in_trip"
  | "turnaround"
  | "maintenance"
  | "suspended"
  | "delisted"
  | "retired";

export type FacilityInventoryManifestSource = {
  system: "robomata" | "partner-upload" | "partner-api" | "manual";
  sourceId?: string;
  sourceUri?: string;
};

export type RentalVehicleDisplayProfile = {
  make?: string;
  model?: string;
  year?: number;
  trim?: string;
  bodyType?: string;
  seats?: number;
  fuelType?: "gas" | "diesel" | "hybrid" | "electric" | "other";
  transmission?: "automatic" | "manual" | "other";
  imageUris?: string[];
};

export type RentalVehiclePrivateReference = {
  vinHash?: HexDigest;
  plateHash?: HexDigest;
  internalFleetId?: string;
  evidenceDigests?: HexDigest[];
};

export type RentalVehicleSetupStatus = "not_started" | "incomplete" | "complete" | "blocked";

export type RentalVehicleSetupChecklistKey =
  | "photos"
  | "description"
  | "pickup_dropoff"
  | "pricing"
  | "availability"
  | "rules";

export type RentalVehicleSetupValidationError = {
  field: RentalVehicleSetupChecklistKey | "vehicle";
  message: string;
};

export type RentalVehiclePickupDropoffSetup = {
  addressLabel?: string;
  city?: string;
  region?: string;
  country?: string;
  pickupInstructions?: string;
  deliveryAvailable?: boolean;
};

export type RentalVehiclePricingSetup = {
  dailyRateCents?: number;
  currency?: "USD";
  minimumTripDays?: number;
  weeklyDiscountBps?: number;
  monthlyDiscountBps?: number;
};

export type RentalVehicleAvailabilitySetup = {
  timezone?: string;
  advanceNoticeHours?: number;
  minimumLeadTimeHours?: number;
  instantBookEnabled?: boolean;
};

export type RentalVehicleRulesSetup = {
  smokingAllowed?: boolean;
  petsAllowed?: boolean;
  mileageLimitPerDay?: number;
  additionalRules?: string;
};

export type RentalVehicleHostSetup = {
  status: RentalVehicleSetupStatus;
  checklist: Record<RentalVehicleSetupChecklistKey, boolean>;
  validationErrors: RentalVehicleSetupValidationError[];
  photoUris: string[];
  publicDescription?: string;
  pickupDropoff?: RentalVehiclePickupDropoffSetup;
  pricing?: RentalVehiclePricingSetup;
  availability?: RentalVehicleAvailabilitySetup;
  rules?: RentalVehicleRulesSetup;
  updatedAt: string;
  completedAt?: string;
};

export type RentalVehicleHostSetupUpdate = {
  availability?: RentalVehicleAvailabilitySetup;
  checklist?: Partial<Record<RentalVehicleSetupChecklistKey, boolean>>;
  photoUris?: string[];
  pickupDropoff?: RentalVehiclePickupDropoffSetup;
  pricing?: RentalVehiclePricingSetup;
  publicDescription?: string;
  rules?: RentalVehicleRulesSetup;
};

export type RentalVehicleDateRange = {
  id: string;
  startsAt: string;
  endsAt: string;
  reason?: string;
  createdAt: string;
};

export type RentalVehicleMaintenanceHold = RentalVehicleDateRange & {
  expectedReturnToServiceAt?: string;
};

export type RentalVehicleBookingReviewRules = {
  autoAcceptEnabled: boolean;
  requireManualApproval?: boolean;
  maxTripDays?: number;
  minimumNoticeHours?: number;
};

export type RentalVehicleHostControls = {
  pricing?: RentalVehiclePricingSetup;
  availability?: RentalVehicleAvailabilitySetup;
  blackoutRanges: RentalVehicleDateRange[];
  maintenanceHolds: RentalVehicleMaintenanceHold[];
  bookingReview: RentalVehicleBookingReviewRules;
  updatedAt: string;
};

export type RentalVehicleHostControlsUpdate = {
  availability?: RentalVehicleAvailabilitySetup;
  blackoutRanges?: RentalVehicleDateRange[];
  bookingReview?: Partial<RentalVehicleBookingReviewRules>;
  maintenanceHolds?: RentalVehicleMaintenanceHold[];
  operationalStatus?: Extract<
    RentalVehicleOperationalStatus,
    "listed" | "reserved" | "in_trip" | "turnaround" | "maintenance" | "suspended" | "delisted" | "retired"
  >;
  pricing?: RentalVehiclePricingSetup;
};

export type FacilityInventoryVehicle = {
  platformVehicleId: PlatformVehicleId;
  facilityAssetId: ProtocolAssetId;
  vehicleAssetId?: ProtocolAssetId;
  display: RentalVehicleDisplayProfile;
  privateReference?: RentalVehiclePrivateReference;
  status: FacilityInventoryVehicleStatus;
  effectiveFrom?: string;
  effectiveTo?: string;
};

export type FacilityInventoryManifest = {
  version: RentalFacilityInventoryManifestVersion;
  manifestId: string;
  facilityAssetId: ProtocolAssetId;
  facilityCommitment?: HexDigest;
  operatorName?: string;
  facilityName?: string;
  asOfDate: string;
  generatedAt: string;
  source: FacilityInventoryManifestSource;
  vehicles: FacilityInventoryVehicle[];
  previousManifestDigest?: HexDigest;
};

export type FacilityInventoryManifestRef = {
  version: RentalFacilityInventoryManifestVersion;
  manifestId: string;
  facilityAssetId: ProtocolAssetId;
  digest: HexDigest;
  storageBackend: RentalInventoryStorageBackend;
  uri?: string;
  generatedAt: string;
  vehicleCount: number;
};

export type RentalInventoryIngestionTrigger = "api_upload" | "manual_replay" | "registry_event" | "scheduled_replay";

export type RentalInventorySourceEvent = {
  blockNumber?: number;
  chainId?: number;
  eventName?: string;
  logIndex?: number;
  metadataUri?: string;
  registry?: "FacilityRegistry" | "VehicleRegistry";
  txHash?: string;
};

export type RentalInventoryIngestionRunStatus = "succeeded" | "failed";

export type RentalInventoryIngestionRun = {
  id: string;
  facilityAssetId?: ProtocolAssetId;
  manifestDigest?: HexDigest;
  manifestId?: string;
  sourceEvent?: RentalInventorySourceEvent;
  status: RentalInventoryIngestionRunStatus;
  trigger: RentalInventoryIngestionTrigger;
  actor?: string;
  createdVehicleCount: number;
  errorMessage?: string;
  replayOfRunId?: string;
  startedAt: string;
  completedAt: string;
  updatedVehicleCount: number;
  vehicleCount: number;
};

export type RentalInventorySyncCheckpoint = {
  id: string;
  chainId: number;
  registry: "FacilityRegistry";
  registryAddress: `0x${string}`;
  nextBlock: string;
  updatedAt: string;
  lastRunId?: string;
  lastSyncedBlock?: string;
};

export type RentalInventoryIngestionInput = {
  actor?: string;
  replayOfRunId?: string;
  sourceEvent?: RentalInventorySourceEvent;
  trigger?: RentalInventoryIngestionTrigger;
};

export type RentalVehicleProtocolLink = {
  platformVehicleId: PlatformVehicleId;
  facilityAssetId: ProtocolAssetId;
  vehicleAssetId?: ProtocolAssetId;
  inventoryManifestDigest: HexDigest;
};

export type RentalVehicleRecord = RentalVehicleProtocolLink & {
  display: RentalVehicleDisplayProfile;
  facilityName?: string;
  hostControls?: RentalVehicleHostControls;
  hostSetup?: RentalVehicleHostSetup;
  operationalStatus: RentalVehicleOperationalStatus;
  operatorName?: string;
  createdAt: string;
  updatedAt: string;
};

export type FacilityInventoryManifestRootPayload = {
  version: RentalFacilityInventoryManifestVersion;
  kind: "facility_inventory_manifest";
  facilityAssetId: ProtocolAssetId;
  manifestId: string;
  inputDigest: HexDigest;
  rootDigest: HexDigest;
  generatedAt: string;
  vehicleCount: number;
};
