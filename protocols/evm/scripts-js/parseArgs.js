import { spawnSync } from "child_process";
import { config } from "dotenv";
import { join, dirname } from "path";
import { readFileSync, existsSync } from "fs";
import { parse } from "toml";
import { fileURLToPath } from "url";
import readline from "readline";
import { selectOrCreateKeystore } from "./selectOrCreateKeystore.js";
import { assertRpcEndpoint, resolveRpcNetwork } from "./cliUtils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config();

// Contract signatures for dependency injection
const CONTRACT_SIGNATURES = {
  // No dependencies - default run()
  PartnerManager: { sig: null, params: [] },
  RoboshareTokens: { sig: null, params: [] },
  // 2 dependencies
  RegistryRouter: {
    sig: "run(address,address)",
    params: ["roboshareTokens", "partnerManager"],
  },
  // 3 dependencies
  VehicleRegistry: {
    sig: "run(address,address,address)",
    params: ["roboshareTokens", "partnerManager", "router"],
  },
  Treasury: {
    sig: "run(address,address,address)",
    params: ["roboshareTokens", "partnerManager", "router"],
  },
  // 4 dependencies
  Marketplace: {
    sig: "run(address,address,address,address)",
    params: ["roboshareTokens", "partnerManager", "router", "treasury"],
  },
  EarningsManager: {
    sig: "run(address,address,address,address)",
    params: ["roboshareTokens", "partnerManager", "router", "treasury"],
  },
};

// Get all arguments after the script name
const args = process.argv.slice(2);

// Allow wrapper scripts to force deploy/upgrade semantics without depending on npm lifecycle names.
const command =
  process.env.ROBO_SCRIPT_COMMAND ||
  process.env.npm_lifecycle_event ||
  "deploy";

let fileName = "Deploy.s.sol";
let network = "localhost";
let rpcProvider = process.env.RPC_PROVIDER || "infura";
let keystoreArg = null;
let contractName = null;
let proxyAddress = null;
let sigArgs = []; // For dependency addresses via --args

// Show help message if --help is provided
if (args.includes("--help") || args.includes("-h")) {
  if (command === "upgrade") {
    console.log(`
Usage: yarn upgrade [options]
Options:
  --contract <name>       Specify the contract to upgrade (required)
  --proxy-address <addr>  Specify the proxy contract address (required)
  --network <network>     Specify the network (default: localhost)
  --rpc-provider <name>   Specify the RPC provider alias to use: infura or alchemy (default: infura)
  --keystore <name>       Specify the keystore account to use (bypasses selection prompt)
  --help, -h             Show this help message
Examples:
  yarn upgrade --contract VehicleRegistry --proxy-address 0x3dc1ec9c2867fd75f63f089b5c9760b3d259e07d
  yarn upgrade --contract Treasury --proxy-address 0x123... --network sepolia
    `);
  } else {
    console.log(`
Usage: yarn deploy [options]
Options:
  --file <filename>     Specify the deployment script file (default: Deploy.s.sol)
  --contract <name>     Deploy a specific contract (uses Deploy<ContractName>.s.sol)
  --network <network>   Specify the network (default: localhost)
  --rpc-provider <name> Specify the RPC provider alias to use: infura or alchemy (default: infura)
  --args <addresses>    Comma-separated dependency addresses (no spaces)
  --keystore <name>     Specify the keystore account to use (bypasses selection prompt)
  --help, -h           Show this help message

Contracts and their dependencies:
  PartnerManager     - No dependencies
  RoboshareTokens    - No dependencies
  RegistryRouter     - 2 dependencies: roboshareTokens,partnerManager
  VehicleRegistry    - 3 dependencies: roboshareTokens,partnerManager,router
  Treasury           - 3 dependencies: roboshareTokens,partnerManager,router
  Marketplace        - 4 dependencies: roboshareTokens,partnerManager,router,treasury
  EarningsManager    - 4 dependencies: roboshareTokens,partnerManager,router,treasury

Examples:
  yarn deploy --contract PartnerManager --network sepolia
  yarn deploy --contract PartnerManager --network sepolia --rpc-provider infura
  yarn deploy --contract RegistryRouter --network sepolia --args 0xTokens,0xPartner
  yarn deploy --contract Treasury --network sepolia --args 0xTokens,0xPartner,0xRouter
  yarn deploy --contract Marketplace --network sepolia --args 0xTokens,0xPartner,0xRouter,0xTreasury
  yarn deploy --contract EarningsManager --network sepolia --args 0xTokens,0xPartner,0xRouter,0xTreasury
    `);
  }
  process.exit(0);
}

