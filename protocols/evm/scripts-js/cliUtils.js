import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { parse } from "toml";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RPC_PROVIDER_SUFFIX = {
  alchemy: "",
  infura: "Infura",
};
const DEFAULT_RPC_PROVIDER = "infura";

export function loadFoundryToml() {
  const foundryTomlPath = join(__dirname, "..", "foundry.toml");
  return parse(readFileSync(foundryTomlPath, "utf-8"));
}

export function assertRpcEndpoint(network) {
  if (isRpcUrl(network)) {
    return;
  }

  const parsedToml = loadFoundryToml();
  if (!parsedToml.rpc_endpoints?.[network]) {
    console.log(
      `\n❌ Error: Network '${network}' not found in foundry.toml!`,
      "\nPlease check `foundry.toml` for available networks in the [rpc_endpoints] section or add a new network."
    );
    process.exit(1);
  }
}

export function isRpcUrl(value) {
  return /^https?:\/\//.test(value) || /^wss?:\/\//.test(value);
}

export function resolveRpcNetwork(
  network,
  rpcProvider = process.env.RPC_PROVIDER || DEFAULT_RPC_PROVIDER
) {
  const normalizedRpcProvider = rpcProvider?.toLowerCase();
  if (
    normalizedRpcProvider === "alchemy" ||
    isRpcUrl(network) ||
    network === "localhost"
  ) {
    return network;
  }

  const providerSuffix = RPC_PROVIDER_SUFFIX[normalizedRpcProvider];
  if (providerSuffix === undefined) {
    console.log(
      `\n❌ Error: Unsupported RPC provider '${rpcProvider}'.`,
      "\nSupported providers: alchemy, infura."
    );
    process.exit(1);
  }

  if (network.endsWith(providerSuffix)) {
    return network;
  }

  return `${network}${providerSuffix}`;
}

export function resolveDeployScript({
  fileName = "Deploy.s.sol",
  contractName = null,
}) {
  if (contractName) {
    return `Deploy${contractName}.s.sol`;
  }
  return fileName;
}

export function parseScriptSelectionArgs(args, defaults = {}) {
  const {
    defaultNetwork = "localhost",
    defaultFileName = "Deploy.s.sol",
    allowRpcUrl = false,
    extraValueFlags = [],
  } = defaults;

  let network = defaultNetwork;
  let fileName = defaultFileName;
  let contractName = null;
  let rpcProvider = process.env.RPC_PROVIDER || DEFAULT_RPC_PROVIDER;
  let help = false;
  let consumedPositionalNetwork = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--network" && args[i + 1]) {
      network = args[i + 1];
      i++;
    } else if (arg === "--file" && args[i + 1]) {
      fileName = args[i + 1];
      i++;
    } else if (arg === "--contract" && args[i + 1]) {
      contractName = args[i + 1];
      i++;
    } else if (arg === "--rpc-provider" && args[i + 1]) {
      rpcProvider = args[i + 1];
      i++;
    } else if (extraValueFlags.includes(arg) && args[i + 1]) {
      i++;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (!arg.startsWith("-") && !consumedPositionalNetwork) {
      network = arg;
      consumedPositionalNetwork = true;
    }
  }

  const rpcNetwork = resolveRpcNetwork(network, rpcProvider);

  if (!allowRpcUrl) {
    assertRpcEndpoint(rpcNetwork);
  } else if (!isRpcUrl(rpcNetwork)) {
    assertRpcEndpoint(rpcNetwork);
  }

  return {
    network,
    rpcNetwork,
    rpcProvider,
    fileName: resolveDeployScript({ fileName, contractName }),
    contractName,
    help,
  };
}

export function runMakeTarget(target, env = {}) {
  const result = spawnSync("make", [target], {
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      ...env,
    },
  });

  process.exit(result.status ?? 1);
}
