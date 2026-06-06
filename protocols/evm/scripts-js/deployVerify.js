import { spawnSync } from "child_process";
import { config } from "dotenv";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseScriptSelectionArgs } from "./cliUtils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

const args = process.argv.slice(2);
const { rpcNetwork, fileName, contractName, help } = parseScriptSelectionArgs(
  args,
  {
    extraValueFlags: ["--args", "--keystore"],
  }
);

if (help) {
  console.log(`
Usage: yarn deploy:verify [options]
Options:
  --file <filename>     Specify the deployment script file (default: Deploy.s.sol)
  --contract <name>     Deploy and verify a specific contract script
  --network <network>   Specify the network (default: localhost)
  --rpc-provider <name> Specify the RPC provider alias to use: infura or alchemy (default: infura)
  --args <addresses>    Comma-separated dependency addresses for deploy
  --keystore <name>     Specify the keystore account to use for deploy
  --help, -h            Show this help message

Examples:
  yarn deploy:verify --network sepolia
  yarn deploy:verify --network sepolia --rpc-provider infura
  yarn deploy:verify --contract Treasury --network sepolia --args 0xTokens,0xPartner,0xRouter
  `);
  process.exit(0);
}

const deployResult = spawnSync("node", ["scripts-js/parseArgs.js", ...args], {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    ROBO_SCRIPT_COMMAND: "deploy",
  },
});

if (deployResult.status !== 0) {
  process.exit(deployResult.status ?? 1);
}

const verifyArgs = ["scripts-js/verify.js", "--network", rpcNetwork];
if (contractName) {
  verifyArgs.push("--contract", contractName);
} else if (fileName !== "Deploy.s.sol") {
  verifyArgs.push("--file", fileName);
}

const verifyResult = spawnSync("node", verifyArgs, {
  stdio: "inherit",
  shell: true,
  env: process.env,
});

process.exit(verifyResult.status ?? 1);
