// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { ProtocolLib } from "../../contracts/Libraries.sol";
import { TreasuryFlowBaseTest } from "../base/TreasuryFlowBaseTest.t.sol";
import { MockUSDC } from "../../contracts/mocks/MockUSDC.sol";
import { RoboshareTokens } from "../../contracts/RoboshareTokens.sol";
import { PartnerManager } from "../../contracts/PartnerManager.sol";
import { RegistryRouter } from "../../contracts/RegistryRouter.sol";
import { Treasury } from "../../contracts/Treasury.sol";
import { ITreasury } from "../../contracts/interfaces/ITreasury.sol";

contract TreasuryBadTotalSupplyToken {
    function totalSupply() external pure returns (uint256) {
        revert("bad totalSupply");
    }
}

contract TreasuryBadDecimalsToken {
    function totalSupply() external pure returns (uint256) {
        return 1;
    }

    function decimals() external pure returns (uint8) {
        revert("bad decimals");
    }
}

contract TreasuryWrongDecimalsToken {
    function totalSupply() external pure returns (uint256) {
        return 1;
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }
}

contract TreasuryInternalHarness is Treasury {
    function exposeTryReleaseCollateral(uint256 assetId, address partner, bool allowSkip) external returns (uint256) {
        return _tryReleaseCollateral(assetId, partner, allowSkip);
    }
}

