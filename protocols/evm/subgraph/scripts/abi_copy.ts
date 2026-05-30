import * as fs from "fs";
import chalk from "chalk";

const parseAndCorrectJSON = (input: string): any => {
  // Add double quotes around keys
  let correctedJSON = input.replace(/(\w+)(?=\s*:)/g, '"$1"');

  // Remove trailing commas
  correctedJSON = correctedJSON.replace(/,(?=\s*[}\]])/g, "");

  try {
    return JSON.parse(correctedJSON);
  } catch (error) {
    console.error("Failed to parse JSON", error);
    throw new Error("Failed to parse JSON");
  }
};

type Contract = {
  address: string;
  abi: any[];
  startBlock?: number;
};

const DEFAULT_CHAIN_ID = 31337;
const DEFAULT_NETWORKS_BY_CHAIN_ID: Record<number, string> = {
  31337: "localhost",
  11155111: "sepolia",
  80002: "polygon-amoy",
  10143: "monad-testnet",
  421614: "arbitrum-sepolia",
};
const CHAIN_ID_BY_NETWORK_NAME: Record<string, number> = Object.fromEntries(
  Object.entries(DEFAULT_NETWORKS_BY_CHAIN_ID).map(([chainId, networkName]) => [networkName, Number.parseInt(chainId, 10)])
);
const EXCLUDED_CONTRACTS = new Set(["ERC1967Proxy"]);

const GRAPH_DIR = "./";
const BROADCAST_FILE_BY_CHAIN_ID = (chainId: number) =>
  `../broadcast/Deploy.s.sol/${chainId}/run-latest.json`;

function publishContract(
  contractName: string,
  contractObject: Contract,
  networkName: string
) {
  try {
    const graphConfigPath = `${GRAPH_DIR}/networks.json`;
    let graphConfig = "{}";
    try {
      if (fs.existsSync(graphConfigPath)) {
        graphConfig = fs.readFileSync(graphConfigPath).toString();
      }
    } catch (e) {
      console.log(e);
    }

    let graphConfigObject = JSON.parse(graphConfig);
    if (!(networkName in graphConfigObject)) {
      graphConfigObject[networkName] = {};
    }
    if (!(contractName in graphConfigObject[networkName])) {
      graphConfigObject[networkName][contractName] = {};
    }
    graphConfigObject[networkName][contractName].address =
      contractObject.address;
    const broadcastStartBlock = contractObject.startBlock;
    const existingStartBlock = graphConfigObject[networkName][contractName].startBlock;
    if (broadcastStartBlock != null && existingStartBlock != null) {
      graphConfigObject[networkName][contractName].startBlock = Math.max(
        broadcastStartBlock,
        existingStartBlock
      );
    } else {
      graphConfigObject[networkName][contractName].startBlock =
        broadcastStartBlock ?? existingStartBlock ?? 0;
    }

    fs.writeFileSync(
      graphConfigPath,
      JSON.stringify(graphConfigObject, null, 2)
    );
    if (!fs.existsSync(`${GRAPH_DIR}/abis`)) fs.mkdirSync(`${GRAPH_DIR}/abis`);
    const abiContent = JSON.stringify(contractObject.abi, null, 2);
    fs.writeFileSync(`${GRAPH_DIR}/abis/${contractName}.json`, abiContent);

    return true;
  } catch (e) {
    console.log(
      "Failed to publish " + chalk.red(contractName) + " to the subgraph."
    );
    console.log(e);
    return false;
  }
}

const DEPLOYED_CONTRACTS_FILE = "../../../web/contracts/deployedContracts.ts";
const FORGE_ARTIFACT_FILE_BY_CONTRACT = (contractName: string) =>
  `../out/${contractName}.sol/${contractName}.json`;

function loadAbiFromForgeArtifact(contractName: string): any[] | undefined {
  const artifactPath = FORGE_ARTIFACT_FILE_BY_CONTRACT(contractName);

  if (!fs.existsSync(artifactPath)) {
    return undefined;
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
    abi?: any[];
  };

  return Array.isArray(artifact.abi) ? artifact.abi : undefined;
}

