// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { AssetLib, ProtocolLib } from "../../contracts/Libraries.sol";
import { IPositionManager } from "../../contracts/interfaces/IPositionManager.sol";
import { MarketplaceFlowBaseTest } from "../base/MarketplaceFlowBaseTest.t.sol";
import { Marketplace } from "../../contracts/Marketplace.sol";
import { PartnerManager } from "../../contracts/PartnerManager.sol";

contract MarketplaceIntegrationTest is MarketplaceFlowBaseTest {
    event ListingCreated(
        uint256 indexed listingId,
        uint256 indexed tokenId,
        uint256 indexed assetId,
        address seller,
        uint256 amount,
        uint256 pricePerToken,
        uint256 expiresAt,
        bool buyerPaysFee
    );

    event RevenueTokensTraded(
        uint256 indexed tokenId,
        address indexed from,
        address indexed to,
        uint256 amount,
        uint256 listingId,
        uint256 totalPrice
    );

    event ListingEnded(uint256 indexed listingId, address indexed seller);

    function setUp() public {
        _ensureState(SetupState.InitialAccountsSetup);
    }

    function _registerAssetAndPrepareRevenueToken()
        internal
        returns (uint256 assetId, uint256 tokenId, uint256 supply)
    {
        return _registerAssetAndPrepareRevenueToken(false, false, 0);
    }

    function _registerAssetAndPrepareRevenueToken(
        bool immediateProceeds,
        bool protectionEnabled,
        uint256 maxSupplyOverride
    ) internal returns (uint256 assetId, uint256 tokenId, uint256 supply) {
        _ensureState(SetupState.InitialAccountsSetup);
        vm.prank(partner1);
        assetId = assetRegistry.registerAsset(_vehicleRegistrationData(TEST_VIN), ASSET_VALUE);
        tokenId = assetId + 1;
        supply = ASSET_VALUE / REVENUE_TOKEN_PRICE;
        uint256 maxSupply = maxSupplyOverride == 0 ? supply : maxSupplyOverride;
        vm.prank(address(router));
        roboshareTokens.setRevenueTokenInfo(
            tokenId,
            REVENUE_TOKEN_PRICE,
            supply,
            maxSupply,
            block.timestamp + 365 days,
            10_000,
            1_000,
            immediateProceeds,
            protectionEnabled
        );
    }

    // Create Listing Tests

    function testCreateListing() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        uint256 buyerBalance = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        vm.startPrank(buyer);
        roboshareTokens.setApprovalForAll(address(marketplace), true);
        uint256 newListingId = marketplace.createListing(
            scenario.revenueTokenId, buyerBalance, REVENUE_TOKEN_PRICE, LISTING_DURATION, true
        );
        vm.stopPrank();

        _assertListingState(newListingId, scenario.revenueTokenId, buyerBalance, REVENUE_TOKEN_PRICE, buyer, true, true);
    }

    function testCreateListingInvalidTokenType() public {
        _ensureState(SetupState.AssetRegistered);

        vm.expectRevert(Marketplace.InvalidTokenType.selector);
        vm.prank(partner1);
        marketplace.createListing(scenario.assetId, 1, REVENUE_TOKEN_PRICE, LISTING_DURATION, true);
    }

    function testCreateListingInvalidAmount() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        vm.expectRevert(Marketplace.InvalidAmount.selector);
        vm.prank(partner1);
        marketplace.createListing(scenario.revenueTokenId, 0, REVENUE_TOKEN_PRICE, LISTING_DURATION, true);
    }

    function testCreateListingInvalidAmountExceedsCurrentSupply() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        uint256 currentSupply = roboshareTokens.getRevenueTokenSupply(scenario.revenueTokenId);
        vm.expectRevert(Marketplace.InvalidAmount.selector);
        vm.prank(partner1);
        marketplace.createListing(
            scenario.revenueTokenId, currentSupply + 1, REVENUE_TOKEN_PRICE, LISTING_DURATION, true
        );
    }

    function testCreateListingInvalidPrice() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        vm.prank(partner1);
        vm.expectRevert(Marketplace.InvalidPrice.selector);
        marketplace.createListing(scenario.revenueTokenId, SECONDARY_LISTING_AMOUNT, 0, LISTING_DURATION, true);
    }

    function testCreateListingInsufficientTokenBalance() public {
        _ensureSecondaryListingScenario();

        vm.prank(buyer);
        vm.expectRevert(Marketplace.InsufficientTokenBalance.selector);
        marketplace.createListing(scenario.revenueTokenId, 1, REVENUE_TOKEN_PRICE, LISTING_DURATION, true);
    }

    function testCreateListingLocksTokensWithoutTransferToMarketplace() public {
        _ensureSecondaryListingScenario();

        uint256 buyerBalance = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        if (buyerBalance == 0) {
            (,, uint256 expectedPayment) =
                marketplace.previewSecondaryPurchase(scenario.listingId, SECONDARY_PURCHASE_AMOUNT);
            vm.startPrank(buyer);
            usdc.approve(address(marketplace), expectedPayment);
            marketplace.buyFromSecondaryListing(scenario.listingId, SECONDARY_PURCHASE_AMOUNT);
            vm.stopPrank();

            vm.prank(partner1);
            usdc.approve(address(treasury), type(uint256).max);
            vm.prank(partner1);
            marketplace.endListing(scenario.listingId);

            vm.prank(buyer);
            // claimTokens removed: immediate settlement
            buyerBalance = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        }

        vm.prank(buyer);
        roboshareTokens.setApprovalForAll(address(marketplace), true);
        uint256 buyerBalanceBefore = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        uint256 lockedBefore = roboshareTokens.getLockedAmount(buyer, scenario.revenueTokenId);
        vm.prank(buyer);
        uint256 listingId = marketplace.createListing(
            scenario.revenueTokenId, buyerBalance, REVENUE_TOKEN_PRICE, LISTING_DURATION, true
        );
        uint256 buyerBalanceAfter = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        uint256 lockedAfter = roboshareTokens.getLockedAmount(buyer, scenario.revenueTokenId);

        assertEq(lockedBefore, 0);
        assertEq(lockedAfter, buyerBalance);
        assertEq(buyerBalanceAfter, buyerBalanceBefore);
        assertEq(roboshareTokens.balanceOf(address(marketplace), scenario.revenueTokenId), 0);
        Marketplace.Listing memory listing = marketplace.getListing(listingId);
        assertEq(listing.amount, buyerBalance);
    }

    function testCreateListingLocksSellerWalletBalance() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        uint256 buyerBalance = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        uint256 lockedBefore = roboshareTokens.getLockedAmount(buyer, scenario.revenueTokenId);
        vm.startPrank(buyer);
        roboshareTokens.setApprovalForAll(address(marketplace), true);
        marketplace.createListing(scenario.revenueTokenId, buyerBalance, REVENUE_TOKEN_PRICE, LISTING_DURATION, true);
        vm.stopPrank();

        uint256 lockedAfter = roboshareTokens.getLockedAmount(buyer, scenario.revenueTokenId);
        assertEq(lockedBefore, 0);
        assertEq(lockedAfter, buyerBalance);
    }

    function testCreatePrimaryPoolAssetNotMarketOperational() public {
        (, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(partner1);
        vm.expectRevert(Marketplace.AssetNotMarketOperational.selector);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);
    }

    function testCreatePrimaryPoolNotPoolPartner() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner2);
        vm.expectRevert(Marketplace.NotPoolPartner.selector);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);
    }

    function testCreatePrimaryPool() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();
        assertFalse(marketplace.isPrimaryPoolActive(tokenId));

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);
        assertTrue(marketplace.isPrimaryPoolActive(tokenId));
    }

    function testCreatePrimaryPoolAlreadyCreated() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.startPrank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);
        vm.expectRevert(Marketplace.PrimaryPoolAlreadyCreated.selector);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);
        vm.stopPrank();
    }

    function testPausePrimaryPool() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);

        vm.prank(partner1);
        marketplace.pausePrimaryPool(tokenId);
        assertFalse(marketplace.isPrimaryPoolActive(tokenId));
    }

    function testPausePrimaryPoolNotPoolPartner() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);

        vm.prank(partner2);
        vm.expectRevert(Marketplace.NotPoolPartner.selector);
        marketplace.pausePrimaryPool(tokenId);
    }

    function testPausePrimaryPoolUnauthorizedPartner() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);

        vm.prank(unauthorized);
        vm.expectRevert(PartnerManager.UnauthorizedPartner.selector);
        marketplace.pausePrimaryPool(tokenId);
    }

    function testPausePrimaryPoolAdmin() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);

        vm.prank(admin);
        marketplace.pausePrimaryPool(tokenId);

        assertFalse(marketplace.isPrimaryPoolActive(tokenId));
    }

    function testUnpausePrimaryPoolNotPoolPartner() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);

        vm.prank(partner1);
        marketplace.pausePrimaryPool(tokenId);

        vm.prank(partner2);
        vm.expectRevert(Marketplace.NotPoolPartner.selector);
        marketplace.unpausePrimaryPool(tokenId);
    }

    function testUnpausePrimaryPoolUnauthorizedPartner() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);

        vm.prank(partner1);
        marketplace.pausePrimaryPool(tokenId);

        vm.prank(unauthorized);
        vm.expectRevert(PartnerManager.UnauthorizedPartner.selector);
        marketplace.unpausePrimaryPool(tokenId);
    }

    function testUnpausePrimaryPool() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);

        vm.prank(partner1);
        marketplace.pausePrimaryPool(tokenId);

        vm.prank(partner1);
        marketplace.unpausePrimaryPool(tokenId);
        assertTrue(marketplace.isPrimaryPoolActive(tokenId));
    }

    function testClosePrimaryPool() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);

        vm.prank(partner1);
        marketplace.closePrimaryPool(tokenId);
        assertFalse(marketplace.isPrimaryPoolActive(tokenId));
    }

    function testClosePrimaryPoolNotPoolPartner() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);

        vm.prank(partner2);
        vm.expectRevert(Marketplace.NotPoolPartner.selector);
        marketplace.closePrimaryPool(tokenId);
    }

    function testClosePrimaryPoolUnauthorizedPartner() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);

        vm.prank(unauthorized);
        vm.expectRevert(PartnerManager.UnauthorizedPartner.selector);
        marketplace.closePrimaryPool(tokenId);
    }

    function testClosePrimaryPoolAuthorizedContract() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);

        vm.prank(address(router));
        marketplace.closePrimaryPool(tokenId);

        assertFalse(marketplace.isPrimaryPoolActive(tokenId));
    }

    function testClosePrimaryPoolAlreadyClosed() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.startPrank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);
        marketplace.closePrimaryPool(tokenId);
        vm.expectRevert(Marketplace.PrimaryPoolAlreadyClosed.selector);
        marketplace.closePrimaryPool(tokenId);
        vm.stopPrank();
    }

    function testCreatePrimaryPoolInvalidTokenType() public {
        _ensureState(SetupState.AssetRegistered);
        vm.prank(partner1);
        vm.expectRevert(Marketplace.InvalidTokenType.selector);
        marketplace.createPrimaryPool(scenario.assetId, REVENUE_TOKEN_PRICE);
    }

    function testCreatePrimaryPoolInvalidPrice() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        vm.expectRevert(Marketplace.InvalidPrice.selector);
        marketplace.createPrimaryPool(tokenId, 0);
    }

    function testCreatePrimaryPoolInvalidMaxSupply() public {
        _ensureState(SetupState.InitialAccountsSetup);
        vm.prank(partner1);
        uint256 assetId = assetRegistry.registerAsset(_vehicleRegistrationData(TEST_VIN), ASSET_VALUE);
        uint256 tokenId = assetId + 1;
        uint256 supply = ASSET_VALUE / REVENUE_TOKEN_PRICE;
        vm.prank(address(router));
        roboshareTokens.setRevenueTokenInfo(
            tokenId, REVENUE_TOKEN_PRICE, supply, 0, block.timestamp + 365 days, 10_000, 1_000, false, false
        );

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        vm.expectRevert(Marketplace.InvalidMaxSupply.selector);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);
    }

    function testPausePrimaryPoolAlreadyClosed() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);

        vm.prank(partner1);
        marketplace.closePrimaryPool(tokenId);

        vm.prank(partner1);
        vm.expectRevert(Marketplace.PrimaryPoolAlreadyClosed.selector);
        marketplace.pausePrimaryPool(tokenId);
    }

    function testUnpausePrimaryPoolAlreadyClosed() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);

        vm.prank(partner1);
        marketplace.closePrimaryPool(tokenId);

        vm.prank(partner1);
        vm.expectRevert(Marketplace.PrimaryPoolAlreadyClosed.selector);
        marketplace.unpausePrimaryPool(tokenId);
    }

    function testPreviewPrimaryPurchaseZeroAmount() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken();

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);

        (uint256 totalCost, uint256 protocolFee, uint256 partnerProceeds) =
            marketplace.previewPrimaryPurchase(tokenId, 0);
        assertEq(totalCost, 0);
        assertEq(protocolFee, 0);
        assertEq(partnerProceeds, 0);
    }

    function testPausePrimaryPoolPrimaryPoolNotFound() public {
        vm.expectRevert(Marketplace.PrimaryPoolNotFound.selector);
        marketplace.pausePrimaryPool(999_999);
    }

    function testPreviewPrimaryPurchaseImmediateProceedsBranch() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken(true, false, 0);
        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);
        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);

        (uint256 totalCost, uint256 protocolFee, uint256 partnerProceeds) =
            marketplace.previewPrimaryPurchase(tokenId, 1);
        assertGt(totalCost, 0);
        assertGt(protocolFee, 0);
        assertEq(partnerProceeds, REVENUE_TOKEN_PRICE);
    }

    function testPreviewPrimaryPoolBufferRequirements() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken(false, true, 0);
        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);

        (uint256 protocolBuffer, uint256 protectionBuffer, uint256 totalBuffer) =
            marketplace.previewPrimaryPoolBufferRequirements(tokenId, ASSET_VALUE);
        uint256 protocolOnly = _getTotalBufferRequirement(ASSET_VALUE, ProtocolLib.BENCHMARK_YIELD_BP, false);
        uint256 withProtection = _getTotalBufferRequirement(ASSET_VALUE, ProtocolLib.BENCHMARK_YIELD_BP, true);

        assertEq(protocolBuffer, protocolOnly);
        assertEq(totalBuffer, withProtection);
        assertEq(protectionBuffer, withProtection - protocolOnly);
    }

    function testRevenueTokenProtectionEnabled() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken(false, true, 0);
        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);

        assertTrue(roboshareTokens.getRevenueTokenProtectionEnabled(tokenId));
    }

    function testRedeemPrimaryPoolInvalidAmount() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        vm.prank(buyer);
        vm.expectRevert(Marketplace.InvalidAmount.selector);
        marketplace.redeemPrimaryPool(scenario.revenueTokenId, 0, 0);
    }

    function testBuyFromPrimaryPoolPrimaryPoolNotActive() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        vm.prank(partner1);
        marketplace.pausePrimaryPool(scenario.revenueTokenId);

        vm.prank(buyer);
        vm.expectRevert(Marketplace.PrimaryPoolNotActive.selector);
        marketplace.buyFromPrimaryPool(scenario.revenueTokenId, 1);
    }

    function testBuyFromPrimaryPoolInvalidAmount() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        vm.prank(buyer);
        vm.expectRevert(Marketplace.InvalidAmount.selector);
        marketplace.buyFromPrimaryPool(scenario.revenueTokenId, 0);
    }

    function testBuyFromPrimaryPoolAssetNotActive() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        vm.prank(address(router));
        assetRegistry.setAssetStatus(scenario.assetId, AssetLib.AssetStatus.Suspended);
        vm.prank(buyer);
        vm.expectRevert(Marketplace.AssetNotActive.selector);
        marketplace.buyFromPrimaryPool(scenario.revenueTokenId, 1);
    }

    function testBuyFromPrimaryPoolInvalidAmountExceedsMaxSupply() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        vm.prank(buyer);
        vm.expectRevert(Marketplace.InvalidAmount.selector);
        marketplace.buyFromPrimaryPool(scenario.revenueTokenId, (ASSET_VALUE / REVENUE_TOKEN_PRICE) + 1);
    }

    function testBuyFromPrimaryPoolInsufficientPayment() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        deal(address(usdc), buyer, 0);
        vm.prank(buyer);
        vm.expectRevert(Marketplace.InsufficientPayment.selector);
        marketplace.buyFromPrimaryPool(scenario.revenueTokenId, 1);
    }

    function testPrimaryRedemptionPreviewAndRedeem() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        uint256 burnAmount = PRIMARY_PURCHASE_AMOUNT / 2;
        IPositionManager manager = roboshareTokens.positionManager();

        (uint256 previewPayout,, uint256 redemptionSupply, uint256 eligibleBalance) =
            marketplace.previewPrimaryRedemption(scenario.revenueTokenId, buyer, burnAmount);
        assertGt(previewPayout, 0);
        assertGt(redemptionSupply, 0);
        assertGe(eligibleBalance, burnAmount);
        assertEq(redemptionSupply, manager.getCurrentPrimaryRedemptionEpochSupply(scenario.revenueTokenId));
        assertEq(eligibleBalance, manager.getPrimaryRedemptionEligibleBalance(buyer, scenario.revenueTokenId));
        uint256 backedPrincipalBefore = manager.getCurrentPrimaryRedemptionBackedPrincipal(scenario.revenueTokenId);

        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);
        uint256 buyerTokensBefore = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);

        vm.prank(buyer);
        uint256 payout = marketplace.redeemPrimaryPool(scenario.revenueTokenId, burnAmount, previewPayout);
        assertEq(payout, previewPayout);

        assertEq(roboshareTokens.balanceOf(buyer, scenario.revenueTokenId), buyerTokensBefore - burnAmount);
        assertEq(usdc.balanceOf(buyer), buyerUsdcBefore + payout);
        assertEq(manager.getCurrentPrimaryRedemptionEpochSupply(scenario.revenueTokenId), redemptionSupply - burnAmount);
        assertEq(
            manager.getCurrentPrimaryRedemptionBackedPrincipal(scenario.revenueTokenId), backedPrincipalBefore - payout
        );
    }

    function testPreviewPrimaryRedemptionZeroAmount() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        (uint256 payout, uint256 liquidity, uint256 supply, uint256 eligibleBalance) =
            marketplace.previewPrimaryRedemption(scenario.revenueTokenId, buyer, 0);
        assertEq(payout, 0);
        assertEq(liquidity, 0);
        assertEq(supply, 0);
        assertEq(eligibleBalance, 0);
    }

    function testImmediateProceedsPrimaryRedemptionOnlyUsesPostReleaseTranche() public {
        (uint256 assetId, uint256 tokenId,) = _registerAssetAndPrepareRevenueToken(true, false, 0);

        vm.prank(address(router));
        assetRegistry.setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        vm.prank(partner1);
        marketplace.createPrimaryPool(tokenId, REVENUE_TOKEN_PRICE);

        uint256 firstPurchaseAmount = 250;
        uint256 secondPurchaseAmount = 500;
        uint256 firstPrincipal = firstPurchaseAmount * REVENUE_TOKEN_PRICE;
        uint256 secondPrincipal = secondPurchaseAmount * REVENUE_TOKEN_PRICE;

        vm.startPrank(buyer);
        usdc.approve(address(marketplace), firstPrincipal + ProtocolLib.calculateProtocolFee(firstPrincipal));
        marketplace.buyFromPrimaryPool(tokenId, firstPurchaseAmount);
        vm.stopPrank();

        uint256 baseAmount = _getCollateralInfo(assetId).baseCollateral;
        uint256 yieldBP = roboshareTokens.getTargetYieldBP(tokenId);
        uint256 requiredCollateral = _getTotalBufferRequirement(baseAmount, yieldBP, false);

        vm.prank(partner1);
        usdc.approve(address(treasury), requiredCollateral);
        vm.prank(partner1);
        treasury.enableProceeds(assetId);

        vm.startPrank(buyer);
        usdc.approve(address(marketplace), secondPrincipal + ProtocolLib.calculateProtocolFee(secondPrincipal));
        marketplace.buyFromPrimaryPool(tokenId, secondPurchaseAmount);
        vm.stopPrank();

        (, uint256 investorLiquidity, uint256 redemptionSupply, uint256 eligibleBalance) =
            marketplace.previewPrimaryRedemption(tokenId, buyer, secondPurchaseAmount);

        assertEq(investorLiquidity, secondPrincipal);
        assertEq(redemptionSupply, secondPurchaseAmount);
        assertEq(eligibleBalance, secondPurchaseAmount);

        (uint256 previewPayout,,,) = marketplace.previewPrimaryRedemption(tokenId, buyer, secondPurchaseAmount);
        assertEq(previewPayout, secondPrincipal);

        (uint256 oversizedPreviewPayout,,, uint256 oversizedEligibleBalance) =
            marketplace.previewPrimaryRedemption(tokenId, buyer, firstPurchaseAmount + secondPurchaseAmount);
        assertEq(oversizedPreviewPayout, 0);
        assertEq(oversizedEligibleBalance, secondPurchaseAmount);

        vm.prank(buyer);
        uint256 payout = marketplace.redeemPrimaryPool(tokenId, secondPurchaseAmount, previewPayout);
        assertEq(payout, secondPrincipal);
        assertEq(roboshareTokens.balanceOf(buyer, tokenId), firstPurchaseAmount);
    }

    function testRedeemPrimaryPoolPrimaryPoolNotActive() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        vm.prank(partner1);
        marketplace.closePrimaryPool(scenario.revenueTokenId);

        vm.prank(buyer);
        vm.expectRevert(Marketplace.PrimaryPoolNotActive.selector);
        marketplace.redeemPrimaryPool(scenario.revenueTokenId, 1, 0);
    }

    function testRedeemPrimaryPoolAssetNotActive() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        vm.prank(address(router));
        assetRegistry.setAssetStatus(scenario.assetId, AssetLib.AssetStatus.Suspended);

        vm.prank(buyer);
        vm.expectRevert(Marketplace.AssetNotActive.selector);
        marketplace.redeemPrimaryPool(scenario.revenueTokenId, 1, 0);
    }

    function testEndListing() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        IPositionManager manager = roboshareTokens.positionManager();

        uint256 buyerBalance = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        vm.startPrank(buyer);
        roboshareTokens.setApprovalForAll(address(marketplace), true);
        uint256 listingId = marketplace.createListing(
            scenario.revenueTokenId, buyerBalance, REVENUE_TOKEN_PRICE, LISTING_DURATION, true
        );
        vm.stopPrank();

        uint256 buyerBefore = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        uint256 lockedBefore = roboshareTokens.getLockedAmount(buyer, scenario.revenueTokenId);

        vm.prank(buyer);
        marketplace.endListing(listingId);

        uint256 buyerAfter = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        uint256 lockedAfter = roboshareTokens.getLockedAmount(buyer, scenario.revenueTokenId);

        assertEq(lockedBefore, buyerBefore);
        assertEq(lockedAfter, 0);
        assertEq(buyerAfter, buyerBefore);
        assertEq(manager.getSalePenalty(listingId), 0);
    }

    function testCreateListingSetsEarlySalePenalty() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        IPositionManager manager = roboshareTokens.positionManager();
        vm.startPrank(buyer);
        roboshareTokens.setApprovalForAll(address(marketplace), true);
        uint256 secondaryListingId = marketplace.createListing(
            scenario.revenueTokenId, SECONDARY_PURCHASE_AMOUNT, REVENUE_TOKEN_PRICE, LISTING_DURATION, true
        );
        vm.stopPrank();

        Marketplace.Listing memory listing = marketplace.getListing(secondaryListingId);
        assertGt(listing.earlySalePenalty, 0, "Early sale penalty should be set");
        assertEq(
            listing.earlySalePenalty,
            manager.getSalesPenalty(buyer, scenario.revenueTokenId, SECONDARY_PURCHASE_AMOUNT),
            "Listing penalty should mirror PositionManager at listing time"
        );
        assertEq(
            manager.getSalePenalty(secondaryListingId), listing.earlySalePenalty, "Manager snapshot penalty mismatch"
        );
    }

    // Purchase Listing Tests

    function testBuyFromSecondaryListingBuyerPaysFee() public {
        _ensureSecondaryListingScenario();

        (uint256 totalPrice, uint256 protocolFee, uint256 expectedPayment) =
            marketplace.previewSecondaryPurchase(scenario.listingId, SECONDARY_PURCHASE_AMOUNT);
        uint256 sellerReceives = totalPrice;

        vm.startPrank(buyer);
        usdc.approve(address(marketplace), expectedPayment);

        BalanceSnapshot memory beforeBalance = _takeBalanceSnapshot(scenario.revenueTokenId);

        _expectRevenueTokensTradedEvent(
            scenario.revenueTokenId, partner1, buyer, SECONDARY_PURCHASE_AMOUNT, scenario.listingId, totalPrice
        );

        marketplace.buyFromSecondaryListing(scenario.listingId, SECONDARY_PURCHASE_AMOUNT);
        vm.stopPrank();

        BalanceSnapshot memory afterBalance = _takeBalanceSnapshot(scenario.revenueTokenId);

        _assertBalanceChanges(
            beforeBalance,
            afterBalance,
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(sellerReceives), // Partner USDC change (immediate)
            // forge-lint: disable-next-line(unsafe-typecast)
            -int256(expectedPayment), // Buyer USDC change
            0, // Treasury Fee Recipient USDC (pending withdrawal only)
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(protocolFee),
            0,
            // forge-lint: disable-next-line(unsafe-typecast)
            -int256(SECONDARY_PURCHASE_AMOUNT),
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(SECONDARY_PURCHASE_AMOUNT)
        );

        Marketplace.Listing memory listing = marketplace.getListing(scenario.listingId);
        assertEq(listing.amount, SECONDARY_LISTING_AMOUNT - SECONDARY_PURCHASE_AMOUNT);
        assertEq(listing.soldAmount, SECONDARY_PURCHASE_AMOUNT);
    }

    function testBuyFromSecondaryListingListingOwnerCannotPurchase() public {
        _ensureSecondaryListingScenario();

        (,, uint256 expectedPayment) = marketplace.previewSecondaryPurchase(scenario.listingId, 1);
        _fundAddressWithUsdc(partner1, expectedPayment);

        vm.startPrank(partner1);
        usdc.approve(address(marketplace), expectedPayment);
        vm.expectRevert(Marketplace.ListingOwnerCannotPurchase.selector);
        marketplace.buyFromSecondaryListing(scenario.listingId, 1);
        vm.stopPrank();
    }

    function testBuyFromSecondaryListingEarlySalePenalty() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        IPositionManager manager = roboshareTokens.positionManager();

        uint256 earlySalePenalty = manager.getSalesPenalty(buyer, scenario.revenueTokenId, SECONDARY_PURCHASE_AMOUNT);
        assertGt(earlySalePenalty, 0, "Sales penalty should be greater than zero");

        vm.startPrank(buyer);
        roboshareTokens.setApprovalForAll(address(marketplace), true);
        uint256 newListingId = marketplace.createListing(
            scenario.revenueTokenId, SECONDARY_PURCHASE_AMOUNT, REVENUE_TOKEN_PRICE, LISTING_DURATION, false
        );
        vm.stopPrank();

        // 3. Calculate expected costs, including the penalty
        (uint256 totalPrice, uint256 protocolFee, uint256 expectedPayment) =
            marketplace.previewSecondaryPurchase(newListingId, SECONDARY_PURCHASE_AMOUNT);

        uint256 fillPenalty = manager.getSalesPenalty(buyer, scenario.revenueTokenId, SECONDARY_PURCHASE_AMOUNT);
        assertEq(fillPenalty, earlySalePenalty, "Fill penalty mismatch");

        // 4. Partner purchases the tokens
        vm.startPrank(partner1);
        usdc.approve(address(marketplace), expectedPayment);

        BalanceSnapshot memory beforeBalance = _takeBalanceSnapshot(scenario.revenueTokenId);

        marketplace.buyFromSecondaryListing(newListingId, SECONDARY_PURCHASE_AMOUNT);
        vm.stopPrank();

        BalanceSnapshot memory afterBalance = _takeBalanceSnapshot(scenario.revenueTokenId);

        // 5. Immediate settlement
        _assertBalanceChanges(
            beforeBalance,
            afterBalance,
            // forge-lint: disable-next-line(unsafe-typecast)
            -int256(expectedPayment), // Partner USDC change (partner1 is buyer)
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(totalPrice - protocolFee - fillPenalty), // Seller proceeds net penalty and fee
            0, // Treasury Fee Recipient USDC (pending withdrawal only)
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(protocolFee + fillPenalty),
            0,
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(SECONDARY_PURCHASE_AMOUNT),
            // forge-lint: disable-next-line(unsafe-typecast)
            -int256(SECONDARY_PURCHASE_AMOUNT)
        );
    }

    function testBuyFromSecondaryListingSellerPaysFee() public {
        _ensureSecondaryListingScenario();
        IPositionManager manager = roboshareTokens.positionManager();

        // Create a secondary listing with seller paying the fee
        uint256 newListingId = _setupSecondaryListing(partner2, SECONDARY_PURCHASE_AMOUNT, REVENUE_TOKEN_PRICE, false);

        (uint256 totalPrice, uint256 protocolFee, uint256 expectedPayment) =
            marketplace.previewSecondaryPurchase(newListingId, SECONDARY_PURCHASE_AMOUNT);
        uint256 sellerReceives = totalPrice - protocolFee;
        uint256 fillPenalty = manager.getSalesPenalty(partner2, scenario.revenueTokenId, SECONDARY_PURCHASE_AMOUNT);

        vm.startPrank(buyer);
        usdc.approve(address(marketplace), expectedPayment);

        BalanceSnapshot memory beforeBalance = _takeBalanceSnapshot(scenario.revenueTokenId);

        marketplace.buyFromSecondaryListing(newListingId, SECONDARY_PURCHASE_AMOUNT);
        vm.stopPrank();

        BalanceSnapshot memory afterBalance = _takeBalanceSnapshot(scenario.revenueTokenId);

        // Immediate settlement
        _assertBalanceChanges(
            beforeBalance,
            afterBalance,
            0,
            // forge-lint: disable-next-line(unsafe-typecast)
            -int256(expectedPayment), // Buyer USDC change
            0, // Treasury Fee Recipient USDC (pending withdrawal only)
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(protocolFee + fillPenalty),
            0,
            0,
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(SECONDARY_PURCHASE_AMOUNT)
        );
        assertEq(
            usdc.balanceOf(partner2), 1_000_000 * 10 ** 6 + (sellerReceives - fillPenalty), "Seller proceeds mismatch"
        );
    }

    function testBuyFromSecondaryListingUsesFillTimePenaltyAfterHoldingPeriod() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        IPositionManager manager = roboshareTokens.positionManager();

        vm.startPrank(buyer);
        roboshareTokens.setApprovalForAll(address(marketplace), true);
        uint256 listingId = marketplace.createListing(
            scenario.revenueTokenId, SECONDARY_PURCHASE_AMOUNT, REVENUE_TOKEN_PRICE, 90 days, false
        );
        vm.stopPrank();

        Marketplace.Listing memory listing = marketplace.getListing(listingId);
        assertGt(listing.earlySalePenalty, 0, "Snapshot penalty should be positive at listing time");

        _warpPastHoldingPeriod();

        uint256 fillPenalty = manager.getSalesPenalty(buyer, scenario.revenueTokenId, SECONDARY_PURCHASE_AMOUNT);
        assertEq(fillPenalty, 0, "Fill-time penalty should decay to zero after holding period");

        (uint256 totalPrice, uint256 protocolFee, uint256 expectedPayment) =
            marketplace.previewSecondaryPurchase(listingId, SECONDARY_PURCHASE_AMOUNT);

        vm.startPrank(partner1);
        usdc.approve(address(marketplace), expectedPayment);
        BalanceSnapshot memory beforeBalance = _takeBalanceSnapshot(scenario.revenueTokenId);
        marketplace.buyFromSecondaryListing(listingId, SECONDARY_PURCHASE_AMOUNT);
        BalanceSnapshot memory afterBalance = _takeBalanceSnapshot(scenario.revenueTokenId);
        vm.stopPrank();

        _assertBalanceChanges(
            beforeBalance,
            afterBalance,
            // forge-lint: disable-next-line(unsafe-typecast)
            -int256(expectedPayment), // Partner USDC change (partner1 is buyer)
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(totalPrice - protocolFee), // Seller receives only price minus protocol fee
            0,
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(protocolFee),
            0,
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(SECONDARY_PURCHASE_AMOUNT),
            // forge-lint: disable-next-line(unsafe-typecast)
            -int256(SECONDARY_PURCHASE_AMOUNT)
        );
    }

    function testBuyFromSecondaryListingCompletelyExhaustsListing() public {
        _ensureSecondaryListingScenario();

        uint256 totalPrice = SECONDARY_LISTING_AMOUNT * REVENUE_TOKEN_PRICE;
        uint256 protocolFee = ProtocolLib.calculateProtocolFee(totalPrice);

        vm.startPrank(buyer);
        usdc.approve(address(marketplace), totalPrice + protocolFee);
        marketplace.buyFromSecondaryListing(scenario.listingId, SECONDARY_LISTING_AMOUNT);
        vm.stopPrank();

        Marketplace.Listing memory listing = marketplace.getListing(scenario.listingId);
        assertEq(listing.amount, 0);
        assertFalse(listing.isActive);
        assertEq(listing.soldAmount, SECONDARY_LISTING_AMOUNT);

        uint256 totalSupply = roboshareTokens.getRevenueTokenSupply(scenario.revenueTokenId);
        assertEq(roboshareTokens.balanceOf(buyer, scenario.revenueTokenId), SECONDARY_LISTING_AMOUNT);
        assertEq(roboshareTokens.balanceOf(partner1, scenario.revenueTokenId), totalSupply - SECONDARY_LISTING_AMOUNT);
        _assertTokenBalance(address(marketplace), scenario.revenueTokenId, 0, "Marketplace token balance mismatch");
        assertEq(roboshareTokens.getLockedAmount(partner1, scenario.revenueTokenId), 0);
    }

    function testBuyFromSecondaryListingAfterSellerRevokesMarketplaceApproval() public {
        _ensureSecondaryListingScenario();

        vm.prank(partner1);
        roboshareTokens.setApprovalForAll(address(marketplace), false);

        uint256 totalPrice = SECONDARY_PURCHASE_AMOUNT * REVENUE_TOKEN_PRICE;
        uint256 protocolFee = ProtocolLib.calculateProtocolFee(totalPrice);

        vm.startPrank(buyer);
        usdc.approve(address(marketplace), totalPrice + protocolFee);
        marketplace.buyFromSecondaryListing(scenario.listingId, SECONDARY_PURCHASE_AMOUNT);
        vm.stopPrank();

        assertEq(roboshareTokens.balanceOf(buyer, scenario.revenueTokenId), SECONDARY_PURCHASE_AMOUNT);
        assertEq(
            roboshareTokens.getLockedAmount(partner1, scenario.revenueTokenId),
            SECONDARY_LISTING_AMOUNT - SECONDARY_PURCHASE_AMOUNT
        );
    }

    function testBuyFromSecondaryListingInsufficientPayment() public {
        _ensureSecondaryListingScenario();

        uint256 totalPrice = SECONDARY_PURCHASE_AMOUNT * REVENUE_TOKEN_PRICE;
        uint256 protocolFee = ProtocolLib.calculateProtocolFee(totalPrice);
        uint256 requiredPayment = totalPrice + protocolFee;

        address poorBuyer = makeAddr("poorBuyer");
        _setupInsufficientFunds(poorBuyer, requiredPayment);

        vm.startPrank(poorBuyer);
        usdc.approve(address(marketplace), requiredPayment);

        vm.expectRevert(); // ERC20: transfer amount exceeds balance
        marketplace.buyFromSecondaryListing(scenario.listingId, SECONDARY_PURCHASE_AMOUNT);
        vm.stopPrank();
    }

    function testBuyFromSecondaryListingExpired() public {
        _ensureSecondaryListingScenario();

        // Create a secondary listing to ensure expiry applies
        uint256 transferAmount = 200;
        _purchaseListingTokens(transferAmount);
        vm.prank(buyer);
        roboshareTokens.safeTransferFrom(buyer, partner2, scenario.revenueTokenId, transferAmount, "");

        vm.startPrank(partner2);
        roboshareTokens.setApprovalForAll(address(marketplace), true);
        uint256 secondaryListingId =
            marketplace.createListing(scenario.revenueTokenId, transferAmount, REVENUE_TOKEN_PRICE, 1 days, true);
        vm.stopPrank();

        _setupExpiredListing(secondaryListingId);

        (,, uint256 expectedPayment) = marketplace.previewSecondaryPurchase(secondaryListingId, 100);
        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);
        uint256 buyerTokenBefore = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        uint256 sellerLockedBefore = roboshareTokens.getLockedAmount(partner2, scenario.revenueTokenId);
        assertEq(sellerLockedBefore, transferAmount);

        vm.startPrank(buyer);
        usdc.approve(address(marketplace), expectedPayment);
        marketplace.buyFromSecondaryListing(secondaryListingId, 100);
        vm.stopPrank();

        Marketplace.Listing memory listing = marketplace.getListing(secondaryListingId);
        assertFalse(listing.isActive);
        assertEq(listing.amount, 0);
        assertEq(roboshareTokens.getLockedAmount(partner2, scenario.revenueTokenId), 0);
        assertEq(usdc.balanceOf(buyer), buyerUsdcBefore);
        assertEq(roboshareTokens.balanceOf(buyer, scenario.revenueTokenId), buyerTokenBefore);
    }

    function testBuyFromSecondaryListingInvalidAmount() public {
        _ensureSecondaryListingScenario();

        vm.expectRevert(Marketplace.InvalidAmount.selector);
        vm.prank(buyer);
        marketplace.buyFromSecondaryListing(scenario.listingId, SECONDARY_LISTING_AMOUNT + 1);
    }

    // End Listing Tests

    function testEndListingReturnsUnsoldTokensToSeller() public {
        _ensureSecondaryListingScenario();

        // 1. Purchase some tokens to have them in escrow
        (,, uint256 expectedPayment) =
            marketplace.previewSecondaryPurchase(scenario.listingId, SECONDARY_PURCHASE_AMOUNT);
        vm.startPrank(buyer);
        usdc.approve(address(marketplace), expectedPayment);
        marketplace.buyFromSecondaryListing(scenario.listingId, SECONDARY_PURCHASE_AMOUNT);
        vm.stopPrank();

        uint256 partnerBalanceBefore = roboshareTokens.balanceOf(partner1, scenario.revenueTokenId);

        // 2. End listing
        vm.prank(partner1);
        marketplace.endListing(scenario.listingId);

        Marketplace.Listing memory listing = marketplace.getListing(scenario.listingId);
        assertFalse(listing.isActive);

        // 3. Verify unsold inventory returned to seller
        _assertTokenBalance(
            partner1, scenario.revenueTokenId, partnerBalanceBefore, "Partner token balance mismatch after ending"
        );
        _assertTokenBalance(
            address(marketplace), scenario.revenueTokenId, 0, "Marketplace token balance mismatch after ending"
        );
        assertEq(roboshareTokens.getLockedAmount(partner1, scenario.revenueTokenId), 0);
        _assertTokenBalance(buyer, scenario.revenueTokenId, SECONDARY_PURCHASE_AMOUNT, "Buyer token balance mismatch");
    }

    function testEndListingExpiredCleanupByNonOwner() public {
        _ensureSecondaryListingScenario();

        _setupExpiredListing(scenario.listingId);

        vm.prank(unauthorized);
        marketplace.endListing(scenario.listingId);

        Marketplace.Listing memory listing = marketplace.getListing(scenario.listingId);
        assertFalse(listing.isActive);
    }

    // Extend Listing Tests

    function testExtendListing() public {
        _ensureSecondaryListingScenario();

        Marketplace.Listing memory listingBefore = marketplace.getListing(scenario.listingId);
        uint256 additionalDuration = 7 days;

        vm.prank(partner1);
        marketplace.extendListing(scenario.listingId, additionalDuration);

        Marketplace.Listing memory listingAfter = marketplace.getListing(scenario.listingId);
        assertEq(listingAfter.expiresAt, listingBefore.expiresAt + additionalDuration);
        assertTrue(listingAfter.isActive);
    }

    function testExtendListingListingNotFound() public {
        _ensureState(SetupState.ContractsDeployed);

        uint256 nonExistentListingId = 999;

        vm.expectRevert(Marketplace.ListingNotFound.selector);
        vm.prank(partner1);
        marketplace.extendListing(nonExistentListingId, 7 days);
    }

    function testExtendListingNotListingOwner() public {
        _ensureSecondaryListingScenario();

        vm.expectRevert(Marketplace.NotListingOwner.selector);
        vm.prank(unauthorized);
        marketplace.extendListing(scenario.listingId, 7 days);
    }

    function testExtendListingInactive() public {
        _ensureSecondaryListingScenario();

        vm.prank(partner1);
        marketplace.endListing(scenario.listingId);

        vm.expectRevert(Marketplace.ListingNotActive.selector);
        vm.prank(partner1);
        marketplace.extendListing(scenario.listingId, 7 days);
    }

    function testExtendListingZeroDuration() public {
        _ensureSecondaryListingScenario();

        vm.expectRevert(Marketplace.InvalidDuration.selector);
        vm.prank(partner1);
        marketplace.extendListing(scenario.listingId, 0);
    }

    function testExtendListingExpiredListingEmitsListingEndedAndCleansUp() public {
        _ensureSecondaryListingScenario();
        _setupExpiredListing(scenario.listingId);

        vm.expectEmit(true, true, false, true, address(marketplace));
        emit ListingEnded(scenario.listingId, partner1);

        vm.prank(partner1);
        marketplace.extendListing(scenario.listingId, 7 days);

        Marketplace.Listing memory listing = marketplace.getListing(scenario.listingId);
        assertFalse(listing.isActive);
        assertEq(listing.amount, 0);
        assertEq(roboshareTokens.getLockedAmount(partner1, scenario.revenueTokenId), 0);
    }

    function testEndListingSoldOut() public {
        _ensureSecondaryListingScenario();

        // Buy all tokens
        (,, uint256 payment) = marketplace.previewSecondaryPurchase(scenario.listingId, SECONDARY_LISTING_AMOUNT);
        vm.startPrank(buyer);
        usdc.approve(address(marketplace), payment);
        marketplace.buyFromSecondaryListing(scenario.listingId, SECONDARY_LISTING_AMOUNT);
        vm.stopPrank();

        // Check state before ending
        Marketplace.Listing memory listing = marketplace.getListing(scenario.listingId);
        assertFalse(listing.isActive); // Already inactive because amount is 0
        assertEq(listing.amount, 0);

        // End listing for sold-out listing (no inventory to return)
        vm.prank(partner1);
        marketplace.endListing(scenario.listingId);
        listing = marketplace.getListing(scenario.listingId);
        assertFalse(listing.isActive);
        assertEq(listing.amount, 0);
    }

    function testEndListingExpiredBySeller() public {
        _ensureSecondaryListingScenario();
        uint256 totalSupply = roboshareTokens.getRevenueTokenSupply(scenario.revenueTokenId);

        // Warping to future
        _warpToTimeOffset(LISTING_DURATION + 1);

        vm.prank(partner1);
        usdc.approve(address(treasury), type(uint256).max);

        vm.prank(partner1);
        marketplace.endListing(scenario.listingId);

        Marketplace.Listing memory listing = marketplace.getListing(scenario.listingId);
        assertFalse(listing.isActive);

        // Unsold tokens are returned to seller
        assertEq(roboshareTokens.balanceOf(partner1, scenario.revenueTokenId), totalSupply);
        assertEq(roboshareTokens.balanceOf(address(marketplace), scenario.revenueTokenId), 0);
        assertEq(roboshareTokens.getLockedAmount(partner1, scenario.revenueTokenId), 0);
    }

    function testEndListingNotListingOwnerBeforeExpiry() public {
        _ensureSecondaryListingScenario();

        vm.expectRevert(Marketplace.NotListingOwner.selector);
        vm.prank(unauthorized);
        marketplace.endListing(scenario.listingId);
    }

    function testEndListingNotFound() public {
        _ensureSecondaryListingScenario();

        vm.prank(partner1);
        vm.expectRevert(Marketplace.ListingNotFound.selector);
        marketplace.endListing(999);
    }

    // View Function Tests

    function testGetAssetListings() public {
        _ensureSecondaryListingScenario();

        assertEq(_getListingCount(scenario.assetId), 1);
        uint256[] memory activeListings = marketplace.getAssetListings(scenario.assetId);
        assertEq(activeListings[0], scenario.listingId);
    }

    function testGetAssetListingsNone() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        uint256[] memory activeListings = marketplace.getAssetListings(scenario.assetId);
        assertEq(activeListings.length, 0);
    }

    function testGetAssetListingsOnlyInactive() public {
        _ensureSecondaryListingScenario();

        vm.prank(partner1);
        marketplace.endListing(scenario.listingId);

        uint256[] memory activeListings = marketplace.getAssetListings(scenario.assetId);
        assertEq(activeListings.length, 0);
    }

    function testGetAssetListingsMixed() public {
        _ensureSecondaryListingScenario(); // Creates listing 1

        uint256 listingId2 = _setupSecondaryListing(partner2, SECONDARY_PURCHASE_AMOUNT, REVENUE_TOKEN_PRICE, true);

        vm.prank(partner1);
        marketplace.endListing(scenario.listingId);

        assertEq(_getListingCount(scenario.assetId), 1);
        uint256[] memory activeListings = marketplace.getAssetListings(scenario.assetId);
        assertEq(activeListings[0], listingId2);
    }

    function testCalculatePurchaseCost() public {
        _ensureSecondaryListingScenario();

        (uint256 totalCost, uint256 protocolFee, uint256 expectedPayment) =
            marketplace.previewSecondaryPurchase(scenario.listingId, SECONDARY_PURCHASE_AMOUNT);

        assertEq(totalCost, SECONDARY_PURCHASE_AMOUNT * REVENUE_TOKEN_PRICE);
        assertEq(protocolFee, ProtocolLib.calculateProtocolFee(totalCost));
        assertEq(expectedPayment, totalCost + protocolFee);
    }

    function testIsAssetMarketOperational() public {
        _ensureState(SetupState.AssetRegistered);
        assertFalse(marketplace.isAssetMarketOperational(scenario.assetId));

        _ensureState(SetupState.PrimaryPoolCreated);
        assertTrue(marketplace.isAssetMarketOperational(scenario.assetId));
    }

    function testIsAssetMarketOperationalAssetNotFound() public {
        _ensureState(SetupState.InitialAccountsSetup);

        assertFalse(marketplace.isAssetMarketOperational(999));
    }

    // Fuzz Tests
    function testFuzzBuyFromSecondaryListing(uint256 purchaseAmount) public {
        _ensureSecondaryListingScenario();

        vm.assume(purchaseAmount > 0 && purchaseAmount <= SECONDARY_LISTING_AMOUNT);

        (,, uint256 expectedPayment) = marketplace.previewSecondaryPurchase(scenario.listingId, purchaseAmount);

        vm.startPrank(buyer);
        usdc.approve(address(marketplace), expectedPayment);
        marketplace.buyFromSecondaryListing(scenario.listingId, purchaseAmount);
        vm.stopPrank();

        // Immediate token transfer
        assertEq(roboshareTokens.balanceOf(buyer, scenario.revenueTokenId), purchaseAmount);
    }

    function testBuyFromSecondaryListingListingNotFound() public {
        _ensureSecondaryListingScenario();
        uint256 nonExistentListingId = 999;

        vm.prank(buyer);
        vm.expectRevert(Marketplace.ListingNotFound.selector);
        marketplace.buyFromSecondaryListing(nonExistentListingId, 1);
    }

    function testBuyFromSecondaryListingInactiveListing() public {
        _ensureSecondaryListingScenario();

        // Deactivate listing by cancelling it
        vm.prank(partner1);
        marketplace.endListing(scenario.listingId);

        // Attempt to purchase from the now-inactive listing
        vm.prank(buyer);
        vm.expectRevert(Marketplace.ListingNotActive.selector);
        marketplace.buyFromSecondaryListing(scenario.listingId, 1);
    }

    function testBuyFromSecondaryListingExpiredListingEmitsListingEnded() public {
        _ensureSecondaryListingScenario();
        _setupExpiredListing(scenario.listingId);

        uint256 buyerBalanceBefore = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);

        vm.expectEmit(true, true, false, true, address(marketplace));
        emit ListingEnded(scenario.listingId, partner1);

        vm.prank(buyer);
        marketplace.buyFromSecondaryListing(scenario.listingId, 1);

        Marketplace.Listing memory listing = marketplace.getListing(scenario.listingId);
        assertFalse(listing.isActive);
        assertEq(listing.amount, 0);
        assertEq(roboshareTokens.getLockedAmount(partner1, scenario.revenueTokenId), 0);
        assertEq(roboshareTokens.balanceOf(buyer, scenario.revenueTokenId), buyerBalanceBefore);
    }

    function testFuzzCreateListing(uint256 amount, uint256 price, uint256 duration) public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        // Constraints
        vm.assume(amount > 0 && amount <= SECONDARY_PURCHASE_AMOUNT);
        vm.assume(price > 0 && price < 1e12); // Reasonable price range
        vm.assume(duration > 0 && duration < 3650 days);

        vm.startPrank(buyer);
        roboshareTokens.setApprovalForAll(address(marketplace), true);

        uint256 listingId = marketplace.createListing(scenario.revenueTokenId, amount, price, duration, true);
        vm.stopPrank();

        Marketplace.Listing memory listing = marketplace.getListing(listingId);
        assertEq(listing.amount, amount);
        assertEq(listing.pricePerToken, price);
        assertEq(listing.expiresAt, block.timestamp + duration);
    }

    function testFuzzPartialSecondaryFillThenEndListing(uint256 purchaseAmount) public {
        _ensureSecondaryListingScenario();
        purchaseAmount = bound(purchaseAmount, 1, SECONDARY_LISTING_AMOUNT - 1);

        (,, uint256 expectedPayment) = marketplace.previewSecondaryPurchase(scenario.listingId, purchaseAmount);

        vm.startPrank(buyer);
        usdc.approve(address(marketplace), expectedPayment);
        marketplace.buyFromSecondaryListing(scenario.listingId, purchaseAmount);
        vm.stopPrank();

        assertEq(
            roboshareTokens.getLockedAmount(partner1, scenario.revenueTokenId),
            SECONDARY_LISTING_AMOUNT - purchaseAmount,
            "Remaining listing amount should stay locked"
        );

        vm.prank(partner1);
        marketplace.endListing(scenario.listingId);

        Marketplace.Listing memory listing = marketplace.getListing(scenario.listingId);
        assertFalse(listing.isActive);
        assertEq(listing.amount, 0);
        assertEq(listing.soldAmount, purchaseAmount);
        assertEq(roboshareTokens.getLockedAmount(partner1, scenario.revenueTokenId), 0);
        assertEq(roboshareTokens.balanceOf(buyer, scenario.revenueTokenId), purchaseAmount);
    }

    function testBuyFromSecondaryListingMinimumProtocolFee() public {
        // 1. Setup with a very low price to ensure percentage-based protocol fee calculates to zero
        uint256 lowPrice = 30; // Total price < 40 results in a percentage fee of 0
        uint256 purchaseAmount = 1;
        uint256 listingAmount = 10;

        _ensureSecondaryListingScenario();
        _purchaseListingTokens(listingAmount);
        _warpPastHoldingPeriod();
        vm.startPrank(buyer);
        roboshareTokens.setApprovalForAll(address(marketplace), true);
        uint256 listingId =
            marketplace.createListing(scenario.revenueTokenId, listingAmount, lowPrice, LISTING_DURATION, true);
        vm.stopPrank();

        // 2. Calculate costs - protocolFee should now be MINIMUM_PROTOCOL_FEE
        (uint256 totalPrice, uint256 protocolFee, uint256 expectedPayment) =
            marketplace.previewSecondaryPurchase(listingId, purchaseAmount);

        assertEq(protocolFee, ProtocolLib.MIN_PROTOCOL_FEE, "Protocol fee should be the minimum fee");
        assertEq(
            expectedPayment, totalPrice + ProtocolLib.MIN_PROTOCOL_FEE, "Expected payment should include minimum fee"
        );

        // 3. Execute purchase
        vm.startPrank(partner1);
        usdc.approve(address(marketplace), expectedPayment);
        BalanceSnapshot memory beforePurchase = _takeBalanceSnapshot(scenario.revenueTokenId);
        marketplace.buyFromSecondaryListing(listingId, purchaseAmount);
        BalanceSnapshot memory afterPurchase = _takeBalanceSnapshot(scenario.revenueTokenId);
        vm.stopPrank();

        // 4. Immediate settlement
        _assertBalanceChanges(
            beforePurchase,
            afterPurchase,
            // forge-lint: disable-next-line(unsafe-typecast)
            -int256(expectedPayment),
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(totalPrice), // Buyer (seller) receives proceeds
            0,
            int256(ProtocolLib.MIN_PROTOCOL_FEE),
            0,
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(purchaseAmount),
            // forge-lint: disable-next-line(unsafe-typecast)
            -int256(purchaseAmount)
        );
    }

    function testBuyFromSecondaryListingFeesExceedPriceBuyerPays() public {
        _ensureSecondaryListingScenario();

        // Transfer tokens to buyer so a penalty applies on re-sale
        _purchaseListingTokens(10);

        // Create a listing with a price so low that the penalty exceeds it
        uint256 lowPrice = 1;
        vm.startPrank(buyer);
        roboshareTokens.setApprovalForAll(address(marketplace), true);
        uint256 listingId = marketplace.createListing(scenario.revenueTokenId, 10, lowPrice, LISTING_DURATION, true);
        vm.stopPrank();

        // Attempt to purchase, which should fail
        vm.startPrank(partner1);
        usdc.approve(address(marketplace), 2_000_000); // Approve more than enough
        vm.expectRevert(Marketplace.FeesExceedPrice.selector);
        marketplace.buyFromSecondaryListing(listingId, 1);
        vm.stopPrank();
    }

    function testBuyFromSecondaryListingFeesExceedPriceSellerPays() public {
        _ensureSecondaryListingScenario();

        // Transfer tokens to a secondary seller so a penalty applies
        _purchaseListingTokens(10);
        vm.prank(buyer);
        roboshareTokens.safeTransferFrom(buyer, partner2, scenario.revenueTokenId, 10, "");

        // Create a listing with a price so low that the penalty exceeds it
        uint256 lowPrice = 1;
        vm.startPrank(partner2);
        roboshareTokens.setApprovalForAll(address(marketplace), true);
        uint256 listingId = marketplace.createListing(scenario.revenueTokenId, 10, lowPrice, LISTING_DURATION, false); // Seller pays
        vm.stopPrank();

        // Attempt to purchase, which should fail
        vm.startPrank(buyer);
        usdc.approve(address(marketplace), 1000); // Approve more than enough
        vm.expectRevert(Marketplace.FeesExceedPrice.selector);
        marketplace.buyFromSecondaryListing(listingId, 1);
        vm.stopPrank();
    }

    // Settlement Integration Tests

    function testCreateListingAssetNotActive() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        // Settle asset
        vm.startPrank(partner1);
        uint256 totalSupply = roboshareTokens.getRevenueTokenSupply(scenario.revenueTokenId);
        uint256 totalLiability = REVENUE_TOKEN_PRICE * totalSupply;
        _fundAddressWithUsdc(partner1, totalLiability);
        usdc.approve(address(treasury), totalLiability);
        assetRegistry.settleAsset(scenario.assetId, totalLiability);
        vm.stopPrank();

        vm.startPrank(partner1);
        roboshareTokens.setApprovalForAll(address(marketplace), true);
        vm.expectRevert(Marketplace.AssetNotMarketOperational.selector);
        marketplace.createListing(
            scenario.revenueTokenId, SECONDARY_LISTING_AMOUNT, REVENUE_TOKEN_PRICE, LISTING_DURATION, true
        );
        vm.stopPrank();
    }

    function testBuyFromSecondaryListingAssetNotActive() public {
        _ensureSecondaryListingScenario();

        // Settle asset
        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        (,, uint256 expectedPayment) =
            marketplace.previewSecondaryPurchase(scenario.listingId, SECONDARY_PURCHASE_AMOUNT);
        vm.startPrank(buyer);
        usdc.approve(address(marketplace), expectedPayment);
        vm.expectRevert(Marketplace.AssetNotActive.selector);
        marketplace.buyFromSecondaryListing(scenario.listingId, SECONDARY_PURCHASE_AMOUNT);
        vm.stopPrank();
    }

    function testPartnerCanPurchaseSecondaryListing() public {
        _ensureSecondaryListingScenario();

        uint256 secondaryListingId =
            _setupSecondaryListing(partner2, SECONDARY_PURCHASE_AMOUNT, REVENUE_TOKEN_PRICE, true);

        (,, uint256 expectedPayment) =
            marketplace.previewSecondaryPurchase(secondaryListingId, SECONDARY_PURCHASE_AMOUNT);
        vm.startPrank(partner1);
        usdc.approve(address(marketplace), expectedPayment);
        marketplace.buyFromSecondaryListing(secondaryListingId, SECONDARY_PURCHASE_AMOUNT);
        vm.stopPrank();

        // Tokens transfer immediately
        assertEq(roboshareTokens.balanceOf(partner1, scenario.revenueTokenId), SECONDARY_LISTING_AMOUNT);
    }

    function _purchaseListingTokens(uint256 amount) internal {
        (,, uint256 expectedPayment) = marketplace.previewSecondaryPurchase(scenario.listingId, amount);
        vm.startPrank(buyer);
        usdc.approve(address(marketplace), expectedPayment);
        marketplace.buyFromSecondaryListing(scenario.listingId, amount);
        vm.stopPrank();
    }

    function _setupSecondaryListing(address seller, uint256 amount, uint256 pricePerToken, bool buyerPaysFee)
        internal
        returns (uint256 listingId)
    {
        _purchaseListingTokens(amount);

        vm.prank(buyer);
        roboshareTokens.safeTransferFrom(buyer, seller, scenario.revenueTokenId, amount, "");

        vm.startPrank(seller);
        roboshareTokens.setApprovalForAll(address(marketplace), true);
        listingId =
            marketplace.createListing(scenario.revenueTokenId, amount, pricePerToken, LISTING_DURATION, buyerPaysFee);
        vm.stopPrank();
    }
}
