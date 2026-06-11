import { randomUUID } from "node:crypto";
import "server-only";
import { type Chain, createPublicClient, fallback, getAddress, http, isAddress, parseAbiItem } from "viem";
import type { FacilityInventoryManifest, RentalInventoryIngestionRun } from "~~/lib/robomata/rentalInventory";
import { getRentalInventoryStore } from "~~/lib/robomata/server/rentalInventoryStore";
import scaffoldConfig, { type ScaffoldConfig } from "~~/scaffold.config";
import { getDeployedContract } from "~~/utils/contracts";
import { getAlchemyHttpUrl, getInfuraHttpUrl } from "~~/utils/scaffold-eth";

const FACILITY_METADATA_UPDATED_EVENT = parseAbiItem(
  "event FacilityMetadataUpdated(uint256 indexed facilityId, bytes32 indexed facilityCommitment, string assetMetadataURI, string revenueTokenMetadataURI)",
);
const DEFAULT_MAX_BLOCK_RANGE = 5_000n;
const DEFAULT_IPFS_GATEWAY = "https://ipfs.io/ipfs";

type FacilityMetadataUpdatedLog = {
  args: {
    assetMetadataURI: string;
    facilityId?: bigint;
  };
  blockNumber: bigint;
  logIndex: number;
  transactionHash: `0x${string}`;
};

export type FacilityRegistryInventorySyncInput = {
  actor?: string;
  chainId?: number;
  fromBlock?: bigint;
  maxBlockRange?: bigint;
  toBlock?: bigint;
};

export type FacilityRegistryInventorySyncResult = {
  chainId: number;
  checkpoint: {
    id: string;
    nextBlock: string;
    updatedAt: string;
  };
  failedRuns: RentalInventoryIngestionRun[];
  fromBlock: string;
  registryAddress: `0x${string}`;
  scannedEvents: number;
  successfulRuns: RentalInventoryIngestionRun[];
  toBlock: string;
};

function normalizeAddress(address: string, field: string): `0x${string}` {
  if (!isAddress(address)) throw new Error(`${field} must be a valid EVM address.`);
  return getAddress(address) as `0x${string}`;
}

function getConfiguredChain(chainId: number | undefined): Chain | undefined {
  if (!chainId) return undefined;
  return scaffoldConfig.targetNetworks.find(targetNetwork => targetNetwork.id === chainId) as Chain | undefined;
}

function getEnvFacilityRegistryAddress(chainId: number | undefined): string | undefined {
  if (!chainId) return undefined;

  const directAddress = process.env[`ROBOMATA_FACILITY_REGISTRY_ADDRESS_${chainId}`]?.trim();
  if (directAddress && isAddress(directAddress)) return directAddress;

  const rawAddressMap = process.env.ROBOMATA_FACILITY_REGISTRY_ADDRESSES_JSON?.trim();
  if (!rawAddressMap) return undefined;

  try {
    const addressMap = JSON.parse(rawAddressMap) as Record<string, unknown>;
    const mappedAddress = addressMap[String(chainId)];
    return typeof mappedAddress === "string" && isAddress(mappedAddress) ? mappedAddress : undefined;
  } catch {
    throw new Error("ROBOMATA_FACILITY_REGISTRY_ADDRESSES_JSON must be valid JSON.");
  }
}

function getConfiguredFacilityRegistryAddress(chainId: number | undefined): `0x${string}` {
  const deployedRegistryAddress = getDeployedContract(chainId, "FacilityRegistry")?.address;
  if (deployedRegistryAddress) return normalizeAddress(deployedRegistryAddress, "FacilityRegistry address");

  const envRegistryAddress = getEnvFacilityRegistryAddress(chainId);
  if (envRegistryAddress) return normalizeAddress(envRegistryAddress, "FacilityRegistry address");

  const localMockRegistryAddress = process.env.ROBOMATA_TOKENIZATION_MOCK_REGISTRY_ADDRESS?.trim();
  if (process.env.NODE_ENV !== "production" && localMockRegistryAddress && isAddress(localMockRegistryAddress)) {
    return normalizeAddress(localMockRegistryAddress, "FacilityRegistry address");
  }

  throw new Error("FacilityRegistry is not deployed for the selected EVM network.");
}

function getRentalInventoryPublicClient(chainId: number) {
  const chain = getConfiguredChain(chainId);
  if (!chain) throw new Error(`No configured EVM network found for chain ${chainId}.`);

  const rpcFallbacks = [];
  const infuraHttpUrl = getInfuraHttpUrl(chain.id);
  const alchemyHttpUrl = getAlchemyHttpUrl(chain.id);
  const rpcOverrideUrl = (scaffoldConfig.rpcOverrides as ScaffoldConfig["rpcOverrides"])?.[chain.id];
  if (infuraHttpUrl) rpcFallbacks.push(http(infuraHttpUrl));
  if (alchemyHttpUrl) rpcFallbacks.push(http(alchemyHttpUrl));
  if (rpcOverrideUrl) rpcFallbacks.push(http(rpcOverrideUrl));
  rpcFallbacks.push(http());

  return createPublicClient({
    chain,
    transport: fallback(rpcFallbacks),
  });
}