// Parse arguments
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--network" && args[i + 1]) {
    network = args[i + 1];
    i++; // Skip next arg since we used it
  } else if (args[i] === "--rpc-provider" && args[i + 1]) {
    rpcProvider = args[i + 1];
    i++; // Skip next arg since we used it
  } else if (args[i] === "--file" && args[i + 1]) {
    fileName = args[i + 1];
    i++; // Skip next arg since we used it
  } else if (args[i] === "--keystore" && args[i + 1]) {
    keystoreArg = args[i + 1];
    i++; // Skip next arg since we used it
  } else if (args[i] === "--contract" && args[i + 1]) {
    contractName = args[i + 1];
    i++; // Skip next arg since we used it
  } else if (args[i] === "--proxy-address" && args[i + 1]) {
    proxyAddress = args[i + 1];
    i++; // Skip next arg since we used it
  } else if (args[i] === "--args" && args[i + 1]) {
    // Parse comma-separated addresses
    sigArgs = args[i + 1].split(",").map((a) => a.trim());
    i++; // Skip next arg since we used it
  }
}

const rpcNetwork = resolveRpcNetwork(network, rpcProvider);
assertRpcEndpoint(rpcNetwork);

// Handle upgrade-specific logic
if (command === "upgrade") {
  // Validate required arguments
  if (!contractName) {
    console.log(
      "\n❌ Error: --contract argument is required for upgrade command"
    );
    console.log(
      "Usage: yarn upgrade --contract <ContractName> --proxy-address <address>"
    );
    process.exit(1);
  }
  if (!proxyAddress) {
    console.log(
      "\n❌ Error: --proxy-address argument is required for upgrade command"
    );
    console.log(
      "Usage: yarn upgrade --contract <ContractName> --proxy-address <address>"
    );
    process.exit(1);
  }

  // Construct upgrade script filename from contract name
  fileName = `Upgrade${contractName}.s.sol`;
} else if (command === "deploy" && contractName) {
  // Handle contract-specific deployments
  fileName = `Deploy${contractName}.s.sol`;

  // Validate dependencies if contract has them
  const contractConfig = CONTRACT_SIGNATURES[contractName];
  if (contractConfig && contractConfig.sig) {
    const expectedCount = contractConfig.params.length;
    if (sigArgs.length !== expectedCount) {
      console.log(
        `\n❌ Error: ${contractName} requires ${expectedCount} dependency address(es)`
      );
      console.log(`   Dependencies: ${contractConfig.params.join(", ")}`);
      console.log(
        `\nUsage: yarn deploy --contract ${contractName} --network <network> --args ${contractConfig.params
          .map((p) => `<${p}>`)
          .join(",")}`
      );
      process.exit(1);
    }
  }
}

// Function to check if a keystore exists
function validateKeystore(keystoreName) {
  if (keystoreName === "scaffold-eth-default") {
    return true; // Default keystore is always valid
  }

  const keystorePath = join(
    process.env.HOME,
    ".foundry",
    "keystores",
    keystoreName
  );
  return existsSync(keystorePath);
}

function isTreasuryFeeRecipientRequired(networkName) {
  return networkName !== "localhost";
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

async function promptTreasuryFeeRecipient() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(
      "\n❌ Error: TREASURY_FEE_RECIPIENT is required for non-local deployments and no interactive TTY is available."
    );
    console.log(
      "Please export TREASURY_FEE_RECIPIENT in your shell before running the deploy command."
    );
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const answer = await new Promise((resolve) => {
        rl.question(
          "\nEnter TREASURY_FEE_RECIPIENT address for this deploy: ",
          resolve
        );
      });

      const trimmed = answer.trim();
      if (!isAddress(trimmed)) {
        console.log(
          "\n❌ Invalid address. Expected a 20-byte hex address like 0x1234..."
        );
        continue;
      }

      return trimmed;
    }
  } finally {
    rl.close();
  }
}

