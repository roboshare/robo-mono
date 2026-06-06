// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { MarketplaceFlowBaseTest } from "../base/MarketplaceFlowBaseTest.t.sol";

contract EarningsTransferRegressionIntegrationTest is MarketplaceFlowBaseTest {
    function setUp() public {
        _ensureState(SetupState.InitialAccountsSetup);
    }

    function testTransferredPositionsCannotClaimAlreadyClaimedHistoricalEarnings() public {
        _ensureState(SetupState.EarningsDistributed);

        vm.prank(buyer);
        earningsManager.claimEarnings(scenario.assetId);

        uint256 transferAmount = roboshareTokens.balanceOf(buyer, scenario.revenueTokenId) / 2;
        vm.prank(buyer);
        roboshareTokens.safeTransferFrom(buyer, partner2, scenario.revenueTokenId, transferAmount, "");

        assertEq(earningsManager.previewClaimEarnings(scenario.assetId, partner2), 0);
    }
}
