// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { console } from "forge-std/console.sol";
import { ScaffoldETHDeploy } from "./DeployHelpers.s.sol";
import { RegistryRouter } from "../contracts/RegistryRouter.sol";

contract UpgradeRegistryRouter is ScaffoldETHDeploy {
    /**
     * @dev Upgrade RegistryRouter implementation
     * Usage: yarn upgrade --contract RegistryRouter --proxy-address <addr>
     */
    function run() external scaffoldEthDeployerRunner {
        // Get proxy address from environment variable (set by parseArgs.js)
        address proxyAddress = vm.envAddress("PROXY_ADDRESS");
        bool confirmSplitUpgrade = vm.envBool("CONFIRM_POSITION_MANAGER_SPLIT_UPGRADE");

        require(proxyAddress != address(0), "Proxy address cannot be zero");
        require(confirmSplitUpgrade, "CONFIRM_POSITION_MANAGER_SPLIT_UPGRADE=true required");

        console.log("=== RegistryRouter Upgrade ===");
        console.log("RegistryRouter proxy:", proxyAddress);

        // Deploy new RegistryRouter implementation
        RegistryRouter newImplementation = new RegistryRouter();
        console.log("New RegistryRouter implementation deployed at:", address(newImplementation));

        // Get the proxy as RegistryRouter
        RegistryRouter proxy = RegistryRouter(proxyAddress);

        // Upgrade the proxy to the new implementation (no reinitializer needed)
        proxy.upgradeToAndCall(address(newImplementation), "");

        // Verify the upgrade
        console.log("=== Upgrade Verification ===");
        console.log("New implementation address:", address(newImplementation));
        console.log("RegistryRouter upgrade completed successfully!");
        console.log("");
        console.log("Note: This is part of the PositionManager split rollout.");
        console.log("Upgrade RoboshareTokens and PositionManager, then complete MANAGER_ROLE wiring before Router.");
        console.log("Run any remaining admin or deployment steps manually or via script.");
    }

    function help() external pure {
        console.log(
            "Usage: CONFIRM_POSITION_MANAGER_SPLIT_UPGRADE=true yarn upgrade --contract RegistryRouter --proxy-address <addr>"
        );
        console.log("Precondition: RoboshareTokens and PositionManager upgrades/wiring completed first.");
        console.log("Post-upgrade: Complete any remaining admin functions");
    }
}
