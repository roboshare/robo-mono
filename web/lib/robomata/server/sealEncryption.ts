import { type KeyServerConfig, SealClient } from "@mysten/seal";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { createHash } from "node:crypto";

const TESTNET_COMMITTEE_KEY_SERVER_OBJECT_ID = "0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98";
const TESTNET_COMMITTEE_AGGREGATOR_URL = "https://seal-aggregator-testnet.mystenlabs.com";

export type SealEvidenceEncryptionResult = {
  encryptedBytes: Buffer;
  ciphertextDigest: string;
  sealPackageId: string;
  sealIdentity: string;
  sealThreshold: number;
  sealKeyServerObjectIds: string[];
  sealKeyServerAggregatorUrl?: string;
};

function normalizeObjectId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Expected a Sui object ID.");
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received '${value}'.`);
  }
  return parsed;
}

function digestBuffer(buffer: Buffer): string {
  return `0x${createHash("sha256").update(buffer).digest("hex")}`;
}

function getSealPackageId(): string {
  const packageId = process.env.ROBOMATA_SEAL_PACKAGE_ID ?? process.env.ROBOMATA_SUI_PACKAGE_ID;
  if (!packageId) {
    throw new Error("ROBOMATA_SEAL_PACKAGE_ID or ROBOMATA_SUI_PACKAGE_ID is required for Seal encryption.");
  }

  return normalizeObjectId(packageId);
}

function getSealIdentity(): string {
  const identity = process.env.ROBOMATA_SEAL_IDENTITY ?? process.env.ROBOMATA_SUI_FACILITY_ID;
  if (!identity) {
    throw new Error("ROBOMATA_SEAL_IDENTITY or ROBOMATA_SUI_FACILITY_ID is required for Seal encryption.");
  }

  return normalizeObjectId(identity);
}

function getSealKeyServerConfigs(): KeyServerConfig[] {
  const rawJson = process.env.ROBOMATA_SEAL_KEY_SERVERS_JSON;
  if (rawJson) {
    const parsed = JSON.parse(rawJson) as KeyServerConfig[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("ROBOMATA_SEAL_KEY_SERVERS_JSON must be a non-empty key server config array.");
    }
    return parsed;
  }

  return [
    {
      objectId: process.env.ROBOMATA_SEAL_KEY_SERVER_OBJECT_ID ?? TESTNET_COMMITTEE_KEY_SERVER_OBJECT_ID,
      aggregatorUrl: process.env.ROBOMATA_SEAL_KEY_SERVER_AGGREGATOR_URL ?? TESTNET_COMMITTEE_AGGREGATOR_URL,
      weight: parsePositiveInteger(process.env.ROBOMATA_SEAL_KEY_SERVER_WEIGHT, 1),
    },
  ];
}

export function isSealEncryptionConfigured(): boolean {
  return Boolean(
    (process.env.ROBOMATA_SEAL_PACKAGE_ID || process.env.ROBOMATA_SUI_PACKAGE_ID) &&
      (process.env.ROBOMATA_SEAL_IDENTITY || process.env.ROBOMATA_SUI_FACILITY_ID),
  );
}

export async function encryptEvidenceWithSeal(input: {
  plaintext: Buffer;
  aad?: Buffer;
}): Promise<SealEvidenceEncryptionResult> {
  const sealPackageId = getSealPackageId();
  const sealIdentity = getSealIdentity();
  const serverConfigs = getSealKeyServerConfigs();
  const threshold = parsePositiveInteger(process.env.ROBOMATA_SEAL_THRESHOLD, 1);
  const network = (process.env.ROBOMATA_SUI_NETWORK ?? "testnet") as "mainnet" | "testnet" | "devnet" | "localnet";
  const rpcUrl = process.env.ROBOMATA_SUI_FULLNODE_URL ?? getJsonRpcFullnodeUrl(network);
  const client = new SealClient({
    suiClient: new SuiJsonRpcClient({ network, url: rpcUrl }),
    serverConfigs,
    verifyKeyServers: process.env.ROBOMATA_SEAL_VERIFY_KEY_SERVERS === "true",
    timeout: parsePositiveInteger(process.env.ROBOMATA_SEAL_TIMEOUT_MS, 10_000),
  });
  const { encryptedObject } = await client.encrypt({
    threshold,
    packageId: sealPackageId,
    id: sealIdentity,
    data: new Uint8Array(input.plaintext),
    aad: input.aad ? new Uint8Array(input.aad) : undefined,
  });
  const encryptedBytes = Buffer.from(encryptedObject);

  return {
    encryptedBytes,
    ciphertextDigest: digestBuffer(encryptedBytes),
    sealPackageId,
    sealIdentity,
    sealThreshold: threshold,
    sealKeyServerObjectIds: serverConfigs.map(config => config.objectId),
    sealKeyServerAggregatorUrl: serverConfigs.find(config => config.aggregatorUrl)?.aggregatorUrl,
  };
}
