// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ERC1155Holder } from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import { StdStorage, stdStorage } from "forge-std/StdStorage.sol";
import { MarketplaceFlowBaseTest } from "../base/MarketplaceFlowBaseTest.t.sol";
import { ProtocolLib, AssetLib, TokenLib, CollateralLib, EarningsLib } from "../../contracts/Libraries.sol";
import { IAssetRegistry } from "../../contracts/interfaces/IAssetRegistry.sol";
import { IPositionManager } from "../../contracts/interfaces/IPositionManager.sol";
import { ITreasury } from "../../contracts/interfaces/ITreasury.sol";
import { PartnerManager } from "../../contracts/PartnerManager.sol";

contract TreasuryIntegrationTest is MarketplaceFlowBaseTest, ERC1155Holder {
    using stdStorage for StdStorage;

    function _positionManager() internal view returns (IPositionManager) {
        return roboshareTokens.positionManager();
    }

    function setUp() public {
        // Integration tests need funded accounts and authorized partners as a baseline
        _ensureState(SetupState.InitialAccountsSetup);
    }

    function _setupImmediateProceedsSettlementAsset()
        internal
        returns (uint256 assetId, uint256 revenueTokenId, uint256 releasedPrincipal)
    {
        vm.prank(partner1);
        assetId = assetRegistry.registerAsset(_vehicleRegistrationData(TEST_VIN), ASSET_VALUE);

        uint256 supply = ASSET_VALUE / REVENUE_TOKEN_PRICE;
        uint256 targetYieldBP = 2_500;

        vm.prank(partner1);
        (revenueTokenId,) = assetRegistry.createRevenueTokenPool(
            assetId, REVENUE_TOKEN_PRICE, block.timestamp + 365 days, 10_000, targetYieldBP, supply, true, true
        );

        releasedPrincipal = 10_000e6;
        uint256 purchaseAmount = releasedPrincipal / REVENUE_TOKEN_PRICE;
        uint256 protocolFee = ProtocolLib.calculateProtocolFee(releasedPrincipal);

        vm.startPrank(buyer);
        usdc.approve(address(marketplace), releasedPrincipal + protocolFee);
        marketplace.buyFromPrimaryPool(revenueTokenId, purchaseAmount);
        vm.stopPrank();

        uint256 requiredCollateral = _getTotalBufferRequirement(releasedPrincipal, targetYieldBP, true);
        vm.prank(partner1);
        usdc.approve(address(treasury), requiredCollateral);
        vm.prank(partner1);
        treasury.enableProceeds(assetId);

        CollateralLib.CollateralInfo memory infoAfterEnable = _getCollateralInfo(assetId);
        assertEq(infoAfterEnable.baseCollateral, 0, "Immediate proceeds should release covered base");
        assertEq(infoAfterEnable.releasedProtectedBase, releasedPrincipal, "Released protected base mismatch");
        assertGt(infoAfterEnable.earningsBuffer, 0, "Protection buffer should be funded");
    }

    function _getProtectedBenchmarkPrincipal(uint256 assetId, uint256 revenueTokenId)
        internal
        view
        returns (uint256 benchmarkPrincipal)
    {
        CollateralLib.CollateralInfo memory info = _getCollateralInfo(assetId);
        bool protectionEnabled = roboshareTokens.getRevenueTokenProtectionEnabled(revenueTokenId);
        if (!protectionEnabled) {
            return 0;
        }

        uint256 protectedExposure = info.baseCollateral;
        if (roboshareTokens.getRevenueTokenImmediateProceedsEnabled(revenueTokenId)) {
            protectedExposure += info.releasedProtectedBase;
        }
        if (protectedExposure == 0) {
            return 0;
        }

        uint256 targetYieldBP = roboshareTokens.getTargetYieldBP(revenueTokenId);
        (, uint256 requiredEarningsBuffer, uint256 requiredProtocolBuffer,) = CollateralLib.calculateCollateralRequirements(
            protectedExposure, ProtocolLib.QUARTERLY_INTERVAL, targetYieldBP
        );

        uint256 protocolCoverCapacity = requiredProtocolBuffer == 0
            ? type(uint256).max
            : Math.mulDiv(info.protocolBuffer, protectedExposure, requiredProtocolBuffer);
        uint256 protectionCoverCapacity = requiredEarningsBuffer == 0
            ? type(uint256).max
            : Math.mulDiv(info.earningsBuffer, protectedExposure, requiredEarningsBuffer);
        benchmarkPrincipal = Math.min(protocolCoverCapacity, protectionCoverCapacity);
        if (benchmarkPrincipal > protectedExposure) {
            benchmarkPrincipal = protectedExposure;
        }
    }

    // Collateral Locking Tests

    function testEnableProceeds() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        uint256 baseAmount = _getCollateralInfo(scenario.assetId).baseCollateral;
        uint256 yieldBP = roboshareTokens.getTargetYieldBP(scenario.revenueTokenId);
        uint256 requiredCollateral = _getTotalBufferRequirement(baseAmount, yieldBP, false);

        vm.prank(partner1);
        usdc.approve(address(treasury), requiredCollateral);

        BalanceSnapshot memory beforeSnapshot = _takeBalanceSnapshot(scenario.revenueTokenId);

        vm.expectEmit(true, true, false, true);
        emit ITreasury.CollateralLocked(scenario.assetId, partner1, requiredCollateral);

        vm.prank(partner1);
        treasury.enableProceeds(scenario.assetId);

        BalanceSnapshot memory afterSnapshot = _takeBalanceSnapshot(scenario.revenueTokenId);

        _assertBalanceChanges(
            beforeSnapshot,
            afterSnapshot,
            // forge-lint: disable-next-line(unsafe-typecast)
            -int256(requiredCollateral), // Partner USDC change
            0, // Buyer USDC change
            0, // Treasury Fee Recipient USDC change
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(requiredCollateral), // Treasury Contract USDC change
            0, // Marketplace Contract USDC change
            0, // Partner token change
            0 // Buyer token change
        );

        _assertCollateralState(scenario.assetId, baseAmount, baseAmount + requiredCollateral, true);
        assertEq(_getCoveredBaseCollateral(scenario.assetId), baseAmount);
        assertEq(treasury.totalCollateralDeposited(), baseAmount + requiredCollateral);
    }

    function testEnableProceedsInitializesTimestampsOnFirstFunding() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        CollateralLib.CollateralInfo memory preFundingInfo = _getCollateralInfo(scenario.assetId);
        uint256 baseAmount = _getCollateralInfo(scenario.assetId).baseCollateral;
        uint256 yieldBP = roboshareTokens.getTargetYieldBP(scenario.revenueTokenId);
        uint256 requiredCollateral = _getTotalBufferRequirement(baseAmount, yieldBP, false);

        assertGt(preFundingInfo.createdAt, 0);
        assertEq(preFundingInfo.lockedAt, 0);

        vm.prank(partner1);
        usdc.approve(address(treasury), requiredCollateral);

        vm.prank(partner1);
        treasury.enableProceeds(scenario.assetId);

        CollateralLib.CollateralInfo memory collateralInfo = _getCollateralInfo(scenario.assetId);
        (,,,, uint256 earningsLastEventTimestamp,,,,) = earningsManager.assetEarnings(scenario.assetId);

        assertTrue(collateralInfo.isLocked);
        assertEq(collateralInfo.createdAt, preFundingInfo.createdAt);
        assertEq(collateralInfo.lockedAt, block.timestamp);
        assertEq(collateralInfo.lastEventTimestamp, block.timestamp);
        assertEq(earningsLastEventTimestamp, block.timestamp);
    }

    function testEnableProceedsAlreadyLocked() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        uint256 baseAmount = _getCollateralInfo(scenario.assetId).baseCollateral;
        uint256 yieldBP = roboshareTokens.getTargetYieldBP(scenario.revenueTokenId);
        uint256 requiredCollateral = _getTotalBufferRequirement(baseAmount, yieldBP, false);

        vm.prank(partner1);
        usdc.approve(address(treasury), requiredCollateral * 2);

        vm.prank(partner1);
        treasury.enableProceeds(scenario.assetId);

        vm.prank(partner1);
        treasury.enableProceeds(scenario.assetId);

        CollateralLib.CollateralInfo memory info = _getCollateralInfo(scenario.assetId);
        assertTrue(info.isLocked);
        assertGt(_getCollateralTotal(info), 0);
    }

    function testEnableProceedsUnauthorizedPartner() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        vm.prank(unauthorized);
        vm.expectRevert(PartnerManager.UnauthorizedPartner.selector);
        treasury.enableProceeds(scenario.assetId);
    }

    function testEnableProceedsAssetNotFound() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        vm.prank(partner1);
        vm.expectRevert(ITreasury.AssetNotFound.selector);
        treasury.enableProceeds(999);
    }

    function testEnableProceedsNotAssetOwner() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        vm.prank(partner2);
        vm.expectRevert(ITreasury.NotAssetOwner.selector);
        treasury.enableProceeds(scenario.assetId);
    }

    function testEnableProceedsInvalidCollateralAmount() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        vm.prank(partner1);
        vm.expectRevert(CollateralLib.InvalidCollateralAmount.selector);
        treasury.enableProceeds(scenario.assetId);
    }

    function testEnableProceedsAlreadyLockedIncreasesOnlyRemainingDue() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        uint256 yieldBP = roboshareTokens.getTargetYieldBP(scenario.revenueTokenId);
        uint256 baseAmount = _getCollateralInfo(scenario.assetId).baseCollateral;
        uint256 requiredCollateral = _getTotalBufferRequirement(baseAmount, yieldBP, false);
        uint256 initialTotal = treasury.totalCollateralDeposited();

        vm.prank(partner1);
        usdc.approve(address(treasury), requiredCollateral);

        vm.prank(partner1);
        treasury.enableProceeds(scenario.assetId);

        uint256 totalAfterFirstFunding = treasury.totalCollateralDeposited();
        uint256 additionalPurchaseAmount = _purchaseRemainingPrimarySupply(buyer, scenario.revenueTokenId);
        uint256 additionalBaseAmount = additionalPurchaseAmount * roboshareTokens.getTokenPrice(scenario.revenueTokenId);

        uint256 expandedBaseAmount = _getCollateralInfo(scenario.assetId).baseCollateral;
        uint256 requiredCollateralSecond = _getTotalBufferRequirement(expandedBaseAmount, yieldBP, false);
        uint256 dueCollateralSecond =
            requiredCollateralSecond > requiredCollateral ? requiredCollateralSecond - requiredCollateral : 0;
        vm.prank(partner1);
        usdc.approve(address(treasury), dueCollateralSecond);

        vm.prank(partner1);
        treasury.enableProceeds(scenario.assetId);

        assertTrue(_getCollateralInfo(scenario.assetId).isLocked);
        assertEq(totalAfterFirstFunding, initialTotal + requiredCollateral);
        assertEq(
            treasury.totalCollateralDeposited(), totalAfterFirstFunding + additionalBaseAmount + dueCollateralSecond
        );
    }

    function testEnableProceedsNoApproval() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        vm.prank(partner1);
        usdc.approve(address(treasury), 0);

        vm.expectRevert();
        vm.prank(partner1);
        treasury.enableProceeds(scenario.assetId);
    }

    function testEnableProceedsInsufficientApproval() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        uint256 baseAmount = _getCollateralInfo(scenario.assetId).baseCollateral;
        uint256 yieldBP = roboshareTokens.getTargetYieldBP(scenario.revenueTokenId);
        uint256 requiredCollateral = _getTotalBufferRequirement(baseAmount, yieldBP, false);
        vm.prank(partner1);
        usdc.approve(address(treasury), requiredCollateral - 1);

        vm.expectRevert();
        vm.prank(partner1);
        treasury.enableProceeds(scenario.assetId);
    }

    // Primary Pool Processing Tests

    function testProcessPrimaryPoolPurchaseForUnauthorizedPartner() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        vm.prank(address(marketplace));
        vm.expectRevert(PartnerManager.UnauthorizedPartner.selector);
        treasury.processPrimaryPoolPurchaseFor(buyer, scenario.revenueTokenId, 1, unauthorized, REVENUE_TOKEN_PRICE, 0);
    }

    function testProcessPrimaryPoolPurchaseForAssetNotFound() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        vm.prank(address(marketplace));
        vm.expectRevert(ITreasury.AssetNotFound.selector);
        treasury.processPrimaryPoolPurchaseFor(buyer, 1000, 1, partner1, REVENUE_TOKEN_PRICE, 0);
    }

    function testProcessPrimaryPoolPurchaseForNotAssetOwner() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        vm.prank(address(marketplace));
        vm.expectRevert(ITreasury.NotAssetOwner.selector);
        treasury.processPrimaryPoolPurchaseFor(buyer, scenario.revenueTokenId, 1, partner2, REVENUE_TOKEN_PRICE, 0);
    }

    function testProcessPrimaryPoolPurchaseFor() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        uint256 amount = 1;
        uint256 principal = REVENUE_TOKEN_PRICE;
        uint256 protocolFee = ProtocolLib.calculateProtocolFee(principal);
        uint256 targetYieldBP = roboshareTokens.getTargetYieldBP(scenario.revenueTokenId);
        uint256 requiredBuffer = _getTotalBufferRequirement(principal, targetYieldBP, false);

        _purchasePrimaryPoolTokens(buyer, scenario.revenueTokenId, amount);
        vm.prank(partner1);
        usdc.approve(address(treasury), requiredBuffer);
        vm.prank(partner1);
        treasury.enableProceeds(scenario.assetId);

        uint256 pendingBefore = treasury.pendingWithdrawals(partner1);
        vm.prank(address(marketplace));
        treasury.processPrimaryPoolPurchaseFor(buyer, scenario.revenueTokenId, amount, partner1, principal, protocolFee);

        assertEq(treasury.pendingWithdrawals(partner1), pendingBefore);
        assertEq(_getCoveredBaseCollateral(scenario.assetId, scenario.revenueTokenId), principal);
        assertEq(uint8(router.getAssetStatus(scenario.assetId)), uint8(AssetLib.AssetStatus.Earning));
    }

    function testProcessPrimaryPoolPurchaseForImmediateProceedsRemainLockedAfterNewPurchase() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        uint256 amount = 1;
        uint256 principal = REVENUE_TOKEN_PRICE;
        uint256 protocolFee = ProtocolLib.calculateProtocolFee(principal);
        uint256 targetYieldBP = roboshareTokens.getTargetYieldBP(scenario.revenueTokenId);
        uint256 requiredBuffer = _getTotalBufferRequirement(principal * 2, targetYieldBP, false);

        _purchasePrimaryPoolTokens(buyer, scenario.revenueTokenId, amount);
        vm.prank(partner1);
        usdc.approve(address(treasury), requiredBuffer);
        vm.prank(partner1);
        treasury.enableProceeds(scenario.assetId);

        uint256 pendingBefore = treasury.pendingWithdrawals(partner1);
        vm.prank(address(marketplace));
        treasury.processPrimaryPoolPurchaseFor(buyer, scenario.revenueTokenId, amount, partner1, principal, protocolFee);

        CollateralLib.CollateralInfo memory info = _getCollateralInfo(scenario.assetId);
        assertEq(treasury.pendingWithdrawals(partner1), pendingBefore);
        assertEq(info.baseCollateral, principal * 2);
        assertEq(_getCoveredBaseCollateral(scenario.assetId, scenario.revenueTokenId), principal);
        assertEq(uint8(router.getAssetStatus(scenario.assetId)), uint8(AssetLib.AssetStatus.Earning));
    }

    function testEnableProceedsReleasesLockedHigherUpsideProceeds() public {
        _ensureState(SetupState.InitialAccountsSetup);

        vm.prank(partner1);
        scenario.assetId = assetRegistry.registerAsset(_vehicleRegistrationData(TEST_VIN), ASSET_VALUE);

        uint256 supply = ASSET_VALUE / REVENUE_TOKEN_PRICE;
        vm.prank(partner1);
        (scenario.revenueTokenId,) = assetRegistry.createRevenueTokenPool(
            scenario.assetId, REVENUE_TOKEN_PRICE, block.timestamp + 365 days, 10_000, 1_000, supply, true, false
        );

        uint256 principal = REVENUE_TOKEN_PRICE;
        uint256 protocolFee = ProtocolLib.calculateProtocolFee(principal);

        vm.prank(address(marketplace));
        treasury.processPrimaryPoolPurchaseFor(buyer, scenario.revenueTokenId, 1, partner1, principal, protocolFee);

        CollateralLib.CollateralInfo memory beforeInfo = _getCollateralInfo(scenario.assetId);
        assertEq(beforeInfo.baseCollateral, principal);
        assertEq(_getCoveredBaseCollateral(scenario.assetId, scenario.revenueTokenId), 0);
        assertEq(treasury.pendingWithdrawals(partner1), 0);

        uint256 requiredBuffer = _getTotalBufferRequirement(principal, 1_000, false);
        vm.prank(partner1);
        usdc.approve(address(treasury), requiredBuffer);

        vm.expectEmit(true, true, false, true);
        emit ITreasury.ImmediateProceedsReleased(scenario.assetId, partner1, principal);

        vm.prank(partner1);
        treasury.enableProceeds(scenario.assetId);

        CollateralLib.CollateralInfo memory afterInfo = _getCollateralInfo(scenario.assetId);
        assertEq(afterInfo.baseCollateral, 0);
        assertEq(_getCoveredBaseCollateral(scenario.assetId, scenario.revenueTokenId), 0);
        assertEq(afterInfo.releasedProtectedBase, principal);
        assertEq(treasury.pendingWithdrawals(partner1), principal);
    }

    function testEnableProceedsHigherUpsideRequiresAdditionalBuffersForNewBuy() public {
        _ensureState(SetupState.InitialAccountsSetup);

        vm.prank(partner1);
        scenario.assetId = assetRegistry.registerAsset(_vehicleRegistrationData(TEST_VIN), ASSET_VALUE);

        uint256 supply = ASSET_VALUE / REVENUE_TOKEN_PRICE;
        vm.prank(partner1);
        (scenario.revenueTokenId,) = assetRegistry.createRevenueTokenPool(
            scenario.assetId, REVENUE_TOKEN_PRICE, block.timestamp + 365 days, 10_000, 1_000, supply, true, false
        );

        uint256 initialPrincipal = 10 * REVENUE_TOKEN_PRICE;
        uint256 initialFee = ProtocolLib.calculateProtocolFee(initialPrincipal);

        vm.prank(address(marketplace));
        treasury.processPrimaryPoolPurchaseFor(
            buyer, scenario.revenueTokenId, 10, partner1, initialPrincipal, initialFee
        );

        uint256 requiredBuffer = _getTotalBufferRequirement(initialPrincipal, 1_000, false);
        vm.prank(partner1);
        usdc.approve(address(treasury), requiredBuffer);
        vm.prank(partner1);
        treasury.enableProceeds(scenario.assetId);

        assertEq(_getCollateralInfo(scenario.assetId).baseCollateral, 0);

        uint256 secondPrincipal = REVENUE_TOKEN_PRICE;
        uint256 secondFee = ProtocolLib.calculateProtocolFee(secondPrincipal);
        uint256 pendingBefore = treasury.pendingWithdrawals(partner1);

        vm.prank(address(marketplace));
        treasury.processPrimaryPoolPurchaseFor(buyer, scenario.revenueTokenId, 1, partner1, secondPrincipal, secondFee);

        uint256 cumulativeExposure = initialPrincipal + secondPrincipal;
        uint256 requiredBufferAfterSecondBuy = _getTotalBufferRequirement(cumulativeExposure, 1_000, false);
        uint256 additionalDue =
            requiredBufferAfterSecondBuy > requiredBuffer ? requiredBufferAfterSecondBuy - requiredBuffer : 0;
        assertGt(additionalDue, 0);

        vm.prank(partner1);
        usdc.approve(address(treasury), additionalDue);
        vm.prank(partner1);
        treasury.enableProceeds(scenario.assetId);

        CollateralLib.CollateralInfo memory info = _getCollateralInfo(scenario.assetId);
        assertEq(info.baseCollateral, 0);
        assertEq(info.releasedProtectedBase, cumulativeExposure);
        assertEq(info.protocolBuffer, requiredBufferAfterSecondBuy);
        assertEq(treasury.pendingWithdrawals(partner1), pendingBefore + secondPrincipal);
    }

    function testProcessPrimaryRedemptionFor() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        IPositionManager manager = roboshareTokens.positionManager();
        uint256 burnAmount = PRIMARY_PURCHASE_AMOUNT / 2;
        (uint256 preview,,,) = marketplace.previewPrimaryRedemption(scenario.revenueTokenId, buyer, burnAmount);
        assertGt(preview, 0);

        CollateralLib.CollateralInfo memory beforeInfo = _getCollateralInfo(scenario.assetId);
        uint256 supplyBefore = manager.getCurrentPrimaryRedemptionEpochSupply(scenario.revenueTokenId);
        uint256 principalBefore = manager.getCurrentPrimaryRedemptionBackedPrincipal(scenario.revenueTokenId);
        uint256 eligibleBefore = manager.getPrimaryRedemptionEligibleBalance(buyer, scenario.revenueTokenId);
        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);
        uint256 buyerTokensBefore = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);

        vm.prank(address(marketplace));
        uint256 payout = treasury.processPrimaryRedemptionFor(buyer, scenario.revenueTokenId, burnAmount, preview);

        CollateralLib.CollateralInfo memory afterInfo = _getCollateralInfo(scenario.assetId);
        assertEq(payout, preview);
        assertEq(usdc.balanceOf(buyer), buyerUsdcBefore + payout);
        assertEq(roboshareTokens.balanceOf(buyer, scenario.revenueTokenId), buyerTokensBefore - burnAmount);
        assertEq(manager.getCurrentPrimaryRedemptionEpochSupply(scenario.revenueTokenId), supplyBefore - burnAmount);
        assertEq(manager.getCurrentPrimaryRedemptionBackedPrincipal(scenario.revenueTokenId), principalBefore - payout);
        assertEq(
            manager.getPrimaryRedemptionEligibleBalance(buyer, scenario.revenueTokenId), eligibleBefore - burnAmount
        );
        assertEq(
            afterInfo.unredeemedBasePrincipal,
            beforeInfo.unredeemedBasePrincipal - (burnAmount * roboshareTokens.getTokenPrice(scenario.revenueTokenId))
        );
    }

    function testProcessPrimaryRedemptionForConsumesManagerStateAfterFullPayout() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        IPositionManager manager = roboshareTokens.positionManager();
        uint256 burnAmount = PRIMARY_PURCHASE_AMOUNT;
        (uint256 preview,,,) = marketplace.previewPrimaryRedemption(scenario.revenueTokenId, buyer, burnAmount);
        uint256 epochBefore = manager.getCurrentPrimaryRedemptionEpoch(scenario.revenueTokenId);

        vm.prank(address(marketplace));
        uint256 payout = treasury.processPrimaryRedemptionFor(buyer, scenario.revenueTokenId, burnAmount, preview);

        assertEq(payout, preview);
        assertEq(manager.getPrimaryRedemptionEligibleBalance(buyer, scenario.revenueTokenId), 0);
        assertEq(manager.getCurrentPrimaryRedemptionEpochSupply(scenario.revenueTokenId), 0);
        assertEq(manager.getCurrentPrimaryRedemptionBackedPrincipal(scenario.revenueTokenId), 0);
        assertEq(manager.getCurrentPrimaryRedemptionEpoch(scenario.revenueTokenId), epochBefore + 1);
    }

    function testProcessPrimaryRedemptionForMultipleBurnsPreservesSnapshottedEarnings() public {
        _ensureState(SetupState.EarningsDistributed);

        uint256 initialEarningsPreview = earningsManager.previewClaimEarnings(scenario.assetId, buyer);
        assertGt(initialEarningsPreview, 0);

        uint256 firstBurnAmount = PRIMARY_PURCHASE_AMOUNT / 3;
        (uint256 firstPayoutPreview,,,) =
            marketplace.previewPrimaryRedemption(scenario.revenueTokenId, buyer, firstBurnAmount);
        vm.prank(address(marketplace));
        treasury.processPrimaryRedemptionFor(buyer, scenario.revenueTokenId, firstBurnAmount, firstPayoutPreview);

        uint256 secondBurnAmount = PRIMARY_PURCHASE_AMOUNT / 3;
        (uint256 secondPayoutPreview,,,) =
            marketplace.previewPrimaryRedemption(scenario.revenueTokenId, buyer, secondBurnAmount);
        vm.prank(address(marketplace));
        treasury.processPrimaryRedemptionFor(buyer, scenario.revenueTokenId, secondBurnAmount, secondPayoutPreview);

        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        vm.prank(buyer);
        router.claimSettlement(scenario.assetId, false);

        uint256 settledEarningsPreview = earningsManager.previewClaimEarnings(scenario.assetId, buyer);
        assertEq(settledEarningsPreview, initialEarningsPreview);

        uint256 pendingBefore = treasury.pendingWithdrawals(buyer);
        vm.prank(buyer);
        earningsManager.claimEarnings(scenario.assetId);
        uint256 pendingAfter = treasury.pendingWithdrawals(buyer);
        assertEq(pendingAfter - pendingBefore, initialEarningsPreview);
    }

    function testProcessPrimaryRedemptionRebasesReleasedCollateralForFutureUnlocks() public {
        _ensureState(SetupState.BuffersFunded);

        CollateralLib.CollateralInfo memory infoInitial = _getCollateralInfo(scenario.assetId);
        assertTrue(infoInitial.isLocked);

        vm.warp(infoInitial.lockedAt + 182 days);
        _setupEarningsDistributed(LARGE_EARNINGS_AMOUNT);

        vm.prank(partner1);
        treasury.releasePartialCollateral(scenario.assetId);

        CollateralLib.CollateralInfo memory infoAfterFirstRelease = _getCollateralInfo(scenario.assetId);
        assertGt(infoAfterFirstRelease.releasedBaseCollateral, 0);

        uint256 burnAmount = PRIMARY_PURCHASE_AMOUNT / 2;
        (uint256 redemptionPreview,,,) =
            marketplace.previewPrimaryRedemption(scenario.revenueTokenId, buyer, burnAmount);
        assertGt(redemptionPreview, 0);

        vm.prank(address(marketplace));
        treasury.processPrimaryRedemptionFor(buyer, scenario.revenueTokenId, burnAmount, redemptionPreview);

        CollateralLib.CollateralInfo memory infoAfterRedemption = _getCollateralInfo(scenario.assetId);
        uint256 expectedReleasedBaseCollateral = infoAfterRedemption.unredeemedBasePrincipal
            > infoAfterRedemption.baseCollateral + infoAfterRedemption.releasedProtectedBase
            ? infoAfterRedemption.unredeemedBasePrincipal - infoAfterRedemption.baseCollateral
                - infoAfterRedemption.releasedProtectedBase
            : 0;

        assertEq(
            infoAfterRedemption.releasedBaseCollateral,
            expectedReleasedBaseCollateral,
            "Released base collateral should be rebased to the remaining outstanding principal"
        );

        vm.warp(infoInitial.lockedAt + 365 days);
        _setupEarningsDistributed(LARGE_EARNINGS_AMOUNT);

        uint256 expectedGrossRelease = CollateralLib.calculateDepreciation(
            infoAfterRedemption.unredeemedBasePrincipal, block.timestamp - infoInitial.lockedAt
        );
        expectedGrossRelease = expectedGrossRelease > expectedReleasedBaseCollateral
            ? expectedGrossRelease - expectedReleasedBaseCollateral
            : 0;
        if (expectedGrossRelease > infoAfterRedemption.baseCollateral) {
            expectedGrossRelease = infoAfterRedemption.baseCollateral;
        }

        uint256 expectedProtocolFee = ProtocolLib.calculateProtocolFee(expectedGrossRelease);
        if (expectedProtocolFee > expectedGrossRelease) {
            expectedProtocolFee = expectedGrossRelease;
        }
        uint256 expectedPartnerRelease = expectedGrossRelease - expectedProtocolFee;

        assertEq(
            treasury.previewCollateralRelease(scenario.assetId, 0),
            expectedPartnerRelease,
            "Future release preview should stay anchored to the remaining tranche after redemption"
        );
    }

    function testPreviewPrimaryRedemptionPayout() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        (uint256 zeroPreview,,,) = marketplace.previewPrimaryRedemption(scenario.revenueTokenId, buyer, 0);
        assertEq(zeroPreview, 0);

        (uint256 payout,,,) = marketplace.previewPrimaryRedemption(scenario.revenueTokenId, buyer, 1);
        assertGt(payout, 0);
    }

    function testPreviewPrimaryRedemptionPayoutZeroCurrentEpochSupply() public {
        _ensureState(SetupState.InitialAccountsSetup);

        vm.prank(partner1);
        scenario.assetId = assetRegistry.registerAsset(_vehicleRegistrationData(TEST_VIN), ASSET_VALUE);

        uint256 supply = ASSET_VALUE / REVENUE_TOKEN_PRICE;
        vm.prank(partner1);
        (scenario.revenueTokenId,) = assetRegistry.createRevenueTokenPool(
            scenario.assetId, REVENUE_TOKEN_PRICE, block.timestamp + 365 days, 10_000, 1_000, supply, true, false
        );

        uint256 grossPrincipal = PRIMARY_PURCHASE_AMOUNT * REVENUE_TOKEN_PRICE;
        uint256 totalPayment = grossPrincipal + ProtocolLib.calculateProtocolFee(grossPrincipal);
        vm.startPrank(buyer);
        usdc.approve(address(marketplace), totalPayment);
        marketplace.buyFromPrimaryPool(scenario.revenueTokenId, PRIMARY_PURCHASE_AMOUNT);
        vm.stopPrank();

        uint256 yieldBP = roboshareTokens.getTargetYieldBP(scenario.revenueTokenId);
        uint256 requiredCollateral = _getTotalBufferRequirement(grossPrincipal, yieldBP, false);
        vm.prank(partner1);
        usdc.approve(address(treasury), requiredCollateral);
        vm.prank(partner1);
        treasury.enableProceeds(scenario.assetId);

        (uint256 payout,,,) = marketplace.previewPrimaryRedemption(scenario.revenueTokenId, buyer, 1);
        assertEq(payout, 0);
    }

    function testProcessPrimaryRedemptionForAssetNotFound() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        vm.prank(address(marketplace));
        vm.expectRevert(ITreasury.AssetNotFound.selector);
        treasury.processPrimaryRedemptionFor(buyer, 1000, 1, 0);
    }

    function testProcessPrimaryRedemptionForAssetNotOperational() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        vm.prank(address(router));
        assetRegistry.setAssetStatus(scenario.assetId, AssetLib.AssetStatus.Suspended);
        vm.prank(address(marketplace));
        vm.expectRevert(
            abi.encodeWithSelector(
                ITreasury.AssetNotOperational.selector, scenario.assetId, AssetLib.AssetStatus.Suspended
            )
        );
        treasury.processPrimaryRedemptionFor(buyer, scenario.revenueTokenId, 1, 0);
    }

    function testProcessPrimaryRedemptionForInsufficientPrimaryLiquidityZeroAmount() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        vm.prank(address(marketplace));
        vm.expectRevert(ITreasury.InsufficientPrimaryLiquidity.selector);
        treasury.processPrimaryRedemptionFor(buyer, scenario.revenueTokenId, 0, 0);
    }

    function testProcessPrimaryRedemptionForInsufficientTokenBalance() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        vm.prank(address(marketplace));
        vm.expectRevert(ITreasury.InsufficientTokenBalance.selector);
        treasury.processPrimaryRedemptionFor(unauthorized, scenario.revenueTokenId, 1, 0);
    }

    function testProcessPrimaryRedemptionForSlippageExceeded() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        uint256 burnAmount = PRIMARY_PURCHASE_AMOUNT / 2;
        (uint256 preview,,,) = marketplace.previewPrimaryRedemption(scenario.revenueTokenId, buyer, burnAmount);

        vm.prank(address(marketplace));
        vm.expectRevert(ITreasury.SlippageExceeded.selector);
        treasury.processPrimaryRedemptionFor(buyer, scenario.revenueTokenId, burnAmount, preview + 1);
    }

    function testProcessPrimaryRedemptionForNoRedeemablePrimarySupplyWithoutEligibleTranche() public {
        _ensureState(SetupState.InitialAccountsSetup);

        vm.prank(partner1);
        scenario.assetId = assetRegistry.registerAsset(_vehicleRegistrationData(TEST_VIN), ASSET_VALUE);

        uint256 supply = ASSET_VALUE / REVENUE_TOKEN_PRICE;
        vm.prank(partner1);
        (scenario.revenueTokenId,) = assetRegistry.createRevenueTokenPool(
            scenario.assetId, REVENUE_TOKEN_PRICE, block.timestamp + 365 days, 10_000, 1_000, supply, true, false
        );

        vm.prank(address(router));
        assetRegistry.setAssetStatus(scenario.assetId, AssetLib.AssetStatus.Active);

        uint256 grossPrincipal = PRIMARY_PURCHASE_AMOUNT * REVENUE_TOKEN_PRICE;
        uint256 totalPayment = grossPrincipal + ProtocolLib.calculateProtocolFee(grossPrincipal);
        vm.startPrank(buyer);
        usdc.approve(address(marketplace), totalPayment);
        marketplace.buyFromPrimaryPool(scenario.revenueTokenId, PRIMARY_PURCHASE_AMOUNT);
        vm.stopPrank();

        uint256 baseAmount = _getCollateralInfo(scenario.assetId).baseCollateral;
        uint256 yieldBP = roboshareTokens.getTargetYieldBP(scenario.revenueTokenId);
        uint256 requiredCollateral = _getTotalBufferRequirement(baseAmount, yieldBP, false);

        vm.prank(partner1);
        usdc.approve(address(treasury), requiredCollateral);
        vm.prank(partner1);
        treasury.enableProceeds(scenario.assetId);

        vm.prank(address(marketplace));
        vm.expectRevert(ITreasury.NoRedeemablePrimarySupply.selector);
        treasury.processPrimaryRedemptionFor(buyer, scenario.revenueTokenId, 1, 0);
    }

    // Collateral Releasing Tests

    function testReleaseCollateral() public {
        _ensureState(SetupState.BuffersFunded);

        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(scenario.assetId);
        _grantBurnerRoleToSelf();
        _burnRevenueTokenBalance(revenueTokenId, buyer);
        _burnRevenueTokenBalance(revenueTokenId, partner1);

        // Partner calls releaseCollateral
        uint256 pendingBefore = treasury.pendingWithdrawals(partner1);
        vm.prank(partner1);
        treasury.releaseCollateral(scenario.assetId);
        uint256 pendingAfter = treasury.pendingWithdrawals(partner1);

        assertFalse(_getCollateralInfo(scenario.assetId).isLocked);
        assertGt(pendingAfter, pendingBefore);
    }

    function testReleaseCollateralFor() public {
        _ensureState(SetupState.BuffersFunded);

        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(scenario.assetId);
        _grantBurnerRoleToSelf();
        _burnRevenueTokenBalance(revenueTokenId, buyer);
        _burnRevenueTokenBalance(revenueTokenId, partner1);

        uint256 pendingBefore = treasury.pendingWithdrawals(partner1);
        vm.prank(address(router));
        treasury.releaseCollateralFor(partner1, scenario.assetId);
        uint256 pendingAfter = treasury.pendingWithdrawals(partner1);

        assertFalse(_getCollateralInfo(scenario.assetId).isLocked);
        assertGt(pendingAfter, pendingBefore);
    }

    function testReleaseCollateralNotLocked() public {
        _ensureState(SetupState.AssetRegistered);
        vm.expectRevert(ITreasury.NoCollateralLocked.selector);
        vm.prank(partner1);
        treasury.releaseCollateral(scenario.assetId);
        vm.stopPrank();
    }

    function testReleasePartialCollateralNotLocked() public {
        _ensureState(SetupState.AssetRegistered);
        vm.expectRevert(ITreasury.NoCollateralLocked.selector);
        vm.prank(partner1);
        treasury.releasePartialCollateral(scenario.assetId);
        vm.stopPrank();
    }

    function testReleasePartialCollateralNoEarningsPeriod() public {
        _ensureState(SetupState.BuffersFunded);

        vm.prank(partner1);
        vm.expectRevert(ITreasury.NoPriorEarningsDistribution.selector);
        treasury.releasePartialCollateral(scenario.assetId);
    }

    function testPreviewCollateralReleaseNoEarnings() public {
        _ensureState(SetupState.BuffersFunded);

        uint256 preview = treasury.previewCollateralRelease(scenario.assetId, 0);
        assertEq(preview, 0, "Preview should be zero without earnings");
    }

    function testPreviewCollateralReleaseMatchesReleasePartial() public {
        _ensureState(SetupState.BuffersFunded);
        _setupEarningsDistributed(LARGE_EARNINGS_AMOUNT);

        vm.warp(block.timestamp + ProtocolLib.YEARLY_INTERVAL);

        uint256 preview = treasury.previewCollateralRelease(scenario.assetId, 0);
        uint256 beforeRelease = treasury.pendingWithdrawals(partner1);

        vm.prank(partner1);
        treasury.releasePartialCollateral(scenario.assetId);

        uint256 afterRelease = treasury.pendingWithdrawals(partner1);
        assertEq(afterRelease - beforeRelease, preview, "Preview should match actual release");
        assertGt(preview, 0, "Preview should be greater than zero");
    }

    function testReleasePartialCollateralNoNewPeriods() public {
        _ensureState(SetupState.EarningsDistributed);

        vm.warp(block.timestamp + 1 days);

        vm.prank(partner1);
        treasury.releasePartialCollateral(scenario.assetId);
    }

    function testReleaseCollateralAssetNotFound() public {
        vm.expectRevert(ITreasury.AssetNotFound.selector);
        vm.prank(partner1);
        treasury.releaseCollateral(999);
        vm.stopPrank();
    }

    function testReleaseCollateralNotAssetOwner() public {
        _ensureState(SetupState.BuffersFunded);

        vm.expectRevert(ITreasury.NotAssetOwner.selector);
        vm.prank(partner2);
        treasury.releaseCollateral(scenario.assetId);
    }

    // Withdrawal Tests

    function testProcessWithdrawal() public {
        _ensureState(SetupState.BuffersFunded);

        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(scenario.assetId);
        _grantBurnerRoleToSelf();
        _burnRevenueTokenBalance(revenueTokenId, buyer);
        _burnRevenueTokenBalance(revenueTokenId, partner1);

        vm.prank(address(router));
        treasury.releaseCollateralFor(partner1, scenario.assetId);

        uint256 initialBalance = usdc.balanceOf(partner1);
        uint256 pending = treasury.pendingWithdrawals(partner1);

        vm.prank(partner1);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit ITreasury.WithdrawalProcessed(partner1, pending);
        treasury.processWithdrawal();

        assertEq(usdc.balanceOf(partner1), initialBalance + pending);
        assertEq(treasury.pendingWithdrawals(partner1), 0);
    }

    function testProcessWithdrawalNoPendingWithdrawals() public {
        vm.expectRevert(ITreasury.NoPendingWithdrawals.selector);
        vm.prank(partner1);
        treasury.processWithdrawal();
    }

    // Access Control

    function testReleaseCollateralUnauthorizedPartner() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        vm.expectRevert(PartnerManager.UnauthorizedPartner.selector);
        vm.prank(unauthorized);
        treasury.releaseCollateral(scenario.assetId);
    }

    // View Functions

    function testGetTreasuryStats() public {
        _ensureState(SetupState.AssetRegistered);
        (uint256 deposited0, uint256 balance0) =
            (treasury.totalCollateralDeposited(), usdc.balanceOf(address(treasury)));
        assertEq(deposited0, 0);
        assertEq(balance0, 0);

        _ensureState(SetupState.PrimaryPoolCreated);
        (uint256 deposited1, uint256 balance1) =
            (treasury.totalCollateralDeposited(), usdc.balanceOf(address(treasury)));
        assertEq(deposited1, 0);
        assertEq(balance1, 0);
    }

    function testGetAssetCollateralInfoUninitialized() public view {
        CollateralLib.CollateralInfo memory info = _getCollateralInfo(scenario.assetId);
        assertEq(info.baseCollateral, 0);
        assertEq(_getCollateralTotal(info), 0);
        assertEq(info.isLocked, false);
    }

    // Complex Scenarios

    function testMultipleAssetCollateralLocking() public {
        _ensureState(SetupState.PrimaryPoolCreated); // First vehicle for partner1
        uint256 vehicleId1 = scenario.assetId;
        uint256 yieldBP1 = roboshareTokens.getTargetYieldBP(scenario.revenueTokenId);
        _purchasePrimaryForBaseAmount(buyer, scenario.revenueTokenId, ASSET_VALUE);
        uint256 requiredCollateral1 = _getTotalBufferRequirement(ASSET_VALUE, yieldBP1, false);
        vm.prank(partner1);
        usdc.approve(address(treasury), requiredCollateral1);
        vm.prank(partner1);
        treasury.enableProceeds(vehicleId1);

        string memory vin = _generateVin(1);
        (uint256 vehicleId2, uint256 revenueTokenId2,) = _setupAdditionalAssetAndPrimaryPool(partner1, vin);

        uint256 yieldBP2 = roboshareTokens.getTargetYieldBP(revenueTokenId2);
        _purchasePrimaryForBaseAmount(buyer, revenueTokenId2, ASSET_VALUE);
        uint256 requiredCollateral2 = _getTotalBufferRequirement(ASSET_VALUE, yieldBP2, false);
        vm.prank(partner1);
        usdc.approve(address(treasury), requiredCollateral2);
        vm.prank(partner1);
        treasury.enableProceeds(vehicleId2);

        assertEq(
            treasury.totalCollateralDeposited(), ASSET_VALUE + requiredCollateral1 + ASSET_VALUE + requiredCollateral2
        );
        _assertCollateralState(vehicleId1, ASSET_VALUE, ASSET_VALUE + requiredCollateral1, true);
        _assertCollateralState(vehicleId2, ASSET_VALUE, ASSET_VALUE + requiredCollateral2, true);
    }

    function testCompleteCollateralLifecycle() public {
        _ensureState(SetupState.BuffersFunded);

        // 1. Lock Collateral (already done in setup)
        assertTrue(_getCollateralInfo(scenario.assetId).isLocked);

        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(scenario.assetId);
        _grantBurnerRoleToSelf();
        _burnRevenueTokenBalance(revenueTokenId, buyer);
        _burnRevenueTokenBalance(revenueTokenId, partner1);

        // 3. Unlock Collateral
        vm.prank(address(router));
        treasury.releaseCollateralFor(partner1, scenario.assetId);

        assertFalse(_getCollateralInfo(scenario.assetId).isLocked);

        // 4. Process Withdrawal
        uint256 initialBalance = usdc.balanceOf(partner1);
        uint256 pending = treasury.pendingWithdrawals(partner1);
        assertGt(pending, 0);

        vm.prank(partner1);
        treasury.processWithdrawal();

        assertEq(usdc.balanceOf(partner1), initialBalance + pending);
        assertEq(treasury.pendingWithdrawals(partner1), 0);
    }

    // Earnings

    function testPreviewSettlementClaimAssetNotFound() public {
        _ensureState(SetupState.EarningsDistributed);
        uint256 nonExistentAssetId = 999;

        vm.expectRevert(ITreasury.AssetNotFound.selector);
        treasury.previewSettlementClaim(nonExistentAssetId, buyer);
    }

    function testPreviewSettlementClaimNotSettledReturnsZero() public {
        _ensureState(SetupState.EarningsDistributed);
        assertEq(treasury.previewSettlementClaim(scenario.assetId, buyer), 0, "Not settled should preview zero");
    }

    function testPreviewSettlementClaimSettledMatchesClaim() public {
        _ensureState(SetupState.EarningsDistributed);

        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        IPositionManager positionManager = _positionManager();
        IPositionManager.SettlementState memory settlementState = positionManager.getSettlementState(scenario.assetId);
        assertTrue(settlementState.isConfigured, "PositionManager settlement should be configured");

        uint256 buyerBalance = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        uint256 previewAmount = treasury.previewSettlementClaim(scenario.assetId, buyer);
        assertGt(previewAmount, 0, "Settled preview should be positive");
        assertEq(
            previewAmount,
            positionManager.previewSettlementClaim(scenario.assetId, buyerBalance),
            "Treasury preview should use PositionManager settlement rate"
        );

        vm.prank(buyer);
        (uint256 settlementClaimed,) = router.claimSettlement(scenario.assetId, false);

        assertEq(settlementClaimed, previewAmount, "Preview should match settlement claimed");
        settlementState = positionManager.getSettlementState(scenario.assetId);
        assertEq(settlementState.claimedBurnAmount, buyerBalance, "Settlement aggregate should track burned amount");
        assertEq(settlementState.claimedPayout, settlementClaimed, "Settlement aggregate should track claimed payout");
        IPositionManager.SettlementClaimState memory claimState =
            positionManager.getSettlementClaimState(scenario.assetId, buyer);
        assertEq(claimState.burnedAmount, buyerBalance, "PositionManager should track claimed burn amount");
        assertEq(claimState.payout, settlementClaimed, "PositionManager should track claimed payout");
        assertEq(treasury.previewSettlementClaim(scenario.assetId, buyer), 0, "Preview should be zero after claim");
    }

    function testReleasePartialCollateral() public {
        _ensureState(SetupState.EarningsDistributed);
        vm.warp(block.timestamp + 30 days);

        uint256 pendingBefore = treasury.pendingWithdrawals(partner1);

        vm.startPrank(partner1);
        vm.expectEmit(true, true, false, false, address(treasury));
        emit ITreasury.CollateralReleased(scenario.assetId, partner1, 0); // Amount check via assert below
        treasury.releasePartialCollateral(scenario.assetId);
        vm.stopPrank();

        assertGt(treasury.pendingWithdrawals(partner1), pendingBefore, "Collateral should be released");
    }

    function testReleasePartialCollateralNoEarnings() public {
        _ensureState(SetupState.BuffersFunded);
        vm.warp(block.timestamp + 16 days);
        vm.expectRevert(ITreasury.NoPriorEarningsDistribution.selector);
        vm.prank(partner1);
        treasury.releasePartialCollateral(scenario.assetId);
    }

    function testReleasePartialCollateralNotOwner() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        // partner2 is authorized but does not own scenario.assetId
        vm.prank(partner2);
        vm.expectRevert(ITreasury.NotAssetOwner.selector);
        treasury.releasePartialCollateral(scenario.assetId);
    }

    function testReleasePartialCollateralUnauthorizedPartner() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        vm.prank(unauthorized);
        vm.expectRevert(PartnerManager.UnauthorizedPartner.selector);
        treasury.releasePartialCollateral(scenario.assetId);
    }

    function testReleaseCollateralForUnauthorizedCaller() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                unauthorized,
                treasury.AUTHORIZED_ROUTER_ROLE()
            )
        );
        vm.prank(unauthorized);
        treasury.releaseCollateralFor(partner1, scenario.assetId);
    }

    function testTreasuryFeeRecipientWithdrawal() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        // Capture initial fee balance BEFORE distributing (includes fees from purchase)
        uint256 initialFeeBalance = treasury.pendingWithdrawals(config.treasuryFeeRecipient);

        _ensureState(SetupState.EarningsDistributed);
        uint256 totalAmount = EARNINGS_AMOUNT;

        // Calculate investor portion (10% with 100/1000 tokens)
        uint256 investorAmount = _calculateInvestorAmountFromRevenue(scenario.revenueTokenId, partner1, totalAmount);

        // Fee is calculated on investor portion, not total amount
        uint256 expectedFee = ProtocolLib.calculateProtocolFee(investorAmount);
        uint256 newFeeBalance = treasury.pendingWithdrawals(config.treasuryFeeRecipient);
        assertEq(newFeeBalance - initialFeeBalance, expectedFee, "Fee delta should match investor portion fee");

        // Fee recipient withdraws ALL pending fees (including prior ones)
        uint256 beforeWithdrawal = usdc.balanceOf(config.treasuryFeeRecipient);
        vm.prank(config.treasuryFeeRecipient);
        treasury.processWithdrawal();
        uint256 afterWithdrawal = usdc.balanceOf(config.treasuryFeeRecipient);
        assertEq(afterWithdrawal, beforeWithdrawal + newFeeBalance);
        assertEq(treasury.pendingWithdrawals(config.treasuryFeeRecipient), 0);
    }

    function testReleasePartialCollateralPerfectBuffersMatch() public {
        _ensureState(SetupState.BuffersFunded);

        // Use a realistic interval to avoid overflow while targeting the equality path
        uint256 dt = 30 days;
        CollateralLib.CollateralInfo memory info = _getCollateralInfo(scenario.assetId);
        assertTrue(info.isLocked);
        vm.warp(info.lockedAt + dt);

        // Compute target net = base * BENCHMARK_YIELD_BP * dt / (BP_PRECISION * YEARLY_INTERVAL)
        uint256 baseCollateral = info.baseCollateral;
        uint256 targetNet = (baseCollateral * ProtocolLib.BENCHMARK_YIELD_BP * dt)
            / (ProtocolLib.BP_PRECISION * ProtocolLib.YEARLY_INTERVAL);

        // Compute gross so that net ~= targetNet (ceil to be safe): gross = ceil(targetNet * BP_PRECISION / (BP_PRECISION - PROTOCOL_FEE_BP))
        uint256 netMultiplier = ProtocolLib.BP_PRECISION - ProtocolLib.PROTOCOL_FEE_BP;
        uint256 gross = (targetNet * ProtocolLib.BP_PRECISION + (netMultiplier - 1)) / netMultiplier;

        _setupEarningsDistributed(gross);

        uint256 pendingBefore = treasury.pendingWithdrawals(partner1);

        // Release; with near-perfect match no shortfall/excess branches should trigger
        vm.prank(partner1);
        vm.expectEmit(true, true, false, false, address(treasury));
        emit ITreasury.CollateralReleased(scenario.assetId, partner1, 0);
        treasury.releasePartialCollateral(scenario.assetId);

        uint256 pendingAfter = treasury.pendingWithdrawals(partner1);
        assertGt(pendingAfter, pendingBefore, "Collateral should be released");
    }

    function testLinearReleaseOneYear() public {
        _ensureState(SetupState.EarningsDistributed);

        // Read initial lockedAt and base
        CollateralLib.CollateralInfo memory infoBefore = _getCollateralInfo(scenario.assetId);
        assertTrue(infoBefore.isLocked);

        // Warp one year from lock and release
        vm.warp(infoBefore.lockedAt + 365 days);

        // Distribute earnings to meet benchmark and keep buffer healthy
        _setupEarningsDistributed(LARGE_EARNINGS_AMOUNT);

        uint256 pendingBefore = treasury.pendingWithdrawals(partner1);
        vm.prank(partner1);
        treasury.releasePartialCollateral(scenario.assetId);

        CollateralLib.CollateralInfo memory infoAfter = _getCollateralInfo(scenario.assetId);

        // Expected linear release = 12% of initial base
        uint256 expectedRelease = (infoBefore.baseCollateral * 1200) / 10000;
        assertEq(
            infoAfter.baseCollateral,
            infoBefore.baseCollateral - expectedRelease,
            "Linear one-year base release mismatch"
        );

        // Pending increased by net release (after protocol fee); total decreased equally (buffers unchanged)
        uint256 pendingAfter = treasury.pendingWithdrawals(partner1);
        uint256 expectedFee = ProtocolLib.calculateProtocolFee(expectedRelease);
        uint256 expectedNet = expectedRelease - expectedFee;
        assertEq(pendingAfter - pendingBefore, expectedNet, "Pending increase mismatch");
    }

    function testLinearReleaseCumulativeEighteenMonths() public {
        _ensureState(SetupState.EarningsDistributed);

        // Read initial lockedAt and base
        CollateralLib.CollateralInfo memory infoInitial = _getCollateralInfo(scenario.assetId);
        assertTrue(infoInitial.isLocked);

        // First release: 12 months (12% expected)
        vm.warp(infoInitial.lockedAt + 365 days);

        // Distribute earnings to meet benchmark
        _setupEarningsDistributed(LARGE_EARNINGS_AMOUNT);

        vm.prank(partner1);
        treasury.releasePartialCollateral(scenario.assetId);

        // Second release: another 6 months (18 months total, 18% cumulative expected)
        vm.warp(infoInitial.lockedAt + 365 days + 182 days);

        // Distribute earnings again to meet benchmark
        _setupEarningsDistributed(LARGE_EARNINGS_AMOUNT);

        vm.prank(partner1);
        treasury.releasePartialCollateral(scenario.assetId);

        CollateralLib.CollateralInfo memory infoFinal = _getCollateralInfo(scenario.assetId);

        // Expected cumulative linear release based on total elapsed days (365 + 182)
        uint256 dt = 365 days + 182 days;
        uint256 expectedCumulative = (infoInitial.baseCollateral * ProtocolLib.DEPRECIATION_RATE_BP * dt)
            / (ProtocolLib.BP_PRECISION * ProtocolLib.YEARLY_INTERVAL);
        assertEq(
            infoFinal.baseCollateral,
            infoInitial.baseCollateral - expectedCumulative,
            "Linear 18-month cumulative base release mismatch"
        );
    }

    // Releasing without new earnings periods should revert (performance gate)
    function testReleasePartialCollateralNoNewEarningsPeriods() public {
        _ensureState(SetupState.EarningsDistributed);

        // Warp relative to the original lock timestamp before first release
        CollateralLib.CollateralInfo memory info = _getCollateralInfo(scenario.assetId);
        vm.warp(info.lockedAt + ProtocolLib.MIN_EVENT_INTERVAL + 1);
        vm.prank(partner1);
        treasury.releasePartialCollateral(scenario.assetId); // updates lastEventTimestamp

        // Capture the timestamp used by the prior release and warp from it
        uint256 tsAfterFirstRelease = block.timestamp;
        vm.warp(tsAfterFirstRelease + ProtocolLib.MIN_EVENT_INTERVAL + 1);
        vm.expectRevert(ITreasury.NoNewEarningsPeriods.selector);
        vm.prank(partner1);
        treasury.releasePartialCollateral(scenario.assetId);
    }

    // Shortfall then replenishment flow emitting events
    function testReleasePartialCollateralShortfallThenReplenishment() public {
        (uint256 assetId,) = _setupProtectedPoolWithPurchaseAndBuffers();

        CollateralLib.CollateralInfo memory info = _getCollateralInfo(assetId);
        assertTrue(info.isLocked);

        // 1. Warp 3 years BEFORE distributing to ensure a massive shortfall
        // Benchmark for 3 years (30% of investor value = 3k) exceeds initial buffer (~2.5k)
        vm.warp(info.lockedAt + (3 * 365 days));

        // 2. Distribute minimal earnings (near-zero performance)
        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), SMALL_EARNINGS_AMOUNT);
        earningsManager.distributeEarnings(assetId, SMALL_EARNINGS_AMOUNT, false);
        vm.stopPrank();

        // 3. Process the pending Period 1 shortfall
        // This will drain the buffer.
        vm.prank(partner1);
        treasury.releasePartialCollateral(assetId);

        // Verify buffer is drained
        CollateralLib.CollateralInfo memory infoAfterShortfall = _getCollateralInfo(assetId);
        assertEq(infoAfterShortfall.earningsBuffer, 0, "Buffer should be drained to zero");
        assertGt(infoAfterShortfall.reservedForLiquidation, 0, "Should have funds reserved for liquidation");

        // 4. Release; should still succeed but release nothing
        uint256 pendingBefore = treasury.pendingWithdrawals(partner1);
        vm.warp(block.timestamp + 30 days);
        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), SMALL_EARNINGS_AMOUNT);
        earningsManager.distributeEarnings(assetId, SMALL_EARNINGS_AMOUNT, false); // Record Period 2 shortfall
        vm.stopPrank();
        vm.prank(partner1);
        treasury.releasePartialCollateral(assetId);
        uint256 pendingAfter = treasury.pendingWithdrawals(partner1);
        CollateralLib.CollateralInfo memory infoDuringShortfall = _getCollateralInfo(assetId);
        assertGe(pendingAfter, pendingBefore, "Shortfall processing should not reduce partner withdrawals");
        assertGt(
            infoDuringShortfall.reservedForLiquidation, 0, "Shortfall should continue reserving funds for liquidation"
        );

        // 5. Now add excess earnings and process to replenish buffers
        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), LARGE_EARNINGS_AMOUNT);
        earningsManager.distributeEarnings(assetId, LARGE_EARNINGS_AMOUNT, false);
        vm.stopPrank();

        // 6. Advance time more and release again (replenishment should have occurred)
        vm.warp(block.timestamp + 120 days);
        vm.prank(partner1);
        treasury.releasePartialCollateral(assetId);
        assertGt(treasury.pendingWithdrawals(partner1), pendingAfter, "Collateral should release after replenishment");
    }

    function testReleasePartialCollateralDepleted() public {
        (uint256 assetId, uint256 revenueTokenId) = _setupProtectedPoolWithPurchaseAndBuffers();

        CollateralLib.CollateralInfo memory info = _getCollateralInfo(assetId);
        assertTrue(info.isLocked);
        uint256 earningsBuffer = info.earningsBuffer;
        uint256 protocolBuffer = info.protocolBuffer;
        uint256 investorTokens = _getInvestorSupply(revenueTokenId, partner1);
        uint256 maxSupply = roboshareTokens.getRevenueTokenMaxSupply(revenueTokenId);

        // Repeatedly release collateral over 10 years until it's fully depleted (12% per year, ~8.33 years to deplete)
        uint256 timeToWarp = info.lockedAt;
        for (uint256 i = 0; i < 9; i++) {
            timeToWarp += 365 days;
            vm.warp(timeToWarp);

            // Ensure investor portion meets benchmark to keep buffers full.
            uint256 benchmark = EarningsLib.calculateEarnings(
                info.unredeemedBasePrincipal, 365 days, roboshareTokens.getTargetYieldBP(revenueTokenId)
            );
            uint256 topUp = (benchmark * maxSupply) / investorTokens;
            vm.startPrank(partner1);
            usdc.approve(address(earningsManager), topUp);
            earningsManager.distributeEarnings(assetId, topUp, false);
            vm.stopPrank();

            vm.prank(partner1);
            treasury.releasePartialCollateral(assetId);
        }

        // Verify base collateral is depleted, but buffers remain
        CollateralLib.CollateralInfo memory infoAfter = _getCollateralInfo(assetId);
        assertEq(infoAfter.baseCollateral, 0, "Base collateral should be zero after 9 years");
        assertEq(
            _getCollateralTotal(infoAfter),
            infoAfter.earningsBuffer + infoAfter.protocolBuffer,
            "Only funded buffers should remain once base collateral is fully depleted"
        );
        assertGt(_getCollateralTotal(infoAfter), 0, "Buffer collateral should remain after base depletion");
        assertLe(infoAfter.earningsBuffer, earningsBuffer, "Earnings buffer should not grow beyond funded level");
        assertLe(infoAfter.protocolBuffer, protocolBuffer, "Protocol buffer should not grow beyond funded level");

        // Attempt one final release in the 10th year
        // distribute enough to satisfy safety gate
        uint256 finalInvestorAmount = (1000 * 1e6 * maxSupply) / investorTokens;
        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), finalInvestorAmount);
        earningsManager.distributeEarnings(assetId, finalInvestorAmount, false);
        vm.stopPrank();

        vm.warp(block.timestamp + 365 days);

        // Should succeed with 0 release
        vm.prank(partner1);
        treasury.releasePartialCollateral(assetId);
    }

    // Settlement Tests

    function testInitiateSettlementTopUp() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        uint256 topUpAmount = SETTLEMENT_TOP_UP_AMOUNT;

        // Partner approves top-up
        vm.prank(partner1);
        usdc.approve(address(treasury), topUpAmount);

        CollateralLib.CollateralInfo memory info = _getCollateralInfo(scenario.assetId);
        uint256 totalSupply = roboshareTokens.getRevenueTokenSupply(scenario.revenueTokenId);
        uint256 expectedSettlementAmount = info.baseCollateral + info.reservedForLiquidation + topUpAmount;
        uint256 expectedSettlementPerToken = expectedSettlementAmount / totalSupply;

        vm.prank(address(router));
        (uint256 settlementAmount, uint256 settlementPerToken) =
            treasury.initiateSettlement(partner1, scenario.assetId, topUpAmount);

        assertEq(settlementAmount, expectedSettlementAmount);
        assertEq(settlementPerToken, expectedSettlementPerToken);
    }

    function testEarlySettlementRequiresImmediateProceedsResidualTopUp() public {
        (uint256 assetId,, uint256 releasedPrincipal) = _setupImmediateProceedsSettlementAsset();

        uint256 requiredTopUp = treasury.previewRequiredSettlementTopUp(assetId);
        assertEq(requiredTopUp, releasedPrincipal, "Required top-up should cover released protected base");

        vm.prank(partner1);
        vm.expectRevert(
            abi.encodeWithSelector(ITreasury.InsufficientSettlementTopUp.selector, assetId, requiredTopUp, 0)
        );
        assetRegistry.settleAsset(assetId, 0);
    }

    function testEarlySettlementPaysImmediateProceedsResidualAndEarningsBuffer() public {
        (uint256 assetId, uint256 revenueTokenId,) = _setupImmediateProceedsSettlementAsset();

        uint256 requiredTopUp = treasury.previewRequiredSettlementTopUp(assetId);
        CollateralLib.CollateralInfo memory infoBefore = _getCollateralInfo(assetId);
        uint256 expectedSettlementAmount =
            infoBefore.baseCollateral + infoBefore.reservedForLiquidation + infoBefore.earningsBuffer + requiredTopUp;
        uint256 totalSupply = roboshareTokens.getRevenueTokenSupply(revenueTokenId);
        uint256 feeRecipientPendingBefore = treasury.pendingWithdrawals(config.treasuryFeeRecipient);

        vm.prank(partner1);
        usdc.approve(address(treasury), requiredTopUp);
        vm.prank(partner1);
        assetRegistry.settleAsset(assetId, requiredTopUp);

        IPositionManager.SettlementState memory settlementState = positionManager.getSettlementState(assetId);
        assertEq(settlementState.settlementAmount, expectedSettlementAmount);
        assertEq(settlementState.settlementPerToken, expectedSettlementAmount / totalSupply);
        assertEq(
            treasury.pendingWithdrawals(config.treasuryFeeRecipient) - feeRecipientPendingBefore,
            infoBefore.protocolBuffer,
            "Protocol buffer should be routed to protocol fees"
        );
        assertFalse(_getCollateralInfo(assetId).isLocked, "Settlement should clear collateral state");
    }

    function testInitiateSettlementPartnerRefundAfterMaturity() public {
        _ensureState(SetupState.BuffersFunded);

        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(scenario.revenueTokenId);
        vm.warp(maturityDate + 1);

        uint256 pendingBefore = treasury.pendingWithdrawals(partner1);

        vm.prank(address(router));
        treasury.initiateSettlement(partner1, scenario.assetId, 0);

        uint256 pendingAfter = treasury.pendingWithdrawals(partner1);
        assertGt(pendingAfter, pendingBefore, "Mature voluntary settlement should credit partner refund");
    }

    function testExecuteLiquidation() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        _purchaseRemainingPrimarySupply(buyer, scenario.revenueTokenId);

        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(scenario.revenueTokenId);
        vm.warp(maturityDate + 1);

        vm.prank(address(router));
        (uint256 liquidationAmount, uint256 settlementPerToken) = treasury.executeLiquidation(scenario.assetId);

        CollateralLib.CollateralInfo memory infoAfter = _getCollateralInfo(scenario.assetId);
        assertFalse(infoAfter.isLocked);
        assertEq(infoAfter.baseCollateral, 0);

        assertGt(liquidationAmount, 0);
        uint256 totalSupply = roboshareTokens.getRevenueTokenSupply(scenario.revenueTokenId);
        assertEq(settlementPerToken, liquidationAmount / totalSupply);
    }

    function testPreviewLiquidationEligibilityNotEligible() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        _purchasePrimaryForBaseAmount(buyer, scenario.revenueTokenId, ASSET_VALUE);

        (bool eligible, uint8 reason) = treasury.previewLiquidationEligibility(scenario.assetId);
        assertFalse(eligible);
        assertEq(reason, 3); // NotEligible

        vm.prank(address(router));
        vm.expectRevert(
            abi.encodeWithSelector(IAssetRegistry.AssetNotEligibleForLiquidation.selector, scenario.assetId)
        );
        treasury.executeLiquidation(scenario.assetId);
    }

    function testPreviewLiquidationEligibilityByMaturity() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        _purchasePrimaryForBaseAmount(buyer, scenario.revenueTokenId, ASSET_VALUE);

        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(scenario.revenueTokenId);
        vm.warp(maturityDate + 1);

        (bool eligible, uint8 reason) = treasury.previewLiquidationEligibility(scenario.assetId);
        assertTrue(eligible);
        assertEq(reason, 0); // EligibleByMaturity
    }

    function testPreviewLiquidationEligibilityNoPriorEarningsInitialized() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        _purchasePrimaryForBaseAmount(buyer, scenario.revenueTokenId, ASSET_VALUE);

        (,,,, uint256 lastEventTimestamp,,,,) = earningsManager.assetEarnings(scenario.assetId);
        assertEq(lastEventTimestamp, 0, "No earnings should be initialized for this branch");

        (bool eligible, uint8 reason) = treasury.previewLiquidationEligibility(scenario.assetId);
        assertFalse(eligible);
        assertEq(reason, 3); // NotEligible
    }

    function testExecuteLiquidationWithNoPriorEarningsRemainsIneligible() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        _purchasePrimaryForBaseAmount(buyer, scenario.revenueTokenId, ASSET_VALUE);

        (,,,, uint256 lastEventTimestamp,,,,) = earningsManager.assetEarnings(scenario.assetId);
        assertEq(lastEventTimestamp, 0, "No earnings should be initialized in normal flow");

        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(scenario.revenueTokenId);
        vm.warp(maturityDate + 1);

        vm.prank(address(router));
        treasury.executeLiquidation(scenario.assetId);

        (bool isSettled,, uint256 totalSettlementPool) = treasury.assetSettlements(scenario.assetId);
        assertTrue(isSettled);
        assertGt(totalSettlementPool, 0);
    }

    function testExecuteLiquidationWithLockedCollateralAndMissingLastEventTimestamp() public {
        _ensureState(SetupState.BuffersFunded);

        // Helper-only malformed state: force earnings lastEventTimestamp=0 while collateral remains locked.
        // This specifically exercises _applyMissedEarningsShortfall early-return branch.
        stdstore.target(address(earningsManager)).sig("assetEarnings(uint256)").with_key(scenario.assetId).depth(4)
            .checked_write(uint256(0));

        (,,,, uint256 lastEventTimestamp,,,,) = earningsManager.assetEarnings(scenario.assetId);
        assertEq(lastEventTimestamp, 0, "Helper override should clear lastEventTimestamp");

        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(scenario.revenueTokenId);
        vm.warp(maturityDate + 1);

        vm.prank(unauthorized);
        assetRegistry.liquidateAsset(scenario.assetId);

        (bool isSettled,, uint256 totalSettlementPool) = treasury.assetSettlements(scenario.assetId);
        assertTrue(isSettled);
        assertGt(totalSettlementPool, 0);
    }

    function testExecuteLiquidationUnprotectedPoolSkipsBenchmarkShortfallAccrual() public {
        _ensureState(SetupState.EarningsDistributed);
        assertFalse(
            roboshareTokens.getRevenueTokenProtectionEnabled(scenario.revenueTokenId),
            "Default scenario should be unprotected"
        );

        (,,,, uint256 lastEventTimestamp,,,,) = earningsManager.assetEarnings(scenario.assetId);
        assertGt(lastEventTimestamp, 0, "Earnings timestamp should be initialized");

        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(scenario.revenueTokenId);
        vm.warp(maturityDate + 1);

        vm.prank(address(router));
        treasury.executeLiquidation(scenario.assetId);

        (,,,, uint256 updatedLastEventTimestamp,,,,) = earningsManager.assetEarnings(scenario.assetId);
        assertEq(
            updatedLastEventTimestamp,
            block.timestamp,
            "Unprotected liquidation should refresh timestamps and skip accrual"
        );
    }

    function testPreviewLiquidationEligibilityZeroElapsed() public {
        _ensureState(SetupState.EarningsDistributed);

        (,,,, uint256 lastEventTimestamp,,,,) = earningsManager.assetEarnings(scenario.assetId);
        assertEq(lastEventTimestamp, block.timestamp, "Preview should run in same timestamp for zero-elapsed branch");

        (bool eligible, uint8 reason) = treasury.previewLiquidationEligibility(scenario.assetId);
        assertFalse(eligible);
        assertEq(reason, 3); // NotEligible
    }

    function testExecuteLiquidationAppliesMissedEarningsShortfall() public {
        (uint256 assetId, uint256 revenueTokenId) = _setupProtectedPoolWithPurchaseAndBuffers();

        (,,,, uint256 lastEventTimestamp,,,,) = earningsManager.assetEarnings(assetId);
        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(revenueTokenId);
        CollateralLib.CollateralInfo memory infoBefore = _getCollateralInfo(assetId);
        uint256 targetYieldBP = roboshareTokens.getTargetYieldBP(revenueTokenId);
        uint256 benchmarkPrincipal = _getProtectedBenchmarkPrincipal(assetId, revenueTokenId);
        uint256 elapsedToDeplete = (infoBefore.earningsBuffer * ProtocolLib.YEARLY_INTERVAL * ProtocolLib.BP_PRECISION)
            / (benchmarkPrincipal * targetYieldBP);
        uint256 warpTo = lastEventTimestamp + elapsedToDeplete + 1;
        require(warpTo < maturityDate, "Test assumes delinquency before maturity");
        vm.warp(warpTo);

        uint256 shortfallAmount = EarningsLib.calculateEarnings(benchmarkPrincipal, elapsedToDeplete + 1, targetYieldBP);

        vm.expectEmit(true, true, false, true, address(treasury));
        emit ITreasury.ShortfallReserved(assetId, shortfallAmount);

        (bool eligible, uint8 reason) = treasury.previewLiquidationEligibility(assetId);
        assertTrue(eligible);
        assertEq(reason, 1); // EligibleByInsolvency

        vm.prank(address(router));
        treasury.executeLiquidation(assetId);
    }

    function testPreviewLiquidationEligibilityIgnoresUncoveredImmediateProceedsTopUps() public {
        _ensureState(SetupState.InitialAccountsSetup);

        vm.prank(partner1);
        uint256 assetId = assetRegistry.registerAsset(_vehicleRegistrationData(TEST_VIN), ASSET_VALUE);

        uint256 supply = ASSET_VALUE / REVENUE_TOKEN_PRICE;
        uint256 maturityDate = block.timestamp + 365 days;
        uint256 targetYieldBP = 2_500;

        uint256 revenueTokenId;
        vm.prank(partner1);
        (revenueTokenId,) = assetRegistry.createRevenueTokenPool(
            assetId, REVENUE_TOKEN_PRICE, maturityDate, 10_000, targetYieldBP, supply, true, true
        );

        uint256 firstPrincipal = 10_000e6;
        uint256 firstAmount = firstPrincipal / REVENUE_TOKEN_PRICE;
        uint256 firstFee = ProtocolLib.calculateProtocolFee(firstPrincipal);

        vm.startPrank(buyer);
        usdc.approve(address(marketplace), firstPrincipal + firstFee);
        marketplace.buyFromPrimaryPool(revenueTokenId, firstAmount);
        vm.stopPrank();

        uint256 requiredCollateral = _getTotalBufferRequirement(firstPrincipal, targetYieldBP, true);
        vm.prank(partner1);
        usdc.approve(address(treasury), requiredCollateral);
        vm.prank(partner1);
        treasury.enableProceeds(assetId);

        CollateralLib.CollateralInfo memory infoAfterEnable = _getCollateralInfo(assetId);
        assertEq(infoAfterEnable.baseCollateral, 0, "Immediate proceeds should release the initial covered base");
        assertEq(
            _getCoveredBaseCollateral(assetId, revenueTokenId), 0, "No in-pool base should remain covered after release"
        );
        assertEq(
            infoAfterEnable.releasedProtectedBase,
            firstPrincipal,
            "Released immediate proceeds exposure should stay tracked"
        );

        address buyer2 = makeAddr("buyer2");
        deal(address(usdc), buyer2, 1_000_000e6);

        uint256 secondPrincipal = 5_000e6;
        uint256 secondAmount = secondPrincipal / REVENUE_TOKEN_PRICE;
        uint256 secondFee = ProtocolLib.calculateProtocolFee(secondPrincipal);

        vm.startPrank(buyer2);
        usdc.approve(address(marketplace), secondPrincipal + secondFee);
        marketplace.buyFromPrimaryPool(revenueTokenId, secondAmount);
        vm.stopPrank();

        CollateralLib.CollateralInfo memory infoAfterTopUp = _getCollateralInfo(assetId);
        assertEq(infoAfterTopUp.baseCollateral, secondPrincipal, "New buyer principal should sit in base liquidity");
        assertEq(
            _getCoveredBaseCollateral(assetId, revenueTokenId),
            0,
            "Unfunded top-up principal should not become covered while earlier immediate proceeds remain outstanding"
        );
        uint256 benchmarkPrincipal = _getProtectedBenchmarkPrincipal(assetId, revenueTokenId);
        assertLt(
            benchmarkPrincipal,
            firstPrincipal + 1,
            "Recovered protected principal should not exceed the originally covered tranche"
        );
        assertGt(
            benchmarkPrincipal,
            firstPrincipal - 100,
            "Recovered protected principal should stay anchored to the originally covered tranche"
        );

        vm.warp(block.timestamp + 75 days);

        (bool eligible, uint8 reason) = treasury.previewLiquidationEligibility(assetId);
        assertFalse(eligible, "Uncovered later deposits should not create a false insolvency preview");
        assertEq(reason, 3, "Pool should remain ineligible before the protected tranche actually depletes");
    }

    function testSettlementProtocolBufferSeparation() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        _purchasePrimaryForBaseAmount(buyer, scenario.revenueTokenId, ASSET_VALUE);

        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(scenario.revenueTokenId);
        vm.warp(maturityDate + 1);

        // Get initial state
        CollateralLib.CollateralInfo memory infoBefore = _getCollateralInfo(scenario.assetId);
        uint256 protocolBuffer = infoBefore.protocolBuffer;
        uint256 initialFeePending = treasury.pendingWithdrawals(config.treasuryFeeRecipient);

        // Settle
        vm.prank(address(router));
        (uint256 settlementAmount,) = treasury.executeLiquidation(scenario.assetId);

        // Verify Fee Recipient got the buffer
        uint256 finalFeePending = treasury.pendingWithdrawals(config.treasuryFeeRecipient);
        assertEq(finalFeePending, initialFeePending + protocolBuffer);

        // Verify Settlement Pool does not include buffer (roughly)
        // Settlement = TotalCollateral - ProtocolBuffer
        // We can't easily get totalCollateral before without calling view, but we know calculation
        assertGt(settlementAmount, 0);
    }

    function testClaimSettlement() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        // Simulate asset being liquidated via VehicleRegistry to ensure status is updated
        // We need to warp to maturity for liquidation to be valid.
        uint256 revenueTokenId = scenario.assetId + 1;
        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(revenueTokenId);
        vm.warp(maturityDate + 1);

        vm.prank(unauthorized); // Anyone can call liquidateAsset
        assetRegistry.liquidateAsset(scenario.assetId);

        uint256 initialBalance = usdc.balanceOf(buyer);
        uint256 buyerBalance = roboshareTokens.balanceOf(buyer, revenueTokenId);
        assertFalse(_getCollateralInfo(scenario.assetId).isLocked); // settlement clears this.

        (, uint256 settlementPerToken,) = treasury.assetSettlements(scenario.assetId);

        vm.startPrank(buyer);
        (uint256 claimed,) = router.claimSettlement(scenario.assetId, false);
        // Settlement now uses pendingWithdrawals pattern - need to withdraw
        treasury.processWithdrawal();
        vm.stopPrank();

        assertEq(claimed, buyerBalance * settlementPerToken, "Claimed amount mismatch");
        assertEq(usdc.balanceOf(buyer), initialBalance + claimed, "Buyer USDC balance mismatch");
    }

    function testSettlementAfterMaturityReturnsBufferToPartner() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        // Warp past maturity
        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(scenario.revenueTokenId);
        vm.warp(maturityDate + 1);

        // Settle asset
        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        // Check results
        CollateralLib.CollateralInfo memory info = _getCollateralInfo(scenario.assetId);
        uint256 earningsBuffer = info.earningsBuffer;
        uint256 protocolBuffer = info.protocolBuffer;

        // Expected behavior: earningsBuffer AND protocolBuffer should be in partner's pending withdrawals
        uint256 pending = treasury.pendingWithdrawals(partner1);
        assertEq(pending, earningsBuffer + protocolBuffer, "Partner should receive earnings AND protocol buffer");

        // Treasury fee recipient should NOT receive protocol buffer
        uint256 feeRecipientPending = treasury.pendingWithdrawals(config.treasuryFeeRecipient);
        assertEq(feeRecipientPending, 0, "Fee recipient should not receive protocol buffer on maturity settlement");
    }

    // ============ Settlement Idempotence ============

    /// @dev Test line 567: initiateSettlement reverts when asset is already settled
    function testInitiateSettlementAlreadySettled() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        // Second settlement should revert with IAssetRegistry.AssetAlreadySettled
        vm.prank(address(router));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAssetRegistry.AssetAlreadySettled.selector, scenario.assetId, AssetLib.AssetStatus.Retired
            )
        );
        treasury.initiateSettlement(partner1, scenario.assetId, 0);
    }

    /// @dev Test line 607: executeLiquidation reverts when asset is already settled
    function testExecuteLiquidationAlreadySettled() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        (bool eligible, uint8 reason) = treasury.previewLiquidationEligibility(scenario.assetId);
        assertFalse(eligible);
        assertEq(reason, 2); // AlreadySettled

        // Second: attempt to liquidate (should revert since already settled)
        vm.prank(address(router));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAssetRegistry.AssetAlreadySettled.selector, scenario.assetId, AssetLib.AssetStatus.Retired
            )
        );
        treasury.executeLiquidation(scenario.assetId);
    }

    /// @dev Test line 689: processSettlementClaim with zero amount returns 0
    function testProcessSettlementClaimForZeroAmount() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        // Settle the asset
        vm.warp(block.timestamp + ProtocolLib.YEARLY_INTERVAL * 5 + 1);
        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        vm.prank(address(router));
        uint256 claimed = treasury.processSettlementClaimFor(buyer, scenario.assetId, 0);
        assertEq(claimed, 0);
    }

    function testProcessSettlementClaimForNotSettled() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        vm.startPrank(address(router));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAssetRegistry.AssetNotSettled.selector, scenario.assetId, router.getAssetStatus(scenario.assetId)
            )
        );
        treasury.processSettlementClaimFor(buyer, scenario.assetId, 1);
        vm.stopPrank();
    }

    // ============================================
    // Earnings Snapshot Tests
    // ============================================

    /// @dev Test claimSettlement with autoClaimEarnings=true claims both settlement and earnings
    function testClaimSettlementAutoClaimEarnings() public {
        _ensureState(SetupState.EarningsDistributed);

        uint256 buyerBalance = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        assertEq(buyerBalance, PRIMARY_PURCHASE_AMOUNT);

        // Settle the asset
        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);
        uint256 buyerPendingBefore = treasury.pendingWithdrawals(buyer);

        // Claim settlement with autoClaimEarnings=true
        vm.prank(buyer);
        (uint256 settlementClaimed, uint256 earningsClaimed) = router.claimSettlement(scenario.assetId, true);

        assertGt(settlementClaimed, 0, "Settlement should be > 0");
        assertGt(earningsClaimed, 0, "Earnings should be > 0 with autoClaim");

        // Both settlement AND earnings now go to pending withdrawals
        uint256 buyerPendingAfter = treasury.pendingWithdrawals(buyer);
        assertEq(
            buyerPendingAfter,
            buyerPendingBefore + settlementClaimed + earningsClaimed,
            "Pending should include earnings"
        );

        // Need to withdraw to get USDC
        vm.prank(buyer);
        treasury.processWithdrawal();

        assertEq(
            usdc.balanceOf(buyer),
            buyerUsdcBefore + settlementClaimed + earningsClaimed,
            "Should receive both settlement and earnings"
        );
    }

    /// @dev Critical test: verify earnings can be claimed via snapshot even after tokens are burned
    /// @dev Test multiple investors claiming in different orders
    function testClaimSettledEarningsMultipleInvestors() public {
        _ensureState(SetupState.BuffersFunded);
        _ensureSecondaryListingScenario();

        // Create second buyer
        address buyer2 = makeAddr("buyer2");
        deal(address(usdc), buyer2, 1_000_000e6);

        // Use existing secondary listing inventory
        uint256 listing2Id = scenario.listingId;
        vm.startPrank(buyer2);
        (,, uint256 payment2) = marketplace.previewSecondaryPurchase(listing2Id, 200);
        usdc.approve(address(marketplace), payment2);
        marketplace.buyFromSecondaryListing(listing2Id, 200);
        vm.stopPrank();

        // Distribute earnings
        uint256 earningsAmount = 30_000e6;
        _setupEarningsDistributed(earningsAmount);

        // Settle
        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        // Buyer1 claims with autoClaim, buyer2 claims without then claims earnings separately
        vm.prank(buyer);
        (uint256 buyer1Settlement, uint256 buyer1Earnings) = router.claimSettlement(scenario.assetId, true);
        assertGt(buyer1Settlement, 0, "Buyer1 settlement should be > 0");
        assertGt(buyer1Earnings, 0, "Buyer1 should have auto-claimed earnings");

        vm.prank(buyer2);
        (uint256 buyer2Settlement, uint256 buyer2EarningsClaimed) = router.claimSettlement(scenario.assetId, false);
        assertGt(buyer2Settlement, 0, "Buyer2 settlement should be > 0");
        assertEq(buyer2EarningsClaimed, 0, "Buyer2 did not auto-claim");

        // Buyer2 claims earnings from snapshot
        uint256 buyer2PendingBefore = treasury.pendingWithdrawals(buyer2);
        vm.prank(buyer2);
        earningsManager.claimEarnings(scenario.assetId);
        uint256 buyer2PendingAfter = treasury.pendingWithdrawals(buyer2);

        assertGt(buyer2PendingAfter, buyer2PendingBefore, "Buyer2 should claim from snapshot");
        uint256 buyer1Balance = PRIMARY_PURCHASE_AMOUNT;
        if (200 > buyer1Balance) {
            assertGt(buyer2PendingAfter - buyer2PendingBefore, buyer1Earnings, "Buyer2 should have more earnings");
        } else {
            assertLt(buyer2PendingAfter - buyer2PendingBefore, buyer1Earnings, "Buyer2 should have fewer earnings");
        }
    }

    /// @dev Test claiming with no unclaimed earnings works fine
    function testClaimSettlementNoUnclaimedEarnings() public {
        _ensureState(SetupState.EarningsDistributed);

        // Buyer claims earnings now
        vm.prank(buyer);
        earningsManager.claimEarnings(scenario.assetId);

        // Now settle
        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        // Claim settlement with autoClaim - should work, but earnings should be 0
        vm.prank(buyer);
        (uint256 settlement, uint256 earnings) = router.claimSettlement(scenario.assetId, true);

        assertGt(settlement, 0, "Should still get settlement");
        assertEq(earnings, 0, "No unclaimed earnings");
    }

    // ============================================
    // Bundled Collateral Release Tests
    // ============================================

    /// @dev Test that consecutive distributions with auto-release work (no interval check)
    function testDistributeEarningsAutoReleaseConsecutive() public {
        _ensureState(SetupState.BuffersFunded);

        uint256 earningsAmount = LARGE_EARNINGS_AMOUNT;
        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), earningsAmount * 2);

        // First distribution - creates period 1, but no prior period to process yet
        uint256 released1 = earningsManager.distributeEarnings(scenario.assetId, earningsAmount, true);
        assertEq(released1, 0, "First distribution has no prior periods to process");

        // Warp time forward - release amount is based on linear depreciation over time
        vm.warp(block.timestamp + 7 days);

        // Second distribution - now has period 1 to process AND time has passed for depreciation
        uint256 released2 = earningsManager.distributeEarnings(scenario.assetId, earningsAmount, true);
        assertGt(released2, 0, "Second distribution should release collateral");

        vm.stopPrank();
    }

    function testAutoReleaseProtocolFeeClamped() public {
        _ensureState(SetupState.InitialAccountsSetup);

        string memory vin = _generateVin(4242);
        uint256 assetValue = 4_400 * 10 ** 6;
        vm.prank(partner1);
        uint256 assetId = assetRegistry.registerAsset(_vehicleRegistrationData(vin), assetValue);

        vm.prank(partner1);
        (uint256 revenueTokenId,) = assetRegistry.createRevenueTokenPool(
            assetId,
            REVENUE_TOKEN_PRICE,
            block.timestamp + 365 days,
            10_000,
            1_000,
            assetValue / REVENUE_TOKEN_PRICE,
            false,
            false
        );

        _purchasePrimaryForBaseAmount(buyer, revenueTokenId, assetValue);

        uint256 targetYieldBP = roboshareTokens.getTargetYieldBP(revenueTokenId);
        uint256 requiredBuffer = _getTotalBufferRequirement(assetValue, targetYieldBP, false);
        vm.prank(partner1);
        usdc.approve(address(treasury), requiredBuffer);
        vm.prank(partner1);
        treasury.enableProceeds(assetId);

        uint256 soldAmount = _getInvestorSupply(revenueTokenId, partner1);
        uint256 maxSupply = roboshareTokens.getRevenueTokenMaxSupply(revenueTokenId);

        vm.warp(block.timestamp + 7 days);

        uint256 investorAmount = (EARNINGS_AMOUNT * soldAmount) / maxSupply;
        uint256 feePendingBefore = treasury.pendingWithdrawals(config.treasuryFeeRecipient);

        vm.startPrank(partner1);
        usdc.approve(address(treasury), type(uint256).max);
        usdc.approve(address(earningsManager), investorAmount);
        uint256 released = earningsManager.distributeEarnings(assetId, EARNINGS_AMOUNT, true);
        vm.stopPrank();

        assertGt(released, 0);

        uint256 feePendingAfter = treasury.pendingWithdrawals(config.treasuryFeeRecipient);
        uint256 protocolFeeFromEarnings = ProtocolLib.calculateProtocolFee(investorAmount);
        uint256 releaseFeeDelta = feePendingAfter - feePendingBefore - protocolFeeFromEarnings;

        assertGt(releaseFeeDelta, 0);
    }

    /// @dev Test manual releasePartialCollateral still works independently
    function testManualReleaseAfterDistributeAutoReleaseDisabled() public {
        _ensureState(SetupState.BuffersFunded);

        uint256 earningsAmount = LARGE_EARNINGS_AMOUNT;
        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), earningsAmount);

        // Distribute without auto-release
        earningsManager.distributeEarnings(scenario.assetId, earningsAmount, false);

        // Advance past minimum interval
        vm.warp(block.timestamp + 16 days);

        // Manual release should work
        uint256 pendingBefore = treasury.pendingWithdrawals(partner1);
        treasury.releasePartialCollateral(scenario.assetId);
        uint256 pendingAfter = treasury.pendingWithdrawals(partner1);

        assertGt(pendingAfter, pendingBefore, "Manual release should work");

        vm.stopPrank();
    }

    function testPreviewCollateralReleasePendingNetEarningsNoEarnings() public {
        _ensureState(SetupState.BuffersFunded);

        vm.warp(block.timestamp + 1 days);
        uint256 preview = treasury.previewCollateralRelease(scenario.assetId, LARGE_EARNINGS_AMOUNT);
        assertGt(preview, 0);
    }

    function testPreviewDistributeEarningsMatchesFirstAutoRelease() public {
        _ensureState(SetupState.BuffersFunded);

        uint256 earningsAmount = LARGE_EARNINGS_AMOUNT;
        vm.warp(block.timestamp + 7 days);

        (,,, uint256 previewRelease) =
            earningsManager.previewDistributeEarnings(partner1, scenario.assetId, earningsAmount, true);

        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), earningsAmount);
        uint256 released = earningsManager.distributeEarnings(scenario.assetId, earningsAmount, true);
        vm.stopPrank();

        assertEq(released, previewRelease, "Distribution preview should match first auto-release");
    }

    function testPreviewCollateralReleasePendingNetEarningsCapsToCoveredBase() public {
        _ensureState(SetupState.BuffersFunded);

        uint256 initialBase = _getCollateralInfo(scenario.assetId).baseCollateral;

        _purchaseRemainingPrimarySupply(buyer, scenario.revenueTokenId);

        CollateralLib.CollateralInfo memory info = _getCollateralInfo(scenario.assetId);
        assertEq(_getCoveredBaseCollateral(scenario.assetId, scenario.revenueTokenId), initialBase);
        assertEq(info.baseCollateral, initialBase * 2);

        vm.warp(info.lockedAt + (5 * 365 days));

        uint256 preview = treasury.previewCollateralRelease(scenario.assetId, LARGE_EARNINGS_AMOUNT);
        assertLe(preview, initialBase);
        assertGt(preview, 0);
    }

    function testPreviewCollateralReleasePendingNetEarningsNoNewPeriods() public {
        _ensureState(SetupState.EarningsDistributed);

        uint256 extraRevenue = 10_000_000_000; // large revenue to avoid shortfall
        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), type(uint256).max);
        earningsManager.distributeEarnings(scenario.assetId, extraRevenue, false);
        vm.stopPrank();

        uint256 firstWarp = block.timestamp + 30 days;
        vm.warp(firstWarp);
        vm.startPrank(partner1);
        treasury.releasePartialCollateral(scenario.assetId);
        vm.stopPrank();

        vm.warp(firstWarp + 30 days);
        uint256 preview = treasury.previewCollateralRelease(scenario.assetId, LARGE_EARNINGS_AMOUNT);
        assertGt(preview, 0);
    }

    function testPreviewCollateralReleasePendingNetEarningsFeeClamp() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        CollateralLib.CollateralInfo memory info = _getCollateralInfo(scenario.assetId);
        vm.warp(info.lockedAt + 1);

        uint256 preview = treasury.previewCollateralRelease(scenario.assetId, LARGE_EARNINGS_AMOUNT);
        assertEq(preview, 0);
    }

    function testPreviewCollateralReleaseNoReleaseDue() public {
        _ensureState(SetupState.EarningsDistributed);

        CollateralLib.CollateralInfo memory info = _getCollateralInfo(scenario.assetId);
        vm.warp(info.lockedAt == 0 ? block.timestamp : info.lockedAt);

        uint256 preview = treasury.previewCollateralRelease(scenario.assetId, 0);
        assertEq(preview, 0);
    }

    function testPreviewCollateralReleaseRecomputesCoverageAfterReplenishment() public {
        (uint256 assetId,) = _setupProtectedPoolWithPurchaseAndBuffers();

        CollateralLib.CollateralInfo memory info = _getCollateralInfo(assetId);
        vm.warp(info.lockedAt + (3 * 365 days));

        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), SMALL_EARNINGS_AMOUNT);
        earningsManager.distributeEarnings(assetId, SMALL_EARNINGS_AMOUNT, false);
        vm.stopPrank();

        vm.prank(partner1);
        treasury.releasePartialCollateral(assetId);

        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), LARGE_EARNINGS_AMOUNT);
        earningsManager.distributeEarnings(assetId, LARGE_EARNINGS_AMOUNT, false);
        vm.stopPrank();

        vm.warp(block.timestamp + 120 days);

        uint256 preview = treasury.previewCollateralRelease(assetId, 0);
        assertGt(preview, 0, "Preview should become positive after replenishment recomputes coverage");
    }

    function testPreviewCollateralReleaseReplenishmentCapsToRecomputedCoveredBase() public {
        (uint256 assetId,) = _setupProtectedPoolWithPurchaseAndBuffers();

        CollateralLib.CollateralInfo memory info = _getCollateralInfo(assetId);
        uint256 initialBase = _getCollateralInfo(assetId).baseCollateral;
        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);

        _purchaseRemainingPrimarySupply(buyer, revenueTokenId);

        vm.warp(info.lockedAt + (3 * 365 days));

        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), SMALL_EARNINGS_AMOUNT);
        earningsManager.distributeEarnings(assetId, SMALL_EARNINGS_AMOUNT, false);
        vm.stopPrank();

        vm.prank(partner1);
        treasury.releasePartialCollateral(assetId);

        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), LARGE_EARNINGS_AMOUNT);
        earningsManager.distributeEarnings(assetId, LARGE_EARNINGS_AMOUNT, false);
        vm.stopPrank();

        vm.warp(block.timestamp + 120 days);

        uint256 preview = treasury.previewCollateralRelease(assetId, 0);
        assertGt(preview, 0, "Preview should be positive after replenishment");
        assertLe(preview, initialBase, "Preview should clamp to recomputed covered base");
    }

    // ============================================
    // Convenience Withdrawal Function Tests
    // ============================================
}