contract TreasuryTest is TreasuryFlowBaseTest {
    function setUp() public {
        _ensureState(SetupState.ContractsDeployed);
    }

    // Initialization Tests

    function testInitialization() public view {
        // Check contract references
        assertEq(address(treasury.partnerManager()), address(partnerManager));
        assertEq(address(treasury.router()), address(router));
        assertEq(address(treasury.usdc()), address(usdc));

        // Check initial state
        assertEq(treasury.totalCollateralDeposited(), 0);

        // Check admin roles
        assertTrue(treasury.hasRole(treasury.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(treasury.hasRole(treasury.UPGRADER_ROLE(), admin));
        assertTrue(treasury.hasRole(treasury.TREASURER_ROLE(), admin));

        // Verify role hashes
        assertEq(treasury.UPGRADER_ROLE(), keccak256("UPGRADER_ROLE"), "Invalid UPGRADER_ROLE hash");
        assertEq(treasury.TREASURER_ROLE(), keccak256("TREASURER_ROLE"), "Invalid TREASURER_ROLE hash");
        assertEq(
            treasury.AUTHORIZED_MARKETPLACE_ROLE(),
            keccak256("AUTHORIZED_MARKETPLACE_ROLE"),
            "Invalid AUTHORIZED_MARKETPLACE_ROLE hash"
        );
        assertEq(
            treasury.AUTHORIZED_ROUTER_ROLE(),
            keccak256("AUTHORIZED_ROUTER_ROLE"),
            "Invalid AUTHORIZED_ROUTER_ROLE hash"
        );

        // Verify hierarchy (all managed by default admin)
        assertEq(treasury.getRoleAdmin(treasury.UPGRADER_ROLE()), treasury.DEFAULT_ADMIN_ROLE());
        assertEq(treasury.getRoleAdmin(treasury.TREASURER_ROLE()), treasury.DEFAULT_ADMIN_ROLE());
        assertEq(treasury.getRoleAdmin(treasury.AUTHORIZED_MARKETPLACE_ROLE()), treasury.DEFAULT_ADMIN_ROLE());
        assertEq(treasury.getRoleAdmin(treasury.AUTHORIZED_ROUTER_ROLE()), treasury.DEFAULT_ADMIN_ROLE());
    }

    function testInitializationZeroAdmin() public {
        Treasury newTreasury = new Treasury();
        vm.expectRevert(Treasury.ZeroAddress.selector);
        new ERC1967Proxy(
            address(newTreasury),
            abi.encodeWithSignature(
                "initialize(address,address,address,address,address,address)",
                address(0),
                address(roboshareTokens),
                address(partnerManager),
                address(router),
                address(usdc),
                config.treasuryFeeRecipient
            )
        );
    }

    function testInitializationZeroTokens() public {
        Treasury newTreasury = new Treasury();
        vm.expectRevert(Treasury.ZeroAddress.selector);
        new ERC1967Proxy(
            address(newTreasury),
            abi.encodeWithSignature(
                "initialize(address,address,address,address,address,address)",
                admin,
                address(0),
                address(partnerManager),
                address(router),
                address(usdc),
                config.treasuryFeeRecipient
            )
        );
    }

    function testInitializationZeroPartnerManager() public {
        Treasury newTreasury = new Treasury();
        vm.expectRevert(Treasury.ZeroAddress.selector);
        new ERC1967Proxy(
            address(newTreasury),
            abi.encodeWithSignature(
                "initialize(address,address,address,address,address,address)",
                admin,
                address(roboshareTokens),
                address(0),
                address(router),
                address(usdc),
                config.treasuryFeeRecipient
            )
        );
    }

    function testInitializationZeroRouter() public {
        Treasury newTreasury = new Treasury();
        vm.expectRevert(Treasury.ZeroAddress.selector);
        new ERC1967Proxy(
            address(newTreasury),
            abi.encodeWithSignature(
                "initialize(address,address,address,address,address,address)",
                admin,
                address(roboshareTokens),
                address(partnerManager),
                address(0),
                address(usdc),
                config.treasuryFeeRecipient
            )
        );
    }

    function testInitializationZeroUSDC() public {
        Treasury newTreasury = new Treasury();
        vm.expectRevert(Treasury.ZeroAddress.selector);
        new ERC1967Proxy(
            address(newTreasury),
            abi.encodeWithSignature(
                "initialize(address,address,address,address,address,address)",
                admin,
                address(roboshareTokens),
                address(partnerManager),
                address(router),
                address(0),
                config.treasuryFeeRecipient
            )
        );
    }

    function testInitializationZeroFeeRecipient() public {
        Treasury newTreasury = new Treasury();
        vm.expectRevert(Treasury.ZeroAddress.selector);
        new ERC1967Proxy(
            address(newTreasury),
            abi.encodeWithSignature(
                "initialize(address,address,address,address,address,address)",
                admin,
                address(roboshareTokens),
                address(partnerManager),
                address(router),
                address(usdc),
                address(0)
            )
        );
    }

    // Collateral Calculation Tests

    function testGetTotalBufferRequirement() public pure {
        uint256 requirement = _getTotalBufferRequirement(ASSET_VALUE, ProtocolLib.BENCHMARK_YIELD_BP, true);
        (,, uint256 expectedTotal) = _calculateExpectedBuffers(ASSET_VALUE);
        assertEq(requirement, expectedTotal);
    }

    function testGetProtocolConfig() public pure {
        (
            uint256 bpPrecision,
            uint256 benchmarkYieldBP,
            uint256 protocolFeeBP,
            uint256 earlySalePenaltyBP,
            uint256 depreciationRateBP,
            uint256 minProtocolFee,
            uint256 minEarlySalePenalty
        ) = (
            ProtocolLib.BP_PRECISION,
            ProtocolLib.BENCHMARK_YIELD_BP,
            ProtocolLib.PROTOCOL_FEE_BP,
            ProtocolLib.EARLY_SALE_PENALTY_BP,
            ProtocolLib.DEPRECIATION_RATE_BP,
            ProtocolLib.MIN_PROTOCOL_FEE,
            ProtocolLib.MIN_EARLY_SALE_PENALTY
        );

        assertEq(bpPrecision, ProtocolLib.BP_PRECISION);
        assertEq(benchmarkYieldBP, ProtocolLib.BENCHMARK_YIELD_BP);
        assertEq(protocolFeeBP, ProtocolLib.PROTOCOL_FEE_BP);
        assertEq(earlySalePenaltyBP, ProtocolLib.EARLY_SALE_PENALTY_BP);
        assertEq(depreciationRateBP, ProtocolLib.DEPRECIATION_RATE_BP);
        assertEq(minProtocolFee, ProtocolLib.MIN_PROTOCOL_FEE);
        assertEq(minEarlySalePenalty, ProtocolLib.MIN_EARLY_SALE_PENALTY);
    }

    // Admin Functions Tests

    function testUpdatePartnerManager() public {
        PartnerManager newPartnerManager = new PartnerManager();

        vm.startPrank(admin);
        treasury.updatePartnerManager(address(newPartnerManager));
        vm.stopPrank();

        assertEq(address(treasury.partnerManager()), address(newPartnerManager));
    }

    function testUpdatePartnerManagerZeroAddress() public {
        vm.expectRevert(Treasury.ZeroAddress.selector);
        vm.startPrank(admin);
        treasury.updatePartnerManager(address(0));
        vm.stopPrank();
    }

    function testUpdatePartnerManagerUnauthorizedCaller() public {
        PartnerManager newPartnerManager = new PartnerManager();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, treasury.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(unauthorized);
        treasury.updatePartnerManager(address(newPartnerManager));
    }

    function testUpdateRouter() public {
        RegistryRouter newRouter = new RegistryRouter();

        vm.startPrank(admin);
        treasury.updateRouter(address(newRouter));
        vm.stopPrank();

        assertEq(address(treasury.router()), address(newRouter));
    }

    function testUpdateRouterZeroAddress() public {
        vm.expectRevert(Treasury.ZeroAddress.selector);
        vm.startPrank(admin);
        treasury.updateRouter(address(0));
        vm.stopPrank();
    }

    function testUpdateRouterUnauthorizedCaller() public {
        RegistryRouter newRouter = new RegistryRouter();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, treasury.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(unauthorized);
        treasury.updateRouter(address(newRouter));
    }

    function testUpdateUSDC() public {
        MockUSDC newUsdc = new MockUSDC();

        vm.startPrank(admin);
        treasury.updateUSDC(address(newUsdc));
        vm.stopPrank();

        assertEq(address(treasury.usdc()), address(newUsdc));
    }

    function testUpdateUSDCZeroAddress() public {
        vm.expectRevert(Treasury.ZeroAddress.selector);
        vm.startPrank(admin);
        treasury.updateUSDC(address(0));
        vm.stopPrank();
    }

    function testUpdateUSDCUnauthorizedCaller() public {
        MockUSDC newUsdc = new MockUSDC();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, treasury.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(unauthorized);
        treasury.updateUSDC(address(newUsdc));
    }

    function testUpdateUSDCInvalidUSDCContractTotalSupply() public {
        TreasuryBadTotalSupplyToken bad = new TreasuryBadTotalSupplyToken();

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(Treasury.InvalidUSDCContract.selector, address(bad)));
        treasury.updateUSDC(address(bad));
        vm.stopPrank();
    }

    function testUpdateUSDCInvalidUSDCContractDecimals() public {
        TreasuryBadDecimalsToken bad = new TreasuryBadDecimalsToken();

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(Treasury.InvalidUSDCContract.selector, address(bad)));
        treasury.updateUSDC(address(bad));
        vm.stopPrank();
    }

    function testUpdateUSDCUnsupportedUSDCDecimals() public {
        TreasuryWrongDecimalsToken bad = new TreasuryWrongDecimalsToken();

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(Treasury.UnsupportedUSDCDecimals.selector, uint8(18)));
        treasury.updateUSDC(address(bad));
        vm.stopPrank();
    }

    function testUpdateRoboshareTokens() public {
        RoboshareTokens newRoboshareTokens = new RoboshareTokens();

        vm.startPrank(admin);
        treasury.updateRoboshareTokens(address(newRoboshareTokens));
        vm.stopPrank();

        assertEq(address(treasury.roboshareTokens()), address(newRoboshareTokens));
    }

    function testUpdateRoboshareTokensZeroAddress() public {
        vm.expectRevert(Treasury.ZeroAddress.selector);
        vm.startPrank(admin);
        treasury.updateRoboshareTokens(address(0));
        vm.stopPrank();
    }

    function testUpdateRoboshareTokensUnauthorizedCaller() public {
        RoboshareTokens newRoboshareTokens = new RoboshareTokens();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, treasury.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(unauthorized);
        treasury.updateRoboshareTokens(address(newRoboshareTokens));
    }

    function testUpdateTreasuryFeeRecipient() public {
        address newRecipient = makeAddr("treasuryFee");

        vm.startPrank(admin);
        treasury.updateTreasuryFeeRecipient(newRecipient);
        vm.stopPrank();
    }

    function testUpdateTreasuryFeeRecipientZeroAddress() public {
        vm.startPrank(admin);
        vm.expectRevert(Treasury.ZeroAddress.selector);
        treasury.updateTreasuryFeeRecipient(address(0));
        vm.stopPrank();
    }

    function testUpdateTreasuryFeeRecipientUnauthorizedCaller() public {
        address newRecipient = makeAddr("treasuryFee");

        vm.startPrank(unauthorized);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, treasury.DEFAULT_ADMIN_ROLE()
            )
        );
        treasury.updateTreasuryFeeRecipient(newRecipient);
        vm.stopPrank();
    }

    function testSetEarningsManager() public {
        address newEarningsManager = makeAddr("newEarningsManager");
        address oldEarningsManager = address(treasury.earningsManager());

        vm.prank(admin);
        treasury.setEarningsManager(newEarningsManager);

        assertEq(address(treasury.earningsManager()), newEarningsManager);
        assertFalse(treasury.hasRole(treasury.AUTHORIZED_EARNINGS_MANAGER_ROLE(), oldEarningsManager));
        assertTrue(treasury.hasRole(treasury.AUTHORIZED_EARNINGS_MANAGER_ROLE(), newEarningsManager));
    }

    function testSetEarningsManagerZeroAddress() public {
        vm.expectRevert(Treasury.ZeroAddress.selector);
        vm.prank(admin);
        treasury.setEarningsManager(address(0));
    }

    function testSetEarningsManagerInitialGrantRoleWhenUnset() public {
        Treasury newTreasury = new Treasury();
        ERC1967Proxy proxy = new ERC1967Proxy(address(newTreasury), "");
        Treasury freshTreasury = Treasury(address(proxy));

        freshTreasury.initialize(
            admin,
            address(roboshareTokens),
            address(partnerManager),
            address(router),
            address(usdc),
            config.treasuryFeeRecipient
        );

        address newEarningsManager = makeAddr("freshEarningsManager");
        vm.prank(admin);
        freshTreasury.setEarningsManager(newEarningsManager);

        assertEq(address(freshTreasury.earningsManager()), newEarningsManager);
        assertTrue(freshTreasury.hasRole(freshTreasury.AUTHORIZED_EARNINGS_MANAGER_ROLE(), newEarningsManager));
    }

    function testEnableProceedsEarningsManagerNotSet() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        vm.store(address(treasury), bytes32(uint256(3)), bytes32(0));

        vm.prank(partner1);
        vm.expectRevert(ITreasury.EarningsManagerNotSet.selector);
        treasury.enableProceeds(scenario.assetId);
    }

    function testPreviewLiquidationEligibilityEarningsManagerNotSet() public {
        _ensureState(SetupState.AssetRegistered);
        vm.store(address(treasury), bytes32(uint256(3)), bytes32(0));

        vm.expectRevert(ITreasury.EarningsManagerNotSet.selector);
        treasury.previewLiquidationEligibility(scenario.assetId);
    }

    function testProcessWithdrawal() public {
        _ensureState(SetupState.InitialAccountsSetup);
        uint256 amount = 50e6;
        deal(address(usdc), address(treasury), amount);

        vm.prank(address(marketplace));
        treasury.recordPendingWithdrawalFor(partner1, amount);

        uint256 before = usdc.balanceOf(partner1);
        vm.prank(partner1);
        treasury.processWithdrawal();

        assertEq(usdc.balanceOf(partner1), before + amount);
        assertEq(treasury.pendingWithdrawals(partner1), 0);
    }

    function testTryReleaseCollateralAllowSkipReturnsZero() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        TreasuryInternalHarness impl = new TreasuryInternalHarness();
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), "");
        TreasuryInternalHarness harness = TreasuryInternalHarness(address(proxy));

        harness.initialize(
            admin,
            address(roboshareTokens),
            address(partnerManager),
            address(router),
            address(usdc),
            config.treasuryFeeRecipient
        );

        vm.prank(admin);
        harness.setEarningsManager(address(earningsManager));

        uint256 released = harness.exposeTryReleaseCollateral(scenario.assetId, partner1, true);

        assertEq(released, 0);
        assertEq(harness.pendingWithdrawals(partner1), 0);
    }

    function testUpgradeUnauthorizedCaller() public {
        Treasury newImpl = new Treasury();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, treasury.UPGRADER_ROLE()
            )
        );
        vm.prank(unauthorized);
        treasury.upgradeToAndCall(address(newImpl), "");
    }
}
