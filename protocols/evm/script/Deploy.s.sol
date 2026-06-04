// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { console } from "forge-std/Script.sol";
import { DeployCore } from "./DeployCore.s.sol";
import { RoboshareTokens } from "../contracts/RoboshareTokens.sol";
import { PartnerManager } from "../contracts/PartnerManager.sol";
import { RegistryRouter } from "../contracts/RegistryRouter.sol";
import { VehicleRegistry } from "../contracts/VehicleRegistry.sol";
import { Treasury } from "../contracts/Treasury.sol";
import { EarningsManager } from "../contracts/EarningsManager.sol";
import { Marketplace } from "../contracts/Marketplace.sol";
import { PositionManager } from "../contracts/PositionManager.sol";

/**
 * @title Deploy
 * @dev Production deployment script. Uses shared deployment logic from DeployCore.
 */
contract Deploy is DeployCore {
    function run()
        external
        scaffoldEthDeployerRunner
        returns (
            RoboshareTokens roboshareTokens,
            PartnerManager partnerManager,
            RegistryRouter router,
            VehicleRegistry vehicleRegistry,
            Treasury treasury,
            EarningsManager earningsManager,
            Marketplace marketplace,
            PositionManager positionManager
        )
    {
        // Get network configuration
        NetworkConfig memory config = getActiveNetworkConfig();

        // For testnets and localhost, deploy MockUSDC if not already set
        if (config.usdcToken == address(0) && isLocalOrTestNetwork()) {
            config.usdcToken = ensureLocalOrTestUsdc(deployer);
            console.log("MockUSDC (6 decimals) deployed at:", config.usdcToken);
        }

        // Only localhost may fall back to the deployer. Public testnets/mainnets
        // must provide TREASURY_FEE_RECIPIENT through the environment.
        if (config.treasuryFeeRecipient == address(0)) {
            if (!isLocalNetwork()) {
                revert MissingTreasuryFeeRecipient(getNetworkName());
            }
            config.treasuryFeeRecipient = deployer;
            console.log("Using deployer as treasuryFeeRecipient:", deployer);
        }

        // Update active config
        activeNetworkConfig = config;

        // Deploy all contracts using shared core logic
        DeployedContracts memory contracts = _deployCore(deployer, config);

        // Unpack for return values
        roboshareTokens = contracts.roboshareTokens;
        partnerManager = contracts.partnerManager;
        router = contracts.router;
        vehicleRegistry = contracts.vehicleRegistry;
        treasury = contracts.treasury;
        earningsManager = contracts.earningsManager;
        marketplace = contracts.marketplace;
        positionManager = contracts.positionManager;

        // Save deployments for frontend generation
        saveDeployment("RoboshareTokens", address(roboshareTokens));
        saveDeployment("PartnerManager", address(partnerManager));
        saveDeployment("RegistryRouter", address(router));
        saveDeployment("VehicleRegistry", address(vehicleRegistry));
        saveDeployment("Treasury", address(treasury));
        saveDeployment("EarningsManager", address(earningsManager));
        saveDeployment("Marketplace", address(marketplace));
        saveDeployment("PositionManager", address(positionManager));

        // Save MockUSDC deployment for test networks
        if (isLocalOrTestNetwork() && config.usdcToken != address(0)) {
            saveDeployment("MockUSDC", config.usdcToken);
        }
    }
}
