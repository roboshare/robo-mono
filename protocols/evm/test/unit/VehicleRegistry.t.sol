// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { VehicleRegistryBaseTest } from "../base/VehicleRegistryBaseTest.t.sol";
import { VehicleLib } from "../../contracts/Libraries.sol";
import { IAssetRegistry } from "../../contracts/interfaces/IAssetRegistry.sol";
import { VehicleRegistry } from "../../contracts/VehicleRegistry.sol";

contract VehicleRegistryTest is VehicleRegistryBaseTest {
    function _setupBuffersFunded() internal override { }

    function _setupEarningsDistributed(uint256) internal override { }

    function setUp() public {
        _ensureState(SetupState.ContractsDeployed);
    }

    // Initialization Tests

    function testInitialization() public view {
        // Check contract references
        assertEq(address(assetRegistry.roboshareTokens()), address(roboshareTokens));
        assertEq(address(assetRegistry.partnerManager()), address(partnerManager));
        assertEq(address(assetRegistry.router()), address(router));

        // Check initial state (no vehicles registered yet)
        assertEq(roboshareTokens.getNextTokenId(), 1);

        // Check roles
        assertTrue(assetRegistry.hasRole(assetRegistry.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(assetRegistry.hasRole(assetRegistry.UPGRADER_ROLE(), admin));

        // Verify role hashes
        assertEq(assetRegistry.UPGRADER_ROLE(), keccak256("UPGRADER_ROLE"), "Invalid UPGRADER_ROLE hash");
        assertEq(assetRegistry.ROUTER_ROLE(), keccak256("ROUTER_ROLE"), "Invalid ROUTER_ROLE hash");

        // Verify hierarchy
        assertEq(assetRegistry.getRoleAdmin(assetRegistry.UPGRADER_ROLE()), assetRegistry.DEFAULT_ADMIN_ROLE());
        assertEq(assetRegistry.getRoleAdmin(assetRegistry.ROUTER_ROLE()), assetRegistry.DEFAULT_ADMIN_ROLE());
    }

    function testInitializationZeroAdmin() public {
        VehicleRegistry newImplementation = new VehicleRegistry();
        bytes memory initData = abi.encodeWithSignature(
            "initialize(address,address,address,address)",
            address(0),
            address(roboshareTokens),
            address(partnerManager),
            address(router)
        );
        vm.expectRevert(VehicleRegistry.ZeroAddress.selector);
        new ERC1967Proxy(address(newImplementation), initData);
    }

    function testInitializationZeroTokens() public {
        VehicleRegistry newImplementation = new VehicleRegistry();
        bytes memory initData = abi.encodeWithSignature(
            "initialize(address,address,address,address)", admin, address(0), address(partnerManager), address(router)
        );
        vm.expectRevert(VehicleRegistry.ZeroAddress.selector);
        new ERC1967Proxy(address(newImplementation), initData);
    }

    function testInitializationZeroPartnerManager() public {
        VehicleRegistry newImplementation = new VehicleRegistry();
        bytes memory initData = abi.encodeWithSignature(
            "initialize(address,address,address,address)", admin, address(roboshareTokens), address(0), address(router)
        );
        vm.expectRevert(VehicleRegistry.ZeroAddress.selector);
        new ERC1967Proxy(address(newImplementation), initData);
    }

    function testInitializationZeroRouter() public {
        VehicleRegistry newImplementation = new VehicleRegistry();
        bytes memory initData = abi.encodeWithSignature(
            "initialize(address,address,address,address)",
            admin,
            address(roboshareTokens),
            address(partnerManager),
            address(0)
        );
        vm.expectRevert(VehicleRegistry.ZeroAddress.selector);
        new ERC1967Proxy(address(newImplementation), initData);
    }

    function testGetAssetInfoAssetNotFound() public {
        vm.expectRevert(abi.encodeWithSelector(IAssetRegistry.AssetNotFound.selector, 999));
        assetRegistry.getAssetInfo(999);
    }

    function testGetAssetStatusAssetNotFound() public {
        vm.expectRevert(abi.encodeWithSelector(IAssetRegistry.AssetNotFound.selector, 999));
        assetRegistry.getAssetStatus(999);
    }

    // Error Case Tests

    function testGetVehicleInfoVehicleDoesNotExist() public {
        vm.expectRevert(VehicleRegistry.VehicleDoesNotExist.selector);
        assetRegistry.getVehicleInfo(999);
    }

    function testRegisterVehicleInvalidVINLength() public {
        _ensureState(SetupState.InitialAccountsSetup);
        string memory shortVin = "VIN123"; // <10 length
        vm.expectRevert(VehicleLib.InvalidVINLength.selector);
        vm.prank(partner1);
        assetRegistry.registerAsset(_vehicleRegistrationData(shortVin), ASSET_VALUE);
    }

    function testRegisterVehicleInvalidMetadataURI() public {
        _ensureState(SetupState.InitialAccountsSetup);
        vm.expectRevert(VehicleLib.InvalidMetadataURI.selector);
        vm.prank(partner1);
        assetRegistry.registerAsset(
            _vehicleRegistrationData(TEST_VIN, "http://invalid-uri", TEST_REVENUE_TOKEN_METADATA_URI), ASSET_VALUE
        );
    }

    function testRegisterVehicleInvalidRevenueTokenMetadataURI() public {
        _ensureState(SetupState.InitialAccountsSetup);
        vm.expectRevert(VehicleLib.InvalidMetadataURI.selector);
        vm.prank(partner1);
        assetRegistry.registerAsset(
            _vehicleRegistrationData(TEST_VIN, TEST_METADATA_URI, "http://invalid-uri"), ASSET_VALUE
        );
    }

    function testRegisterVehicleAcceptsLegacyPartnerFormPayload() public {
        _ensureState(SetupState.InitialAccountsSetup);

        bytes memory legacyPayload = _legacyVehicleRegistrationData(TEST_VIN, TEST_METADATA_URI);

        vm.prank(partner1);
        uint256 assetId = assetRegistry.registerAsset(legacyPayload, ASSET_VALUE);

        (bytes32 vinHash, string memory assetMetadataURI, string memory revenueTokenMetadataURI) =
            assetRegistry.getVehicleInfo(assetId);

        assertEq(vinHash, keccak256(bytes(TEST_VIN)));
        assertEq(assetMetadataURI, TEST_METADATA_URI);
        assertEq(revenueTokenMetadataURI, TEST_METADATA_URI);
        assertEq(roboshareTokens.uri(assetId), TEST_METADATA_URI);
        assertEq(roboshareTokens.uri(assetId + 1), TEST_METADATA_URI);
    }

    function testGetRegistryForAsset() public {
        _ensureState(SetupState.AssetRegistered);

        // Existing asset
        assertEq(assetRegistry.getRegistryForAsset(scenario.assetId), address(assetRegistry));

        // Non-existent asset
        assertEq(assetRegistry.getRegistryForAsset(999), address(0));
    }

    function testGetVehicleInfo() public {
        _ensureState(SetupState.AssetRegistered);

        (bytes32 vinHash, string memory assetMetadataURI, string memory revenueTokenMetadataURI) =
            assetRegistry.getVehicleInfo(scenario.assetId);

        assertEq(vinHash, keccak256(bytes(TEST_VIN)));
        assertEq(assetMetadataURI, TEST_METADATA_URI);
        assertEq(revenueTokenMetadataURI, TEST_REVENUE_TOKEN_METADATA_URI);
    }

    // ============ Admin Function Tests ============

    function testUpdateRoboshareTokens() public {
        address newTokens = makeAddr("newRoboshareTokens");
        address oldTokens = address(assetRegistry.roboshareTokens());

        vm.prank(admin);
        vm.expectEmit(true, true, false, false);
        emit VehicleRegistry.RoboshareTokensUpdated(oldTokens, newTokens);
        assetRegistry.updateRoboshareTokens(newTokens);

        assertEq(address(assetRegistry.roboshareTokens()), newTokens);
    }

    function testUpdateRoboshareTokensZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(VehicleRegistry.ZeroAddress.selector);
        assetRegistry.updateRoboshareTokens(address(0));
    }

    function testUpdateRoboshareTokensUnauthorizedCaller() public {
        address newTokens = makeAddr("newRoboshareTokens");

        vm.startPrank(unauthorized);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                unauthorized,
                assetRegistry.DEFAULT_ADMIN_ROLE()
            )
        );
        assetRegistry.updateRoboshareTokens(newTokens);
        vm.stopPrank();
    }

    function testUpdatePartnerManager() public {
        address newPM = makeAddr("newPartnerManager");
        address oldPM = address(assetRegistry.partnerManager());

        vm.prank(admin);
        vm.expectEmit(true, true, false, false);
        emit VehicleRegistry.PartnerManagerUpdated(oldPM, newPM);
        assetRegistry.updatePartnerManager(newPM);

        assertEq(address(assetRegistry.partnerManager()), newPM);
    }

    function testUpdatePartnerManagerZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(VehicleRegistry.ZeroAddress.selector);
        assetRegistry.updatePartnerManager(address(0));
    }

    function testUpdatePartnerManagerUnauthorizedCaller() public {
        address newPM = makeAddr("newPartnerManager");

        vm.startPrank(unauthorized);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                unauthorized,
                assetRegistry.DEFAULT_ADMIN_ROLE()
            )
        );
        assetRegistry.updatePartnerManager(newPM);
        vm.stopPrank();
    }

    function testUpdateRouter() public {
        address newRouter = makeAddr("newRouter");
        address oldRouter = address(assetRegistry.router());

        vm.prank(admin);
        vm.expectEmit(true, true, false, false);
        emit VehicleRegistry.RouterUpdated(oldRouter, newRouter);
        assetRegistry.updateRouter(newRouter);

        assertEq(address(assetRegistry.router()), newRouter);
        // Verify role update
        assertTrue(assetRegistry.hasRole(assetRegistry.ROUTER_ROLE(), newRouter));
        assertFalse(assetRegistry.hasRole(assetRegistry.ROUTER_ROLE(), oldRouter));
    }

    function testUpdateRouterZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(VehicleRegistry.ZeroAddress.selector);
        assetRegistry.updateRouter(address(0));
    }

    function testUpgradeUnauthorizedCaller() public {
        VehicleRegistry newImpl = new VehicleRegistry();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, assetRegistry.UPGRADER_ROLE()
            )
        );
        vm.prank(unauthorized);
        assetRegistry.upgradeToAndCall(address(newImpl), "");
    }
}
