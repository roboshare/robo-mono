// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { TreasuryFlowBaseTest } from "../base/TreasuryFlowBaseTest.t.sol";
import { AssetLib, TokenLib } from "../../contracts/Libraries.sol";
import { IAssetRegistry } from "../../contracts/interfaces/IAssetRegistry.sol";
import { IPositionManager } from "../../contracts/interfaces/IPositionManager.sol";
import { Marketplace } from "../../contracts/Marketplace.sol";
import { RoboshareTokens } from "../../contracts/RoboshareTokens.sol";
import { RegistryRouter } from "../../contracts/RegistryRouter.sol";
import { Treasury } from "../../contracts/Treasury.sol";
import { PartnerManager } from "../../contracts/PartnerManager.sol";

// Simple Mock Registry to simulate a second asset type (e.g., "MachineRegistry")
contract MockRegistry is IAssetRegistry {
    RegistryRouter public router;
    RoboshareTokens public roboshareTokens;
    Treasury public treasuryContract;

    struct MockAsset {
        uint256 id;
        AssetLib.AssetInfo info;
    }

    mapping(uint256 => MockAsset) public assets;

    constructor(address _router, address _tokens, address _treasury) {
        router = RegistryRouter(_router);
        roboshareTokens = RoboshareTokens(_tokens);
        treasuryContract = Treasury(_treasury);
    }

    function registerAndMint(address partner, uint256 assetValue, uint256 tokenPrice)
        external
        returns (uint256 assetId, uint256 revenueTokenId, uint256 supply)
    {
        // 1. Reserve IDs from Router (this binds the assetId to this registry in the Router)
        (assetId, revenueTokenId) = router.reserveNextTokenIdPair();

        // 2. Initialize local state
        assets[assetId].id = assetId;
        assets[assetId].info.assetValue = assetValue;
        assets[assetId].info.status = AssetLib.AssetStatus.Active;
        assets[assetId].info.createdAt = block.timestamp;
        assets[assetId].info.updatedAt = block.timestamp;

        // 3. Compute supply for preview + mint flow
        uint256 maturityDate = block.timestamp + 365 days;
        uint256 supplyToOffer = assetValue / tokenPrice;

        // Mint Asset NFT first so partner owns it for collateral locking
        roboshareTokens.mint(partner, assetId, 1, "");

        // 4. Configure token economics and create the primary pool through the router flow.
        (revenueTokenId, supply) = router.createRevenueTokenPoolFor(
            partner, assetId, tokenPrice, maturityDate, 10_000, 1_000, supplyToOffer, false, false
        );

        return (assetId, revenueTokenId, supply);
    }

    function registerAssetForTest(uint256 assetId, uint256 assetValue) external {
        assets[assetId].id = assetId;
        assets[assetId].info.assetValue = assetValue;
        assets[assetId].info.status = AssetLib.AssetStatus.Active;
        assets[assetId].info.createdAt = block.timestamp;
        assets[assetId].info.updatedAt = block.timestamp;
    }

    // Implement required IAssetRegistry view functions
    function assetExists(uint256 assetId) external view override returns (bool) {
        return assets[assetId].id != 0;
    }

    function getAssetInfo(uint256 assetId) external view override returns (AssetLib.AssetInfo memory) {
        return assets[assetId].info;
    }

    function getAssetStatus(uint256 assetId) external view override returns (AssetLib.AssetStatus) {
        return assets[assetId].info.status;
    }

    // Stubs for other functions
    function registerAsset(bytes calldata, uint256) external pure override returns (uint256) {
        return 0;
    }

    function registerAssetAndCreateRevenueTokenPool(
        bytes calldata,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256,
        bool,
        bool
    ) external pure override returns (uint256, uint256, uint256) {
        return (0, 0, 0);
    }

    function createRevenueTokenPool(uint256, uint256, uint256, uint256, uint256, uint256, bool, bool)
        external
        pure
        override
        returns (uint256, uint256)
    {
        return (0, 0);
    }

    function previewCreateRevenueTokenPool(uint256 assetId, address partner, uint256 requestedSupply)
        external
        view
        override
        returns (uint256 tokenId, uint256 supply)
    {
        if (assets[assetId].id == 0) {
            revert AssetNotFound(assetId);
        }
        if (roboshareTokens.balanceOf(partner, assetId) == 0) {
            revert NotAssetOwner();
        }

        tokenId = TokenLib.getTokenIdFromAssetId(assetId);
        if (roboshareTokens.getRevenueTokenSupply(tokenId) > 0) {
            revert RevenueTokensAlreadyMinted();
        }
        if (requestedSupply == 0) {
            revert InvalidPoolSupply();
        }

        supply = requestedSupply;
    }

    function setAssetStatus(uint256, AssetLib.AssetStatus) external override { }
    function burnRevenueTokens(uint256, uint256) external override { }
    function retireAsset(uint256) external override { }
    function retireAssetAndBurnTokens(uint256) external override { }

    function settleAsset(
        uint256 assetId,
        uint256 /* topUpAmount */
    )
        external
        override
    {
        // Mock implementation: just set status to Retired
        assets[assetId].info.status = AssetLib.AssetStatus.Retired;
    }

    function liquidateAsset(uint256 assetId) external override {
        // Mock implementation: just set status to Expired
        assets[assetId].info.status = AssetLib.AssetStatus.Expired;
    }

    function executeSettlementClaimFor(address, uint256, bool) external pure override returns (uint256, uint256) {
        return (0, 0);
    }

    function getRegistryType() external pure override returns (string memory) {
        return "MockRegistry";
    }

    function getRegistryVersion() external pure override returns (uint256) {
        return 1;
    }

    function setTreasury(address) external { }

    function treasury() external view returns (address) {
        return address(treasuryContract);
    }

    function getRegistryForAsset(uint256) external view override returns (address) {
        return address(this);
    }
}

