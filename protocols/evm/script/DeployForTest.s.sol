// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

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
 * @title DeployForTest
 * @dev Test deployment script. Uses shared deployment logic from DeployCore.
 * Unlike Deploy.s.sol, this accepts a custom deployer address for test flexibility.
 */
contract DeployForTest is DeployCore {
    modifier testDeployerRunner(address _deployer) {
        vm.startPrank(_deployer);
        _;
        vm.stopPrank();
    }

    function run(address _deployer)
        public
        testDeployerRunner(_deployer)
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

        // For local testing, deploy mock USDC if not set
        if (config.usdcToken == address(0)) {
            config.usdcToken = ensureLocalOrTestUsdc(_deployer);
        }

        // Use deployer as treasuryFeeRecipient fallback for testing
        if (config.treasuryFeeRecipient == address(0)) {
            config.treasuryFeeRecipient = _deployer;
        }

        // Update the active config
        activeNetworkConfig = config;

        // Deploy all contracts using shared core logic
        DeployedContracts memory contracts = _deployCore(_deployer, config);

        // Unpack for return values
        roboshareTokens = contracts.roboshareTokens;
        partnerManager = contracts.partnerManager;
        router = contracts.router;
        vehicleRegistry = contracts.vehicleRegistry;
        treasury = contracts.treasury;
        earningsManager = contracts.earningsManager;
        marketplace = contracts.marketplace;
        positionManager = contracts.positionManager;
    }
}
