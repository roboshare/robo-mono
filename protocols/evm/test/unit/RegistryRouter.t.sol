// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { AssetMetadataBaseTest } from "../base/AssetMetadataBaseTest.t.sol";
import { AssetLib } from "../../contracts/Libraries.sol";
import { RegistryRouter } from "../../contracts/RegistryRouter.sol";
import { RoboshareTokens } from "../../contracts/RoboshareTokens.sol";

contract RegistryRouterTest is AssetMetadataBaseTest {
    function _setupBuffersFunded() internal override { }

    function _setupEarningsDistributed(uint256) internal override { }

    function setUp() public {
        _ensureState(SetupState.InitialAccountsSetup);
    }

    function testInitialization() public view {
        assertEq(router.getRegistryType(), "RegistryRouter");
        assertEq(router.getRegistryVersion(), 1);
        assertEq(router.treasury(), address(treasury));

        // Verify role hashes
        assertEq(router.REGISTRY_ADMIN_ROLE(), keccak256("REGISTRY_ADMIN_ROLE"), "Invalid REGISTRY_ADMIN_ROLE hash");
        assertEq(
            router.AUTHORIZED_REGISTRY_ROLE(),
            keccak256("AUTHORIZED_REGISTRY_ROLE"),
            "Invalid AUTHORIZED_REGISTRY_ROLE hash"
        );
        assertEq(router.UPGRADER_ROLE(), keccak256("UPGRADER_ROLE"), "Invalid UPGRADER_ROLE hash");

        // Verify role hierarchy (AUTHORIZED_REGISTRY_ROLE admin should be REGISTRY_ADMIN_ROLE)
        assertEq(
            router.getRoleAdmin(router.AUTHORIZED_REGISTRY_ROLE()),
            router.REGISTRY_ADMIN_ROLE(),
            "Invalid role admin for registry"
        );
        // Verify default admin for other roles
        assertEq(
            router.getRoleAdmin(router.REGISTRY_ADMIN_ROLE()),
            router.DEFAULT_ADMIN_ROLE(),
            "REGISTRY_ADMIN admin should be default"
        );
    }

    function testAuthorizeRegistry() public {
        address newRegistry = makeAddr("newRegistry");

        vm.startPrank(admin);
        router.grantRole(router.AUTHORIZED_REGISTRY_ROLE(), newRegistry);
        vm.stopPrank();

        assertTrue(router.hasRole(router.AUTHORIZED_REGISTRY_ROLE(), newRegistry));
    }

    function testAuthorizeRegistryUnauthorizedCaller() public {
        address newRegistry = makeAddr("newRegistry");

        bytes32 registryManagerRole = router.REGISTRY_ADMIN_ROLE();
        bytes32 authorizedRegistryRole = router.AUTHORIZED_REGISTRY_ROLE();

        vm.startPrank(unauthorized);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, registryManagerRole
            )
        );
        router.grantRole(authorizedRegistryRole, newRegistry);
        vm.stopPrank();
    }

    function testDeauthorizeRegistry() public {
        address newRegistry = makeAddr("newRegistry");

        vm.startPrank(admin);
        router.grantRole(router.AUTHORIZED_REGISTRY_ROLE(), newRegistry);
        assertTrue(router.hasRole(router.AUTHORIZED_REGISTRY_ROLE(), newRegistry));

        router.revokeRole(router.AUTHORIZED_REGISTRY_ROLE(), newRegistry);
        assertFalse(router.hasRole(router.AUTHORIZED_REGISTRY_ROLE(), newRegistry));
        vm.stopPrank();
    }

    function testSetTreasury() public {
        address newTreasury = makeAddr("newTreasury");

        vm.startPrank(admin);
        router.setTreasury(newTreasury);
        vm.stopPrank();

        assertEq(router.treasury(), newTreasury);
    }

    function testSetTreasuryZeroAddress() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.ZeroAddress.selector));
        router.setTreasury(address(0));
        vm.stopPrank();

        assertEq(router.treasury(), address(treasury));
    }

    function testSetTreasuryUnauthorizedCaller() public {
        address newTreasury = makeAddr("newTreasury");

        vm.startPrank(unauthorized);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, router.DEFAULT_ADMIN_ROLE()
            )
        );
        router.setTreasury(newTreasury);
        vm.stopPrank();
    }

    function testSetEarningsManager() public {
        address newEarningsManager = makeAddr("newEarningsManager");

        vm.startPrank(admin);
        router.setEarningsManager(newEarningsManager);
        vm.stopPrank();

        assertEq(router.earningsManager(), newEarningsManager);
    }

    function testSetEarningsManagerZeroAddress() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.ZeroAddress.selector));
        router.setEarningsManager(address(0));
        vm.stopPrank();
    }

    function testSetEarningsManagerUnauthorizedCaller() public {
        address newEarningsManager = makeAddr("newEarningsManager");

        vm.startPrank(unauthorized);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, router.DEFAULT_ADMIN_ROLE()
            )
        );
        router.setEarningsManager(newEarningsManager);
        vm.stopPrank();
    }

    function testSetMarketplace() public {
        address newMarketplace = makeAddr("newMarketplace");

        vm.startPrank(admin);
        router.setMarketplace(newMarketplace);
        vm.stopPrank();

        assertEq(router.marketplace(), newMarketplace);
    }

    function testSetMarketplaceZeroAddress() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.ZeroAddress.selector));
        router.setMarketplace(address(0));
        vm.stopPrank();
    }

    function testSetMarketplaceUnauthorizedCaller() public {
        address newMarketplace = makeAddr("newMarketplace");

        vm.startPrank(unauthorized);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, router.DEFAULT_ADMIN_ROLE()
            )
        );
        router.setMarketplace(newMarketplace);
        vm.stopPrank();
    }

    function testReserveNextTokenIdPair() public {
        address newRegistry = makeAddr("newRegistry");

        vm.startPrank(admin);
        router.grantRole(router.AUTHORIZED_REGISTRY_ROLE(), newRegistry);
        vm.stopPrank();

        vm.startPrank(newRegistry);
        (uint256 assetId, uint256 revenueTokenId) = router.reserveNextTokenIdPair();
        vm.stopPrank();

        assertGt(assetId, 0);
        assertEq(revenueTokenId, assetId + 1);
        assertEq(router.idToRegistry(assetId), newRegistry);
    }

    function testRoutingGetAssetInfo() public {
        // Register asset via VehicleRegistry (which calls router)
        vm.prank(partner1);
        uint256 assetId = assetRegistry.registerAsset(_vehicleRegistrationData(TEST_VIN), ASSET_VALUE);

        // Call via Router
        AssetLib.AssetInfo memory info = router.getAssetInfo(assetId);
        assertEq(uint8(info.status), uint8(AssetLib.AssetStatus.Pending));
    }

    function testRoutingAssetExists() public {
        vm.prank(partner1);
        uint256 assetId = assetRegistry.registerAsset(_vehicleRegistrationData(TEST_VIN), ASSET_VALUE);

        assertTrue(router.assetExists(assetId));
        assertFalse(router.assetExists(999));
    }

    function testRegisterAssetDirectCall() public {
        vm.expectRevert(RegistryRouter.DirectCallNotAllowed.selector);
        router.registerAsset(bytes(""), ASSET_VALUE);
    }

    function testRegisterAssetAndCreateRevenueTokenPoolDirectCall() public {
        vm.expectRevert(RegistryRouter.DirectCallNotAllowed.selector);
        router.registerAssetAndCreateRevenueTokenPool(
            bytes(""), ASSET_VALUE, REVENUE_TOKEN_PRICE, block.timestamp + 365 days, 10_000, 1_000, 1000, false, false
        );
    }

    function testClaimSettlementRegistryNotFound() public {
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, uint256(0)));
        router.claimSettlement(scenario.assetId, false);
    }

    function testRecordImmediateProceedsReleaseNotTreasury() public {
        vm.expectRevert(RegistryRouter.NotTreasury.selector);
        router.recordImmediateProceedsRelease(102, 1);
    }

    function testRecordImmediateProceedsReleaseInvalidTokenType() public {
        vm.prank(address(treasury));
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, scenario.assetId));
        router.recordImmediateProceedsRelease(scenario.assetId, 1);
    }

    function testRecordImmediateProceedsReleaseRegistryNotFound() public {
        uint256 tokenIdWithoutRegistry = 1000;
        vm.prank(address(treasury));
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, tokenIdWithoutRegistry));
        router.recordImmediateProceedsRelease(tokenIdWithoutRegistry, 1);
    }

    function testRecordImmediateProceedsReleaseRevertsWhenPositionManagerUnset() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        RoboshareTokens freshToken = RoboshareTokens(
            address(
                new ERC1967Proxy(address(new RoboshareTokens()), abi.encodeWithSignature("initialize(address)", admin))
            )
        );

        vm.prank(admin);
        router.updateRoboshareTokens(address(freshToken));

        vm.prank(address(treasury));
        vm.expectRevert(RegistryRouter.PositionManagerNotSet.selector);
        router.recordImmediateProceedsRelease(scenario.revenueTokenId, 1);
    }

    function testCreateRevenueTokenPoolRevertsWhenMarketplaceIsNotContract() public {
        _ensureState(SetupState.AssetRegistered);

        vm.prank(admin);
        router.setMarketplace(unauthorized);

        vm.prank(partner1);
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.InvalidMarketplace.selector, unauthorized));
        assetRegistry.createRevenueTokenPool(
            scenario.assetId,
            REVENUE_TOKEN_PRICE,
            block.timestamp + 365 days,
            10_000,
            1_000,
            ASSET_VALUE / REVENUE_TOKEN_PRICE,
            false,
            false
        );
    }

    function testBurnRevenueTokensFromHolderForPrimaryRedemptionRevertsWhenPositionManagerIsNotContract() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        RoboshareTokens freshToken = RoboshareTokens(
            address(
                new ERC1967Proxy(address(new RoboshareTokens()), abi.encodeWithSignature("initialize(address)", admin))
            )
        );

        vm.prank(admin);
        freshToken.setPositionManager(unauthorized);

        vm.prank(admin);
        router.updateRoboshareTokens(address(freshToken));

        vm.prank(address(treasury));
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.InvalidPositionManager.selector, unauthorized));
        router.burnRevenueTokensFromHolderForPrimaryRedemption(buyer, scenario.revenueTokenId, 1);
    }

    function testRecordPrimaryRedemptionPayoutNotTreasury() public {
        vm.expectRevert(RegistryRouter.NotTreasury.selector);
        router.recordPrimaryRedemptionPayout(102, 1);
    }

    function testRecordPrimaryRedemptionPayoutInvalidTokenType() public {
        vm.prank(address(treasury));
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, scenario.assetId));
        router.recordPrimaryRedemptionPayout(scenario.assetId, 1);
    }

    function testRecordPrimaryRedemptionPayoutRegistryNotFound() public {
        uint256 tokenIdWithoutRegistry = 1000;
        vm.prank(address(treasury));
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, tokenIdWithoutRegistry));
        router.recordPrimaryRedemptionPayout(tokenIdWithoutRegistry, 1);
    }

    function testPreviewLiquidationEligibilityView() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        (bool eligible, uint8 reason) = router.previewLiquidationEligibility(scenario.assetId);
        assertFalse(eligible);
        assertEq(reason, 3); // NotEligible
    }

    function testInitializationZeroAdmin() public {
        RegistryRouter routerImpl = new RegistryRouter();

        vm.expectRevert(RegistryRouter.ZeroAddress.selector);

        new ERC1967Proxy(
            address(routerImpl),
            abi.encodeWithSignature(
                "initialize(address,address,address)", address(0), address(roboshareTokens), address(partnerManager)
            )
        );
    }

    function testInitializationZeroTokens() public {
        RegistryRouter routerImpl = new RegistryRouter();

        vm.expectRevert(RegistryRouter.ZeroAddress.selector);

        new ERC1967Proxy(
            address(routerImpl),
            abi.encodeWithSignature("initialize(address,address,address)", admin, address(0), address(partnerManager))
        );
    }

    function testInitializationZeroPartnerManager() public {
        RegistryRouter routerImpl = new RegistryRouter();

        vm.expectRevert(RegistryRouter.ZeroAddress.selector);

        new ERC1967Proxy(
            address(routerImpl),
            abi.encodeWithSignature("initialize(address,address,address)", admin, address(roboshareTokens), address(0))
        );
    }

    // ============ Admin Function Tests ============

    function testUpdateRoboshareTokens() public {
        address newTokens = makeAddr("newRoboshareTokens");
        address oldTokens = address(router.roboshareTokens());

        vm.prank(admin);
        vm.expectEmit(true, true, false, false);
        emit RegistryRouter.RoboshareTokensUpdated(oldTokens, newTokens);
        router.updateRoboshareTokens(newTokens);

        assertEq(address(router.roboshareTokens()), newTokens);
    }

    function testUpdateRoboshareTokensZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(RegistryRouter.ZeroAddress.selector);
        router.updateRoboshareTokens(address(0));
    }

    function testUpdateRoboshareTokensUnauthorizedCaller() public {
        address newTokens = makeAddr("newRoboshareTokens");

        vm.startPrank(unauthorized);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, router.DEFAULT_ADMIN_ROLE()
            )
        );
        router.updateRoboshareTokens(newTokens);
        vm.stopPrank();
    }

    function testUpdatePartnerManager() public {
        address newPartnerManager = makeAddr("newPartnerManager");
        address oldPartnerManager = address(router.partnerManager());

        vm.prank(admin);
        vm.expectEmit(true, true, false, false);
        emit RegistryRouter.PartnerManagerUpdated(oldPartnerManager, newPartnerManager);
        router.updatePartnerManager(newPartnerManager);

        assertEq(address(router.partnerManager()), newPartnerManager);
    }

    function testUpdatePartnerManagerZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(RegistryRouter.ZeroAddress.selector);
        router.updatePartnerManager(address(0));
    }

    function testUpdatePartnerManagerUnauthorizedCaller() public {
        address newPartnerManager = makeAddr("newPartnerManager");

        vm.startPrank(unauthorized);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, router.DEFAULT_ADMIN_ROLE()
            )
        );
        router.updatePartnerManager(newPartnerManager);
        vm.stopPrank();
    }

    function testUpgradeUnauthorizedCaller() public {
        RegistryRouter newImpl = new RegistryRouter();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, router.UPGRADER_ROLE()
            )
        );
        vm.prank(unauthorized);
        router.upgradeToAndCall(address(newImpl), "");
    }
}