// Check if the network exists in rpc_endpoints
try {
  const foundryTomlPath = join(__dirname, "..", "foundry.toml");
  const tomlString = readFileSync(foundryTomlPath, "utf-8");
  const parsedToml = parse(tomlString);

  if (!parsedToml.rpc_endpoints[network]) {
    console.log(
      `\n❌ Error: Network '${network}' not found in foundry.toml!`,
      "\nPlease check `foundry.toml` for available networks in the [rpc_endpoints] section or add a new network."
    );
    process.exit(1);
  }
} catch (error) {
  console.error("\n❌ Error reading or parsing foundry.toml:", error);
  process.exit(1);
}

// Determine which keystore to use
let selectedKeystore =
  process.env.ETH_KEYSTORE_ACCOUNT || "scaffold-eth-default";

// Handle --keystore flag override
if (keystoreArg) {
  if (!validateKeystore(keystoreArg)) {
    console.log(`\n❌ Error: Keystore '${keystoreArg}' not found!`);
    console.log(
      `Please check that the keystore exists in ~/.foundry/keystores/`
    );
    process.exit(1);
  }
  selectedKeystore = keystoreArg;
  console.log(`\n🔑 Using keystore: ${selectedKeystore}`);
} else if (
  network !== "localhost" &&
  selectedKeystore === "scaffold-eth-default"
) {
  // For non-localhost networks, prompt for keystore selection if using default
  try {
    selectedKeystore = await selectOrCreateKeystore();
  } catch (error) {
    console.error("\n❌ Error selecting keystore:", error);
    process.exit(1);
  }
} else if (selectedKeystore !== "scaffold-eth-default") {
  // Using a custom keystore from .env
  if (!validateKeystore(selectedKeystore)) {
    console.log(`\n❌ Error: Keystore '${selectedKeystore}' not found!`);
    console.log(
      `Please check that the keystore exists in ~/.foundry/keystores/`
    );
    process.exit(1);
  }
  console.log(
    `\n🔑 Using keystore from ETH_KEYSTORE_ACCOUNT: ${selectedKeystore}`
  );
}

if (
  command === "deploy" &&
  isTreasuryFeeRecipientRequired(network) &&
  !process.env.TREASURY_FEE_RECIPIENT
) {
  process.env.TREASURY_FEE_RECIPIENT = await promptTreasuryFeeRecipient();
  console.log(
    `\n🏦 Using TREASURY_FEE_RECIPIENT: ${process.env.TREASURY_FEE_RECIPIENT}`
  );
}

// Check for default account on live network
if (selectedKeystore === "scaffold-eth-default" && network !== "localhost") {
  console.log(`
❌ Error: Cannot deploy to live network using default keystore account!

To deploy to ${network}, please follow these steps:

1. If you haven't generated a keystore account yet:
   $ yarn generate

2. Run the deployment command again.

The default account (scaffold-eth-default) can only be used for localhost deployments.
`);
  process.exit(0);
}

// Build the --sig argument if contract has dependencies
let sigArg = "";
if (command === "deploy" && contractName) {
  const contractConfig = CONTRACT_SIGNATURES[contractName];
  if (contractConfig && contractConfig.sig && sigArgs.length > 0) {
    sigArg = `--sig "${contractConfig.sig}" ${sigArgs.join(" ")}`;
  }
}

// Set environment variables for the make command
if (command === "upgrade") {
  process.env.DEPLOY_SCRIPT = `script/${fileName}`;
  process.env.PROXY_ADDRESS = proxyAddress;
  process.env.RPC_URL = rpcNetwork;
  process.env.ETH_KEYSTORE_ACCOUNT = selectedKeystore;
  process.env.SCRIPT_SIG_ARGS = "";

  const result = spawnSync("make", ["deploy-and-generate-abis"], {
    stdio: "inherit",
    shell: true,
  });

  process.exit(result.status);
} else {
  // Deploy command
  process.env.DEPLOY_SCRIPT = `script/${fileName}`;
  process.env.RPC_URL = rpcNetwork;
  process.env.ETH_KEYSTORE_ACCOUNT = selectedKeystore;
  process.env.SCRIPT_SIG_ARGS = sigArg;

  const result = spawnSync("make", ["deploy-and-generate-abis"], {
    stdio: "inherit",
    shell: true,
  });

  process.exit(result.status);
}