function configuredSyncFromBlock(): bigint {
  const raw = process.env.ROBOMATA_RENTAL_INVENTORY_SYNC_FROM_BLOCK?.trim();
  if (!raw) return 0n;
  try {
    return BigInt(raw);
  } catch {
    throw new Error("ROBOMATA_RENTAL_INVENTORY_SYNC_FROM_BLOCK must be an integer block number.");
  }
}

function configuredMaxBlockRange(): bigint {
  const raw = process.env.ROBOMATA_RENTAL_INVENTORY_SYNC_MAX_BLOCK_RANGE?.trim();
  if (!raw) return DEFAULT_MAX_BLOCK_RANGE;
  try {
    const parsed = BigInt(raw);
    if (parsed <= 0n) throw new Error();
    return parsed;
  } catch {
    throw new Error("ROBOMATA_RENTAL_INVENTORY_SYNC_MAX_BLOCK_RANGE must be a positive integer.");
  }
}

function configuredAllowedMetadataOrigins(): Set<string> {
  return new Set(
    (process.env.ROBOMATA_RENTAL_INVENTORY_METADATA_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map(origin => origin.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
}

function isLocalDevelopmentUrl(url: URL): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
}

function assertSafeMetadataUrl(url: URL, source: "direct" | "ipfs") {
  if (source === "ipfs") return;
  if (url.protocol === "http:" && isLocalDevelopmentUrl(url)) return;
  if (url.protocol !== "https:") throw new Error(`Unsupported rental inventory metadata URL protocol: ${url.protocol}`);
  if (configuredAllowedMetadataOrigins().has(url.origin)) return;
  throw new Error(`Rental inventory metadata origin ${url.origin} is not allowlisted.`);
}

function checkpointId(chainId: number, registryAddress: `0x${string}`) {
  return `${chainId}:${registryAddress.toLowerCase()}:FacilityRegistry`;
}

function resolveMetadataUrl(uri: string): string {
  if (uri.startsWith("https://") || uri.startsWith("http://")) {
    const url = new URL(uri);
    assertSafeMetadataUrl(url, "direct");
    return url.toString();
  }
  if (uri.startsWith("ipfs://")) {
    const gateway = (process.env.ROBOMATA_RENTAL_INVENTORY_IPFS_GATEWAY || DEFAULT_IPFS_GATEWAY).replace(/\/+$/, "");
    const url = new URL(`${gateway}/${uri.slice("ipfs://".length).replace(/^\/+/, "")}`);
    assertSafeMetadataUrl(url, "ipfs");
    return url.toString();
  }
  throw new Error(`Unsupported rental inventory metadata URI: ${uri}`);
}

async function fetchJson(uri: string): Promise<unknown> {
  const response = await fetch(resolveMetadataUrl(uri), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to fetch rental inventory metadata: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function findManifestUri(metadata: Record<string, unknown>): string | undefined {
  const direct =
    metadata.rentalInventoryManifestUri ??
    metadata.rental_inventory_manifest_uri ??
    objectRecord(metadata.properties)?.rentalInventoryManifestUri ??
    objectRecord(metadata.properties)?.rental_inventory_manifest_uri;
  return typeof direct === "string" && direct.trim() ? direct : undefined;
}

async function loadFacilityInventoryManifest(assetMetadataUri: string): Promise<FacilityInventoryManifest> {
  const metadata = objectRecord(await fetchJson(assetMetadataUri));
  if (!metadata) throw new Error("Facility metadata must be a JSON object.");

  const embeddedManifest = metadata.rentalInventoryManifest ?? metadata.rental_inventory_manifest;
  if (embeddedManifest && typeof embeddedManifest === "object") return embeddedManifest as FacilityInventoryManifest;

  const manifestUri = findManifestUri(metadata);
  if (!manifestUri) throw new Error("Facility metadata does not reference a rental inventory manifest.");

  const manifest = await fetchJson(manifestUri);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Rental inventory manifest must be a JSON object.");
  }
  return manifest as FacilityInventoryManifest;
}

function createFailedIngestionRun(input: {
  actor?: string;
  chainId: number;
  errorMessage: string;
  facilityAssetId?: string;
  log: FacilityMetadataUpdatedLog;
}): RentalInventoryIngestionRun {
  const now = new Date().toISOString();
  return {
    id: `rii_${randomUUID()}`,
    actor: input.actor,
    completedAt: now,
    createdVehicleCount: 0,
    errorMessage: input.errorMessage,
    facilityAssetId: input.facilityAssetId,
    sourceEvent: {
      blockNumber: Number(input.log.blockNumber),
      chainId: input.chainId,
      eventName: "FacilityMetadataUpdated",
      logIndex: input.log.logIndex,
      metadataUri: input.log.args.assetMetadataURI,
      registry: "FacilityRegistry",
      txHash: input.log.transactionHash,
    },
    startedAt: now,
    status: "failed",
    trigger: "registry_event",
    updatedVehicleCount: 0,
    vehicleCount: 0,
  };
}

function parseFacilityId(log: FacilityMetadataUpdatedLog): string {
  return log.args.facilityId?.toString() ?? "";
}

export async function syncFacilityRegistryRentalInventory(
  input: FacilityRegistryInventorySyncInput = {},
): Promise<FacilityRegistryInventorySyncResult> {
  const chainId = input.chainId ?? scaffoldConfig.targetNetworks[0]?.id;
  if (!chainId) throw new Error("chainId is required for FacilityRegistry rental inventory sync.");

  const publicClient = getRentalInventoryPublicClient(chainId);
  const registryAddress = getConfiguredFacilityRegistryAddress(chainId);
  const store = getRentalInventoryStore();
  const checkpointKey = checkpointId(chainId, registryAddress);
  const checkpoint = await store.getSyncCheckpoint(checkpointKey);
  const latestBlock = await publicClient.getBlockNumber();
  const fromBlock = input.fromBlock ?? (checkpoint ? BigInt(checkpoint.nextBlock) : configuredSyncFromBlock());
  const rangeLimit = input.maxBlockRange ?? configuredMaxBlockRange();
  const requestedToBlock = input.toBlock ?? latestBlock;
  const cappedToBlock = fromBlock + rangeLimit - 1n;
  const toBlock = requestedToBlock < cappedToBlock ? requestedToBlock : cappedToBlock;

  if (toBlock < fromBlock) {
    const now = new Date().toISOString();
    const savedCheckpoint = await store.saveSyncCheckpoint({
      id: checkpointKey,
      chainId,
      registry: "FacilityRegistry",
      registryAddress,
      nextBlock: fromBlock.toString(),
      updatedAt: now,
      lastSyncedBlock: checkpoint?.lastSyncedBlock,
      lastRunId: checkpoint?.lastRunId,
    });
    return {
      chainId,
      checkpoint: {
        id: savedCheckpoint.id,
        nextBlock: savedCheckpoint.nextBlock,
        updatedAt: savedCheckpoint.updatedAt,
      },
      failedRuns: [],
      fromBlock: fromBlock.toString(),
      registryAddress,
      scannedEvents: 0,
      successfulRuns: [],
      toBlock: requestedToBlock.toString(),
    };
  }

  const logs = (await publicClient.getLogs({
    address: registryAddress,
    event: FACILITY_METADATA_UPDATED_EVENT,
    fromBlock,
    toBlock,
  })) as FacilityMetadataUpdatedLog[];
  const successfulRuns: RentalInventoryIngestionRun[] = [];
  const failedRuns: RentalInventoryIngestionRun[] = [];

  for (const log of logs) {
    const facilityAssetId = parseFacilityId(log);
    try {
      const manifest = await loadFacilityInventoryManifest(log.args.assetMetadataURI);
      if (manifest.facilityAssetId !== facilityAssetId) {
        throw new Error("Rental inventory manifest facilityAssetId does not match FacilityRegistry event facilityId.");
      }
      const result = await store.upsertManifest(manifest, {
        actor: input.actor,
        sourceEvent: {
          blockNumber: Number(log.blockNumber),
          chainId,
          eventName: "FacilityMetadataUpdated",
          logIndex: log.logIndex,
          metadataUri: log.args.assetMetadataURI,
          registry: "FacilityRegistry",
          txHash: log.transactionHash,
        },
        trigger: "registry_event",
      });
      successfulRuns.push(result.ingestionRun);
    } catch (error) {
      const failedRun = createFailedIngestionRun({
        actor: input.actor,
        chainId,
        errorMessage: error instanceof Error ? error.message : "FacilityRegistry inventory sync failed.",
        facilityAssetId,
        log,
      });
      failedRuns.push(await store.recordIngestionRun(failedRun));
    }
  }

  const lastRun = successfulRuns.at(-1) ?? failedRuns.at(-1);
  const now = new Date().toISOString();
  const savedCheckpoint = await store.saveSyncCheckpoint({
    id: checkpointKey,
    chainId,
    registry: "FacilityRegistry",
    registryAddress,
    nextBlock: (toBlock + 1n).toString(),
    updatedAt: now,
    lastRunId: lastRun?.id,
    lastSyncedBlock: toBlock.toString(),
  });

  return {
    chainId,
    checkpoint: { id: savedCheckpoint.id, nextBlock: savedCheckpoint.nextBlock, updatedAt: savedCheckpoint.updatedAt },
    failedRuns,
    fromBlock: fromBlock.toString(),
    registryAddress,
    scannedEvents: logs.length,
    successfulRuns,
    toBlock: toBlock.toString(),
  };
}
