// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { TreasuryFlowBaseTest } from "./TreasuryFlowBaseTest.t.sol";
import { Marketplace } from "../../contracts/Marketplace.sol";

abstract contract MarketplaceFlowBaseTest is TreasuryFlowBaseTest {
    struct BalanceSnapshot {
        uint256 partnerUsdc;
        uint256 buyerUsdc;
        uint256 treasuryFeeRecipientUsdc;
        uint256 treasuryContractUsdc;
        uint256 marketplaceContractUsdc;
        uint256 partnerTokens;
        uint256 buyerTokens;
        uint256 timestamp;
    }

    function _setupSecondaryListingScenario() internal returns (uint256 listingId) {
        _ensureState(SetupState.PrimaryPoolCreated);

        _purchasePrimaryPoolTokens(partner1, scenario.revenueTokenId, SECONDARY_LISTING_AMOUNT);

        vm.startPrank(partner1);
        roboshareTokens.setApprovalForAll(address(marketplace), true);
        listingId = marketplace.createListing(
            scenario.revenueTokenId, SECONDARY_LISTING_AMOUNT, REVENUE_TOKEN_PRICE, LISTING_DURATION, true
        );
        vm.stopPrank();
    }

    function _ensureSecondaryListingScenario() internal returns (uint256 listingId) {
        if (scenario.listingId != 0) {
            return scenario.listingId;
        }

        scenario.listingId = _setupSecondaryListingScenario();
        return scenario.listingId;
    }

    function _warpToListingExpiry(uint256 listingId) internal {
        Marketplace.Listing memory listing = marketplace.getListing(listingId);
        vm.warp(listing.expiresAt + 1);
    }

    function _warpPastHoldingPeriod() internal {
        vm.warp(block.timestamp + 30 days + 1);
    }

    function _warpToTimeOffset(uint256 offsetSeconds) internal {
        vm.warp(block.timestamp + offsetSeconds);
    }

    function _assertListingState(
        uint256 listingId,
        uint256 expectedTokenId,
        uint256 expectedAmount,
        uint256 expectedPrice,
        address expectedSeller,
        bool expectedActive,
        bool expectedBuyerPaysFee
    ) internal view {
        Marketplace.Listing memory listing = marketplace.getListing(listingId);
        assertEq(listing.tokenId, expectedTokenId, "Listing token ID mismatch");
        assertEq(listing.amount, expectedAmount, "Listing amount mismatch");
        assertEq(listing.pricePerToken, expectedPrice, "Listing price mismatch");
        assertEq(listing.seller, expectedSeller, "Listing seller mismatch");
        assertEq(listing.isActive, expectedActive, "Listing active state mismatch");
        assertEq(listing.buyerPaysFee, expectedBuyerPaysFee, "Listing fee payer mismatch");
    }

    function _assertTokenBalance(address account, uint256 tokenId, uint256 expectedBalance, string memory message)
        internal
        view
    {
        uint256 actualBalance = roboshareTokens.balanceOf(account, tokenId);
        assertEq(actualBalance, expectedBalance, message);
    }

    function _assertUsdcBalance(address account, uint256 expectedBalance, string memory message) internal view {
        uint256 actualBalance = usdc.balanceOf(account);
        assertEq(actualBalance, expectedBalance, message);
    }

    function _takeBalanceSnapshot(uint256 tokenId) internal view returns (BalanceSnapshot memory snapshot) {
        snapshot.partnerUsdc = usdc.balanceOf(partner1);
        snapshot.buyerUsdc = usdc.balanceOf(buyer);
        snapshot.treasuryFeeRecipientUsdc = usdc.balanceOf(config.treasuryFeeRecipient);
        snapshot.treasuryContractUsdc = usdc.balanceOf(address(treasury));
        snapshot.marketplaceContractUsdc = usdc.balanceOf(address(marketplace));
        snapshot.partnerTokens = roboshareTokens.balanceOf(partner1, tokenId);
        snapshot.buyerTokens = roboshareTokens.balanceOf(buyer, tokenId);
        snapshot.timestamp = block.timestamp;
    }

    function _assertBalanceChanges(
        BalanceSnapshot memory beforeSnapshot,
        BalanceSnapshot memory afterSnapshot,
        int256 expectedPartnerUsdcChange,
        int256 expectedBuyerUsdcChange,
        int256 expectedTreasuryFeeRecipientUsdcChange,
        int256 expectedTreasuryContractUsdcChange,
        int256 expectedMarketplaceContractUsdcChange,
        int256 expectedPartnerTokenChange,
        int256 expectedBuyerTokenChange
    ) internal pure {
        assertEq(
            int256(afterSnapshot.partnerUsdc) - int256(beforeSnapshot.partnerUsdc),
            expectedPartnerUsdcChange,
            "Partner USDC change mismatch"
        );
        assertEq(
            int256(afterSnapshot.buyerUsdc) - int256(beforeSnapshot.buyerUsdc),
            expectedBuyerUsdcChange,
            "Buyer USDC change mismatch"
        );
        assertEq(
            int256(afterSnapshot.treasuryFeeRecipientUsdc) - int256(beforeSnapshot.treasuryFeeRecipientUsdc),
            expectedTreasuryFeeRecipientUsdcChange,
            "Treasury Fee Recipient USDC change mismatch"
        );
        assertEq(
            int256(afterSnapshot.treasuryContractUsdc) - int256(beforeSnapshot.treasuryContractUsdc),
            expectedTreasuryContractUsdcChange,
            "Treasury Contract USDC change mismatch"
        );
        assertEq(
            int256(afterSnapshot.marketplaceContractUsdc) - int256(beforeSnapshot.marketplaceContractUsdc),
            expectedMarketplaceContractUsdcChange,
            "Marketplace Contract USDC change mismatch"
        );
        assertEq(
            int256(afterSnapshot.partnerTokens) - int256(beforeSnapshot.partnerTokens),
            expectedPartnerTokenChange,
            "Partner token change mismatch"
        );
        assertEq(
            int256(afterSnapshot.buyerTokens) - int256(beforeSnapshot.buyerTokens),
            expectedBuyerTokenChange,
            "Buyer token change mismatch"
        );
    }

    function _expectRevenueTokensTradedEvent(
        uint256 revenueTokenId,
        address from,
        address to,
        uint256 amount,
        uint256 listingId,
        uint256 totalPrice
    ) internal {
        vm.expectEmit(true, true, true, true, address(marketplace));
        emit Marketplace.RevenueTokensTraded(revenueTokenId, from, to, amount, listingId, totalPrice);
    }

    function _setupInsufficientFunds(address account, uint256 neededAmount) internal {
        uint256 currentBalance = usdc.balanceOf(account);
        if (currentBalance >= neededAmount / 2) {
            vm.prank(account);
            bool ok = usdc.transfer(makeAddr("drain"), currentBalance - (neededAmount / 3));
            require(ok, "drain transfer failed");
        }
    }

    function _setupExpiredListing(uint256 listingId) internal {
        _warpToListingExpiry(listingId);
    }

    function _getListingCount(uint256 assetId) internal view returns (uint256) {
        return marketplace.getAssetListings(assetId).length;
    }
}