function loadStartBlocks(chainId: number): Record<string, number> {
  const broadcastFile = BROADCAST_FILE_BY_CHAIN_ID(chainId);

  if (!fs.existsSync(broadcastFile)) {
    return {};
  }

  const broadcast = JSON.parse(fs.readFileSync(broadcastFile, "utf8")) as {
    receipts?: Array<{ transactionHash?: string; blockNumber?: string }>;
    transactions?: Array<{
      hash?: string;
      transactionType?: string;
      contractAddress?: string;
    }>;
  };

  const receiptBlockByHash = new Map<string, number>();
  for (const receipt of broadcast.receipts ?? []) {
    if (!receipt.transactionHash || !receipt.blockNumber) {
      continue;
    }

    receiptBlockByHash.set(
      receipt.transactionHash.toLowerCase(),
      Number.parseInt(receipt.blockNumber, 16)
    );
  }

  const startBlockByAddress: Record<string, number> = {};
  for (const transaction of broadcast.transactions ?? []) {
    if (
      transaction.transactionType !== "CREATE" ||
      !transaction.contractAddress ||
      !transaction.hash
    ) {
      continue;
    }

    const blockNumber = receiptBlockByHash.get(transaction.hash.toLowerCase());
    if (!blockNumber) {
      continue;
    }

    startBlockByAddress[transaction.contractAddress.toLowerCase()] = blockNumber;
  }

  return startBlockByAddress;
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  let chainIdArg: number | undefined;
  let networkArg: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if ((arg === "--chain-id" || arg === "-c") && args[i + 1]) {
      chainIdArg = Number.parseInt(args[i + 1] as string, 10);
      i++;
      continue;
    }

    if ((arg === "--network" || arg === "-n") && args[i + 1]) {
      networkArg = args[i + 1];
      i++;
    }
  }

  const chainId =
    chainIdArg ??
    (networkArg ? CHAIN_ID_BY_NETWORK_NAME[networkArg] : undefined) ??
    (process.env.SUBGRAPH_CHAIN_ID ? Number.parseInt(process.env.SUBGRAPH_CHAIN_ID, 10) : undefined) ??
    DEFAULT_CHAIN_ID;

  if (!Number.isInteger(chainId)) {
    throw new Error(`Invalid chain id: ${chainId}`);
  }

  const networkName =
    networkArg ??
    process.env.SUBGRAPH_NETWORK ??
    DEFAULT_NETWORKS_BY_CHAIN_ID[chainId];

  if (!networkName) {
    throw new Error(
      `No subgraph network name provided for chain ${chainId}. Pass --network <graph-network> or set SUBGRAPH_NETWORK.`
    );
  }

  return { chainId, networkName };
}

async function main() {
  const { chainId, networkName } = parseCliArgs();
  const startBlockByAddress = loadStartBlocks(chainId);
  const fileContent = fs.readFileSync(DEPLOYED_CONTRACTS_FILE, "utf8");

  const pattern = /const deployedContracts = ({[^;]+}) as const;/s;
  const match = fileContent.match(pattern);

  if (!match || !match[1]) {
    throw new Error(
      `Failed to find deployedContracts in the ${DEPLOYED_CONTRACTS_FILE}`
    );
  }
  const jsonString = match[1];

  // Parse the JSON string
  const deployedContracts = parseAndCorrectJSON(jsonString);
  const targetContracts = deployedContracts[chainId];

  if (!targetContracts) {
    const availableChainIds = Object.keys(deployedContracts)
      .filter(key => Number.isInteger(Number.parseInt(key, 10)))
      .join(", ");
    console.error(
      `No contracts found for chain ${chainId}. Available chain ids in deployedContracts.ts: ${availableChainIds || "none"}`
    );
    return;
  }

  for (const contractName in targetContracts) {
    if (EXCLUDED_CONTRACTS.has(contractName)) {
      continue;
    }
    const contractObject = targetContracts[contractName];
    if (!contractObject) {
      console.error(
        `Contract ${contractName} does not have an ABI or address. Skipping.`
      );
      continue;
    }
    const latestAbi = loadAbiFromForgeArtifact(contractName);
    publishContract(
      contractName,
      {
        ...contractObject,
        abi: latestAbi ?? contractObject.abi,
        startBlock: startBlockByAddress[contractObject.address.toLowerCase()],
      },
      networkName
    );
  }

  console.log(`✅  Published contracts for chain ${chainId} to the subgraph package as ${networkName}.`);
}
main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
