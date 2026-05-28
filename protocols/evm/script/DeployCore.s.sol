// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { ScaffoldETHDeploy } from "./DeployHelpers.s.sol";
import { RoboshareTokens } from "../contracts/RoboshareTokens.sol";
import { PartnerManager } from "../contracts/PartnerManager.sol";
import { RegistryRouter } from "../contracts/RegistryRouter.sol";
import { VehicleRegistry } from "../contracts/VehicleRegistry.sol";
import { Treasury } from "../contracts/Treasury.sol";
import { EarningsManager } from "../contracts/EarningsManager.sol";
import { Marketplace } from "../contracts/Marketplace.sol";
import { PositionManager } from "../contracts/PositionManager.sol";

/**
 * @title DeployCore
 * @dev Shared deployment logic used by both Deploy.s.sol and DeployForTest.s.sol
 * This ensures the production deployment and test deployment use identical configuration.
 */
abstract contract DeployCore is ScaffoldETHDeploy {
    struct DeployedContracts {
        RoboshareTokens roboshareTokens;
        PartnerManager partnerManager;
        RegistryRouter router;
        VehicleRegistry vehicleRegistry;
        Treasury treasury;
        EarningsManager earningsManager;
        Marketplace marketplace;
        PositionManager positionManager;
    }

    /**
     * @dev Core deployment logic shared between production and test deployments.
     * @param _deployer The address that will receive admin roles
     * @param config The network configuration (USDC address, fee recipient, etc.)
     * @return contracts Struct containing all deployed contract references
     */
    function _deployCore(address _deployer, NetworkConfig memory config)
        internal
        returns (DeployedContracts memory contracts)
    {
        // Deploy RoboshareTokens
        {
            RoboshareTokens tokenImplementation = new RoboshareTokens();
            bytes memory tokenInitData = abi.encodeWithSignature("initialize(address)", _deployer);
            ERC1967Proxy tokenProxy = new ERC1967Proxy(address(tokenImplementation), tokenInitData);
            contracts.roboshareTokens = RoboshareTokens(address(tokenProxy));
        }

        // Deploy PartnerManager
        {
            PartnerManager partnerImplementation = new PartnerManager();
            bytes memory partnerInitData = abi.encodeWithSignature("initialize(address)", _deployer);
            ERC1967Proxy partnerProxy = new ERC1967Proxy(address(partnerImplementation), partnerInitData);
            contracts.partnerManager = PartnerManager(address(partnerProxy));
        }

        // Deploy RegistryRouter
        {
            RegistryRouter routerImplementation = new RegistryRouter();
            bytes memory routerInitData = abi.encodeWithSignature(
                "initialize(address,address,address)",
                _deployer,
                address(contracts.roboshareTokens),
                address(contracts.partnerManager)
            );
            ERC1967Proxy routerProxy = new ERC1967Proxy(address(routerImplementation), routerInitData);
            contracts.router = RegistryRouter(address(routerProxy));
        }

        // Deploy VehicleRegistry
        {
            VehicleRegistry vehicleImplementation = new VehicleRegistry();
            bytes memory vehicleInitData = abi.encodeWithSignature(
                "initialize(address,address,address,address)",
                _deployer,
                address(contracts.roboshareTokens),
                address(contracts.partnerManager),
                address(contracts.router)
            );
            ERC1967Proxy vehicleProxy = new ERC1967Proxy(address(vehicleImplementation), vehicleInitData);
            contracts.vehicleRegistry = VehicleRegistry(address(vehicleProxy));
        }

        // Deploy Treasury
        {
            Treasury treasuryImplementation = new Treasury();
            bytes memory treasuryInitData = abi.encodeWithSignature(
                "initialize(address,address,address,address,address,address)",
                _deployer,
                address(contracts.roboshareTokens),
                address(contracts.partnerManager),
                address(contracts.router),
                config.usdcToken,
                config.treasuryFeeRecipient
            );
            ERC1967Proxy treasuryProxy = new ERC1967Proxy(address(treasuryImplementation), treasuryInitData);
            contracts.treasury = Treasury(address(treasuryProxy));
        }

        // Deploy EarningsManager
        {
            EarningsManager earningsManagerImplementation = new EarningsManager();
            bytes memory earningsManagerInitData = abi.encodeWithSignature(
                "initialize(address,address,address,address,address,address)",
                _deployer,
                address(contracts.roboshareTokens),
                address(contracts.partnerManager),
                address(contracts.router),
                address(contracts.treasury),
                config.usdcToken
            );
            ERC1967Proxy earningsManagerProxy =
                new ERC1967Proxy(address(earningsManagerImplementation), earningsManagerInitData);
            contracts.earningsManager = EarningsManager(address(earningsManagerProxy));
        }

        // Deploy Marketplace
        {
            Marketplace marketplaceImplementation = new Marketplace();
            bytes memory marketplaceInitData = abi.encodeWithSignature(
                "initialize(address,address,address,address,address,address)",
                _deployer,
                address(contracts.roboshareTokens),
                address(contracts.partnerManager),
                address(contracts.router),
                address(contracts.treasury),
                config.usdcToken
            );
            ERC1967Proxy marketplaceProxy = new ERC1967Proxy(address(marketplaceImplementation), marketplaceInitData);
            contracts.marketplace = Marketplace(address(marketplaceProxy));
        }

        // Deploy PositionManager
        {
            PositionManager positionManagerImplementation = new PositionManager();
            bytes memory positionManagerInitData = abi.encodeWithSignature(
                "initialize(address,address,address,address,address,address,address,address)",
                _deployer,
                address(contracts.router),
                address(contracts.roboshareTokens),
                address(contracts.partnerManager),
                address(contracts.marketplace),
                address(contracts.treasury),
                address(contracts.earningsManager),
                config.usdcToken
            );
            ERC1967Proxy positionManagerProxy =
                new ERC1967Proxy(address(positionManagerImplementation), positionManagerInitData);
            contracts.positionManager = PositionManager(address(positionManagerProxy));
        }

        // --- Configuration & Role Granting ---
        _configureRoles(contracts);
    }

    /**
     * @dev Configure all required roles and permissions.
     * This is the SINGLE SOURCE OF TRUTH for role configuration.
     */
    function _configureRoles(DeployedContracts memory contracts) internal {
        // 1. Configure Router
        contracts.router.setTreasury(address(contracts.treasury));
        contracts.router.setEarningsManager(address(contracts.earningsManager));
        contracts.router.setMarketplace(address(contracts.marketplace));
        contracts.treasury.setEarningsManager(address(contracts.earningsManager));
        contracts.roboshareTokens.setPositionManager(address(contracts.positionManager));

        // 2. Grant Roles
        // Grant AUTHORIZED_REGISTRY_ROLE to VehicleRegistry
        contracts.router.grantRole(contracts.router.AUTHORIZED_REGISTRY_ROLE(), address(contracts.vehicleRegistry));

        // Grant MINTER_ROLE to Router (for reserving token IDs) and to VehicleRegistry (for minting revenue tokens)
        contracts.roboshareTokens.grantRole(contracts.roboshareTokens.MINTER_ROLE(), address(contracts.router));
        contracts.roboshareTokens.grantRole(contracts.roboshareTokens.MINTER_ROLE(), address(contracts.vehicleRegistry));

        // Grant BURNER_ROLE to VehicleRegistry (for burning revenue tokens on retirement)
        contracts.roboshareTokens.grantRole(contracts.roboshareTokens.BURNER_ROLE(), address(contracts.vehicleRegistry));

        // Grant AUTHORIZED_MARKETPLACE_ROLE to Marketplace on Treasury for purchase/redemption settlement flows
        contracts.treasury.grantRole(contracts.treasury.AUTHORIZED_MARKETPLACE_ROLE(), address(contracts.marketplace));

        // Grant AUTHORIZED_CONTRACT_ROLE to Router on Marketplace (for createPrimaryPoolFor via registries)
        contracts.marketplace.grantRole(contracts.marketplace.AUTHORIZED_CONTRACT_ROLE(), address(contracts.router));
    }
}
