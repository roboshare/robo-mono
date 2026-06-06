import { listKeystores } from "./listKeystores.js";
import { execSync } from "child_process";
import dotenv from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { toString } from "qrcode";
import { readFileSync, existsSync } from "fs";
import { parse } from "toml";
import { ethers } from "ethers";

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "..", ".env") });
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "";
const INFURA_API_KEY = process.env.INFURA_API_KEY || "";

async function getBalanceForEachNetwork(address) {
  try {
    // Read the foundry.toml file
    const foundryTomlPath = join(__dirname, "..", "foundry.toml");
    const tomlString = readFileSync(foundryTomlPath, "utf-8");

    // Parse the tomlString to get the JS object representation
    const parsedToml = parse(tomlString);

    // Extract rpc_endpoints from parsedToml
    const rpcEndpoints = parsedToml.rpc_endpoints || {};

    // Replace ${ENV_VAR} placeholders in the rpc_endpoints section.
    function replaceEnvPlaceholders(input) {
      return input.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, envName) => {
        return process.env[envName] || "";
      });
    }

    console.log(await toString(address, { type: "terminal", small: true }));
    console.log(`\n📊 Address: ${address}`);

    if (!ALCHEMY_API_KEY) {
      console.log(
        "⚠️  ALCHEMY_API_KEY is missing in protocols/evm/.env. Public networks may fail."
      );
    }
    if (!INFURA_API_KEY) {
      console.log(
        "⚠️  INFURA_API_KEY is missing in protocols/evm/.env. Infura network aliases may fail."
      );
    }

    for (const networkName in rpcEndpoints) {
      if (networkName === "default_network") {
        continue;
      }
      const networkUrl = replaceEnvPlaceholders(rpcEndpoints[networkName]);
      console.log(`\n--${networkName}-- 📡`);

      try {
        const provider = new ethers.providers.JsonRpcProvider(networkUrl);

        // Get balance and format it
        const balance = await provider.getBalance(address);
        const formattedBalance = +ethers.utils.formatUnits(balance);

        console.log("   Balance:", formattedBalance);
        console.log("   Nonce:", await provider.getTransactionCount(address));
      } catch (e) {
        console.log(
          `   ❌ Can't connect to network ${networkName}: ${e.message}`
        );
      }
    }
  } catch (error) {
    console.error("Error reading foundry.toml:", error);
  }
}

function getAddressFromKeystoreFile(keystoreName) {
  const keystorePath = join(
    process.env.HOME || "",
    ".foundry",
    "keystores",
    keystoreName
  );

  if (!existsSync(keystorePath)) {
    throw new Error(`Keystore file not found: ${keystorePath}`);
  }

  const keystoreContent = readFileSync(keystorePath, "utf-8");
  const keystoreJson = JSON.parse(keystoreContent);
  const rawAddress = keystoreJson?.address;

  if (!rawAddress || typeof rawAddress !== "string") {
    throw new Error(`Missing 'address' field in keystore: ${keystoreName}`);
  }

  const normalizedAddress = rawAddress.startsWith("0x")
    ? rawAddress
    : `0x${rawAddress}`;
  return ethers.utils.getAddress(normalizedAddress);
}

async function checkAccountBalance() {
  try {
    // Step 1: List accounts and let user select one
    console.log("📋 Listing available accounts...");
    const selectedKeystore = await listKeystores(
      "Select a keystore to display its balance (enter the number, e.g., 1): "
    );

    if (!selectedKeystore) {
      console.error("❌ No keystore selected");
      process.exit(1);
    }

    // Step 2: Get the address of the selected account
    console.log(`\n🔍 Getting address for keystore: ${selectedKeystore}`);

    let address;
    try {
      address = getAddressFromKeystoreFile(selectedKeystore);
    } catch (keystoreError) {
      const addressCommand = `cast wallet address --account ${selectedKeystore}`;
      try {
        address = execSync(addressCommand).toString().trim();
      } catch (castError) {
        throw new Error(
          `Unable to resolve address from keystore file or cast command.\n` +
            `Keystore error: ${keystoreError.message}\n` +
            `Cast error: ${castError.message}`
        );
      }
    }

    try {
      console.log("\n💰 Checking balances across networks...");
      console.log("\n");
      await getBalanceForEachNetwork(address);
    } catch (error) {
      console.error(`❌ Error getting address: ${error.message}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    process.exit(1);
  }
}

// Run the function if this script is called directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkAccountBalance().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { checkAccountBalance };
