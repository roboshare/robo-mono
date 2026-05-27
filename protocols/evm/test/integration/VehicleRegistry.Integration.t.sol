// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Test } from "forge-std/Test.sol";
import { BaseTest } from "../base/BaseTest.t.sol";
import { AssetMetadataBaseTest } from "../base/AssetMetadataBaseTest.t.sol";
import { VehicleRegistryBaseTest } from "../base/VehicleRegistryBaseTest.t.sol";
import { TreasuryFlowBaseTest } from "../base/TreasuryFlowBaseTest.t.sol";
import { MarketplaceFlowBaseTest } from "../base/MarketplaceFlowBaseTest.t.sol";
import { RoboshareTokens } from "../../contracts/RoboshareTokens.sol";
import { Treasury } from "../../contracts/Treasury.sol";
import { EarningsManager } from "../../contracts/EarningsManager.sol";
import { Marketplace } from "../../contracts/Marketplace.sol";
import { AssetLib, VehicleLib, CollateralLib, ProtocolLib, EarningsLib } from "../../contracts/Libraries.sol";
import { IAssetRegistry } from "../../contracts/interfaces/IAssetRegistry.sol";
import { IPositionManager } from "../../contracts/interfaces/IPositionManager.sol";
import { ITreasury } from "../../contracts/interfaces/ITreasury.sol";
import { PartnerManager } from "../../contracts/PartnerManager.sol";
import { VehicleRegistry } from "../../contracts/VehicleRegistry.sol";

contract VehicleRegistryIntegrationHelper is Test {
    function setupProtectedPoolWithPurchaseAndBuffers(
        VehicleRegistry registry,
        Marketplace market,
        Treasury treasuryContract,
        EarningsManager,
        RoboshareTokens tokens,
        IERC20 usdcToken,
        address poolPartner,
        address poolBuyer,
        bytes memory assetData,
        uint256 assetValue,
        uint256 tokenPrice,
        uint256 purchaseAmount
    ) external returns (uint256 assetId, uint256 revenueTokenId) {
        vm.prank(poolPartner);
        assetId = registry.registerAsset(assetData, assetValue);

        uint256 supply = assetValue / tokenPrice;
        uint256 maturityDate = block.timestamp + 365 days;

        vm.prank(poolPartner);
        (revenueTokenId,) =
            registry.createRevenueTokenPool(assetId, tokenPrice, maturityDate, 10_000, 1_000, supply, false, true);

        (uint256 expectedPayment,,) = market.previewPrimaryPurchase(revenueTokenId, purchaseAmount);
        vm.startPrank(poolBuyer);
        usdcToken.approve(address(market), expectedPayment);
        market.buyFromPrimaryPool(revenueTokenId, purchaseAmount);
        vm.stopPrank();

        (, uint256 baseAmount,,,,,,,,,) = treasuryContract.assetCollateral(assetId);
        uint256 yieldBP = tokens.getTargetYieldBP(revenueTokenId);
        (, uint256 earningsBuffer, uint256 protocolBuffer,) =
            CollateralLib.calculateCollateralRequirements(baseAmount, ProtocolLib.QUARTERLY_INTERVAL, yieldBP);
        uint256 requiredCollateral = protocolBuffer + earningsBuffer;

        vm.prank(poolPartner);
        usdcToken.approve(address(treasuryContract), requiredCollateral);
        vm.prank(poolPartner);
        treasuryContract.enableProceeds(assetId);
    }

    function expectedLiquidationAfterMissedShortfall(
        Treasury treasuryContract,
        EarningsManager earningsManagerContract,
        RoboshareTokens tokens,
        uint256 assetId,
        uint256 revenueTokenId
    ) external view returns (uint256) {
        (
            uint256 unredeemedBasePrincipal,
            uint256 baseCollateral,
            uint256 earningsBuffer,,,,,
            uint256 reservedForLiquidation,,,
        ) = treasuryContract.assetCollateral(assetId);

        (,,,, uint256 lastEventTimestamp,,,,) = earningsManagerContract.assetEarnings(assetId);
        uint256 elapsed = block.timestamp - lastEventTimestamp;
        uint256 targetYieldBP = tokens.getTargetYieldBP(revenueTokenId);
        uint256 baseEarnings = EarningsLib.calculateEarnings(unredeemedBasePrincipal, elapsed, targetYieldBP);
        uint256 reservedIncrease = baseEarnings < earningsBuffer ? baseEarnings : earningsBuffer;
        return baseCollateral + reservedForLiquidation + reservedIncrease;
    }
}

