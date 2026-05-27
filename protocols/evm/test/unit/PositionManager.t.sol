// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { IERC1155 } from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import { Test } from "forge-std/Test.sol";
import { TokenLib } from "../../contracts/Libraries.sol";
import { IPositionManager } from "../../contracts/interfaces/IPositionManager.sol";
import { PositionManager } from "../../contracts/PositionManager.sol";

contract PositionManagerTest is Test {
    PositionManager public positionManager;

    address public admin = makeAddr("admin");
    address public registryRouter = makeAddr("registryRouter");
    address public roboshareTokens = makeAddr("roboshareTokens");
    address public partnerManager = makeAddr("partnerManager");
    address public marketplace = makeAddr("marketplace");
    address public treasury = makeAddr("treasury");
    address public usdc = makeAddr("usdc");
    address public unauthorized = makeAddr("unauthorized");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");

    uint256 private constant ASSET_ID = 101;
    uint256 private constant TOKEN_ID = 102;
    uint256 private constant TOKEN_PRICE = 10e6;

    bytes32 private constant PRIMARY_REASON = keccak256("primary");
    bytes32 private constant LISTING_REASON = keccak256("listing");
    bytes32 private constant REDEEM_REASON = keccak256("redeem");
    bytes32 private constant SETTLE_REASON = keccak256("settle");
    bytes32 private constant CLAIM_REASON = keccak256("claim");

    event PositionMutated(
        uint256 indexed assetId,
        uint256 indexed tokenId,
        address indexed account,
        uint256 amount,
        uint256 auxValue,
        IPositionManager.PositionMutationType mutationType,
        bytes32 reason
    );

    event ListingLocked(address indexed holder, uint256 indexed revenueTokenId, uint256 amount);
    event ListingUnlocked(address indexed holder, uint256 indexed revenueTokenId, uint256 amount);
    event LockedTransferSettled(
        address indexed from, address indexed to, uint256 indexed revenueTokenId, uint256 amount
    );
    event SalePenaltyBooked(
        uint256 indexed listingId, address indexed seller, uint256 indexed revenueTokenId, uint256 amount
    );

    event PositionLockUpdated(
        uint256 indexed assetId, uint256 indexed tokenId, address indexed account, uint256 lockUntil, bytes32 reason
    );

    event RedemptionStateUpdated(
        uint256 indexed tokenId,
        uint256 indexed epochId,
        uint256 redeemableSupply,
        uint256 backedPrincipal,
        bytes32 reason
    );

    event SettlementConfigured(
        uint256 indexed assetId,
        uint256 indexed epochId,
        uint256 settlementAmount,
        uint256 settlementPerToken,
        bytes32 reason
    );

    event SettlementClaimRecorded(
        uint256 indexed assetId,
        uint256 indexed tokenId,
        address indexed account,
        uint256 burnAmount,
        uint256 payout,
        bytes32 reason
    );

    event PrimaryRedemptionConsumed(
        uint256 indexed tokenId,
        uint256 indexed epochId,
        address indexed account,
        uint256 burnAmount,
        uint256 payout,
        bytes32 reason
    );

    function setUp() public {
        vm.etch(roboshareTokens, hex"00");
        positionManager =
            _deployPositionManager(admin, registryRouter, roboshareTokens, partnerManager, marketplace, treasury, usdc);
        _mockTokenPrice(TOKEN_ID, TOKEN_PRICE);
    }

    function testInitialization() public view {
        assertEq(positionManager.registryRouter(), registryRouter);
        assertEq(positionManager.roboshareTokens(), roboshareTokens);
        assertEq(positionManager.partnerManager(), partnerManager);
        assertEq(positionManager.marketplace(), marketplace);
        assertEq(positionManager.treasury(), treasury);
        assertEq(positionManager.usdc(), usdc);

        assertEq(positionManager.UPGRADER_ROLE(), keccak256("UPGRADER_ROLE"));
        assertEq(positionManager.POSITION_ADMIN_ROLE(), keccak256("POSITION_ADMIN_ROLE"));
        assertEq(positionManager.AUTHORIZED_ROUTER_ROLE(), keccak256("AUTHORIZED_ROUTER_ROLE"));
        assertEq(positionManager.AUTHORIZED_MARKETPLACE_ROLE(), keccak256("AUTHORIZED_MARKETPLACE_ROLE"));
        assertEq(positionManager.AUTHORIZED_TREASURY_ROLE(), keccak256("AUTHORIZED_TREASURY_ROLE"));

        assertTrue(positionManager.hasRole(positionManager.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(positionManager.hasRole(positionManager.UPGRADER_ROLE(), admin));
        assertTrue(positionManager.hasRole(positionManager.POSITION_ADMIN_ROLE(), admin));
        assertTrue(positionManager.hasRole(positionManager.AUTHORIZED_ROUTER_ROLE(), registryRouter));
        assertTrue(positionManager.hasRole(positionManager.AUTHORIZED_MARKETPLACE_ROLE(), marketplace));
        assertTrue(positionManager.hasRole(positionManager.AUTHORIZED_TREASURY_ROLE(), treasury));

        assertEq(
            positionManager.getRoleAdmin(positionManager.AUTHORIZED_ROUTER_ROLE()),
            positionManager.POSITION_ADMIN_ROLE()
        );
        assertEq(
            positionManager.getRoleAdmin(positionManager.AUTHORIZED_MARKETPLACE_ROLE()),
            positionManager.POSITION_ADMIN_ROLE()
        );
        assertEq(
            positionManager.getRoleAdmin(positionManager.AUTHORIZED_TREASURY_ROLE()),
            positionManager.POSITION_ADMIN_ROLE()
        );
    }

    function testInitializationZeroAddress() public {
        PositionManager implementation = new PositionManager();

        vm.expectRevert(IPositionManager.ZeroAddress.selector);
        new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(
                PositionManager.initialize,
                (admin, registryRouter, roboshareTokens, partnerManager, address(0), treasury, usdc)
            )
        );
    }

    function testPositionAdminCanRotateDependencyRoles() public {
        address newRouter = makeAddr("newRouter");
        address newMarketplace = makeAddr("newMarketplace");
        address newTreasury = makeAddr("newTreasury");

        vm.startPrank(admin);
        positionManager.updateRegistryRouter(newRouter);
        positionManager.updateMarketplace(newMarketplace);
        positionManager.updateTreasury(newTreasury);
        vm.stopPrank();

        assertEq(positionManager.registryRouter(), newRouter);
        assertEq(positionManager.marketplace(), newMarketplace);
        assertEq(positionManager.treasury(), newTreasury);

        assertFalse(positionManager.hasRole(positionManager.AUTHORIZED_ROUTER_ROLE(), registryRouter));
        assertFalse(positionManager.hasRole(positionManager.AUTHORIZED_MARKETPLACE_ROLE(), marketplace));
        assertFalse(positionManager.hasRole(positionManager.AUTHORIZED_TREASURY_ROLE(), treasury));
        assertTrue(positionManager.hasRole(positionManager.AUTHORIZED_ROUTER_ROLE(), newRouter));
        assertTrue(positionManager.hasRole(positionManager.AUTHORIZED_MARKETPLACE_ROLE(), newMarketplace));
        assertTrue(positionManager.hasRole(positionManager.AUTHORIZED_TREASURY_ROLE(), newTreasury));
    }

    function testUpdateMarketplaceZeroAddress() public {
        vm.expectRevert(IPositionManager.ZeroAddress.selector);
        vm.prank(admin);
        positionManager.updateMarketplace(address(0));
    }

    function testUpdateMarketplaceUnauthorizedCaller() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                unauthorized,
                positionManager.POSITION_ADMIN_ROLE()
            )
        );
        vm.prank(unauthorized);
        positionManager.updateMarketplace(makeAddr("newMarketplace"));
    }

    function testAuthorizedMarketplaceCanRecordPositionMutation() public {
        IPositionManager.PositionMutation memory mutation = IPositionManager.PositionMutation({
            assetId: ASSET_ID,
            tokenId: TOKEN_ID,
            account: alice,
            amount: 3,
            auxValue: 4,
            mutationType: IPositionManager.PositionMutationType.Mint,
            reason: PRIMARY_REASON
        });

        vm.expectEmit(true, true, true, true, address(positionManager));
        emit PositionMutated(
            mutation.assetId,
            mutation.tokenId,
            mutation.account,
            mutation.amount,
            mutation.auxValue,
            mutation.mutationType,
            mutation.reason
        );

        vm.prank(marketplace);
        positionManager.recordPositionMutation(mutation);
    }

    function testAuthorizedMarketplaceMintMutationStoresPosition() public {
        vm.prank(marketplace);
        positionManager.recordPositionMutation(
            IPositionManager.PositionMutation({
                assetId: ASSET_ID,
                tokenId: TOKEN_ID,
                account: alice,
                amount: 100,
                auxValue: 0,
                mutationType: IPositionManager.PositionMutationType.Mint,
                reason: PRIMARY_REASON
            })
        );

        TokenLib.TokenPosition[] memory positions = positionManager.getUserPositions(TOKEN_ID, alice);
        assertEq(positions.length, 1);
        assertEq(positions[0].uid, 0);
        assertEq(positions[0].tokenId, TOKEN_ID);
        assertEq(positions[0].amount, 100);
        assertGt(positions[0].acquiredAt, 0);
        assertEq(positions[0].soldAt, 0);
        assertEq(positions[0].redemptionEpoch, 0);
        assertEq(positionManager.getCurrentPrimaryRedemptionEpoch(TOKEN_ID), 0);
        assertEq(positionManager.getCurrentPrimaryRedemptionEpochSupply(TOKEN_ID), 100);
        assertEq(positionManager.getCurrentPrimaryRedemptionBackedPrincipal(TOKEN_ID), 100 * TOKEN_PRICE);
        assertEq(positionManager.getPrimaryRedemptionEligibleBalance(alice, TOKEN_ID), 100);
    }

    function testBeforeRevenueTokenUpdateMintStoresPosition() public {
        vm.prank(roboshareTokens);
        positionManager.beforeRevenueTokenUpdate(address(0), alice, TOKEN_ID, 80);

        TokenLib.TokenPosition[] memory positions = positionManager.getUserPositions(TOKEN_ID, alice);
        assertEq(positions.length, 1);
        assertEq(positions[0].uid, 0);
        assertEq(positions[0].tokenId, TOKEN_ID);
        assertEq(positions[0].amount, 80);
        assertGt(positions[0].acquiredAt, 0);
        assertEq(positions[0].soldAt, 0);
        assertEq(positions[0].redemptionEpoch, 0);
        assertEq(positionManager.getCurrentPrimaryRedemptionEpoch(TOKEN_ID), 0);
        assertEq(positionManager.getCurrentPrimaryRedemptionEpochSupply(TOKEN_ID), 80);
        assertEq(positionManager.getCurrentPrimaryRedemptionBackedPrincipal(TOKEN_ID), 80 * TOKEN_PRICE);
        assertEq(positionManager.getPrimaryRedemptionEligibleBalance(alice, TOKEN_ID), 80);
    }

    function testBeforeRevenueTokenUpdateTransferMovesFifoLotsAndBurnConsumesRecipientQueue() public {
        vm.prank(roboshareTokens);
        positionManager.beforeRevenueTokenUpdate(address(0), alice, TOKEN_ID, 100);
        vm.warp(block.timestamp + 1);
        vm.prank(roboshareTokens);
        positionManager.beforeRevenueTokenUpdate(address(0), alice, TOKEN_ID, 50);

        vm.warp(block.timestamp + 1);
        vm.prank(roboshareTokens);
        positionManager.beforeRevenueTokenUpdate(alice, bob, TOKEN_ID, 120);

        TokenLib.TokenPosition[] memory alicePositions = positionManager.getUserPositions(TOKEN_ID, alice);
        assertEq(alicePositions.length, 2);
        assertEq(alicePositions[0].amount, 0);
        assertEq(alicePositions[1].amount, 30);

        TokenLib.TokenPosition[] memory bobPositions = positionManager.getUserPositions(TOKEN_ID, bob);
        assertEq(bobPositions.length, 2);
        assertEq(bobPositions[0].amount, 100);
        assertEq(bobPositions[0].redemptionEpoch, 0);
        assertEq(bobPositions[1].amount, 20);
        assertEq(bobPositions[1].redemptionEpoch, 0);
        assertEq(bobPositions[0].acquiredAt, bobPositions[1].acquiredAt);
        assertGt(bobPositions[0].acquiredAt, alicePositions[1].acquiredAt);
        assertEq(positionManager.getCurrentPrimaryRedemptionEpochSupply(TOKEN_ID), 150);
        assertEq(positionManager.getCurrentPrimaryRedemptionBackedPrincipal(TOKEN_ID), 150 * TOKEN_PRICE);
        assertEq(positionManager.getPrimaryRedemptionEligibleBalance(alice, TOKEN_ID), 30);
        assertEq(positionManager.getPrimaryRedemptionEligibleBalance(bob, TOKEN_ID), 120);

        vm.warp(block.timestamp + 1);
        vm.prank(roboshareTokens);
        positionManager.beforeRevenueTokenUpdate(bob, address(0), TOKEN_ID, 110);

        bobPositions = positionManager.getUserPositions(TOKEN_ID, bob);
        assertEq(bobPositions.length, 2);
        assertEq(bobPositions[0].amount, 0);
        assertTrue(bobPositions[0].soldAt > 0);
        assertEq(bobPositions[1].amount, 10);
        assertEq(positionManager.getCurrentPrimaryRedemptionEpochSupply(TOKEN_ID), 40);
        assertEq(positionManager.getCurrentPrimaryRedemptionBackedPrincipal(TOKEN_ID), 150 * TOKEN_PRICE);
        assertEq(positionManager.getPrimaryRedemptionEligibleBalance(alice, TOKEN_ID), 30);
        assertEq(positionManager.getPrimaryRedemptionEligibleBalance(bob, TOKEN_ID), 10);
    }

    function testBeforeRevenueTokenUpdateTransferRevertsWhenSenderBalanceIsInsufficient() public {
        vm.prank(roboshareTokens);
        positionManager.beforeRevenueTokenUpdate(address(0), alice, TOKEN_ID, 50);

        vm.expectRevert(TokenLib.InsufficientTokenBalance.selector);
        vm.prank(roboshareTokens);
        positionManager.beforeRevenueTokenUpdate(alice, bob, TOKEN_ID, 51);

        TokenLib.TokenPosition[] memory alicePositions = positionManager.getUserPositions(TOKEN_ID, alice);
        TokenLib.TokenPosition[] memory bobPositions = positionManager.getUserPositions(TOKEN_ID, bob);
        assertEq(alicePositions.length, 1);
        assertEq(alicePositions[0].amount, 50);
        assertEq(bobPositions.length, 0);
        assertEq(positionManager.getCurrentPrimaryRedemptionEpochSupply(TOKEN_ID), 50);
        assertEq(positionManager.getCurrentPrimaryRedemptionBackedPrincipal(TOKEN_ID), 50 * TOKEN_PRICE);
    }

    function testTransferredPositionsRestartHoldingPeriodForBuyerPenalty() public {
        vm.prank(admin);
        positionManager.syncRevenueTokenPolicy(TOKEN_ID, TOKEN_PRICE, 30 days);

        vm.prank(roboshareTokens);
        positionManager.beforeRevenueTokenUpdate(address(0), alice, TOKEN_ID, 100);

        vm.warp(block.timestamp + 30 days + 1);
        vm.prank(roboshareTokens);
        positionManager.beforeRevenueTokenUpdate(alice, bob, TOKEN_ID, 100);

        _mockRevenueTokenBalance(bob, ASSET_ID, 0);

        assertGt(positionManager.getSalesPenalty(bob, TOKEN_ID, 100), 0);

        vm.warp(block.timestamp + 365 days);
        assertEq(positionManager.getSalesPenalty(bob, TOKEN_ID, 100), 0);
    }

    function testBurnConsumesPositionsFifo() public {
        vm.startPrank(marketplace);
        positionManager.recordPositionMutation(
            IPositionManager.PositionMutation({
                assetId: ASSET_ID,
                tokenId: TOKEN_ID,
                account: alice,
                amount: 100,
                auxValue: 0,
                mutationType: IPositionManager.PositionMutationType.Mint,
                reason: PRIMARY_REASON
            })
        );
        vm.warp(block.timestamp + 1);
        positionManager.recordPositionMutation(
            IPositionManager.PositionMutation({
                assetId: ASSET_ID,
                tokenId: TOKEN_ID,
                account: alice,
                amount: 50,
                auxValue: 0,
                mutationType: IPositionManager.PositionMutationType.Mint,
                reason: PRIMARY_REASON
            })
        );
        vm.warp(block.timestamp + 1);
        positionManager.recordPositionMutation(
            IPositionManager.PositionMutation({
                assetId: ASSET_ID,
                tokenId: TOKEN_ID,
                account: alice,
                amount: 120,
                auxValue: 0,
                mutationType: IPositionManager.PositionMutationType.Burn,
                reason: REDEEM_REASON
            })
        );
        vm.stopPrank();

        TokenLib.TokenPosition[] memory positions = positionManager.getUserPositions(TOKEN_ID, alice);
        assertEq(positions.length, 2);
        assertEq(positions[0].amount, 0);
        assertTrue(positions[0].soldAt > 0);
        assertEq(positions[1].amount, 30);
        assertEq(positionManager.getCurrentPrimaryRedemptionEpochSupply(TOKEN_ID), 30);
        assertEq(positionManager.getPrimaryRedemptionEligibleBalance(alice, TOKEN_ID), 30);
    }

    function testGetLockedAmountRevertsForNonRevenueToken() public {
        vm.expectRevert(IPositionManager.NotRevenueToken.selector);
        positionManager.getLockedAmount(alice, ASSET_ID);
    }

    function testLockForListingTracksAmount() public {
        _mockRevenueTokenBalance(alice, TOKEN_ID, 100);

        vm.expectEmit(true, true, false, true, address(positionManager));
        emit ListingLocked(alice, TOKEN_ID, 40);

        vm.prank(marketplace);
        positionManager.lockForListing(alice, TOKEN_ID, 40);

        assertEq(positionManager.getLockedAmount(alice, TOKEN_ID), 40);
        assertEq(positionManager.getAvailableAmount(alice, TOKEN_ID, 100), 60);
    }

    function testLockForListingRevertsWhenAmountIsZero() public {
        vm.expectRevert(IPositionManager.InvalidAmount.selector);
        vm.prank(marketplace);
        positionManager.lockForListing(alice, TOKEN_ID, 0);
    }

    function testLockForListingRevertsWhenUnlockedBalanceInsufficient() public {
        _mockRevenueTokenBalance(alice, TOKEN_ID, 100);

        vm.startPrank(marketplace);
        positionManager.lockForListing(alice, TOKEN_ID, 80);

        vm.expectRevert(IPositionManager.InsufficientUnlockedBalance.selector);
        positionManager.lockForListing(alice, TOKEN_ID, 21);
        vm.stopPrank();
    }

    function testLockForListingChecksRoboshareTokenBalance() public {
        _mockRevenueTokenBalance(alice, TOKEN_ID, 39);

        vm.expectRevert(IPositionManager.InsufficientUnlockedBalance.selector);
        vm.prank(marketplace);
        positionManager.lockForListing(alice, TOKEN_ID, 40);
    }

    function testUnlockForListingRevertsWhenLockedBalanceInsufficient() public {
        vm.expectRevert(IPositionManager.InsufficientLockedBalance.selector);
        vm.prank(marketplace);
        positionManager.unlockForListing(alice, TOKEN_ID, 1);
    }

    function testUnlockForListingRevertsWhenAmountIsZero() public {
        vm.expectRevert(IPositionManager.InvalidAmount.selector);
        vm.prank(marketplace);
        positionManager.unlockForListing(alice, TOKEN_ID, 0);
    }

    function testSettleLockedTransferConsumesLockBeforeTokenMove() public {
        _mockRevenueTokenBalance(alice, TOKEN_ID, 100);

        vm.prank(marketplace);
        positionManager.lockForListing(alice, TOKEN_ID, 55);

        vm.expectEmit(true, true, false, true, address(positionManager));
        emit ListingUnlocked(alice, TOKEN_ID, 20);
        vm.expectEmit(true, true, true, true, address(positionManager));
        emit LockedTransferSettled(alice, bob, TOKEN_ID, 20);

        vm.prank(marketplace);
        positionManager.settleLockedTransfer(alice, bob, TOKEN_ID, 20);

        assertEq(positionManager.getLockedAmount(alice, TOKEN_ID), 35);
    }

    function testSettleLockedTransferRevertsForInvalidMove() public {
        _mockRevenueTokenBalance(alice, TOKEN_ID, 100);

        vm.prank(marketplace);
        positionManager.lockForListing(alice, TOKEN_ID, 10);

        vm.expectRevert(IPositionManager.InsufficientLockedBalance.selector);
        vm.prank(marketplace);
        positionManager.settleLockedTransfer(alice, bob, TOKEN_ID, 11);
    }

    function testSettleLockedTransferRevertsWhenAmountIsZero() public {
        vm.expectRevert(IPositionManager.InvalidAmount.selector);
        vm.prank(marketplace);
        positionManager.settleLockedTransfer(alice, bob, TOKEN_ID, 0);
    }

    function testAuthorizedMarketplaceCanTransferLockedForListingViaTokenManager() public {
        vm.expectCall(
            roboshareTokens,
            abi.encodeWithSignature(
                "transferLockedForListing(address,address,uint256,uint256,bytes)", alice, bob, TOKEN_ID, 20, ""
            )
        );

        vm.prank(marketplace);
        positionManager.transferLockedForListing(alice, bob, TOKEN_ID, 20);
    }

    function testTransferLockedForListingUnauthorizedCaller() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                unauthorized,
                positionManager.AUTHORIZED_MARKETPLACE_ROLE()
            )
        );
        vm.prank(unauthorized);
        positionManager.transferLockedForListing(alice, bob, TOKEN_ID, 20);
    }

    function testTransferLockedForListingRevertsWhenRoboshareTokensIsNotContract() public {
        vm.prank(admin);
        positionManager.updateRoboshareTokens(unauthorized);

        vm.prank(marketplace);
        vm.expectRevert(abi.encodeWithSelector(IPositionManager.InvalidRoboshareTokens.selector, unauthorized));
        positionManager.transferLockedForListing(alice, bob, TOKEN_ID, 20);
    }

    function testAuthorizedRouterCanBurnCurrentEpochForPrimaryRedemption() public {
        vm.expectCall(
            roboshareTokens,
            abi.encodeWithSignature("managerBurnCurrentEpoch(address,uint256,uint256)", alice, TOKEN_ID, 10)
        );

        vm.prank(registryRouter);
        positionManager.burnCurrentEpochForPrimaryRedemption(alice, TOKEN_ID, 10);
    }

    function testBurnCurrentEpochForPrimaryRedemptionRevertsWhenAmountIsZero() public {
        vm.expectRevert(IPositionManager.InvalidAmount.selector);
        vm.prank(registryRouter);
        positionManager.burnCurrentEpochForPrimaryRedemption(alice, TOKEN_ID, 0);
    }

    function testBurnCurrentEpochForPrimaryRedemptionUnauthorizedCaller() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                unauthorized,
                positionManager.AUTHORIZED_ROUTER_ROLE()
            )
        );
        vm.prank(unauthorized);
        positionManager.burnCurrentEpochForPrimaryRedemption(alice, TOKEN_ID, 10);
    }

    function testBurnCurrentEpochForPrimaryRedemptionRevertsWhenRoboshareTokensIsNotContract() public {
        vm.prank(admin);
        positionManager.updateRoboshareTokens(unauthorized);

        vm.prank(registryRouter);
        vm.expectRevert(abi.encodeWithSelector(IPositionManager.InvalidRoboshareTokens.selector, unauthorized));
        positionManager.burnCurrentEpochForPrimaryRedemption(alice, TOKEN_ID, 10);
    }

    function testSalesPenaltyBookkeeping() public {
        uint256 listingId = 7;

        vm.expectEmit(true, true, true, true, address(positionManager));
        emit SalePenaltyBooked(listingId, alice, TOKEN_ID, 15e6);

        vm.prank(marketplace);
        positionManager.bookSalePenalty(listingId, alice, TOKEN_ID, 15e6);
        assertEq(positionManager.getSalePenalty(listingId), 15e6);

        vm.prank(marketplace);
        positionManager.clearSalePenalty(listingId);
        assertEq(positionManager.getSalePenalty(listingId), 0);
    }

    function testNonRevenueTokenPositionMutationReverts() public {
        vm.expectRevert(IPositionManager.NotRevenueToken.selector);
        vm.prank(marketplace);
        positionManager.recordPositionMutation(
            IPositionManager.PositionMutation({
                assetId: ASSET_ID,
                tokenId: ASSET_ID,
                account: alice,
                amount: 1,
                auxValue: 0,
                mutationType: IPositionManager.PositionMutationType.Mint,
                reason: PRIMARY_REASON
            })
        );
    }

    function testTransferMutationsRevertUntilHookShapeIsImplemented() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IPositionManager.UnsupportedPositionMutation.selector, IPositionManager.PositionMutationType.TransferOut
            )
        );
        vm.prank(marketplace);
        positionManager.recordPositionMutation(
            IPositionManager.PositionMutation({
                assetId: ASSET_ID,
                tokenId: TOKEN_ID,
                account: alice,
                amount: 1,
                auxValue: 0,
                mutationType: IPositionManager.PositionMutationType.TransferOut,
                reason: LISTING_REASON
            })
        );
    }

    function testUnauthorizedCallerCannotRecordPositionMutation() public {
        IPositionManager.PositionMutation memory mutation = IPositionManager.PositionMutation({
            assetId: ASSET_ID,
            tokenId: TOKEN_ID,
            account: alice,
            amount: 3,
            auxValue: 4,
            mutationType: IPositionManager.PositionMutationType.Mint,
            reason: PRIMARY_REASON
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                unauthorized,
                positionManager.AUTHORIZED_MARKETPLACE_ROLE()
            )
        );
        vm.prank(unauthorized);
        positionManager.recordPositionMutation(mutation);
    }

    function testUnauthorizedCallerCannotLockForListing() public {
        vm.expectRevert(abi.encodeWithSelector(IPositionManager.UnauthorizedTokenHookCaller.selector, unauthorized));
        vm.prank(unauthorized);
        positionManager.lockForListing(alice, TOKEN_ID, 1);
    }

    function testAuthorizedRouterCanRecordPositionLock() public {
        vm.expectEmit(true, true, true, true, address(positionManager));
        emit PositionLockUpdated(ASSET_ID, TOKEN_ID, alice, block.timestamp + 1 days, LISTING_REASON);

        vm.prank(registryRouter);
        positionManager.recordPositionLock(ASSET_ID, TOKEN_ID, alice, block.timestamp + 1 days, LISTING_REASON);
    }

    function testAuthorizedTreasuryCanRecordRedemptionAndSettlementEvents() public {
        vm.startPrank(treasury);

        vm.expectEmit(true, true, false, true, address(positionManager));
        emit RedemptionStateUpdated(TOKEN_ID, 1, 100, 1000, REDEEM_REASON);
        positionManager.recordRedemptionEpoch(TOKEN_ID, 1, 100, 1000, REDEEM_REASON);

        vm.expectEmit(true, true, false, true, address(positionManager));
        emit SettlementConfigured(ASSET_ID, 1, 1000, 10, SETTLE_REASON);
        positionManager.recordSettlement(ASSET_ID, 1, 1000, 10, SETTLE_REASON);

        vm.expectEmit(true, true, true, true, address(positionManager));
        emit SettlementClaimRecorded(ASSET_ID, TOKEN_ID, alice, 20, 200, CLAIM_REASON);
        positionManager.recordSettlementClaim(ASSET_ID, TOKEN_ID, alice, 20, 200, CLAIM_REASON);

        vm.stopPrank();
    }

    function testConsumePrimaryRedemptionDoesNotDoubleConsumeBurnHookState() public {
        vm.prank(treasury);
        positionManager.recordRedemptionEpoch(TOKEN_ID, 2, 0, 0, REDEEM_REASON);

        vm.prank(marketplace);
        positionManager.recordPositionMutation(
            IPositionManager.PositionMutation({
                assetId: ASSET_ID,
                tokenId: TOKEN_ID,
                account: alice,
                amount: 100,
                auxValue: 0,
                mutationType: IPositionManager.PositionMutationType.Mint,
                reason: PRIMARY_REASON
            })
        );

        vm.prank(roboshareTokens);
        positionManager.beforeRevenueTokenUpdate(alice, address(0), TOKEN_ID, 40);

        TokenLib.TokenPosition[] memory positionsAfterBurn = positionManager.getUserPositions(TOKEN_ID, alice);
        assertEq(positionsAfterBurn[0].amount, 60);
        assertEq(positionManager.getPrimaryRedemptionEligibleBalance(alice, TOKEN_ID), 60);
        assertEq(positionManager.getCurrentPrimaryRedemptionEpochSupply(TOKEN_ID), 60);
        assertEq(positionManager.getCurrentPrimaryRedemptionBackedPrincipal(TOKEN_ID), 100 * TOKEN_PRICE);

        vm.expectEmit(true, true, true, true, address(positionManager));
        emit PrimaryRedemptionConsumed(TOKEN_ID, 2, alice, 40, 40 * TOKEN_PRICE, REDEEM_REASON);
        vm.expectEmit(true, true, false, true, address(positionManager));
        emit RedemptionStateUpdated(TOKEN_ID, 2, 60, 60 * TOKEN_PRICE, REDEEM_REASON);

        vm.prank(treasury);
        positionManager.consumePrimaryRedemption(alice, TOKEN_ID, 40, 40 * TOKEN_PRICE, REDEEM_REASON);

        TokenLib.TokenPosition[] memory positions = positionManager.getUserPositions(TOKEN_ID, alice);
        assertEq(positions[0].amount, 60);
        assertEq(positionManager.getPrimaryRedemptionEligibleBalance(alice, TOKEN_ID), 60);
        assertEq(positionManager.getCurrentPrimaryRedemptionEpoch(TOKEN_ID), 2);
        assertEq(positionManager.getCurrentPrimaryRedemptionEpochSupply(TOKEN_ID), 60);
        assertEq(positionManager.getCurrentPrimaryRedemptionBackedPrincipal(TOKEN_ID), 60 * TOKEN_PRICE);
    }

    function testRecordImmediateProceedsReleaseReducesBackedPrincipal() public {
        vm.prank(marketplace);
        positionManager.recordPositionMutation(
            IPositionManager.PositionMutation({
                assetId: ASSET_ID,
                tokenId: TOKEN_ID,
                account: alice,
                amount: 100,
                auxValue: 0,
                mutationType: IPositionManager.PositionMutationType.Mint,
                reason: PRIMARY_REASON
            })
        );

        vm.expectEmit(true, true, false, true, address(positionManager));
        emit RedemptionStateUpdated(TOKEN_ID, 0, 100, 60 * TOKEN_PRICE, REDEEM_REASON);

        vm.prank(treasury);
        positionManager.recordImmediateProceedsRelease(TOKEN_ID, 40 * TOKEN_PRICE, REDEEM_REASON);

        assertEq(positionManager.getCurrentPrimaryRedemptionEpoch(TOKEN_ID), 0);
        assertEq(positionManager.getCurrentPrimaryRedemptionEpochSupply(TOKEN_ID), 100);
        assertEq(positionManager.getCurrentPrimaryRedemptionBackedPrincipal(TOKEN_ID), 60 * TOKEN_PRICE);
    }

    function testAuthorizedRouterCanRecordImmediateProceedsRelease() public {
        vm.prank(marketplace);
        positionManager.recordPositionMutation(
            IPositionManager.PositionMutation({
                assetId: ASSET_ID,
                tokenId: TOKEN_ID,
                account: alice,
                amount: 100,
                auxValue: 0,
                mutationType: IPositionManager.PositionMutationType.Mint,
                reason: PRIMARY_REASON
            })
        );

        vm.prank(registryRouter);
        positionManager.recordImmediateProceedsRelease(TOKEN_ID, 25 * TOKEN_PRICE, REDEEM_REASON);

        assertEq(positionManager.getCurrentPrimaryRedemptionBackedPrincipal(TOKEN_ID), 75 * TOKEN_PRICE);
    }

    function testUnauthorizedCallerCannotRecordImmediateProceedsRelease() public {
        vm.expectRevert(abi.encodeWithSelector(IPositionManager.UnauthorizedTokenHookCaller.selector, unauthorized));
        vm.prank(unauthorized);
        positionManager.recordImmediateProceedsRelease(TOKEN_ID, TOKEN_PRICE, REDEEM_REASON);
    }

    function testSettlementStateTracksClaimTotals() public {
        vm.startPrank(treasury);
        positionManager.recordSettlement(ASSET_ID, 4, 900, 9, SETTLE_REASON);
        assertEq(positionManager.previewSettlementClaim(ASSET_ID, 25), 225);

        positionManager.recordSettlementClaim(ASSET_ID, TOKEN_ID, alice, 20, 180, CLAIM_REASON);
        positionManager.recordSettlementClaim(ASSET_ID, TOKEN_ID, alice, 5, 45, CLAIM_REASON);
        vm.stopPrank();

        IPositionManager.SettlementState memory settlement = positionManager.getSettlementState(ASSET_ID);
        assertTrue(settlement.isConfigured);
        assertEq(settlement.epochId, 4);
        assertEq(settlement.settlementAmount, 900);
        assertEq(settlement.settlementPerToken, 9);
        assertEq(settlement.claimedBurnAmount, 25);
        assertEq(settlement.claimedPayout, 225);

        IPositionManager.SettlementClaimState memory claimState =
            positionManager.getSettlementClaimState(ASSET_ID, alice);
        assertEq(claimState.burnedAmount, 25);
        assertEq(claimState.payout, 225);
    }

    function testCreditSettlementClaimUsesConfiguredSettlementRate() public {
        vm.prank(treasury);
        positionManager.recordSettlement(ASSET_ID, 4, 900, 9, SETTLE_REASON);

        vm.expectEmit(true, true, true, true, address(positionManager));
        emit SettlementClaimRecorded(ASSET_ID, TOKEN_ID, alice, 20, 180, CLAIM_REASON);

        vm.prank(treasury);
        uint256 payout = positionManager.creditSettlementClaim(alice, ASSET_ID, 20, CLAIM_REASON);

        assertEq(payout, 180);

        IPositionManager.SettlementState memory settlement = positionManager.getSettlementState(ASSET_ID);
        assertEq(settlement.claimedBurnAmount, 20);
        assertEq(settlement.claimedPayout, 180);

        IPositionManager.SettlementClaimState memory claimState =
            positionManager.getSettlementClaimState(ASSET_ID, alice);
        assertEq(claimState.burnedAmount, 20);
        assertEq(claimState.payout, 180);
    }

    function testCreditSettlementClaimReturnsZeroForZeroBurnAmount() public {
        vm.prank(treasury);
        positionManager.recordSettlement(ASSET_ID, 4, 900, 9, SETTLE_REASON);

        vm.prank(treasury);
        uint256 payout = positionManager.creditSettlementClaim(alice, ASSET_ID, 0, CLAIM_REASON);

        assertEq(payout, 0);

        IPositionManager.SettlementState memory settlement = positionManager.getSettlementState(ASSET_ID);
        assertEq(settlement.claimedBurnAmount, 0);
        assertEq(settlement.claimedPayout, 0);

        IPositionManager.SettlementClaimState memory claimState =
            positionManager.getSettlementClaimState(ASSET_ID, alice);
        assertEq(claimState.burnedAmount, 0);
        assertEq(claimState.payout, 0);
    }

    function testCreditSettlementClaimRevertsWhenSettlementNotConfigured() public {
        vm.expectRevert(abi.encodeWithSelector(IPositionManager.SettlementNotConfigured.selector, ASSET_ID));
        vm.prank(treasury);
        positionManager.creditSettlementClaim(alice, ASSET_ID, 1, CLAIM_REASON);
    }

    function testSettlementClaimsResetAcrossEpochs() public {
        vm.startPrank(treasury);
        positionManager.recordSettlement(ASSET_ID, 4, 900, 9, SETTLE_REASON);
        positionManager.recordSettlementClaim(ASSET_ID, TOKEN_ID, alice, 20, 180, CLAIM_REASON);

        positionManager.recordSettlement(ASSET_ID, 5, 500, 5, SETTLE_REASON);
        vm.stopPrank();

        IPositionManager.SettlementState memory settlement = positionManager.getSettlementState(ASSET_ID);
        assertTrue(settlement.isConfigured);
        assertEq(settlement.epochId, 5);
        assertEq(settlement.settlementAmount, 500);
        assertEq(settlement.settlementPerToken, 5);
        assertEq(settlement.claimedBurnAmount, 0);
        assertEq(settlement.claimedPayout, 0);

        IPositionManager.SettlementClaimState memory claimState =
            positionManager.getSettlementClaimState(ASSET_ID, alice);
        assertEq(claimState.burnedAmount, 0);
        assertEq(claimState.payout, 0);

        assertEq(positionManager.previewSettlementClaim(ASSET_ID, 10), 50);
    }

    function testUpgradeAuthorizedCaller() public {
        PositionManager newImplementation = new PositionManager();

        vm.prank(admin);
        positionManager.upgradeToAndCall(address(newImplementation), "");
    }

    function testUpgradeUnauthorizedCaller() public {
        PositionManager newImplementation = new PositionManager();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, positionManager.UPGRADER_ROLE()
            )
        );
        vm.prank(unauthorized);
        positionManager.upgradeToAndCall(address(newImplementation), "");
    }

    function _deployPositionManager(
        address _admin,
        address _registryRouter,
        address _roboshareTokens,
        address _partnerManager,
        address _marketplace,
        address _treasury,
        address _usdc
    ) internal returns (PositionManager) {
        PositionManager implementation = new PositionManager();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(
                PositionManager.initialize,
                (_admin, _registryRouter, _roboshareTokens, _partnerManager, _marketplace, _treasury, _usdc)
            )
        );

        return PositionManager(address(proxy));
    }

    function _mockRevenueTokenBalance(address holder, uint256 tokenId, uint256 balance) internal {
        vm.mockCall(roboshareTokens, abi.encodeCall(IERC1155.balanceOf, (holder, tokenId)), abi.encode(balance));
    }

    function _mockTokenPrice(uint256 tokenId, uint256 price) internal {
        vm.mockCall(roboshareTokens, abi.encodeWithSignature("getTokenPrice(uint256)", tokenId), abi.encode(price));
    }
}
