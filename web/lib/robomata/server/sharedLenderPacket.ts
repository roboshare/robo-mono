import "server-only";
import { isRobomataFacilityMonitoringEnabled, isRobomataLenderMonitoringShareEnabled } from "~~/lib/featureFlags";
import { getFacilityMonitoringStore } from "~~/lib/robomata/server/facilityMonitoringStore";
import {
  type SharedLenderPacketView,
  type SubmissionShareLink,
  type SubmissionShareLinkMonitoringBinding,
  buildSharedLenderPacketView,
} from "~~/lib/robomata/shareLinks";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";

const MONITORING_METADATA_KEYS = [
  "facilityId",
  "monitoringRootVersion",
  "packetFreshnessStatus",
  "packetGeneratedAt",
  "packetManifestId",
  "packetRootDigest",
  "runId",
  "runRootDigest",
] as const;

function stringMetadata(metadata: SubmissionShareLink["metadata"] | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function monitoringBindingFromMetadata(
  metadata: SubmissionShareLink["metadata"] | undefined,
): SubmissionShareLinkMonitoringBinding | undefined {
  const facilityId = stringMetadata(metadata, "facilityId");
  const runId = stringMetadata(metadata, "runId");
  const packetManifestId = stringMetadata(metadata, "packetManifestId");
  const packetGeneratedAt = stringMetadata(metadata, "packetGeneratedAt");
  const packetFreshnessStatus = stringMetadata(metadata, "packetFreshnessStatus");
  if (!facilityId || !runId || !packetManifestId || !packetGeneratedAt || !packetFreshnessStatus) return undefined;

  return {
    facilityId,
    runId,
    packetManifestId,
    packetGeneratedAt,
    packetFreshnessStatus: packetFreshnessStatus as SubmissionShareLinkMonitoringBinding["packetFreshnessStatus"],
    monitoringRootVersion: stringMetadata(metadata, "monitoringRootVersion"),
    packetRootDigest: stringMetadata(metadata, "packetRootDigest"),
    runRootDigest: stringMetadata(metadata, "runRootDigest"),
  };
}

export async function buildShareLinkMonitoringMetadata(
  submission: FacilitySubmission,
): Promise<Record<string, string | number | boolean | null> | undefined> {
  if (!isRobomataFacilityMonitoringEnabled() || !isRobomataLenderMonitoringShareEnabled()) return undefined;

  const projection = await getFacilityMonitoringStore().getProjectionForSubmission(submission);
  const latestRun = projection.latestRun;
  const latestPacket = projection.latestPacket;
  if (!latestRun || !latestPacket) return undefined;

  return {
    facilityId: projection.facility.id,
    monitoringRootVersion:
      typeof latestPacket.publicMetadata.monitoringRootVersion === "string"
        ? latestPacket.publicMetadata.monitoringRootVersion
        : null,
    packetFreshnessStatus: latestPacket.freshnessStatus,
    packetGeneratedAt: latestPacket.generatedAt,
    packetManifestId: latestPacket.id,
    packetRootDigest:
      typeof latestPacket.publicMetadata.packetRootDigest === "string"
        ? latestPacket.publicMetadata.packetRootDigest
        : null,
    runId: latestRun.id,
    runRootDigest: latestRun.rootDigest || null,
  };
}

export async function buildResolvedSharedLenderPacketView(input: {
  shareLink: SubmissionShareLink;
  submission: FacilitySubmission;
}): Promise<SharedLenderPacketView> {
  if (!isRobomataFacilityMonitoringEnabled() || !isRobomataLenderMonitoringShareEnabled()) {
    return buildSharedLenderPacketView(input);
  }

  const binding = monitoringBindingFromMetadata(input.shareLink.metadata);
  if (!binding) return buildSharedLenderPacketView(input);

  const projection = await getFacilityMonitoringStore().getProjectionForSubmission(input.submission);
  const packetManifest =
    projection.packetManifests.find(packet => packet.id === binding.packetManifestId) ??
    projection.packetManifests.find(packet => packet.runId === binding.runId);
  const run = projection.runHistory.find(candidate => candidate.id === binding.runId);
  if (!packetManifest || !run) return buildSharedLenderPacketView(input);

  const currentPacketFreshnessStatus =
    projection.latestPacket &&
    projection.latestPacket.id !== packetManifest.id &&
    projection.latestPacket.generatedAt > packetManifest.generatedAt
      ? "superseded"
      : packetManifest.freshnessStatus;

  return buildSharedLenderPacketView({
    ...input,
    packetManifest,
    run,
    monitoring: {
      ...binding,
      currentPacketFreshnessStatus,
      pinnedAtShare: true,
    },
  });
}

export function shareLinkHasMonitoringMetadata(shareLink: Pick<SubmissionShareLink, "metadata">) {
  return MONITORING_METADATA_KEYS.some(key => shareLink.metadata?.[key] !== undefined);
}