contract VehicleRegistryIntegrationTest is VehicleRegistryBaseTest, MarketplaceFlowBaseTest {
    VehicleRegistryIntegrationHelper internal helper;

    function _positionManager() internal view returns (IPositionManager) {
        return roboshareTokens.positionManager();
    }

    function setUp() public {
        _ensureState(SetupState.InitialAccountsSetup);
        helper = new VehicleRegistryIntegrationHelper();
    }

    function _setupAssetRegistered() internal override(AssetMetadataBaseTest) returns (uint256 assetId) {
        return super._setupAssetRegistered();
    }

    function _setupPrimaryPoolCreated() internal override(AssetMetadataBaseTest) returns (uint256 revenueTokenId) {
        return super._setupPrimaryPoolCreated();
    }

    function _setupPurchasedFromPrimaryPool() internal override(AssetMetadataBaseTest) {
        super._setupPurchasedFromPrimaryPool();
    }

    function _setupBuffersFunded() internal override(BaseTest, TreasuryFlowBaseTest) {
        super._setupBuffersFunded();
    }

    function _setupEarningsDistributed(uint256 totalEarningsAmount) internal override(BaseTest, TreasuryFlowBaseTest) {
        super._setupEarningsDistributed(totalEarningsAmount);
    }

    function _setupProtectedPoolWithPurchaseAndBuffers()
        internal
        override(TreasuryFlowBaseTest)
        returns (uint256 assetId, uint256 revenueTokenId)
    {
        string memory vin = _generateVin(999);
        return helper.setupProtectedPoolWithPurchaseAndBuffers(
            assetRegistry,
            marketplace,
            treasury,
            earningsManager,
            roboshareTokens,
            usdc,
            partner1,
            buyer,
            _vehicleRegistrationData(vin),
            ASSET_VALUE,
            REVENUE_TOKEN_PRICE,
            PRIMARY_PURCHASE_AMOUNT
        );
    }

    function testRetireAssetOutstandingTokens() public {
        _ensureState(SetupState.BuffersFunded);
        // Don't burn tokens
        vm.prank(partner1);
        // Expect Treasury error now
        vm.expectRevert(ITreasury.OutstandingRevenueTokens.selector);
        assetRegistry.retireAsset(scenario.assetId);
    }

    // Vehicle Registration Tests

    function testRegisterAsset() public {
        (string memory vin, string memory metadataURI) = _generateVehicleData(1);

        vm.expectEmit(true, true, false, true, address(assetRegistry));
        emit IAssetRegistry.AssetRegistered(1, partner1, ASSET_VALUE, AssetLib.AssetStatus.Pending);

        vm.expectEmit(true, true, false, true, address(assetRegistry));
        emit VehicleRegistry.VehicleRegistered(1, partner1, keccak256(bytes(vin)));

        vm.prank(partner1);
        uint256 newVehicleId = assetRegistry.registerAsset(
            _vehicleRegistrationData(vin, metadataURI, TEST_REVENUE_TOKEN_METADATA_URI), ASSET_VALUE
        );

        assertEq(newVehicleId, 1);
        _assertVehicleState(newVehicleId, partner1, vin, true);
        assertEq(roboshareTokens.uri(newVehicleId), metadataURI);
        assertEq(roboshareTokens.uri(newVehicleId + 1), TEST_REVENUE_TOKEN_METADATA_URI);
        assertEq(roboshareTokens.getNextTokenId(), 3);
    }

    function testRegisterAssetRejectsLegacyPartnerFormPayload() public {
        (string memory vin, string memory metadataURI) = _generateVehicleData(2);

        vm.expectRevert(VehicleRegistry.UnsupportedVehicleRegistrationPayload.selector);
        vm.prank(partner1);
        assetRegistry.registerAsset(_legacyVehicleRegistrationData(vin, metadataURI), ASSET_VALUE);
    }

    function testRegisterMultipleVehicles() public {
        uint256[] memory p1Assets = _createMultipleTestVehicles(partner1, 1);
        uint256[] memory p2Assets = _createMultipleTestVehicles(partner2, 1);

        assertEq(p1Assets[0], 1);
        assertEq(p2Assets[0], 3);
        _assertVehicleState(p1Assets[0], partner1, "", true); // Skip exact VIN check
        _assertVehicleState(p2Assets[0], partner2, "", true);
        assertEq(roboshareTokens.getNextTokenId(), 5);
    }

    // Revenue Share Token Tests

    function testRegisterAssetAndCreateRevenueTokenPool() public {
        _ensureState(SetupState.InitialAccountsSetup);

        bytes memory vehicleData = _vehicleRegistrationData(TEST_VIN);
        uint256 explicitSupply = (ASSET_VALUE / REVENUE_TOKEN_PRICE) / 2;

        vm.prank(partner1);
        (uint256 assetId, uint256 revenueTokenId, uint256 supply) = assetRegistry.registerAssetAndCreateRevenueTokenPool(
            vehicleData,
            ASSET_VALUE,
            REVENUE_TOKEN_PRICE,
            block.timestamp + 365 days,
            10_000,
            1_000,
            explicitSupply,
            false,
            false
        );

        assertEq(assetId, 1);
        assertEq(revenueTokenId, 2);
        assertEq(supply, explicitSupply);
        assertTrue(marketplace.isPrimaryPoolActive(revenueTokenId));
        assertEq(uint8(assetRegistry.getAssetStatus(assetId)), uint8(AssetLib.AssetStatus.Active));
    }

    function testCreateRevenueTokenPool() public {
        _ensureState(SetupState.InitialAccountsSetup);

        vm.startPrank(admin);
        router.setMarketplace(address(marketplace));
        marketplace.grantRole(marketplace.AUTHORIZED_CONTRACT_ROLE(), address(router));
        vm.stopPrank();

        vm.startPrank(partner1);
        uint256 assetId = assetRegistry.registerAsset(_vehicleRegistrationData(TEST_VIN), ASSET_VALUE);
        uint256 explicitSupply = (ASSET_VALUE / REVENUE_TOKEN_PRICE) / 2;

        (uint256 revenueTokenId, uint256 tokenSupply) = assetRegistry.createRevenueTokenPool(
            assetId, REVENUE_TOKEN_PRICE, block.timestamp + 365 days, 10_000, 1_000, explicitSupply, false, false
        );
        vm.stopPrank();

        assertEq(uint8(assetRegistry.getAssetStatus(assetId)), uint8(AssetLib.AssetStatus.Active));
        assertEq(tokenSupply, explicitSupply);
        assertEq(roboshareTokens.balanceOf(address(marketplace), revenueTokenId), 0);
        assertEq(roboshareTokens.getRevenueTokenSupply(revenueTokenId), 0);
    }

    function testRegisterAssetAndCreateRevenueTokenPoolUnauthorizedPartner() public {
        _ensureState(SetupState.InitialAccountsSetup);

        bytes memory vehicleData = _vehicleRegistrationData(TEST_VIN);

        vm.expectRevert(PartnerManager.UnauthorizedPartner.selector);
        vm.prank(unauthorized);
        assetRegistry.registerAssetAndCreateRevenueTokenPool(
            vehicleData,
            ASSET_VALUE,
            REVENUE_TOKEN_PRICE,
            block.timestamp + 365 days,
            10_000,
            1_000,
            ASSET_VALUE / REVENUE_TOKEN_PRICE,
            false,
            false
        );
    }

    function testCreateRevenueTokenPoolUnauthorizedPartner() public {
        _ensureState(SetupState.InitialAccountsSetup);

        vm.prank(partner1);
        uint256 assetId = assetRegistry.registerAsset(_vehicleRegistrationData(TEST_VIN), ASSET_VALUE);

        vm.expectRevert(PartnerManager.UnauthorizedPartner.selector);
        vm.prank(unauthorized);
        assetRegistry.createRevenueTokenPool(
            assetId,
            REVENUE_TOKEN_PRICE,
            block.timestamp + 365 days,
            10_000,
            1_000,
            ASSET_VALUE / REVENUE_TOKEN_PRICE,
            false,
            false
        );
    }

    // Metadata Update Tests

    function testUpdateVehicleMetadata() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        // Use a valid IPFS URI (prefix + 46-char CID)
        string memory newAssetURI = "ipfs://QmYwAPJzv5CZsnAzt8auVTLpG1bG6dkprdFM5ocTyBCQb";
        string memory newRevenueTokenURI = "ipfs://QmRevenueTokenMetadataUpdated";

        vm.prank(partner1);
        assetRegistry.updateVehicleMetadata(scenario.assetId, newAssetURI, newRevenueTokenURI);

        (, string memory assetMetadataURI, string memory revenueTokenMetadataURI) =
            assetRegistry.getVehicleInfo(scenario.assetId);
        assertEq(assetMetadataURI, newAssetURI);
        assertEq(revenueTokenMetadataURI, newRevenueTokenURI);
        assertEq(roboshareTokens.uri(scenario.assetId), newAssetURI);
        assertEq(roboshareTokens.uri(scenario.revenueTokenId), newRevenueTokenURI);
    }

    function testUpdateVehicleMetadataInvalidUri() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        vm.expectRevert(VehicleLib.InvalidMetadataURI.selector);
        vm.prank(partner1);
        assetRegistry.updateVehicleMetadata(scenario.assetId, "http://not-ipfs", "ipfs://QmRevenueTokenMetadataUpdated");
    }

    // Access Control Tests

    function testRegisterAssetUnauthorizedPartner() public {
        vm.expectRevert(PartnerManager.UnauthorizedPartner.selector);
        vm.prank(unauthorized);
        assetRegistry.registerAsset(_vehicleRegistrationData(TEST_VIN), ASSET_VALUE);
    }

    function testUpdateVehicleMetadataUnauthorizedPartner() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        vm.expectRevert(PartnerManager.UnauthorizedPartner.selector);
        vm.prank(unauthorized);
        assetRegistry.updateVehicleMetadata(
            scenario.assetId,
            "ipfs://QmYwAPJzv5CZsnAzt8auVTLpG1bG6dkprdFM5ocTyBCQb",
            "ipfs://QmRevenueTokenMetadataUpdated"
        );
    }

    function testUpdateVehicleMetadataAuthorizedPartnerNotAssetOwner() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        vm.expectRevert(IAssetRegistry.NotAssetOwner.selector);
        vm.prank(partner2);
        assetRegistry.updateVehicleMetadata(
            scenario.assetId,
            "ipfs://QmYwAPJzv5CZsnAzt8auVTLpG1bG6dkprdFM5ocTyBCQb",
            "ipfs://QmRevenueTokenMetadataUpdated"
        );
    }

    // Error Cases

    function testRegisterAssetDuplicateVIN() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        (, string memory metadataURI) = _generateVehicleData(3);
        vm.expectRevert(VehicleRegistry.VehicleAlreadyExists.selector);
        vm.prank(partner2);
        assetRegistry.registerAsset(
            _vehicleRegistrationData(TEST_VIN, metadataURI, TEST_REVENUE_TOKEN_METADATA_URI), ASSET_VALUE
        );
    }

    function testUpdateVehicleMetadataVehicleDoesNotExist() public {
        vm.expectRevert(VehicleRegistry.VehicleDoesNotExist.selector);
        vm.prank(partner1);
        assetRegistry.updateVehicleMetadata(
            999, "ipfs://QmYwAPJzv5CZsnAzt8auVTLpG1bG6dkprdFM5ocTyBCQb", "ipfs://QmRevenueTokenMetadataUpdated"
        );
    }

    function testPreviewMintRevenueTokensAssetNotFound() public {
        _ensureState(SetupState.InitialAccountsSetup);
        vm.expectRevert(abi.encodeWithSelector(IAssetRegistry.AssetNotFound.selector, 999));
        assetRegistry.previewCreateRevenueTokenPool(999, partner1, ASSET_VALUE / REVENUE_TOKEN_PRICE);
    }

    function testPreviewMintRevenueTokensUnauthorizedPartner() public {
        _ensureState(SetupState.AssetRegistered);
        vm.expectRevert(PartnerManager.UnauthorizedPartner.selector);
        assetRegistry.previewCreateRevenueTokenPool(scenario.assetId, unauthorized, ASSET_VALUE / REVENUE_TOKEN_PRICE);
    }

    function testPreviewMintRevenueTokensNotAssetOwner() public {
        _ensureState(SetupState.AssetRegistered);
        vm.expectRevert(IAssetRegistry.NotAssetOwner.selector);
        assetRegistry.previewCreateRevenueTokenPool(scenario.assetId, partner2, ASSET_VALUE / REVENUE_TOKEN_PRICE);
    }

    function testPreviewMintRevenueTokensAlreadyMinted() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        (uint256 expectedPayment,,) = marketplace.previewPrimaryPurchase(scenario.revenueTokenId, 1);
        vm.startPrank(buyer);
        usdc.approve(address(marketplace), expectedPayment);
        marketplace.buyFromPrimaryPool(scenario.revenueTokenId, 1);
        vm.stopPrank();

        vm.expectRevert(IAssetRegistry.RevenueTokensAlreadyMinted.selector);
        assetRegistry.previewCreateRevenueTokenPool(scenario.assetId, partner1, ASSET_VALUE / REVENUE_TOKEN_PRICE);
    }

    function testPreviewMintRevenueTokensZeroSupply() public {
        _ensureState(SetupState.AssetRegistered);
        vm.expectRevert(IAssetRegistry.InvalidPoolSupply.selector);
        assetRegistry.previewCreateRevenueTokenPool(scenario.assetId, partner1, 0);
    }

    function testCreateRevenueTokenPoolRejectsSupplyAboveAssetBacking() public {
        _ensureState(SetupState.AssetRegistered);

        uint256 excessiveSupply = (ASSET_VALUE / REVENUE_TOKEN_PRICE) + 1;

        vm.expectRevert(IAssetRegistry.InvalidPoolSupply.selector);
        vm.prank(partner1);
        assetRegistry.createRevenueTokenPool(
            scenario.assetId,
            REVENUE_TOKEN_PRICE,
            block.timestamp + 365 days,
            10_000,
            1_000,
            excessiveSupply,
            false,
            false
        );
    }

    // View Function Tests

    function testVehicleExists() public {
        assertFalse(assetRegistry.assetExists(999));
        _ensureState(SetupState.PrimaryPoolCreated);
        assertTrue(assetRegistry.assetExists(scenario.assetId));
    }

    function testVINExists() public {
        assertFalse(assetRegistry.vinHashExists(keccak256(bytes("FAKE_VIN"))));
        _ensureState(SetupState.PrimaryPoolCreated);
        assertTrue(assetRegistry.vinHashExists(keccak256(bytes(TEST_VIN))));
    }

    // New: registry introspection and asset info branches
    function testRegistryIntrospectionAndAssetInfo() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        // Introspection
        assertEq(assetRegistry.getRegistryType(), "VehicleRegistry");
        assertEq(assetRegistry.getRegistryVersion(), 1);

        // Asset info and active status
        AssetLib.AssetInfo memory info = assetRegistry.getAssetInfo(scenario.assetId);
        assertEq(uint8(info.status), uint8(AssetLib.AssetStatus.Active));
        assertGt(info.createdAt, 0);
        assertGe(info.updatedAt, info.createdAt);
    }

    // Fuzz Tests

    function testFuzzRegisterAssetAndMintTokens(uint256 assetValue, uint256 tokenPrice, uint256 explicitSupply) public {
        tokenPrice = bound(tokenPrice, 1, 1_000_000_000 * 1e6);
        assetValue = bound(assetValue, tokenPrice, 1_000_000_000 * 1e6);
        uint256 maxSupportedSupply = assetValue / tokenPrice;
        explicitSupply = bound(explicitSupply, 1, maxSupportedSupply);

        _ensureState(SetupState.InitialAccountsSetup);

        // Setup: Configure marketplace on Router and grant role to Router
        vm.startPrank(admin);
        router.setMarketplace(address(marketplace));
        marketplace.grantRole(marketplace.AUTHORIZED_CONTRACT_ROLE(), address(router));
        vm.stopPrank();

        // Partner must approve marketplace for token transfers
        vm.startPrank(partner1);
        roboshareTokens.setApprovalForAll(address(marketplace), true);

        uint256 maturityDate = block.timestamp + 365 days;

        bytes memory vehicleData = _vehicleRegistrationData(TEST_VIN);

        (uint256 assetId, uint256 revenueTokenId, uint256 actualSupply) = assetRegistry.registerAssetAndCreateRevenueTokenPool(
            vehicleData, assetValue, tokenPrice, maturityDate, 10_000, 1_000, explicitSupply, false, false
        );
        vm.stopPrank();

        assertEq(roboshareTokens.balanceOf(address(marketplace), revenueTokenId), 0);
        assertEq(actualSupply, explicitSupply, "Supply should match explicit pool size");

        // Buffers are not funded by pool creation alone.
        CollateralLib.CollateralInfo memory info = _getCollateralInfo(assetId);
        assertEq(info.baseCollateral, 0);
        assertEq(info.isLocked, false);
    }

    function testFuzzRegisterAssetAndCreateRevenueTokenPool(
        uint256 assetValue,
        uint256 tokenPrice,
        uint256 explicitSupply
    ) public {
        tokenPrice = bound(tokenPrice, 1e6, 1_000_000_000 * 1e6);
        assetValue = bound(assetValue, tokenPrice, 1_000_000_000 * 1e6);
        uint256 maxSupportedSupply = assetValue / tokenPrice;
        explicitSupply = bound(explicitSupply, 1, maxSupportedSupply);

        _ensureState(SetupState.InitialAccountsSetup);

        // Setup: Configure marketplace on Router and grant role to Router
        vm.startPrank(admin);
        router.setMarketplace(address(marketplace));
        marketplace.grantRole(marketplace.AUTHORIZED_CONTRACT_ROLE(), address(router));
        vm.stopPrank();

        vm.startPrank(partner1);

        bytes memory vehicleData = _vehicleRegistrationData(TEST_VIN);

        (, uint256 revenueTokenId, uint256 tokenSupply) = assetRegistry.registerAssetAndCreateRevenueTokenPool(
            vehicleData, assetValue, tokenPrice, block.timestamp + 365 days, 10_000, 1_000, explicitSupply, false, false
        );
        vm.stopPrank();

        assertEq(tokenSupply, explicitSupply, "Supply should match explicit pool size");

        assertEq(roboshareTokens.balanceOf(address(marketplace), revenueTokenId), 0);
    }

    // Lifecycle Test

    function testCompleteVehicleLifecycle() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        assertTrue(assetRegistry.assetExists(scenario.assetId));

        string memory newAssetURI = "ipfs://QmYwAPJzv5CZsnAzt8auVTLpG1bG6dkprdFM5ocTyBCQb";
        string memory newRevenueTokenURI = "ipfs://QmRevenueTokenMetadataUpdated";
        vm.prank(partner1);
        assetRegistry.updateVehicleMetadata(scenario.assetId, newAssetURI, newRevenueTokenURI);

        (, string memory assetMetadataURI, string memory revenueTokenMetadataURI) =
            assetRegistry.getVehicleInfo(scenario.assetId);
        assertEq(assetMetadataURI, newAssetURI);
        assertEq(revenueTokenMetadataURI, newRevenueTokenURI);
    }

    function testSetAssetStatus() public {
        _ensureState(SetupState.AssetRegistered);
        uint256 assetId = scenario.assetId;

        // Initial status is Pending
        assertEq(uint8(assetRegistry.getAssetStatus(assetId)), uint8(AssetLib.AssetStatus.Pending));

        // Valid transition: Pending -> Active (called by Router)
        vm.startPrank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);
        vm.stopPrank();

        assertEq(uint8(assetRegistry.getAssetStatus(assetId)), uint8(AssetLib.AssetStatus.Active));
    }

    function testSetAssetStatusUnauthorizedCaller() public {
        _ensureState(SetupState.AssetRegistered);
        uint256 assetId = scenario.assetId;

        // Invalid access: unauthorized caller
        vm.startPrank(unauthorized);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, assetRegistry.ROUTER_ROLE()
            )
        );
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Pending);
        vm.stopPrank();
    }

    function testSetAssetStatusAssetNotFound() public {
        vm.startPrank(address(router));
        vm.expectRevert(abi.encodeWithSelector(IAssetRegistry.AssetNotFound.selector, 999));
        assetRegistry.setAssetStatus(999, AssetLib.AssetStatus.Active);
        vm.stopPrank();
    }

    // Retirement Tests

    function testRetireAssetAndBurnTokens() public {
        _ensureState(SetupState.BuffersFunded);
        _ensureSecondaryListingScenario();
        // Verify initial state (seller still holds listed tokens under lock-based listings)
        assertEq(roboshareTokens.balanceOf(partner1, scenario.revenueTokenId), SECONDARY_LISTING_AMOUNT);
        CollateralLib.CollateralInfo memory info = _getCollateralInfo(scenario.assetId);
        uint256 expectedCollateral = _getCollateralTotal(info);
        _assertCollateralState(scenario.assetId, info.baseCollateral, expectedCollateral, true);

        // Acquire all tokens from buyers to allow retirement
        uint256 buyerBalance = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        vm.prank(partner1);
        marketplace.endListing(scenario.listingId);
        vm.prank(buyer);
        roboshareTokens.safeTransferFrom(buyer, partner1, scenario.revenueTokenId, buyerBalance, "");

        // Partner retires asset
        vm.startPrank(partner1);
        assetRegistry.retireAssetAndBurnTokens(scenario.assetId);
        vm.stopPrank();

        // Verify tokens burned
        assertEq(roboshareTokens.balanceOf(partner1, scenario.revenueTokenId), 0);
        assertEq(roboshareTokens.getRevenueTokenSupply(scenario.revenueTokenId), 0);

        // Verify status updated
        assertEq(uint8(assetRegistry.getAssetStatus(scenario.assetId)), uint8(AssetLib.AssetStatus.Retired));

        // Verify collateral released
        // Collateral should be unlocked (locked = false)
        assertFalse(_getCollateralInfo(scenario.assetId).isLocked);
    }

    function testRetireAssetAndBurnTokensNoPurchase() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        uint256 totalSupply = roboshareTokens.getRevenueTokenSupply(scenario.revenueTokenId);

        // In the manager-backed primary-pool model, inventory is capacity only until a buy mints positions.
        assertEq(totalSupply, 0);
        assertEq(roboshareTokens.balanceOf(partner1, scenario.revenueTokenId), 0);
        assertEq(roboshareTokens.balanceOf(address(marketplace), scenario.revenueTokenId), 0);

        CollateralLib.CollateralInfo memory info = _getCollateralInfo(scenario.assetId);
        uint256 expectedCollateral = _getCollateralTotal(info);
        _assertCollateralState(scenario.assetId, info.baseCollateral, expectedCollateral, false);

        vm.startPrank(partner1);

        // Expect AssetStatusUpdated from VehicleRegistry
        vm.expectEmit(true, true, true, true, address(assetRegistry));
        emit IAssetRegistry.AssetStatusUpdated(
            scenario.assetId, AssetLib.AssetStatus.Active, AssetLib.AssetStatus.Retired
        );

        // Expect AssetRetired from VehicleRegistry
        vm.expectEmit(true, true, true, true, address(assetRegistry));
        emit IAssetRegistry.AssetRetired(scenario.assetId, partner1, totalSupply, expectedCollateral);

        assetRegistry.retireAssetAndBurnTokens(scenario.assetId);
        vm.stopPrank();

        assertEq(roboshareTokens.balanceOf(partner1, scenario.revenueTokenId), 0);
        assertEq(roboshareTokens.getRevenueTokenSupply(scenario.revenueTokenId), 0);
        assertEq(uint8(assetRegistry.getAssetStatus(scenario.assetId)), uint8(AssetLib.AssetStatus.Retired));
        assertFalse(_getCollateralInfo(scenario.assetId).isLocked);
    }

    function testRetireAssetAndBurnTokensOutstandingTokensListedSellerEscrow() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        uint256 purchaseAmount = 100;
        (uint256 expectedPayment,,) = marketplace.previewPrimaryPurchase(scenario.revenueTokenId, purchaseAmount);
        vm.startPrank(buyer);
        usdc.approve(address(marketplace), expectedPayment);
        marketplace.buyFromPrimaryPool(scenario.revenueTokenId, purchaseAmount);
        roboshareTokens.setApprovalForAll(address(marketplace), true);
        marketplace.createListing(scenario.revenueTokenId, purchaseAmount, REVENUE_TOKEN_PRICE, LISTING_DURATION, true);
        vm.stopPrank();

        vm.prank(partner1);
        vm.expectRevert(VehicleRegistry.OutstandingTokensHeldByOthers.selector);
        assetRegistry.retireAssetAndBurnTokens(scenario.assetId);
    }

    function testRetireAssetAndBurnTokensAfterBuyback() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        uint256 mintedSupply = ASSET_VALUE / REVENUE_TOKEN_PRICE;
        uint256 purchaseAmount = mintedSupply / 5;
        (uint256 expectedPayment,,) = marketplace.previewPrimaryPurchase(scenario.revenueTokenId, purchaseAmount);
        vm.startPrank(buyer);
        usdc.approve(address(marketplace), expectedPayment);
        marketplace.buyFromPrimaryPool(scenario.revenueTokenId, purchaseAmount);
        vm.stopPrank();

        // Buyer lists their tokens on secondary market
        vm.startPrank(buyer);
        roboshareTokens.setApprovalForAll(address(marketplace), true);
        uint256 buyerListingId = marketplace.createListing(
            scenario.revenueTokenId, purchaseAmount, REVENUE_TOKEN_PRICE, LISTING_DURATION, true
        );
        vm.stopPrank();

        // Partner buys back all sold tokens
        (,, expectedPayment) = marketplace.previewSecondaryPurchase(buyerListingId, purchaseAmount);
        vm.startPrank(partner1);
        usdc.approve(address(marketplace), expectedPayment);
        marketplace.buyFromSecondaryListing(buyerListingId, purchaseAmount);
        vm.stopPrank();

        // Partner should now hold all outstanding tokens.
        uint256 partnerBalance = roboshareTokens.balanceOf(partner1, scenario.revenueTokenId);
        assertEq(partnerBalance, purchaseAmount);
        assertEq(roboshareTokens.getRevenueTokenSupply(scenario.revenueTokenId), purchaseAmount);

        vm.prank(partner1);
        assetRegistry.retireAssetAndBurnTokens(scenario.assetId);

        assertEq(roboshareTokens.getRevenueTokenSupply(scenario.revenueTokenId), 0);
        assertEq(uint8(assetRegistry.getAssetStatus(scenario.assetId)), uint8(AssetLib.AssetStatus.Retired));
    }

    function testRetireAssetAndBurnTokensOutstandingTokensHeldByOthers() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        // Buyer still holds sold tokens; partner holds none.
        vm.prank(partner1);
        vm.expectRevert(VehicleRegistry.OutstandingTokensHeldByOthers.selector);
        assetRegistry.retireAssetAndBurnTokens(scenario.assetId);
    }

    function testRetireAssetAndBurnTokensAllTokensHeldByPartner() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        uint256 totalSupply = ASSET_VALUE / REVENUE_TOKEN_PRICE;
        (uint256 expectedPayment,,) = marketplace.previewPrimaryPurchase(scenario.revenueTokenId, totalSupply);
        vm.startPrank(buyer);
        usdc.approve(address(marketplace), expectedPayment);
        marketplace.buyFromPrimaryPool(scenario.revenueTokenId, totalSupply);
        vm.stopPrank();

        vm.prank(buyer);
        roboshareTokens.safeTransferFrom(buyer, partner1, scenario.revenueTokenId, totalSupply, "");

        vm.prank(partner1);
        assetRegistry.retireAssetAndBurnTokens(scenario.assetId);

        assertEq(roboshareTokens.getRevenueTokenSupply(scenario.revenueTokenId), 0);
    }

    function testBurnRevenueTokens() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        uint256 mintAmount = (ASSET_VALUE / REVENUE_TOKEN_PRICE) / 2;
        uint256 burnAmount = mintAmount;
        (uint256 expectedPayment,,) = marketplace.previewPrimaryPurchase(scenario.revenueTokenId, burnAmount);
        vm.startPrank(buyer);
        usdc.approve(address(marketplace), expectedPayment);
        marketplace.buyFromPrimaryPool(scenario.revenueTokenId, burnAmount);
        vm.stopPrank();

        vm.prank(buyer);
        roboshareTokens.safeTransferFrom(buyer, partner1, scenario.revenueTokenId, burnAmount, "");

        vm.prank(partner1);
        assetRegistry.burnRevenueTokens(scenario.assetId, burnAmount);

        assertEq(roboshareTokens.balanceOf(partner1, scenario.revenueTokenId), 0);
        assertEq(roboshareTokens.getRevenueTokenSupply(scenario.revenueTokenId), 0);
    }

    function testBurnRevenueTokensAssetNotFound() public {
        _ensureState(SetupState.InitialAccountsSetup);
        vm.prank(partner1);
        vm.expectRevert(abi.encodeWithSelector(IAssetRegistry.AssetNotFound.selector, 999));
        assetRegistry.burnRevenueTokens(999, 100);
    }

    function testRetireAsset() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        uint256 totalSupply = ASSET_VALUE / REVENUE_TOKEN_PRICE;
        (uint256 expectedPayment,,) = marketplace.previewPrimaryPurchase(scenario.revenueTokenId, totalSupply);
        vm.startPrank(buyer);
        usdc.approve(address(marketplace), expectedPayment);
        marketplace.buyFromPrimaryPool(scenario.revenueTokenId, totalSupply);
        vm.stopPrank();

        vm.prank(buyer);
        roboshareTokens.safeTransferFrom(buyer, partner1, scenario.revenueTokenId, totalSupply, "");

        // Burn all tokens first
        vm.prank(partner1);
        assetRegistry.burnRevenueTokens(scenario.assetId, totalSupply);

        // Now retire
        vm.prank(partner1);
        assetRegistry.retireAsset(scenario.assetId);

        assertEq(uint8(assetRegistry.getAssetStatus(scenario.assetId)), uint8(AssetLib.AssetStatus.Retired));
        assertFalse(_getCollateralInfo(scenario.assetId).isLocked);
    }

    function testRetireAssetAssetNotActive() public {
        _ensureState(SetupState.AssetRegistered);
        // Asset is registered but not active (Pending)

        vm.prank(partner1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAssetRegistry.AssetNotActive.selector, scenario.assetId, AssetLib.AssetStatus.Pending
            )
        );
        assetRegistry.retireAsset(scenario.assetId);
    }

    function testRetireAssetNotAssetOwner() public {
        _expectOwnerActionRevert(partner2, IAssetRegistry.NotAssetOwner.selector, OwnerAction.Retire);
    }

    function testRetireAssetAndBurnTokensAssetNotFound() public {
        _ensureState(SetupState.InitialAccountsSetup);
        vm.prank(partner1);
        vm.expectRevert(abi.encodeWithSelector(IAssetRegistry.AssetNotFound.selector, 999));
        assetRegistry.retireAssetAndBurnTokens(999);
    }

    function testRetireAssetAndBurnTokensNotAssetOwner() public {
        _expectOwnerActionRevert(partner2, IAssetRegistry.NotAssetOwner.selector, OwnerAction.RetireAndBurn);
    }

    // Settlement Tests

    function testSettleAsset() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        uint256 topUpAmount = SETTLEMENT_TOP_UP_AMOUNT;

        // Partner approves top-up
        vm.prank(partner1);
        usdc.approve(address(treasury), topUpAmount);

        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, topUpAmount);

        IPositionManager.SettlementState memory settlementState =
            _positionManager().getSettlementState(scenario.assetId);
        assertTrue(settlementState.isConfigured);
        assertEq(uint8(assetRegistry.getAssetStatus(scenario.assetId)), uint8(AssetLib.AssetStatus.Retired));
        assertFalse(marketplace.isPrimaryPoolActive(scenario.revenueTokenId));
    }

    function testLiquidateAssetMaturity() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        // Get maturity date from RoboshareTokens (now stored in TokenInfo)
        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(scenario.revenueTokenId);

        // Warp to maturity
        vm.warp(maturityDate + 1);

        uint256 expectedLiquidationAmount = helper.expectedLiquidationAfterMissedShortfall(
            treasury, earningsManager, roboshareTokens, scenario.assetId, scenario.revenueTokenId
        );
        assetRegistry.liquidateAsset(scenario.assetId);
        uint256 totalSupply = roboshareTokens.getRevenueTokenSupply(scenario.revenueTokenId);
        uint256 expectedPerToken = totalSupply > 0 ? expectedLiquidationAmount / totalSupply : 0;

        (bool isSettled, uint256 settlementPerToken, uint256 totalSettlementPool) =
            treasury.assetSettlements(scenario.assetId);
        IPositionManager.SettlementState memory settlementState =
            _positionManager().getSettlementState(scenario.assetId);
        assertTrue(isSettled);
        assertTrue(settlementState.isConfigured);
        assertEq(totalSettlementPool, expectedLiquidationAmount);
        assertEq(settlementPerToken, expectedPerToken);
        assertEq(settlementState.settlementAmount, expectedLiquidationAmount);
        assertEq(settlementState.settlementPerToken, expectedPerToken);
        assertEq(uint8(assetRegistry.getAssetStatus(scenario.assetId)), uint8(AssetLib.AssetStatus.Expired));
        assertFalse(marketplace.isPrimaryPoolActive(scenario.revenueTokenId));
    }

    function testLiquidateAssetNotEligible() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        // Try to liquidate before maturity and while solvent
        vm.expectRevert(
            abi.encodeWithSelector(IAssetRegistry.AssetNotEligibleForLiquidation.selector, scenario.assetId)
        );
        assetRegistry.liquidateAsset(scenario.assetId);
    }

    function testLiquidateAssetAfterMissedEarningsShortfall() public {
        (uint256 assetId, uint256 revenueTokenId) = _setupProtectedPoolWithPurchaseAndBuffers();

        (,,,, uint256 lastEventTimestamp,,,,) = earningsManager.assetEarnings(assetId);
        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(revenueTokenId);
        CollateralLib.CollateralInfo memory infoBefore = _getCollateralInfo(assetId);
        uint256 targetYieldBP = roboshareTokens.getTargetYieldBP(revenueTokenId);
        uint256 elapsedToDeplete = (infoBefore.earningsBuffer * ProtocolLib.YEARLY_INTERVAL * ProtocolLib.BP_PRECISION)
            / (infoBefore.unredeemedBasePrincipal * targetYieldBP);
        uint256 warpTo = lastEventTimestamp + elapsedToDeplete + 1;
        require(warpTo < maturityDate, "Test assumes delinquency before maturity");
        vm.warp(warpTo);

        uint256 expectedLiquidationAmount = helper.expectedLiquidationAfterMissedShortfall(
            treasury, earningsManager, roboshareTokens, assetId, revenueTokenId
        );

        assetRegistry.liquidateAsset(assetId);

        uint256 totalSupply = roboshareTokens.getRevenueTokenSupply(revenueTokenId);
        uint256 expectedPerToken = totalSupply > 0 ? expectedLiquidationAmount / totalSupply : 0;

        (bool isSettled, uint256 settlementPerToken, uint256 totalSettlementPool) = treasury.assetSettlements(assetId);
        IPositionManager.SettlementState memory settlementState = _positionManager().getSettlementState(assetId);
        assertTrue(isSettled);
        assertTrue(settlementState.isConfigured);
        assertEq(totalSettlementPool, expectedLiquidationAmount);
        assertEq(settlementPerToken, expectedPerToken);
        assertEq(settlementState.settlementAmount, expectedLiquidationAmount);
        assertEq(settlementState.settlementPerToken, expectedPerToken);
        assertEq(uint8(assetRegistry.getAssetStatus(assetId)), uint8(AssetLib.AssetStatus.Expired));
    }

    // New Tests for Settlement and Liquidation Branches

    function testSettleAssetNotAssetOwner() public {
        _expectOwnerActionRevert(partner2, IAssetRegistry.NotAssetOwner.selector, OwnerAction.Settle);
    }

    function testSettleAssetNotActive() public {
        _ensureState(SetupState.AssetRegistered); // Status is Pending
        vm.prank(partner1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAssetRegistry.AssetNotActive.selector, scenario.assetId, AssetLib.AssetStatus.Pending
            )
        );
        assetRegistry.settleAsset(scenario.assetId, 0);
    }

    function testLiquidateAssetNotFound() public {
        vm.expectRevert(abi.encodeWithSelector(IAssetRegistry.AssetNotFound.selector, 999));
        assetRegistry.liquidateAsset(999);
    }

    function testLiquidateAssetAlreadySettled() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        // Settle the asset first
        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        // Try to liquidate an already settled asset
        vm.expectRevert(
            abi.encodeWithSelector(
                IAssetRegistry.AssetAlreadySettled.selector, scenario.assetId, AssetLib.AssetStatus.Retired
            )
        );
        assetRegistry.liquidateAsset(scenario.assetId);
    }

    function testClaimSettlementAssetNotFound() public {
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("RegistryNotFound(uint256)")), 999));
        vm.prank(partner1);
        router.claimSettlement(999, false);
    }

    function testClaimSettlementNotSettled() public {
        _ensureState(SetupState.PrimaryPoolCreated); // Asset is Active, not Retired or Expired
        vm.prank(partner1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAssetRegistry.AssetNotSettled.selector, scenario.assetId, AssetLib.AssetStatus.Active
            )
        );
        router.claimSettlement(scenario.assetId, false);
    }

    function testClaimSettlementNoTokens() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        // Liquidate the asset to make it eligible for claiming
        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(scenario.revenueTokenId);
        vm.warp(maturityDate + 1);
        assetRegistry.liquidateAsset(scenario.assetId);

        // Try to claim settlement as an address with no tokens for this asset

        vm.prank(unauthorized);

        vm.expectRevert(
            abi.encodeWithSelector(IAssetRegistry.InsufficientTokenBalance.selector, scenario.revenueTokenId, 1, 0)
        );

        router.claimSettlement(scenario.assetId, false);
    }

    function testClaimSettlementTracksManagerPayout() public {
        _ensureState(SetupState.EarningsDistributed);

        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        uint256 buyerBalance = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        uint256 expectedPayout = _positionManager().previewSettlementClaim(scenario.assetId, buyerBalance);

        vm.prank(buyer);
        (uint256 claimedAmount, uint256 earningsClaimed) = router.claimSettlement(scenario.assetId, false);

        assertEq(earningsClaimed, 0);
        assertEq(claimedAmount, expectedPayout);
        assertEq(roboshareTokens.balanceOf(buyer, scenario.revenueTokenId), 0);

        IPositionManager.SettlementClaimState memory claimState =
            _positionManager().getSettlementClaimState(scenario.assetId, buyer);
        assertEq(claimState.burnedAmount, buyerBalance);
        assertEq(claimState.payout, claimedAmount);
    }

    function testExecuteSettlementClaimForUnauthorizedCaller() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        vm.startPrank(unauthorized);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, assetRegistry.ROUTER_ROLE()
            )
        );
        assetRegistry.executeSettlementClaimFor(partner1, scenario.assetId, false);
        vm.stopPrank();
    }

    function testRetireAssetUnauthorizedPartner() public {
        _expectOwnerActionRevert(unauthorized, PartnerManager.UnauthorizedPartner.selector, OwnerAction.Retire);
    }

    function testRetireAssetAndBurnTokensUnauthorizedPartner() public {
        _expectOwnerActionRevert(unauthorized, PartnerManager.UnauthorizedPartner.selector, OwnerAction.RetireAndBurn);
    }

    function testSettleAssetUnauthorizedPartner() public {
        _expectOwnerActionRevert(unauthorized, PartnerManager.UnauthorizedPartner.selector, OwnerAction.Settle);
    }
}
