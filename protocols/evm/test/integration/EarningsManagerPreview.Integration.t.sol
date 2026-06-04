// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { MarketplaceFlowBaseTest } from "../base/MarketplaceFlowBaseTest.t.sol";
import { ProtocolLib, TokenLib } from "../../contracts/Libraries.sol";
import { IPositionManager } from "../../contracts/interfaces/IPositionManager.sol";

contract EarningsManagerPreviewIntegrationTest is MarketplaceFlowBaseTest {
    function setUp() public {
        _ensureState(SetupState.InitialAccountsSetup);
    }

    function testPreviewDistributeEarningsZeroRevenueReturnsZeros() public {
        _ensureState(SetupState.BuffersFunded);

        (uint256 investorAmount, uint256 protocolFee, uint256 netEarnings, uint256 collateralReleased) =
            earningsManager.previewDistributeEarnings(partner1, scenario.assetId, 0, true);

        assertEq(investorAmount, 0);
        assertEq(protocolFee, 0);
        assertEq(netEarnings, 0);
        assertEq(collateralReleased, 0);
    }

    function testPreviewDistributeEarningsNonEarningStatusReturnsZeros() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        (uint256 investorAmount, uint256 protocolFee, uint256 netEarnings, uint256 collateralReleased) =
            earningsManager.previewDistributeEarnings(partner1, scenario.assetId, EARNINGS_AMOUNT, true);

        assertEq(investorAmount, 0);
        assertEq(protocolFee, 0);
        assertEq(netEarnings, 0);
        assertEq(collateralReleased, 0);
    }

    function testPreviewDistributeEarningsNoInvestorsPartnerHoldsAllOutstandingTokensReturnsZeros() public {
        _ensureState(SetupState.BuffersFunded);
        _ensureSecondaryListingScenario();

        vm.prank(buyer);
        roboshareTokens.safeTransferFrom(buyer, partner1, scenario.revenueTokenId, PRIMARY_PURCHASE_AMOUNT, "");
        vm.prank(partner1);
        marketplace.endListing(scenario.listingId);

        (uint256 investorAmount, uint256 protocolFee, uint256 netEarnings, uint256 collateralReleased) =
            earningsManager.previewDistributeEarnings(partner1, scenario.assetId, EARNINGS_AMOUNT, true);

        assertEq(investorAmount, 0);
        assertEq(protocolFee, 0);
        assertEq(netEarnings, 0);
        assertEq(collateralReleased, 0);
    }

    function testPreviewDistributeEarningsUsesTokenBalanceGateBeforeManagerPositions() public {
        _ensureState(SetupState.BuffersFunded);

        uint256 totalSupply = roboshareTokens.getRevenueTokenSupply(scenario.revenueTokenId);
        TokenLib.TokenPosition[] memory positions = new TokenLib.TokenPosition[](1);
        positions[0] = TokenLib.TokenPosition({
            uid: 1,
            tokenId: scenario.revenueTokenId,
            amount: totalSupply,
            acquiredAt: block.timestamp,
            soldAt: 0,
            redemptionEpoch: 0
        });

        address mockManager = makeAddr("mockManager");
        vm.mockCall(address(roboshareTokens), abi.encodeWithSignature("positionManager()"), abi.encode(mockManager));
        vm.mockCall(
            mockManager,
            abi.encodeWithSelector(IPositionManager.getUserPositions.selector, scenario.revenueTokenId, partner1),
            abi.encode(positions)
        );

        (uint256 investorAmount, uint256 protocolFee, uint256 netEarnings,) =
            earningsManager.previewDistributeEarnings(partner1, scenario.assetId, EARNINGS_AMOUNT, true);

        assertGt(investorAmount, 0);
        assertGt(netEarnings, 0);
        assertEq(netEarnings, investorAmount - protocolFee);
        assertEq(protocolFee, ProtocolLib.calculateProtocolFee(investorAmount));
    }

    function testPreviewDistributeEarningsBelowMinimumFeeReturnsInvestorAmountOnly() public {
        _ensureState(SetupState.BuffersFunded);

        uint256 investorSupply = _getInvestorSupply(scenario.revenueTokenId, partner1);
        uint256 maxSupply = roboshareTokens.getRevenueTokenMaxSupply(scenario.revenueTokenId);
        uint256 totalRevenue = (maxSupply + investorSupply - 1) / investorSupply;

        (uint256 investorAmount, uint256 protocolFee, uint256 netEarnings, uint256 collateralReleased) =
            earningsManager.previewDistributeEarnings(partner1, scenario.assetId, totalRevenue, true);

        assertGt(investorAmount, 0);
        assertLt(investorAmount, ProtocolLib.MIN_PROTOCOL_FEE);
        assertEq(protocolFee, 0);
        assertEq(netEarnings, 0);
        assertEq(collateralReleased, 0);
    }

    function testPreviewDistributeEarningsCapsInvestorAmountToRevenueShare() public {
        string memory vin = _generateVin(777);
        vm.prank(partner1);
        uint256 assetId = assetRegistry.registerAsset(_vehicleRegistrationData(vin), ASSET_VALUE);

        uint256 supply = ASSET_VALUE / REVENUE_TOKEN_PRICE;
        uint256 maturityDate = block.timestamp + 365 days;

        vm.prank(partner1);
        (uint256 revenueTokenId,) = assetRegistry.createRevenueTokenPool(
            assetId, REVENUE_TOKEN_PRICE, maturityDate, 500, 1_000, supply, false, false
        );

        _purchasePrimaryPoolTokens(buyer, revenueTokenId, PRIMARY_PURCHASE_AMOUNT);

        uint256 baseAmount = _getCollateralInfo(assetId).baseCollateral;
        uint256 yieldBP = roboshareTokens.getTargetYieldBP(revenueTokenId);
        uint256 requiredCollateral = _getTotalBufferRequirement(baseAmount, yieldBP, false);

        vm.prank(partner1);
        usdc.approve(address(treasury), requiredCollateral);
        vm.prank(partner1);
        treasury.enableProceeds(assetId);

        uint256 totalRevenue = LARGE_EARNINGS_AMOUNT;
        uint256 expectedCap = (totalRevenue * 500) / ProtocolLib.BP_PRECISION;

        (uint256 investorAmount,,,) = earningsManager.previewDistributeEarnings(partner1, assetId, totalRevenue, false);

        assertEq(investorAmount, expectedCap);
    }
}
