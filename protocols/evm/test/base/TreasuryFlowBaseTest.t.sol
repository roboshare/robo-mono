// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { AssetMetadataBaseTest } from "./AssetMetadataBaseTest.t.sol";
import { ProtocolLib, CollateralLib, TokenLib } from "../../contracts/Libraries.sol";

abstract contract TreasuryFlowBaseTest is AssetMetadataBaseTest {
    function _setupBuffersFunded() internal virtual override {
        uint256 baseAmount = _getCollateralInfo(scenario.assetId).baseCollateral;
        uint256 yieldBP = roboshareTokens.getTargetYieldBP(scenario.revenueTokenId);
        uint256 requiredCollateral = _getTotalBufferRequirement(baseAmount, yieldBP, false);
        vm.prank(partner1);
        usdc.approve(address(treasury), requiredCollateral);
        vm.prank(partner1);
        treasury.enableProceeds(scenario.assetId);
    }

    function _setupEarningsDistributed(uint256 totalEarningsAmount) internal virtual override {
        vm.startPrank(partner1);
        usdc.approve(address(earningsManager), totalEarningsAmount);
        earningsManager.distributeEarnings(scenario.assetId, totalEarningsAmount, false);
        vm.stopPrank();
    }

    function _setupAdditionalAssetAndPrimaryPool(address partner, string memory vin)
        internal
        returns (uint256 assetId, uint256 revenueTokenId, uint256 supply)
    {
        vm.prank(partner);
        assetId = assetRegistry.registerAsset(_vehicleRegistrationData(vin), ASSET_VALUE);

        supply = ASSET_VALUE / REVENUE_TOKEN_PRICE;
        uint256 maturityDate = block.timestamp + 365 days;

        vm.prank(partner);
        (revenueTokenId,) = assetRegistry.createRevenueTokenPool(
            assetId, REVENUE_TOKEN_PRICE, maturityDate, 10_000, 1_000, supply, false, false
        );
    }

    function _setupProtectedPoolWithPurchaseAndBuffers()
        internal
        virtual
        returns (uint256 assetId, uint256 revenueTokenId)
    {
        string memory vin = _generateVin(999);
        vm.prank(partner1);
        assetId = assetRegistry.registerAsset(_vehicleRegistrationData(vin), ASSET_VALUE);

        uint256 supply = ASSET_VALUE / REVENUE_TOKEN_PRICE;
        uint256 maturityDate = block.timestamp + 365 days;

        vm.prank(partner1);
        (revenueTokenId,) = assetRegistry.createRevenueTokenPool(
            assetId, REVENUE_TOKEN_PRICE, maturityDate, 10_000, 1_000, supply, false, true
        );

        _purchasePrimaryPoolTokens(buyer, revenueTokenId, PRIMARY_PURCHASE_AMOUNT);

        uint256 baseAmount = _getCollateralInfo(assetId).baseCollateral;
        uint256 yieldBP = roboshareTokens.getTargetYieldBP(revenueTokenId);
        uint256 requiredCollateral = _getTotalBufferRequirement(baseAmount, yieldBP, true);

        vm.prank(partner1);
        usdc.approve(address(treasury), requiredCollateral);
        vm.prank(partner1);
        treasury.enableProceeds(assetId);
    }

    function _purchasePrimaryForBaseAmount(address purchaser, uint256 revenueTokenId, uint256 baseAmount)
        internal
        returns (uint256 amount)
    {
        uint256 pricePerToken = roboshareTokens.getTokenPrice(revenueTokenId);
        assertEq(baseAmount % pricePerToken, 0, "Base amount must align with token price");
        amount = baseAmount / pricePerToken;
        _purchasePrimaryPoolTokens(purchaser, revenueTokenId, amount);
    }

    function _purchaseRemainingPrimarySupply(address purchaser, uint256 revenueTokenId)
        internal
        returns (uint256 amount)
    {
        uint256 currentSupply = roboshareTokens.getRevenueTokenSupply(revenueTokenId);
        uint256 maxSupply = roboshareTokens.getRevenueTokenMaxSupply(revenueTokenId);
        amount = maxSupply > currentSupply ? maxSupply - currentSupply : 0;
        _purchasePrimaryPoolTokens(purchaser, revenueTokenId, amount);
    }

    function _getInvestorSupply(uint256 revenueTokenId, address partner) internal view returns (uint256) {
        uint256 totalSupply = roboshareTokens.getRevenueTokenSupply(revenueTokenId);
        uint256 partnerBalance = roboshareTokens.balanceOf(partner, revenueTokenId);
        return totalSupply > partnerBalance ? totalSupply - partnerBalance : 0;
    }

    function _calculateInvestorAmountFromRevenue(uint256 revenueTokenId, address partner, uint256 totalRevenue)
        internal
        view
        returns (uint256 investorAmount)
    {
        uint256 investorTokens = _getInvestorSupply(revenueTokenId, partner);
        uint256 maxSupply = roboshareTokens.getRevenueTokenMaxSupply(revenueTokenId);
        uint256 revenueShareBP = roboshareTokens.getRevenueShareBP(revenueTokenId);
        uint256 cap = (totalRevenue * revenueShareBP) / ProtocolLib.BP_PRECISION;
        uint256 soldShare = (totalRevenue * investorTokens) / maxSupply;
        return soldShare < cap ? soldShare : cap;
    }

    function _assertCollateralState(uint256 assetId, uint256 expectedBase, uint256 expectedTotal, bool expectedLocked)
        internal
        view
    {
        CollateralLib.CollateralInfo memory info = _getCollateralInfo(assetId);
        assertEq(info.baseCollateral, expectedBase, "Base collateral mismatch");
        assertEq(_getCollateralTotal(info), expectedTotal, "Total collateral mismatch");
        assertEq(info.isLocked, expectedLocked, "Collateral locked state mismatch");
    }

    function _getCollateralTotal(CollateralLib.CollateralInfo memory info) internal pure returns (uint256) {
        return CollateralLib.getTotalCollateral(info.baseCollateral, info.earningsBuffer, info.protocolBuffer);
    }

    function _getCoveredBaseCollateral(uint256 assetId) internal view returns (uint256) {
        return _getCoveredBaseCollateral(assetId, TokenLib.getTokenIdFromAssetId(assetId));
    }

    function _getCoveredBaseCollateral(uint256 assetId, uint256 revenueTokenId) internal view returns (uint256) {
        CollateralLib.CollateralInfo memory info = _getCollateralInfo(assetId);
        return CollateralLib.calculateCoverableBaseCollateral(
            info,
            roboshareTokens.getTargetYieldBP(revenueTokenId),
            roboshareTokens.getRevenueTokenProtectionEnabled(revenueTokenId),
            roboshareTokens.getRevenueTokenImmediateProceedsEnabled(revenueTokenId)
        );
    }

    function _getCollateralInfo(uint256 assetId) internal view returns (CollateralLib.CollateralInfo memory info) {
        (
            info.unredeemedBasePrincipal,
            info.baseCollateral,
            info.earningsBuffer,
            info.protocolBuffer,
            info.isLocked,
            info.lockedAt,
            info.lastEventTimestamp,
            info.reservedForLiquidation,
            info.createdAt,
            info.releasedProtectedBase,
            info.releasedBaseCollateral
        ) = treasury.assetCollateral(assetId);
    }

    function _getTotalBufferRequirement(uint256 baseAmount, uint256 yieldBP, bool protectionEnabled)
        internal
        pure
        returns (uint256)
    {
        (, uint256 earningsBuffer, uint256 protocolBuffer,) =
            CollateralLib.calculateCollateralRequirements(baseAmount, ProtocolLib.QUARTERLY_INTERVAL, yieldBP);
        return protocolBuffer + (protectionEnabled ? earningsBuffer : 0);
    }

    function _calculateExpectedBuffers(uint256 baseAmount)
        internal
        pure
        returns (uint256 earningsBuffer, uint256 protocolBuffer, uint256 total)
    {
        uint256 expectedQuarterlyEarnings =
            (baseAmount * ProtocolLib.QUARTERLY_INTERVAL) / ProtocolLib.YEARLY_INTERVAL;
        earningsBuffer = (expectedQuarterlyEarnings * ProtocolLib.BENCHMARK_YIELD_BP) / ProtocolLib.BP_PRECISION;
        protocolBuffer = (expectedQuarterlyEarnings * ProtocolLib.PROTOCOL_FEE_BP) / ProtocolLib.BP_PRECISION;
        total = earningsBuffer + protocolBuffer;
    }

    function _grantBurnerRoleToSelf() internal {
        vm.startPrank(admin);
        roboshareTokens.grantRole(roboshareTokens.BURNER_ROLE(), address(this));
        vm.stopPrank();
    }

    function _burnRevenueTokenBalance(uint256 revenueTokenId, address holder) internal {
        uint256 balance = roboshareTokens.balanceOf(holder, revenueTokenId);
        if (balance > 0) {
            roboshareTokens.burn(holder, revenueTokenId, balance);
        }
    }
}
