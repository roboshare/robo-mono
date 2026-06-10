import { createHash } from "node:crypto";
import "server-only";
import {
  type BorrowingBaseRun,
  type FacilityObservation,
  type PacketManifest,
  ROBOMATA_MONITORING_ROOT_VERSION,
  type SuiRootPayload,
} from "~~/lib/robomata/facilityMonitoring";

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function stableJson(value: CanonicalJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function sha256Hex(value: CanonicalJson): string {
  return `0x${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function compactBorrowingBase(run: BorrowingBaseRun): CanonicalJson {
  return {
    advanceRateCents: run.borrowingBase.advanceRateCents,
    availableBorrowingBaseCents: run.borrowingBase.availableBorrowingBaseCents,
    concentrationReserveCents: run.borrowingBase.concentrationReserveCents,
    exceptionCount: run.borrowingBase.exceptionCount,
    grossReceivablesCents: run.borrowingBase.grossReceivablesCents,
    eligibleReceivablesCents: run.borrowingBase.eligibleReceivablesCents,
  };
}

function normalizeObservationDigest(observation: FacilityObservation): CanonicalJson {
  return {
    digest: observation.digest,
    effectiveAt: observation.effectiveAt ?? null,
    expiresAt: observation.expiresAt ?? null,
    id: observation.id,
    kind: observation.kind,
    observedAt: observation.observedAt,
    status: observation.status,
    supersedesObservationId: observation.supersedesObservationId ?? null,
  };
}

export function buildEvidenceBatchRootPayload(input: {
  facilityId: string;
  generatedAt: string;
  observations: FacilityObservation[];
}): SuiRootPayload {
  const source = {
    facilityId: input.facilityId,
    kind: "evidence_batch",
    observations: input.observations
      .map(normalizeObservationDigest)
      .sort((left, right) => String((left as { id: string }).id).localeCompare(String((right as { id: string }).id))),
    version: ROBOMATA_MONITORING_ROOT_VERSION,
  } satisfies CanonicalJson;
  const inputDigest = sha256Hex(source);

  return {
    version: ROBOMATA_MONITORING_ROOT_VERSION,
    kind: "evidence_batch",
    facilityId: input.facilityId,
    inputDigest,
    rootDigest: sha256Hex({ generatedAt: input.generatedAt, inputDigest, source }),
    generatedAt: input.generatedAt,
  };
}

export function buildBorrowingBaseRunRootPayload(run: BorrowingBaseRun): SuiRootPayload {
  const source = {
    asOfDate: run.asOfDate,
    borrowingBase: compactBorrowingBase(run),
    exceptionIds: run.exceptions.map(exception => `${exception.id}:${exception.actionStatus}`).sort(),
    facilityId: run.facilityId,
    inputDigest: run.inputDigest,
    inputObservationIds: [...run.inputObservationIds].sort(),
    kind: "borrowing_base_run",
    policyVersion: run.policyVersion,
    runId: run.id,
    runNumber: run.runNumber,
    status: run.status,
    version: ROBOMATA_MONITORING_ROOT_VERSION,
  } satisfies CanonicalJson;
  const inputDigest = sha256Hex(source);

  return {
    version: ROBOMATA_MONITORING_ROOT_VERSION,
    kind: "borrowing_base_run",
    facilityId: run.facilityId,
    runId: run.id,
    inputDigest,
    rootDigest: sha256Hex({ generatedAt: run.lockedAt ?? run.createdAt, inputDigest, source }),
    generatedAt: run.lockedAt ?? run.createdAt,
  };
}

export function buildPacketManifestRootPayload(packet: PacketManifest): SuiRootPayload {
  const source = {
    evidenceObservationIds: [...packet.evidenceObservationIds].sort(),
    facilityId: packet.facilityId,
    freshnessStatus: packet.freshnessStatus,
    kind: "packet_manifest",
    packetManifestId: packet.id,
    publicMetadata: packet.publicMetadata as CanonicalJson,
    runDigest: packet.runDigest,
    runId: packet.runId,
    version: ROBOMATA_MONITORING_ROOT_VERSION,
  } satisfies CanonicalJson;
  const inputDigest = sha256Hex(source);

  return {
    version: ROBOMATA_MONITORING_ROOT_VERSION,
    kind: "packet_manifest",
    facilityId: packet.facilityId,
    runId: packet.runId,
    packetManifestId: packet.id,
    inputDigest,
    rootDigest: sha256Hex({ generatedAt: packet.generatedAt, inputDigest, source }),
    generatedAt: packet.generatedAt,
  };
}
