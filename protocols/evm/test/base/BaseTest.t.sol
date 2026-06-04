// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { PositionManager } from "../../contracts/PositionManager.sol";
import { RoboshareTokens } from "../../contracts/RoboshareTokens.sol";
import { PartnerManager } from "../../contracts/PartnerManager.sol";
import { RegistryRouter } from "../../contracts/RegistryRouter.sol";
import { VehicleRegistry } from "../../contracts/VehicleRegistry.sol";
import { Treasury } from "../../contracts/Treasury.sol";
import { EarningsManager } from "../../contracts/EarningsManager.sol";
import { Marketplace } from "../../contracts/Marketplace.sol";
import { DeployForTest } from "../../script/DeployForTest.s.sol";

abstract contract BaseTest is Test {
    enum SetupState {
        None,
        ContractsDeployed,
        InitialAccountsSetup,
        AssetRegistered,
        PrimaryPoolCreated,
        PurchasedFromPrimaryPool,
        BuffersFunded,
        EarningsDistributed
    }

    SetupState private currentState;

    DeployForTest public deployer;
    RoboshareTokens public roboshareTokens;
    PartnerManager public partnerManager;
    Treasury public treasury;
    EarningsManager public earningsManager;
    RegistryRouter public router;
    VehicleRegistry public assetRegistry;
    Marketplace public marketplace;
    PositionManager public positionManager;
    IERC20 public usdc;

    DeployForTest.NetworkConfig public config;

    address public admin = makeAddr("admin");
    address public partner1 = makeAddr("partner1");
    address public partner2 = makeAddr("partner2");
    address public buyer = makeAddr("buyer");
    address public unauthorized = makeAddr("unauthorized");

    string constant PARTNER1_NAME = "RideShare Fleet Co.";
    string constant PARTNER2_NAME = "Urban Delivery Services";

    uint256 constant REVENUE_TOKEN_PRICE = 100 * 10 ** 6;
    uint256 constant ASSET_VALUE = 100000 * 10 ** 6;
    uint256 constant PRIMARY_PURCHASE_AMOUNT = (ASSET_VALUE / REVENUE_TOKEN_PRICE) / 2;
    uint256 constant SECONDARY_LISTING_AMOUNT = PRIMARY_PURCHASE_AMOUNT / 2;
    uint256 constant LISTING_DURATION = 30 days;
    uint256 constant SECONDARY_PURCHASE_AMOUNT = SECONDARY_LISTING_AMOUNT / 2;
    uint256 constant EARNINGS_AMOUNT = 1000 * 1e6;
    uint256 constant SMALL_EARNINGS_AMOUNT = 100 * 1e6;
    uint256 constant LARGE_EARNINGS_AMOUNT = 10000 * 1e6;
    uint256 constant SETTLEMENT_TOP_UP_AMOUNT = (PRIMARY_PURCHASE_AMOUNT * REVENUE_TOKEN_PRICE) / 10;

    struct TestScenario {
        uint256 assetId;
        uint256 revenueTokenId;
        uint256 listingId;
    }

    TestScenario public scenario;

    function _ensureState(SetupState requiredState) internal {
        if (currentState >= requiredState) {
            return;
        }

        if (currentState < SetupState.ContractsDeployed) {
            _deployContracts();
            currentState = SetupState.ContractsDeployed;
        }

        if (requiredState >= SetupState.InitialAccountsSetup && currentState < SetupState.InitialAccountsSetup) {
            _setupInitialRolesAndAccounts();
            currentState = SetupState.InitialAccountsSetup;
        }

        if (requiredState >= SetupState.AssetRegistered && currentState < SetupState.AssetRegistered) {
            scenario.assetId = _setupAssetRegistered();
            currentState = SetupState.AssetRegistered;
        }

        if (requiredState >= SetupState.PrimaryPoolCreated && currentState < SetupState.PrimaryPoolCreated) {
            scenario.revenueTokenId = _setupPrimaryPoolCreated();
            currentState = SetupState.PrimaryPoolCreated;
        }

        if (requiredState >= SetupState.PurchasedFromPrimaryPool && currentState < SetupState.PurchasedFromPrimaryPool)
        {
            _setupPurchasedFromPrimaryPool();
            currentState = SetupState.PurchasedFromPrimaryPool;
        }

        if (requiredState >= SetupState.BuffersFunded && currentState < SetupState.BuffersFunded) {
            _setupBuffersFunded();
            currentState = SetupState.BuffersFunded;
        }

        if (requiredState >= SetupState.EarningsDistributed && currentState < SetupState.EarningsDistributed) {
            _setupEarningsDistributed(EARNINGS_AMOUNT);
            currentState = SetupState.EarningsDistributed;
        }
    }

    function _deployContracts() internal {
        deployer = new DeployForTest();
        (
            roboshareTokens,
            partnerManager,
            router,
            assetRegistry,
            treasury,
            earningsManager,
            marketplace,
            positionManager
        ) = deployer.run(admin);

        config = deployer.getActiveNetworkConfig();
        usdc = IERC20(config.usdcToken);
    }

    function _setupInitialRolesAndAccounts() internal {
        _setupMultiplePartners(2);
        _fundAddressWithUsdc(buyer, 1000000 * 10 ** 6);
    }

    function _setupMultiplePartners(uint256 count) internal returns (address[] memory partners) {
        partners = new address[](count);

        vm.startPrank(admin);
        for (uint256 i = 0; i < count; i++) {
            partners[i] = makeAddr(string(abi.encodePacked("partner", vm.toString(i + 1))));
            partnerManager.authorizePartner(partners[i], string(abi.encodePacked("Partner ", vm.toString(i + 1))));
            _fundAddressWithUsdc(partners[i], 1000000 * 10 ** 6);
        }
        vm.stopPrank();

        return partners;
    }

    function _fundAddressWithUsdc(address account, uint256 amount) internal {
        deal(address(usdc), account, amount);
    }

    function _setupAssetRegistered() internal virtual returns (uint256);

    function _setupPrimaryPoolCreated() internal virtual returns (uint256);

    function _setupPurchasedFromPrimaryPool() internal virtual;

    function _setupBuffersFunded() internal virtual;

    function _setupEarningsDistributed(uint256) internal virtual;
}
