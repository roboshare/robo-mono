import { createHash } from "node:crypto";
import "server-only";
import {
  type FacilityInventoryManifest,
  type FacilityInventoryManifestRootPayload,
  type FacilityInventoryVehicle,
  RENTAL_FACILITY_INVENTORY_MANIFEST_VERSION,
} from "~~/lib/robomata/rentalInventory";

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function stableJson(value: CanonicalJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function sha256Hex(value: CanonicalJson): `0x${string}` {
  return `0x${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function canonicalVehicle(vehicle: FacilityInventoryVehicle): CanonicalJson {
  return {
    display: {
      bodyType: vehicle.display.bodyType ?? null,
      fuelType: vehicle.display.fuelType ?? null,
      imageUris: [...(vehicle.display.imageUris ?? [])].sort(),
      make: vehicle.display.make ?? null,
      model: vehicle.display.model ?? null,
      seats: vehicle.display.seats ?? null,
      transmission: vehicle.display.transmission ?? null,
      trim: vehicle.display.trim ?? null,
      year: vehicle.display.year ?? null,
    },
    effectiveFrom: vehicle.effectiveFrom ?? null,
    effectiveTo: vehicle.effectiveTo ?? null,
    facilityAssetId: vehicle.facilityAssetId,
    platformVehicleId: vehicle.platformVehicleId,
    privateReference: {
      evidenceDigests: [...(vehicle.privateReference?.evidenceDigests ?? [])].sort(),
      internalFleetId: vehicle.privateReference?.internalFleetId ?? null,
      plateHash: vehicle.privateReference?.plateHash ?? null,
      vinHash: vehicle.privateReference?.vinHash ?? null,
    },
    status: vehicle.status,
    vehicleAssetId: vehicle.vehicleAssetId ?? null,
  };
}

function canonicalVehicles(vehicles: FacilityInventoryVehicle[]): CanonicalJson[] {
  return [...vehicles]
    .sort((left, right) => left.platformVehicleId.localeCompare(right.platformVehicleId))
    .map(canonicalVehicle);
}

export function buildFacilityInventoryManifestRootPayload(
  manifest: FacilityInventoryManifest,
): FacilityInventoryManifestRootPayload {
  const source = {
    asOfDate: manifest.asOfDate,
    facilityAssetId: manifest.facilityAssetId,
    facilityCommitment: manifest.facilityCommitment ?? null,
    facilityName: manifest.facilityName ?? null,
    kind: "facility_inventory_manifest",
    manifestId: manifest.manifestId,
    operatorName: manifest.operatorName ?? null,
    previousManifestDigest: manifest.previousManifestDigest ?? null,
    source: {
      sourceId: manifest.source.sourceId ?? null,
      sourceUri: manifest.source.sourceUri ?? null,
      system: manifest.source.system,
    },
    vehicles: canonicalVehicles(manifest.vehicles),
    version: RENTAL_FACILITY_INVENTORY_MANIFEST_VERSION,
  } satisfies CanonicalJson;
  const inputDigest = sha256Hex(source);

  return {
    version: RENTAL_FACILITY_INVENTORY_MANIFEST_VERSION,
    kind: "facility_inventory_manifest",
    facilityAssetId: manifest.facilityAssetId,
    manifestId: manifest.manifestId,
    inputDigest,
    rootDigest: sha256Hex({ generatedAt: manifest.generatedAt, inputDigest, source }),
    generatedAt: manifest.generatedAt,
    vehicleCount: manifest.vehicles.length,
  };
}
