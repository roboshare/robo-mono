import * as chains from "viem/chains";
import deployedContracts from "~~/contracts/deployedContracts";
import { getLocalRpcUrl, getLocalWsRpcUrl } from "~~/utils/localServiceUrls";

export type ScaffoldConfig = {
  targetNetworks: readonly chains.Chain[];
  pollingInterval: number;
  infuraApiKey: string;
  alchemyApiKey: string;
  isUsingDefaultAlchemyApiKey: boolean;
  rpcOverrides?: Record<number, string>;
  walletConnectProjectId: string;
  onlyLocalBurnerWallet: boolean;
};

export const DEFAULT_ALCHEMY_API_KEY = "oKxs-03sij-U_N0iOlrSsZFr29-IqbuF";

const RELEASE_TARGET_NETWORKS = [
  chains.sepolia,
  chains.polygonAmoy,
  chains.monadTestnet,
  chains.arbitrumSepolia,
  chains.baseSepolia,
] as const;
const buildLocalTargetNetwork = (): chains.Chain => {
  const localRpcUrl = getLocalRpcUrl();
  const localWsRpcUrl = getLocalWsRpcUrl();

  if (!localRpcUrl) {
    return chains.foundry;
  }

  return {
    ...chains.foundry,
    rpcUrls: {
      default: {
        http: [localRpcUrl],
        ...(localWsRpcUrl ? { webSocket: [localWsRpcUrl] } : {}),
      },
      public: {
        http: [localRpcUrl],
        ...(localWsRpcUrl ? { webSocket: [localWsRpcUrl] } : {}),
      },
    },
  };
};

const LOCAL_TARGET_NETWORK = buildLocalTargetNetwork();
const hasDeployedContracts = (contractsForChain: unknown): boolean => {
  return !!contractsForChain && typeof contractsForChain === "object" && Object.keys(contractsForChain).length > 0;
};
const deployedChainIds = new Set(
  Object.entries(deployedContracts)
    .filter(([, contractsForChain]) => hasDeployedContracts(contractsForChain))
    .map(([chainId]) => Number.parseInt(chainId, 10))
    .filter(Number.isInteger),
);

const includeLocalNetwork =
  process.env.NEXT_PUBLIC_INCLUDE_LOCAL_CHAIN === "true" ||
  RELEASE_TARGET_NETWORKS.every(network => !deployedChainIds.has(network.id));

const configuredNetworks = [
  ...RELEASE_TARGET_NETWORKS.filter(network => deployedChainIds.has(network.id)),
  ...(includeLocalNetwork && deployedChainIds.has(LOCAL_TARGET_NETWORK.id) ? [LOCAL_TARGET_NETWORK] : []),
];

const parsedDefaultChainId = process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID
  ? Number.parseInt(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID, 10)
  : undefined;

const sortNetworks = (networks: readonly chains.Chain[]) => {
  if (!parsedDefaultChainId) {
    return networks;
  }

  return [...networks].sort((left, right) => {
    if (left.id === parsedDefaultChainId) return -1;
    if (right.id === parsedDefaultChainId) return 1;
    return 0;
  });
};

const targetNetworks = sortNetworks(configuredNetworks.length > 0 ? configuredNetworks : [LOCAL_TARGET_NETWORK]);
const localRpcUrl = getLocalRpcUrl();
const configuredInfuraApiKey = process.env.NEXT_PUBLIC_INFURA_API_KEY?.trim();
const configuredAlchemyApiKey = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY?.trim();
const rpcOverrideNetworks = [...targetNetworks, chains.mainnet].filter(
  (network, index, networks) => networks.findIndex(candidate => candidate.id === network.id) === index,
);
const publicRpcOverrideEntries = rpcOverrideNetworks.flatMap(network => {
  const rpcUrl = process.env[`NEXT_PUBLIC_RPC_URL_${network.id}`]?.trim();
  return rpcUrl ? [[network.id, rpcUrl] as const] : [];
});
const rpcOverrides = Object.fromEntries([
  ...publicRpcOverrideEntries,
  ...(localRpcUrl ? ([[LOCAL_TARGET_NETWORK.id, localRpcUrl]] as const) : []),
]) as Record<number, string>;
const configuredRpcOverrides = Object.keys(rpcOverrides).length > 0 ? rpcOverrides : undefined;

const scaffoldConfig = {
  // The networks on which your DApp is live
  targetNetworks,

  // The interval at which your front-end polls the RPC servers for new data
  // it has no effect if you only target the local network (default is 4000)
  pollingInterval: 30000,

  // Infura is the preferred release RPC provider. Alchemy remains the first managed fallback.
  // You can get provider API keys from https://developer.metamask.io/ and https://dashboard.alchemyapi.io.
  // It's recommended to store it in an env variable:
  // .env.local for local testing, and in the Vercel/system env config for live apps.
  infuraApiKey: configuredInfuraApiKey || "",
  alchemyApiKey: configuredAlchemyApiKey || DEFAULT_ALCHEMY_API_KEY,
  isUsingDefaultAlchemyApiKey: !configuredAlchemyApiKey,

  // If you want to add another per-chain RPC fallback, configure it here.
  // The key is the chain ID, and the value is the HTTP RPC URL
  rpcOverrides: configuredRpcOverrides,

  // This is ours WalletConnect's default project ID.
  // You can get your own at https://cloud.walletconnect.com
  // It's recommended to store it in an env variable:
  // .env.local for local testing, and in the Vercel/system env config for live apps.
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || "3a8170812b534d0ff9d794f19a901d64",

  // Only show the Burner Wallet when running on hardhat network
  onlyLocalBurnerWallet: targetNetworks.every(network => network.id === LOCAL_TARGET_NETWORK.id),
} as const satisfies ScaffoldConfig;

export default scaffoldConfig;
