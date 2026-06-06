import { type Keypair, decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import { isRobomataSuiCommitEnabled } from "~~/lib/featureFlags";

export const DEFAULT_ROBOMATA_SUI_GAS_BUDGET = 100_000_000;
export const DEFAULT_ROBOMATA_SUI_TIMEOUT_MS = 120_000;

type SuiNetwork = "mainnet" | "testnet" | "devnet" | "localnet";

function trimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getRobomataSuiNetwork(): SuiNetwork {
  return (trimmedEnv("ROBOMATA_SUI_NETWORK") ?? "testnet") as SuiNetwork;
}

export function getRobomataSuiClient() {
  const network = getRobomataSuiNetwork();
  return new SuiJsonRpcClient({
    network,
    url: trimmedEnv("ROBOMATA_SUI_FULLNODE_URL") ?? getJsonRpcFullnodeUrl(network),
  });
}

function keypairFromSuiPrivateKey(privateKey: string): Keypair {
  const decoded = decodeSuiPrivateKey(privateKey);

  switch (decoded.scheme) {
    case "ED25519":
      return Ed25519Keypair.fromSecretKey(decoded.secretKey);
    case "Secp256k1":
      return Secp256k1Keypair.fromSecretKey(decoded.secretKey);
    case "Secp256r1":
      return Secp256r1Keypair.fromSecretKey(decoded.secretKey);
    default:
      throw new Error(`Unsupported Sui private key scheme: ${decoded.scheme}`);
  }
}

export function getRobomataSuiServerSigner(): { keypair: Keypair; address: string } | null {
  const privateKey = trimmedEnv("ROBOMATA_SUI_PRIVATE_KEY");
  if (!privateKey) return null;

  try {
    const keypair = keypairFromSuiPrivateKey(privateKey);
    return {
      keypair,
      address: keypair.getPublicKey().toSuiAddress().toLowerCase(),
    };
  } catch {
    return null;
  }
}

export function getRobomataSuiGasBudget(): number {
  return parsePositiveInteger(trimmedEnv("ROBOMATA_SUI_GAS_BUDGET"), DEFAULT_ROBOMATA_SUI_GAS_BUDGET);
}

export function getRobomataSuiTimeoutMs(): number {
  return parsePositiveInteger(
    trimmedEnv("ROBOMATA_SUI_TIMEOUT_MS") ?? trimmedEnv("ROBOMATA_SUI_CLI_TIMEOUT_MS"),
    DEFAULT_ROBOMATA_SUI_TIMEOUT_MS,
  );
}

export function isRobomataSuiCommitRuntimeConfigured(input: {
  facilityObjectId: string | undefined;
  facilityOperatorAddress: string | undefined;
}): boolean {
  const packageId = trimmedEnv("ROBOMATA_SUI_PACKAGE_ID");
  const signer = getRobomataSuiServerSigner();
  const expectedSignerAddress = trimmedEnv("ROBOMATA_SUI_SIGNER_ADDRESS")?.toLowerCase();
  const facilityOperatorAddress = input.facilityOperatorAddress?.toLowerCase();

  return Boolean(
    packageId &&
      input.facilityObjectId &&
      facilityOperatorAddress &&
      signer &&
      expectedSignerAddress &&
      signer.address === expectedSignerAddress &&
      signer.address === facilityOperatorAddress &&
      isRobomataSuiCommitEnabled(),
  );
}