contract RegistryRouterIntegrationTest is TreasuryFlowBaseTest {
    MockRegistry public mockRegistry;

    function setUp() public {
        _ensureState(SetupState.InitialAccountsSetup);

        // Get the router deployed in BaseTest
        // router is already set in BaseTest

        // Deploy MockRegistry
        mockRegistry = new MockRegistry(address(router), address(roboshareTokens), address(treasury));

        // Setup Roles for MockRegistry
        vm.startPrank(admin);

        // 1. Grant AUTHORIZED_REGISTRY_ROLE to MockRegistry on Router
        router.grantRole(router.AUTHORIZED_REGISTRY_ROLE(), address(mockRegistry));

        // 2. Grant MINTER_ROLE to MockRegistry on RoboshareTokens
        roboshareTokens.grantRole(roboshareTokens.MINTER_ROLE(), address(mockRegistry));

        vm.stopPrank();
    }

    function testMultiRegistryOperations() public {
        // 1. Register a standard Vehicle (Asset ID 1, Token ID 2)
        _ensureState(SetupState.PrimaryPoolCreated);
        uint256 vehicleAssetId = scenario.assetId;

        // Verify Router knows about VehicleRegistry
        assertEq(router.getRegistryForAsset(vehicleAssetId), address(assetRegistry));

        // 2. Register a Mock Asset (Asset ID 3, Token ID 4)
        vm.startPrank(partner1);

        (uint256 mockAssetId, uint256 mockTokenId,) =
            mockRegistry.registerAndMint(partner1, ASSET_VALUE, REVENUE_TOKEN_PRICE);
        vm.stopPrank();

        // Verify IDs
        assertEq(mockAssetId, 3);
        assertEq(mockTokenId, 4);

        // Verify Router knows about MockRegistry
        assertEq(router.getRegistryForAsset(mockAssetId), address(mockRegistry));

        // 3. Purchase Mock Token from primary pool
        uint256 purchaseAmount = PRIMARY_PURCHASE_AMOUNT;
        (uint256 expectedPayment,,) = marketplace.previewPrimaryPurchase(mockTokenId, purchaseAmount);

        vm.startPrank(buyer);
        usdc.approve(address(marketplace), expectedPayment);
        marketplace.buyFromPrimaryPool(mockTokenId, purchaseAmount);
        vm.stopPrank();

        // Verify ownership transfer
        assertEq(roboshareTokens.balanceOf(buyer, mockTokenId), purchaseAmount);
    }

    function testCreateRevenueTokenPool() public {
        _ensureState(SetupState.InitialAccountsSetup);

        vm.startPrank(admin);
        router.setMarketplace(address(marketplace));
        marketplace.grantRole(marketplace.AUTHORIZED_CONTRACT_ROLE(), address(router));
        vm.stopPrank();

        // Register asset only
        vm.startPrank(partner1);
        uint256 assetId = assetRegistry.registerAsset(_vehicleRegistrationData(TEST_VIN), ASSET_VALUE);
        uint256 explicitSupply = (ASSET_VALUE / REVENUE_TOKEN_PRICE) / 2;

        (uint256 revenueTokenId, uint256 tokenSupply) = router.createRevenueTokenPool(
            assetId, REVENUE_TOKEN_PRICE, block.timestamp + 365 days, 10_000, 1_000, explicitSupply, false, false
        );
        vm.stopPrank();

        assertEq(uint8(assetRegistry.getAssetStatus(assetId)), uint8(AssetLib.AssetStatus.Active));
        assertEq(tokenSupply, explicitSupply);
        assertEq(roboshareTokens.balanceOf(address(marketplace), revenueTokenId), 0);
        assertEq(roboshareTokens.getRevenueTokenSupply(revenueTokenId), 0);
        Marketplace.PrimaryPool memory pool = marketplace.getPrimaryPool(revenueTokenId);
        assertEq(pool.tokenId, revenueTokenId);
        assertEq(pool.partner, partner1);
        assertEq(pool.pricePerToken, REVENUE_TOKEN_PRICE);
        assertEq(roboshareTokens.getRevenueTokenMaxSupply(revenueTokenId), tokenSupply);
    }

    function testBurnRevenueTokensFromHolderForPrimaryRedemptionUnauthorizedCaller() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        vm.prank(unauthorized);
        vm.expectRevert(RegistryRouter.NotTreasury.selector);
        router.burnRevenueTokensFromHolderForPrimaryRedemption(buyer, scenario.revenueTokenId, 1);
    }

    function testBurnRevenueTokensFromHolderForPrimaryRedemptionInvalidTokenType() public {
        vm.prank(address(treasury));
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, uint256(2)));
        router.burnRevenueTokensFromHolderForPrimaryRedemption(buyer, 2, 1);
    }

    function testBurnRevenueTokensFromHolderForPrimaryRedemptionUnboundRevenueToken() public {
        uint256 unboundRevenueTokenId = 999;
        vm.prank(address(treasury));
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, unboundRevenueTokenId));
        router.burnRevenueTokensFromHolderForPrimaryRedemption(buyer, unboundRevenueTokenId, 1);
    }

    function testBurnRevenueTokensFromHolderForPrimaryRedemption() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        uint256 buyerBalanceBefore = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        assertGt(buyerBalanceBefore, 0);

        vm.prank(address(treasury));
        router.burnRevenueTokensFromHolderForPrimaryRedemption(buyer, scenario.revenueTokenId, 1);

        assertEq(roboshareTokens.balanceOf(buyer, scenario.revenueTokenId), buyerBalanceBefore - 1);
    }

    function testMintRevenueTokensToBuyerFromPrimaryPoolUnauthorizedCaller() public {
        vm.prank(unauthorized);
        vm.expectRevert(RegistryRouter.NotTreasury.selector);
        router.mintRevenueTokensToBuyerFromPrimaryPool(buyer, scenario.revenueTokenId, 1);
    }

    function testMintRevenueTokensToBuyerFromPrimaryPoolInvalidTokenType() public {
        vm.prank(address(treasury));
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, uint256(1)));
        router.mintRevenueTokensToBuyerFromPrimaryPool(buyer, 1, 1);
    }

    function testMintRevenueTokensToBuyerFromPrimaryPoolUnboundRevenueToken() public {
        uint256 unboundRevenueTokenId = 1000;
        vm.prank(address(treasury));
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, unboundRevenueTokenId));
        router.mintRevenueTokensToBuyerFromPrimaryPool(buyer, unboundRevenueTokenId, 1);
    }

    function testMintRevenueTokensToBuyerFromPrimaryPool() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        uint256 buyerBalanceBefore = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);

        vm.prank(address(treasury));
        router.mintRevenueTokensToBuyerFromPrimaryPool(buyer, scenario.revenueTokenId, 1);

        assertEq(roboshareTokens.balanceOf(buyer, scenario.revenueTokenId), buyerBalanceBefore + 1);
    }

    // RegistryNotFound Tests

    function testGetAssetInfoRegistryNotFound() public {
        uint256 nonExistentAssetId = 999;
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, nonExistentAssetId));
        router.getAssetInfo(nonExistentAssetId);
    }

    function testCreateRevenueTokenPoolRegistryNotFound() public {
        _ensureState(SetupState.InitialAccountsSetup);
        uint256 nonExistentAssetId = 999;
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, nonExistentAssetId));
        vm.prank(partner1);
        router.createRevenueTokenPool(
            nonExistentAssetId, REVENUE_TOKEN_PRICE, block.timestamp + 365 days, 10_000, 1_000, 0, false, false
        );
    }

    function testCreateRevenueTokenPoolUnauthorizedPartner() public {
        _ensureState(SetupState.AssetRegistered);
        vm.expectRevert(PartnerManager.UnauthorizedPartner.selector);
        vm.prank(buyer);
        router.createRevenueTokenPool(
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

    function testPreviewMintRevenueTokensRegistryNotFound() public {
        uint256 nonExistentAssetId = 999;
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, nonExistentAssetId));
        router.previewCreateRevenueTokenPool(nonExistentAssetId, partner1, ASSET_VALUE / REVENUE_TOKEN_PRICE);
    }

    function testPreviewMintRevenueTokens() public {
        _ensureState(SetupState.AssetRegistered);
        uint256 explicitSupply = (ASSET_VALUE / REVENUE_TOKEN_PRICE) / 2;
        (uint256 tokenId, uint256 supply) =
            router.previewCreateRevenueTokenPool(scenario.assetId, partner1, explicitSupply);

        assertEq(tokenId, TokenLib.getTokenIdFromAssetId(scenario.assetId));
        assertEq(supply, explicitSupply);
    }

    function testPreviewMintRevenueTokensZeroSupply() public {
        _ensureState(SetupState.AssetRegistered);
        vm.expectRevert(IAssetRegistry.InvalidPoolSupply.selector);
        router.previewCreateRevenueTokenPool(scenario.assetId, partner1, 0);
    }

    function testGetAssetStatusRegistryNotFound() public {
        uint256 nonExistentAssetId = 999;
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, nonExistentAssetId));
        router.getAssetStatus(nonExistentAssetId);
    }

    function testSetAssetStatusRegistryNotFound() public {
        uint256 nonExistentAssetId = 999;
        vm.prank(address(treasury));
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, nonExistentAssetId));
        router.setAssetStatus(nonExistentAssetId, AssetLib.AssetStatus.Active);
    }

    function testSetAssetStatusTreasury() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        vm.prank(address(treasury));
        router.setAssetStatus(scenario.assetId, AssetLib.AssetStatus.Active);

        assertEq(uint8(router.getAssetStatus(scenario.assetId)), uint8(AssetLib.AssetStatus.Active));
    }

    function testSetAssetStatusNotTreasury() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        vm.expectRevert(RegistryRouter.NotTreasury.selector);
        router.setAssetStatus(scenario.assetId, AssetLib.AssetStatus.Active);
    }

    function testBurnRevenueTokensRegistryNotFound() public {
        uint256 nonExistentAssetId = 999;
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, nonExistentAssetId));
        router.burnRevenueTokens(nonExistentAssetId, 100);
    }

    function testRetireAssetRegistryNotFound() public {
        uint256 nonExistentAssetId = 999;
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, nonExistentAssetId));
        router.retireAsset(nonExistentAssetId);
    }

    function testRetireAssetAndBurnTokensRegistryNotFound() public {
        uint256 nonExistentAssetId = 999;
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, nonExistentAssetId));
        router.retireAssetAndBurnTokens(nonExistentAssetId);
    }

    function testSettleAssetRegistryNotFound() public {
        uint256 nonExistentAssetId = 999;
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, nonExistentAssetId));
        router.settleAsset(nonExistentAssetId, 0);
    }

    function testLiquidateAssetRegistryNotFound() public {
        uint256 nonExistentAssetId = 999;
        vm.expectRevert(abi.encodeWithSelector(RegistryRouter.RegistryNotFound.selector, nonExistentAssetId));
        router.liquidateAsset(nonExistentAssetId);
    }

    // RegistryNotBoundToAsset Tests

    function testReleaseCollateralForRegistryNotBoundToAsset() public {
        uint256 assetId = 100;
        address unauthorizedRegistry = makeAddr("unauthorizedRegistry");

        vm.startPrank(admin);
        router.grantRole(router.AUTHORIZED_REGISTRY_ROLE(), unauthorizedRegistry);
        vm.stopPrank();

        vm.prank(unauthorizedRegistry);
        vm.expectRevert(RegistryRouter.RegistryNotBoundToAsset.selector);
        router.releaseCollateralFor(partner1, assetId);
    }

    function testInitiateSettlementRegistryNotBoundToAsset() public {
        uint256 assetId = 100;
        address unauthorizedRegistry = makeAddr("unauthorizedRegistry");

        vm.startPrank(admin);
        router.grantRole(router.AUTHORIZED_REGISTRY_ROLE(), unauthorizedRegistry);
        vm.stopPrank();

        vm.prank(unauthorizedRegistry);
        vm.expectRevert(RegistryRouter.RegistryNotBoundToAsset.selector);
        router.initiateSettlement(partner1, assetId, 100);
    }

    function testExecuteLiquidationRegistryNotBoundToAsset() public {
        uint256 assetId = 100;
        address unauthorizedRegistry = makeAddr("unauthorizedRegistry");

        vm.startPrank(admin);
        router.grantRole(router.AUTHORIZED_REGISTRY_ROLE(), unauthorizedRegistry);
        vm.stopPrank();

        vm.prank(unauthorizedRegistry);
        vm.expectRevert(RegistryRouter.RegistryNotBoundToAsset.selector);
        router.executeLiquidation(assetId);
    }

    function testProcessSettlementClaimForRegistryNotBoundToAsset() public {
        uint256 assetId = 100;
        address unauthorizedRegistry = makeAddr("unauthorizedRegistry");

        vm.startPrank(admin);
        router.grantRole(router.AUTHORIZED_REGISTRY_ROLE(), unauthorizedRegistry);
        vm.stopPrank();

        vm.prank(unauthorizedRegistry);
        vm.expectRevert(RegistryRouter.RegistryNotBoundToAsset.selector);
        router.processSettlementClaimFor(partner1, assetId, 100);
    }

    function testInitiateSettlementReturnsManagerSettlementState() public {
        _ensureState(SetupState.EarningsDistributed);
        uint256 topUpAmount = SETTLEMENT_TOP_UP_AMOUNT;

        vm.prank(partner1);
        usdc.approve(address(treasury), topUpAmount);

        vm.prank(address(assetRegistry));
        (uint256 settlementAmount, uint256 settlementPerToken) =
            router.initiateSettlement(partner1, scenario.assetId, topUpAmount);

        IPositionManager.SettlementState memory settlementState =
            roboshareTokens.positionManager().getSettlementState(scenario.assetId);
        assertTrue(settlementState.isConfigured);
        assertEq(settlementAmount, settlementState.settlementAmount);
        assertEq(settlementPerToken, settlementState.settlementPerToken);
    }

    function testClaimSettlementRoutesThroughRegistry() public {
        _ensureState(SetupState.EarningsDistributed);

        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        IPositionManager positionManager = roboshareTokens.positionManager();
        uint256 buyerBalance = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        uint256 expectedPayout = positionManager.previewSettlementClaim(scenario.assetId, buyerBalance);

        vm.prank(buyer);
        (uint256 claimedAmount, uint256 earningsClaimed) = router.claimSettlement(scenario.assetId, false);

        assertEq(earningsClaimed, 0);
        assertEq(claimedAmount, expectedPayout);
        assertEq(roboshareTokens.balanceOf(buyer, scenario.revenueTokenId), 0);
        IPositionManager.SettlementClaimState memory claimState =
            positionManager.getSettlementClaimState(scenario.assetId, buyer);
        assertEq(claimState.burnedAmount, buyerBalance);
        assertEq(claimState.payout, claimedAmount);
    }

    // TreasuryNotSet Tests

    function _setupRouterWithoutTreasury() internal returns (RegistryRouter, uint256 assetId) {
        vm.startPrank(admin);
        RegistryRouter freshRouter = new RegistryRouter();
        ERC1967Proxy proxy = new ERC1967Proxy(address(freshRouter), "");
        RegistryRouter proxyRouter = RegistryRouter(address(proxy));
        proxyRouter.initialize(admin, address(roboshareTokens), address(partnerManager));
        proxyRouter.grantRole(proxyRouter.AUTHORIZED_REGISTRY_ROLE(), address(assetRegistry));
        roboshareTokens.grantRole(roboshareTokens.MINTER_ROLE(), address(proxyRouter));
        vm.stopPrank();

        vm.prank(address(assetRegistry));
        (assetId,) = proxyRouter.reserveNextTokenIdPair();

        return (proxyRouter, assetId);
    }

    function testReleaseCollateralForTreasuryNotSet() public {
        (RegistryRouter proxyRouter, uint256 assetId) = _setupRouterWithoutTreasury();
        vm.prank(address(assetRegistry));
        vm.expectRevert(RegistryRouter.TreasuryNotSet.selector);
        proxyRouter.releaseCollateralFor(partner1, assetId);
    }

    function testIsAssetSolventTreasuryNotSet() public {
        (RegistryRouter proxyRouter, uint256 assetId) = _setupRouterWithoutTreasury();
        vm.prank(address(assetRegistry));
        vm.expectRevert(RegistryRouter.TreasuryNotSet.selector);
        proxyRouter.isAssetSolvent(assetId);
    }

    function testPreviewLiquidationEligibilityTreasuryNotSet() public {
        (RegistryRouter proxyRouter, uint256 assetId) = _setupRouterWithoutTreasury();
        vm.expectRevert(RegistryRouter.TreasuryNotSet.selector);
        proxyRouter.previewLiquidationEligibility(assetId);
    }

    function testInitiateSettlementTreasuryNotSet() public {
        (RegistryRouter proxyRouter, uint256 assetId) = _setupRouterWithoutTreasury();
        vm.prank(address(assetRegistry));
        vm.expectRevert(RegistryRouter.TreasuryNotSet.selector);
        proxyRouter.initiateSettlement(partner1, assetId, 100);
    }

    function testExecuteLiquidationTreasuryNotSet() public {
        (RegistryRouter proxyRouter, uint256 assetId) = _setupRouterWithoutTreasury();
        vm.prank(address(assetRegistry));
        vm.expectRevert(RegistryRouter.TreasuryNotSet.selector);
        proxyRouter.executeLiquidation(assetId);
    }

    function testProcessSettlementClaimForTreasuryNotSet() public {
        (RegistryRouter proxyRouter, uint256 assetId) = _setupRouterWithoutTreasury();
        vm.prank(address(assetRegistry));
        vm.expectRevert(RegistryRouter.TreasuryNotSet.selector);
        proxyRouter.processSettlementClaimFor(partner1, assetId, 100);
    }

    function testSnapshotAndClaimEarningsEarningsManagerNotSet() public {
        (RegistryRouter proxyRouter, uint256 assetId) = _setupRouterWithoutTreasury();
        vm.prank(address(assetRegistry));
        vm.expectRevert(RegistryRouter.EarningsManagerNotSet.selector);
        proxyRouter.snapshotAndClaimEarnings(assetId, partner1, false);
    }

    function testSnapshotAndClaimEarningsRegistryNotBoundToAsset() public {
        uint256 assetId = 100;
        address unauthorizedRegistry = makeAddr("unauthorizedRegistry");

        vm.startPrank(admin);
        router.grantRole(router.AUTHORIZED_REGISTRY_ROLE(), unauthorizedRegistry);
        vm.stopPrank();

        vm.prank(unauthorizedRegistry);
        vm.expectRevert(RegistryRouter.RegistryNotBoundToAsset.selector);
        router.snapshotAndClaimEarnings(assetId, partner1, false);
    }

    // MarketplaceNotSet Tests

    function _setupRouterWithoutMarketplace() internal returns (RegistryRouter, uint256 assetId) {
        vm.startPrank(admin);
        RegistryRouter freshRouter = new RegistryRouter();
        ERC1967Proxy proxy = new ERC1967Proxy(address(freshRouter), "");
        RegistryRouter proxyRouter = RegistryRouter(address(proxy));
        proxyRouter.initialize(admin, address(roboshareTokens), address(partnerManager));
        proxyRouter.setTreasury(address(treasury));
        proxyRouter.grantRole(proxyRouter.AUTHORIZED_REGISTRY_ROLE(), address(assetRegistry));
        roboshareTokens.grantRole(roboshareTokens.MINTER_ROLE(), address(proxyRouter));
        vm.stopPrank();

        vm.prank(address(assetRegistry));
        (assetId,) = proxyRouter.reserveNextTokenIdPair();

        return (proxyRouter, assetId);
    }

    function testCreateRevenueTokenPoolForMarketplaceNotSet() public {
        (RegistryRouter proxyRouter,) = _setupRouterWithoutMarketplace();
        vm.startPrank(admin);
        assetRegistry.updateRouter(address(proxyRouter));
        proxyRouter.grantRole(proxyRouter.AUTHORIZED_REGISTRY_ROLE(), address(assetRegistry));
        vm.stopPrank();

        vm.prank(partner1);
        uint256 assetId = assetRegistry.registerAsset(_vehicleRegistrationData(TEST_VIN), ASSET_VALUE);
        uint256 explicitSupply = ASSET_VALUE / REVENUE_TOKEN_PRICE;

        vm.prank(address(assetRegistry));
        vm.expectRevert();
        proxyRouter.createRevenueTokenPoolFor(
            partner1,
            assetId,
            REVENUE_TOKEN_PRICE,
            block.timestamp + 365 days,
            10_000,
            1_000,
            explicitSupply,
            false,
            false
        );
    }

    // Solvency Tests

    function testIsAssetSolvent() public {
        _ensureState(SetupState.PrimaryPoolCreated); // Asset 1 is active and solvent by default

        // Initially solvent
        assertTrue(router.isAssetSolvent(scenario.assetId));

        // Get maturity date from RoboshareTokens (now stored in TokenInfo)
        uint256 revenueTokenId = scenario.assetId + 1;
        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(revenueTokenId);

        // Warp to after maturity date to enable liquidation
        vm.warp(maturityDate + 1);

        // Trigger liquidation to make it Expired
        vm.prank(unauthorized); // Anyone can call liquidateAsset
        assetRegistry.liquidateAsset(scenario.assetId);

        // After liquidation, Treasury should reflect non-solvency due to settlement (even if solvent before)
        assertFalse(router.isAssetSolvent(scenario.assetId));
    }

    function testPreviewLiquidationEligibility() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        _purchasePrimaryForBaseAmount(buyer, scenario.revenueTokenId, ASSET_VALUE);

        (bool eligible, uint8 reason) = router.previewLiquidationEligibility(scenario.assetId);
        assertFalse(eligible);
        assertEq(reason, 3); // NotEligible

        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(scenario.revenueTokenId);
        vm.warp(maturityDate + 1);

        (eligible, reason) = router.previewLiquidationEligibility(scenario.assetId);
        assertTrue(eligible);
        assertEq(reason, 0); // EligibleByMaturity
    }
}
