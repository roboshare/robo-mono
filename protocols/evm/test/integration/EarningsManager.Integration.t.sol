// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { MarketplaceFlowBaseTest } from "../base/MarketplaceFlowBaseTest.t.sol";
import { ProtocolLib, AssetLib, CollateralLib, TokenLib } from "../../contracts/Libraries.sol";
import { IEarningsManager } from "../../contracts/interfaces/IEarningsManager.sol";
import { IPositionManager } from "../../contracts/interfaces/IPositionManager.sol";
import { ITreasury } from "../../contracts/interfaces/ITreasury.sol";
import { PartnerManager } from "../../contracts/PartnerManager.sol";

contract EarningsManagerIntegrationTest is MarketplaceFlowBaseTest {
    function setUp() public {
        _ensureState(SetupState.InitialAccountsSetup);
    }

    function testDistributeEarnings() public {
        _ensureState(SetupState.BuffersFunded);
        uint256 earningsAmount = EARNINGS_AMOUNT;
        uint256 investorAmount = _calculateInvestorAmountFromRevenue(scenario.revenueTokenId, partner1, earningsAmount);
        uint256 protocolFee = ProtocolLib.calculateProtocolFee(investorAmount);
        uint256 netEarnings = investorAmount - protocolFee;
        uint256 treasuryBalanceBefore = usdc.balanceOf(address(treasury));

        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), investorAmount);
        vm.expectEmit(true, true, false, true);
        emit IEarningsManager.EarningsDistributed(scenario.assetId, partner1, earningsAmount, netEarnings, 1);
        earningsManager.distributeEarnings(scenario.assetId, earningsAmount, false);
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(treasury)), treasuryBalanceBefore + investorAmount);
    }

    function testDistributeEarningsExcludesPartnerHoldings() public {
        _ensureState(SetupState.BuffersFunded);
        uint256 earningsAmount = EARNINGS_AMOUNT;
        uint256 revenueTokenId = scenario.revenueTokenId;
        uint256 buyerBalance = roboshareTokens.balanceOf(buyer, revenueTokenId);
        uint256 transferAmount = buyerBalance / 2;

        vm.prank(buyer);
        roboshareTokens.safeTransferFrom(buyer, partner1, revenueTokenId, transferAmount, "");

        uint256 investorAmount = _calculateInvestorAmountFromRevenue(revenueTokenId, partner1, earningsAmount);
        uint256 treasuryBalanceBefore = usdc.balanceOf(address(treasury));

        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), investorAmount);
        earningsManager.distributeEarnings(scenario.assetId, earningsAmount, false);
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(treasury)), treasuryBalanceBefore + investorAmount);

        vm.prank(partner1);
        vm.expectRevert(ITreasury.NoEarningsToClaim.selector);
        earningsManager.claimEarnings(scenario.assetId);
    }

    function testDistributeEarningsUnauthorizedPartner() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        vm.expectRevert(PartnerManager.UnauthorizedPartner.selector);
        vm.prank(unauthorized);
        earningsManager.distributeEarnings(scenario.assetId, EARNINGS_AMOUNT, false);
    }

    function testDistributeEarningsInvalidAmount() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        vm.expectRevert(ITreasury.InvalidEarningsAmount.selector);
        vm.prank(partner1);
        earningsManager.distributeEarnings(scenario.assetId, 0, false);
    }

    function testDistributeEarningsAssetNotFound() public {
        vm.expectRevert(ITreasury.AssetNotFound.selector);
        vm.prank(partner1);
        earningsManager.distributeEarnings(999, EARNINGS_AMOUNT, false);
    }

    function testDistributeEarningsPendingAsset() public {
        _ensureState(SetupState.AssetRegistered);

        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), EARNINGS_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(ITreasury.AssetNotActive.selector, scenario.assetId, AssetLib.AssetStatus.Pending)
        );
        earningsManager.distributeEarnings(scenario.assetId, EARNINGS_AMOUNT, false);
        vm.stopPrank();
    }

    function testDistributeEarningsNoInvestorsPartnerHoldsAllOutstandingTokens() public {
        _ensureState(SetupState.BuffersFunded);
        _ensureSecondaryListingScenario();

        vm.prank(buyer);
        roboshareTokens.safeTransferFrom(buyer, partner1, scenario.revenueTokenId, PRIMARY_PURCHASE_AMOUNT, "");
        vm.prank(partner1);
        marketplace.endListing(scenario.listingId);

        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), EARNINGS_AMOUNT);
        vm.expectRevert(ITreasury.NoInvestors.selector);
        earningsManager.distributeEarnings(scenario.assetId, EARNINGS_AMOUNT, false);
        vm.stopPrank();
    }

    function testDistributeEarningsNoInvestors() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), EARNINGS_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(ITreasury.AssetNotActive.selector, scenario.assetId, AssetLib.AssetStatus.Active)
        );
        earningsManager.distributeEarnings(scenario.assetId, EARNINGS_AMOUNT, false);
        vm.stopPrank();
    }

    function testDistributeEarningsNoInvestorsNoPrimaryPurchases() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), EARNINGS_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(ITreasury.AssetNotActive.selector, scenario.assetId, AssetLib.AssetStatus.Active)
        );
        earningsManager.distributeEarnings(scenario.assetId, EARNINGS_AMOUNT, false);
        vm.stopPrank();
    }

    function testDistributeEarningsSettledAsset() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), EARNINGS_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(ITreasury.AssetNotActive.selector, scenario.assetId, AssetLib.AssetStatus.Retired)
        );
        earningsManager.distributeEarnings(scenario.assetId, EARNINGS_AMOUNT, false);
        vm.stopPrank();
    }

    function testDistributeEarningsNotAssetOwner() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        vm.startPrank(partner2);
        usdc.approve(address(earningsManager), 1e9);
        vm.expectRevert(ITreasury.NotAssetOwner.selector);
        earningsManager.distributeEarnings(scenario.assetId, EARNINGS_AMOUNT, false);
        vm.stopPrank();
    }

    function testPreviewClaimEarningsActiveMatchesClaim() public {
        _ensureState(SetupState.EarningsDistributed);

        uint256 previewAmount = earningsManager.previewClaimEarnings(scenario.assetId, buyer);
        assertGt(previewAmount, 0);

        uint256 pendingBefore = treasury.pendingWithdrawals(buyer);
        vm.prank(buyer);
        earningsManager.claimEarnings(scenario.assetId);
        uint256 pendingAfter = treasury.pendingWithdrawals(buyer);

        assertEq(pendingAfter - pendingBefore, previewAmount);
        assertEq(earningsManager.previewClaimEarnings(scenario.assetId, buyer), 0);
    }

    function testPreviewClaimEarningsNoTokenBalanceReturnsZero() public {
        _ensureState(SetupState.EarningsDistributed);
        assertEq(earningsManager.previewClaimEarnings(scenario.assetId, unauthorized), 0);
    }

    function testClaimEarningsUsesTokenBalanceGateBeforeManagerPositions() public {
        _ensureState(SetupState.EarningsDistributed);

        TokenLib.TokenPosition[] memory positions = roboshareTokens.getUserPositions(scenario.revenueTokenId, buyer);
        assertGt(positions.length, 0);

        address mockManager = makeAddr("mockManager");
        vm.mockCall(address(roboshareTokens), abi.encodeWithSignature("positionManager()"), abi.encode(mockManager));
        vm.mockCall(
            mockManager,
            abi.encodeWithSelector(IPositionManager.getUserPositions.selector, scenario.revenueTokenId, buyer),
            abi.encode(positions)
        );
        vm.mockCall(
            address(roboshareTokens),
            abi.encodeWithSignature("balanceOf(address,uint256)", buyer, scenario.revenueTokenId),
            abi.encode(uint256(0))
        );

        vm.expectRevert(ITreasury.InsufficientTokenBalance.selector);
        vm.prank(buyer);
        earningsManager.claimEarnings(scenario.assetId);
    }

    function testPreviewClaimEarningsNoEarningsInitialized() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);
        assertEq(earningsManager.previewClaimEarnings(scenario.assetId, buyer), 0);
    }

    function testPreviewClaimEarningsSettledSnapshotLifecycle() public {
        _ensureState(SetupState.EarningsDistributed);

        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        uint256 buyerBalance = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        vm.prank(buyer);
        router.claimSettlement(scenario.assetId, false);
        assertEq(roboshareTokens.balanceOf(buyer, scenario.revenueTokenId), 0);
        IPositionManager.SettlementClaimState memory claimState =
            roboshareTokens.positionManager().getSettlementClaimState(scenario.assetId, buyer);
        assertEq(claimState.burnedAmount, buyerBalance);

        uint256 previewAmount = earningsManager.previewClaimEarnings(scenario.assetId, buyer);
        assertGt(previewAmount, 0);

        uint256 pendingBefore = treasury.pendingWithdrawals(buyer);
        vm.prank(buyer);
        earningsManager.claimEarnings(scenario.assetId);
        uint256 pendingAfter = treasury.pendingWithdrawals(buyer);

        assertEq(pendingAfter - pendingBefore, previewAmount);
        assertEq(earningsManager.previewClaimEarnings(scenario.assetId, buyer), 0);
    }

    function testPreviewClaimEarningsSettledPreBurnUsesCurrentPositions() public {
        _ensureState(SetupState.EarningsDistributed);

        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        uint256 previewAmount = earningsManager.previewClaimEarnings(scenario.assetId, buyer);
        assertGt(previewAmount, 0);
    }

    function testClaimEarningsSettledPreBurnUsesCurrentPositions() public {
        _ensureState(SetupState.EarningsDistributed);

        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        uint256 pendingBefore = treasury.pendingWithdrawals(buyer);
        vm.prank(buyer);
        earningsManager.claimEarnings(scenario.assetId);
        uint256 pendingAfter = treasury.pendingWithdrawals(buyer);

        assertGt(pendingAfter, pendingBefore);
    }

    function testClaimEarningsAssetNotFound() public {
        _ensureState(SetupState.EarningsDistributed);
        uint256 nonExistentAssetId = 999;

        vm.prank(buyer);
        vm.expectRevert(ITreasury.AssetNotFound.selector);
        earningsManager.claimEarnings(nonExistentAssetId);
    }

    function testPreviewClaimEarningsAssetNotFound() public {
        _ensureState(SetupState.EarningsDistributed);
        uint256 nonExistentAssetId = 999;

        vm.expectRevert(ITreasury.AssetNotFound.selector);
        earningsManager.previewClaimEarnings(nonExistentAssetId, buyer);
    }

    function testPreviewClaimEarningsAssetOwner() public {
        _ensureState(SetupState.EarningsDistributed);
        assertEq(earningsManager.previewClaimEarnings(scenario.assetId, partner1), 0);
    }

    function testPreviewClaimEarningsSettledAssetOwnerRemainsZero() public {
        _ensureState(SetupState.EarningsDistributed);

        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        assertEq(earningsManager.previewClaimEarnings(scenario.assetId, partner1), 0);
    }

    function testClaimEarnings() public {
        _ensureState(SetupState.EarningsDistributed);
        uint256 earningsAmount = EARNINGS_AMOUNT;

        uint256 buyerBalance = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        uint256 investorTokens = _getInvestorSupply(scenario.revenueTokenId, partner1);
        uint256 investorAmount = _calculateInvestorAmountFromRevenue(scenario.revenueTokenId, partner1, earningsAmount);
        uint256 netEarnings = investorAmount - ProtocolLib.calculateProtocolFee(investorAmount);
        uint256 buyerShare = (netEarnings * buyerBalance) / investorTokens;
        uint256 pendingBefore = treasury.pendingWithdrawals(buyer);

        vm.startPrank(buyer);
        vm.expectEmit(true, true, false, true);
        emit IEarningsManager.EarningsClaimed(scenario.assetId, buyer, buyerShare);
        earningsManager.claimEarnings(scenario.assetId);
        vm.stopPrank();

        assertEq(treasury.pendingWithdrawals(buyer), pendingBefore + buyerShare);
    }

    function testClaimEarningsMultiplePeriods() public {
        _ensureState(SetupState.BuffersFunded);
        uint256 earnings1 = EARNINGS_AMOUNT;
        uint256 earnings2 = 500 * 1e6;
        _setupEarningsDistributed(earnings1);
        _setupEarningsDistributed(earnings2);

        uint256 buyerBalance = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        uint256 investorTokens = _getInvestorSupply(scenario.revenueTokenId, partner1);
        uint256 maxSupply = roboshareTokens.getRevenueTokenMaxSupply(scenario.revenueTokenId);
        uint256 revenueShareBP = roboshareTokens.getRevenueShareBP(scenario.revenueTokenId);
        uint256 cap1 = (earnings1 * revenueShareBP) / ProtocolLib.BP_PRECISION;
        uint256 soldShare1 = (earnings1 * investorTokens) / maxSupply;
        uint256 investorAmount1 = soldShare1 < cap1 ? soldShare1 : cap1;
        uint256 cap2 = (earnings2 * revenueShareBP) / ProtocolLib.BP_PRECISION;
        uint256 soldShare2 = (earnings2 * investorTokens) / maxSupply;
        uint256 investorAmount2 = soldShare2 < cap2 ? soldShare2 : cap2;
        uint256 totalNet = (investorAmount1 - ProtocolLib.calculateProtocolFee(investorAmount1))
            + (investorAmount2 - ProtocolLib.calculateProtocolFee(investorAmount2));
        uint256 buyerShare = (totalNet * buyerBalance) / investorTokens;

        uint256 initialPending = treasury.pendingWithdrawals(buyer);
        vm.prank(buyer);
        earningsManager.claimEarnings(scenario.assetId);
        assertEq(treasury.pendingWithdrawals(buyer), initialPending + buyerShare);
    }

    function testClaimEarningsAssetNotSettledNoSnapshot() public {
        _ensureState(SetupState.EarningsDistributed);

        uint256 pendingBefore = treasury.pendingWithdrawals(buyer);

        vm.prank(buyer);
        earningsManager.claimEarnings(scenario.assetId);

        uint256 pendingAfter = treasury.pendingWithdrawals(buyer);
        assertGt(pendingAfter, pendingBefore);
        assertGt(roboshareTokens.balanceOf(buyer, scenario.revenueTokenId), 0);
    }

    function testSnapshotEarningsMultipleEarningsPeriods() public {
        _ensureState(SetupState.BuffersFunded);

        for (uint256 i = 0; i < 3; i++) {
            uint256 earningsAmount = 3_000e6;
            _setupEarningsDistributed(earningsAmount);
            vm.warp(block.timestamp + 30 days);
        }

        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        uint256 pendingBefore = treasury.pendingWithdrawals(buyer);

        vm.prank(buyer);
        (uint256 settlement, uint256 earnings) = router.claimSettlement(scenario.assetId, true);

        assertGt(settlement, 0);
        assertGt(earnings, 0);

        uint256 pendingAfter = treasury.pendingWithdrawals(buyer);
        assertEq(pendingAfter - pendingBefore, settlement + earnings);
    }

    function testClaimEarningsNoBalance() public {
        _ensureState(SetupState.EarningsDistributed);
        vm.expectRevert(ITreasury.InsufficientTokenBalance.selector);
        vm.prank(unauthorized);
        earningsManager.claimEarnings(scenario.assetId);
    }

    function testClaimEarningsAlreadyClaimed() public {
        _ensureState(SetupState.EarningsDistributed);

        vm.startPrank(buyer);
        earningsManager.claimEarnings(scenario.assetId);
        vm.expectRevert(ITreasury.NoEarningsToClaim.selector);
        earningsManager.claimEarnings(scenario.assetId);
        vm.stopPrank();
    }

    function testClaimEarningsSettledUsesSnapshot() public {
        _ensureState(SetupState.EarningsDistributed);

        vm.prank(address(router));
        earningsManager.snapshotAndClaimEarnings(scenario.assetId, buyer, false);

        vm.prank(address(treasury));
        router.setAssetStatus(scenario.assetId, AssetLib.AssetStatus.Retired);

        uint256 pendingBefore = treasury.pendingWithdrawals(buyer);
        vm.prank(buyer);
        earningsManager.claimEarnings(scenario.assetId);
        uint256 pendingAfter = treasury.pendingWithdrawals(buyer);
        assertGt(pendingAfter, pendingBefore);
    }

    function testClaimSettlementThenClaimEarningsFromSnapshot() public {
        _ensureState(SetupState.EarningsDistributed);

        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        uint256 buyerPendingBefore = treasury.pendingWithdrawals(buyer);

        vm.prank(buyer);
        (uint256 settlementClaimed, uint256 earningsClaimed) = router.claimSettlement(scenario.assetId, false);

        assertGt(settlementClaimed, 0);
        assertEq(earningsClaimed, 0);
        assertEq(roboshareTokens.balanceOf(buyer, scenario.revenueTokenId), 0);
        assertGt(earningsManager.previewClaimEarnings(scenario.assetId, buyer), 0);

        vm.prank(buyer);
        earningsManager.claimEarnings(scenario.assetId);

        uint256 buyerPendingAfter = treasury.pendingWithdrawals(buyer);
        assertGt(buyerPendingAfter, buyerPendingBefore);
    }

    function testClaimEarningsCannotClaimSnapshotTwice() public {
        _ensureState(SetupState.EarningsDistributed);

        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        vm.prank(buyer);
        router.claimSettlement(scenario.assetId, false);

        vm.prank(buyer);
        earningsManager.claimEarnings(scenario.assetId);

        vm.prank(buyer);
        vm.expectRevert(ITreasury.NoEarningsToClaim.selector);
        earningsManager.claimEarnings(scenario.assetId);
    }

    function testDistributeEarningsAutoReleasesCollateral() public {
        _ensureState(SetupState.BuffersFunded);

        uint256 earningsAmount = LARGE_EARNINGS_AMOUNT;
        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), earningsAmount * 3);

        uint256 released1 = earningsManager.distributeEarnings(scenario.assetId, earningsAmount, true);
        assertEq(released1, 0);

        vm.warp(block.timestamp + 16 days);

        uint256 pendingBefore = treasury.pendingWithdrawals(partner1);
        vm.expectEmit(true, true, false, false, address(treasury));
        emit ITreasury.CollateralReleased(scenario.assetId, partner1, 0);

        uint256 released2 = earningsManager.distributeEarnings(scenario.assetId, earningsAmount, true);
        assertGt(released2, 0);

        uint256 pendingAfter = treasury.pendingWithdrawals(partner1);
        assertEq(pendingAfter - pendingBefore, released2);
        vm.stopPrank();
    }

    function testDistributeEarningsAutoReleaseDisabled() public {
        _ensureState(SetupState.BuffersFunded);

        uint256 earningsAmount = LARGE_EARNINGS_AMOUNT;
        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), earningsAmount * 2);

        earningsManager.distributeEarnings(scenario.assetId, earningsAmount, false);
        vm.warp(block.timestamp + 16 days);

        uint256 released = earningsManager.distributeEarnings(scenario.assetId, earningsAmount, false);
        assertEq(released, 0);

        treasury.releasePartialCollateral(scenario.assetId);
        vm.stopPrank();
    }

    function testDistributeEarningsAutoReleaseNotLocked() public {
        _ensureSecondaryListingScenario();

        uint256 soldAmount = _getInvestorSupply(scenario.revenueTokenId, partner1);
        uint256 maxSupply = roboshareTokens.getRevenueTokenMaxSupply(scenario.revenueTokenId);

        uint256 investorAmount = (EARNINGS_AMOUNT * soldAmount) / maxSupply;
        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), investorAmount);
        vm.expectRevert(
            abi.encodeWithSelector(ITreasury.AssetNotActive.selector, scenario.assetId, AssetLib.AssetStatus.Active)
        );
        earningsManager.distributeEarnings(scenario.assetId, EARNINGS_AMOUNT, true);
        vm.stopPrank();
    }

    function testDistributeEarningsMinimumProtocolFee() public {
        _ensureState(SetupState.BuffersFunded);

        uint256 maxSupply = roboshareTokens.getRevenueTokenMaxSupply(scenario.revenueTokenId);
        uint256 buyerBalance = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        uint256 totalAmount = (ProtocolLib.MIN_PROTOCOL_FEE * maxSupply) / buyerBalance;

        uint256 initialFeeBalance = treasury.pendingWithdrawals(config.treasuryFeeRecipient);

        _setupEarningsDistributed(totalAmount);

        uint256 finalFeeBalance = treasury.pendingWithdrawals(config.treasuryFeeRecipient);
        assertEq(finalFeeBalance, initialFeeBalance + ProtocolLib.MIN_PROTOCOL_FEE);
    }

    function testDistributeEarningsAmountLessThanMinimumFee() public {
        _ensureState(SetupState.BuffersFunded);
        uint256 insufficientEarningsAmount = ProtocolLib.MIN_PROTOCOL_FEE - 1;

        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), insufficientEarningsAmount);
        vm.expectRevert(ITreasury.EarningsLessThanMinimumFee.selector);
        earningsManager.distributeEarnings(scenario.assetId, insufficientEarningsAmount, false);
        vm.stopPrank();
    }

    function testDistributeEarningsWithoutAutoReleaseRefreshesLiquidationClockForProtectedImmediateProceedsPool()
        public
    {
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

        uint256 grossPrincipal = PRIMARY_PURCHASE_AMOUNT * REVENUE_TOKEN_PRICE;
        uint256 protocolFee = ProtocolLib.calculateProtocolFee(grossPrincipal);

        vm.startPrank(buyer);
        usdc.approve(address(marketplace), grossPrincipal + protocolFee);
        marketplace.buyFromPrimaryPool(revenueTokenId, PRIMARY_PURCHASE_AMOUNT);
        vm.stopPrank();

        uint256 requiredCollateral = _getTotalBufferRequirement(grossPrincipal, targetYieldBP, true);
        vm.prank(partner1);
        usdc.approve(address(treasury), requiredCollateral);
        vm.prank(partner1);
        treasury.enableProceeds(assetId);

        CollateralLib.CollateralInfo memory infoAfterEnable = _getCollateralInfo(assetId);
        assertEq(infoAfterEnable.baseCollateral, 0);
        assertGt(infoAfterEnable.earningsBuffer, 0);

        vm.warp(block.timestamp + 75 days);

        uint256 investorSupply = _getInvestorSupply(revenueTokenId, partner1);
        uint256 maxSupply = roboshareTokens.getRevenueTokenMaxSupply(revenueTokenId);
        uint256 totalRevenue = (ProtocolLib.MIN_PROTOCOL_FEE * maxSupply * 10) / investorSupply;

        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), totalRevenue);
        earningsManager.distributeEarnings(assetId, totalRevenue, false);
        vm.stopPrank();

        (,,,, uint256 earningsLastEventTimestamp,,,,) = earningsManager.assetEarnings(assetId);
        assertEq(earningsLastEventTimestamp, block.timestamp);

        vm.warp(block.timestamp + 20 days);

        (bool eligible, uint8 reason) = treasury.previewLiquidationEligibility(assetId);
        assertFalse(eligible);
        assertEq(reason, 3);
    }

    function testClaimEarningsThenWithdraw() public {
        _ensureState(SetupState.EarningsDistributed);

        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);

        vm.prank(buyer);
        earningsManager.claimEarnings(scenario.assetId);

        uint256 pendingBeforeWithdraw = treasury.pendingWithdrawals(buyer);
        assertGt(pendingBeforeWithdraw, 0);

        vm.prank(buyer);
        treasury.processWithdrawal();

        assertEq(usdc.balanceOf(buyer), buyerUsdcBefore + pendingBeforeWithdraw);
        assertEq(treasury.pendingWithdrawals(buyer), 0);
    }

    function testClaimEarningsThenWithdrawSettledAsset() public {
        _ensureState(SetupState.EarningsDistributed);

        vm.prank(partner1);
        assetRegistry.settleAsset(scenario.assetId, 0);

        vm.prank(buyer);
        router.claimSettlement(scenario.assetId, false);

        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);
        uint256 buyerPendingBefore = treasury.pendingWithdrawals(buyer);

        vm.prank(buyer);
        earningsManager.claimEarnings(scenario.assetId);

        uint256 earningsPending = treasury.pendingWithdrawals(buyer) - buyerPendingBefore;
        assertGt(earningsPending, 0);

        vm.prank(buyer);
        treasury.processWithdrawal();

        assertEq(usdc.balanceOf(buyer), buyerUsdcBefore + buyerPendingBefore + earningsPending);
    }

    function testClaimEarningsNoEarnings() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        vm.prank(buyer);
        vm.expectRevert(ITreasury.NoEarningsToClaim.selector);
        earningsManager.claimEarnings(scenario.assetId);
    }

    function testCompleteEarningsLifecycle() public {
        _ensureState(SetupState.EarningsDistributed);

        uint256 buyerInitialBalance = usdc.balanceOf(buyer);
        uint256 earningsAmount = EARNINGS_AMOUNT;

        uint256 buyerBalance = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId);
        uint256 investorTokens = _getInvestorSupply(scenario.revenueTokenId, partner1);
        uint256 investorAmount = _calculateInvestorAmountFromRevenue(scenario.revenueTokenId, partner1, earningsAmount);
        uint256 netEarnings = investorAmount - ProtocolLib.calculateProtocolFee(investorAmount);
        uint256 buyerShare = (netEarnings * buyerBalance) / investorTokens;

        vm.startPrank(buyer);
        vm.expectEmit(true, true, false, true, address(earningsManager));
        emit IEarningsManager.EarningsClaimed(scenario.assetId, buyer, buyerShare);
        earningsManager.claimEarnings(scenario.assetId);

        vm.expectEmit(true, false, false, true, address(treasury));
        emit ITreasury.WithdrawalProcessed(buyer, buyerShare);
        treasury.processWithdrawal();
        vm.stopPrank();

        assertEq(usdc.balanceOf(buyer), buyerInitialBalance + buyerShare);
    }

    function testFuzzDistributeEarnings(uint256 totalEarnings) public {
        totalEarnings = bound(totalEarnings, (10 * 1e6) + 1, 1e12 - 1);

        _ensureState(SetupState.BuffersFunded);
        _fundAddressWithUsdc(partner1, totalEarnings * 2);

        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), totalEarnings);

        uint256 treasuryBalanceBefore = usdc.balanceOf(address(treasury));

        earningsManager.distributeEarnings(scenario.assetId, totalEarnings, false);

        uint256 treasuryBalanceAfter = usdc.balanceOf(address(treasury));
        uint256 investorAmount = _calculateInvestorAmountFromRevenue(scenario.revenueTokenId, partner1, totalEarnings);

        assertEq(treasuryBalanceAfter, treasuryBalanceBefore + investorAmount);
        vm.stopPrank();
    }

    function testFuzzPreviewClaimMatchesClaimThenWithdraw(uint256 totalEarnings) public {
        totalEarnings = bound(totalEarnings, 1_000 * 1e6, 1e12 - 1);

        _ensureState(SetupState.BuffersFunded);
        _fundAddressWithUsdc(partner1, totalEarnings * 2);

        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), totalEarnings);
        earningsManager.distributeEarnings(scenario.assetId, totalEarnings, false);
        vm.stopPrank();

        uint256 preview = earningsManager.previewClaimEarnings(scenario.assetId, buyer);
        assertGt(preview, 0);

        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);

        vm.prank(buyer);
        earningsManager.claimEarnings(scenario.assetId);

        assertEq(treasury.pendingWithdrawals(buyer), preview);

        vm.prank(buyer);
        treasury.processWithdrawal();

        assertEq(treasury.pendingWithdrawals(buyer), 0);
        assertEq(usdc.balanceOf(buyer), buyerUsdcBefore + preview);
    }
}
