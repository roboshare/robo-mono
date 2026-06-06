import { config } from "dotenv";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseScriptSelectionArgs, runMakeTarget } from "./cliUtils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

const args = process.argv.slice(2);
const { rpcNetwork, fileName, help } = parseScriptSelectionArgs(args);

if (help) {
  console.log(`
Usage: yarn verify [network] [options]
Options:
  --network <network>   Specify the network or RPC alias (default: localhost)
  --rpc-provider <name> Specify the RPC provider alias to use: infura or alchemy (default: infura)
  --file <filename>     Verify deployments from a specific deploy script broadcast
  --contract <name>     Verify deployments from Deploy<ContractName>.s.sol
  --help, -h            Show this help message

Examples:
  yarn verify sepolia
  yarn verify sepolia --rpc-provider alchemy
  yarn verify --network polygonAmoy
  yarn verify --contract Treasury --network sepolia
  yarn verify --file DeployTreasury.s.sol --network arbitrumSepolia
  `);
  process.exit(0);
}

runMakeTarget("verify", {
  RPC_URL: rpcNetwork,
  VERIFY_TARGET_SCRIPT: fileName,
});
