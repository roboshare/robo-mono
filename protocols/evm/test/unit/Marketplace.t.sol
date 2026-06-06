// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { AssetMetadataBaseTest } from "../base/AssetMetadataBaseTest.t.sol";
import { MockUSDC } from "../../contracts/mocks/MockUSDC.sol";
import { RoboshareTokens } from "../../contracts/RoboshareTokens.sol";
import { PartnerManager } from "../../contracts/PartnerManager.sol";
import { RegistryRouter } from "../../contracts/RegistryRouter.sol";
import { Treasury } from "../../contracts/Treasury.sol";
import { Marketplace } from "../../contracts/Marketplace.sol";
import { IPositionManager } from "../../contracts/interfaces/IPositionManager.sol";

contract MarketplaceBadTotalSupplyToken {
    function totalSupply() external pure returns (uint256) {
        revert("bad totalSupply");
    }
}

contract MarketplaceBadDecimalsToken {
    function totalSupply() external pure returns (uint256) {
        return 1;
    }

    function decimals() external pure returns (uint8) {
        revert("bad decimals");
    }
}

contract MarketplaceWrongDecimalsToken {
    function totalSupply() external pure returns (uint256) {
        return 1;
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }
}

contract MarketplaceInternalHarness is Marketplace {
    function exposeTransferUSDCFromBuyer(address buyer, address recipient, uint256 amount) external {
        _transferUSDCFromBuyer(buyer, recipient, amount);
    }

    function exposeTransferUSDC(address recipient, uint256 amount) external {
        _transferUSDC(recipient, amount);
    }

    function exposeRouteProtocolFee(uint256 amount) external {
        _routeProtocolFee(amount);
    }
}

contract MarketplaceRoboshareTokensStub {
    IPositionManager internal _positionManager;
    uint256 internal _supply;
    uint256 internal _penalty;
    mapping(address => mapping(uint256 => uint256)) internal _balances;

    function setPositionManager(address manager) external {
        _positionManager = IPositionManager(manager);
    }

    function setRevenueTokenSupply(uint256 supply) external {
        _supply = supply;
    }

    function setSalesPenalty(uint256 penalty) external {
        _penalty = penalty;
    }

    function setBalance(address holder, uint256 tokenId, uint256 amount) external {
        _balances[holder][tokenId] = amount;
    }

    function positionManager() external view returns (IPositionManager) {
        return _positionManager;
    }

    function getRevenueTokenSupply(uint256) external view returns (uint256) {
        return _supply;
    }

    function balanceOf(address holder, uint256 tokenId) external view returns (uint256) {
        return _balances[holder][tokenId];
    }

    function getSalesPenalty(address, uint256, uint256) external view returns (uint256) {
        return _penalty;
    }
}

contract MarketplacePositionManagerStub {
    uint256 internal _penalty;
    uint256 internal _eligibleBalance;
    uint256 internal _redemptionSupply;
    address internal _lastLockHolder;
    uint256 internal _lastLockTokenId;
    uint256 internal _lastLockAmount;
    mapping(uint256 => uint256) internal _listingPenalties;

    function setSalesPenalty(uint256 penalty) external {
        _penalty = penalty;
    }

    function setRedemptionPreview(uint256 eligibleBalance, uint256 redemptionSupply) external {
        _eligibleBalance = eligibleBalance;
        _redemptionSupply = redemptionSupply;
    }

    function getSalesPenalty(address, uint256, uint256) external view returns (uint256) {
        return _penalty;
    }

    function getPrimaryRedemptionEligibleBalance(address, uint256) external view returns (uint256) {
        return _eligibleBalance;
    }

    function getCurrentPrimaryRedemptionEpochSupply(uint256) external view returns (uint256) {
        return _redemptionSupply;
    }

    function lockForListing(address holder, uint256 tokenId, uint256 amount) external {
        _lastLockHolder = holder;
        _lastLockTokenId = tokenId;
        _lastLockAmount = amount;
    }

    function getLastLock() external view returns (address holder, uint256 tokenId, uint256 amount) {
        return (_lastLockHolder, _lastLockTokenId, _lastLockAmount);
    }

    function bookSalePenalty(uint256 listingId, address, uint256, uint256 amount) external {
        _listingPenalties[listingId] = amount;
    }

    function clearSalePenalty(uint256 listingId) external {
        delete _listingPenalties[listingId];
    }

    function getSalePenalty(uint256 listingId) external view returns (uint256) {
        return _listingPenalties[listingId];
    }
}

contract MarketplaceTest is AssetMetadataBaseTest {
    function _setupBuffersFunded() internal override { }

    function _setupEarningsDistributed(uint256) internal override { }

    function setUp() public {
        _ensureState(SetupState.ContractsDeployed);
    }

    // Initialization Tests

    function testInitialization() public view {
        // Check contract references
        assertEq(address(marketplace.roboshareTokens()), address(roboshareTokens));
        assertEq(address(marketplace.partnerManager()), address(partnerManager));
        assertEq(address(marketplace.router()), address(router));
        assertEq(address(marketplace.treasury()), address(treasury));
        assertEq(address(marketplace.usdc()), address(usdc));

        // Check initial state
        assertEq(marketplace.getCurrentListingId(), 1);

        // Check roles
        assertTrue(marketplace.hasRole(marketplace.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(marketplace.hasRole(marketplace.UPGRADER_ROLE(), admin));

        // Verify role hashes
        assertEq(marketplace.UPGRADER_ROLE(), keccak256("UPGRADER_ROLE"), "Invalid UPGRADER_ROLE hash");
        assertEq(
            marketplace.AUTHORIZED_CONTRACT_ROLE(),
            keccak256("AUTHORIZED_CONTRACT_ROLE"),
            "Invalid AUTHORIZED_CONTRACT_ROLE hash"
        );
    }

    function testInitializationZeroAdmin() public {
        Marketplace newImpl = new Marketplace();
        vm.expectRevert(Marketplace.ZeroAddress.selector);
        new ERC1967Proxy(
            address(newImpl),
            abi.encodeWithSignature(
                "initialize(address,address,address,address,address,address)",
                address(0),
                address(roboshareTokens),
                address(partnerManager),
                address(router),
                address(treasury),
                address(usdc)
            )
        );
    }

    function testInitializationZeroTokens() public {
        Marketplace newImpl = new Marketplace();
        vm.expectRevert(Marketplace.ZeroAddress.selector);
        new ERC1967Proxy(
            address(newImpl),
            abi.encodeWithSignature(
                "initialize(address,address,address,address,address,address)",
                admin,
                address(0),
                address(partnerManager),
                address(router),
                address(treasury),
                address(usdc)
            )
        );
    }

    function testInitializationZeroPartnerManager() public {
        Marketplace newImpl = new Marketplace();
        vm.expectRevert(Marketplace.ZeroAddress.selector);
        new ERC1967Proxy(
            address(newImpl),
            abi.encodeWithSignature(
                "initialize(address,address,address,address,address,address)",
                admin,
                address(roboshareTokens),
                address(0),
                address(router),
                address(treasury),
                address(usdc)
            )
        );
    }

    function testInitializationZeroRouter() public {
        Marketplace newImpl = new Marketplace();
        vm.expectRevert(Marketplace.ZeroAddress.selector);
        new ERC1967Proxy(
            address(newImpl),
            abi.encodeWithSignature(
                "initialize(address,address,address,address,address,address)",
                admin,
                address(roboshareTokens),
                address(partnerManager),
                address(0),
                address(treasury),
                address(usdc)
            )
        );
    }

    function testInitializationZeroTreasury() public {
        Marketplace newImpl = new Marketplace();
        vm.expectRevert(Marketplace.ZeroAddress.selector);
        new ERC1967Proxy(
            address(newImpl),
            abi.encodeWithSignature(
                "initialize(address,address,address,address,address,address)",
                admin,
                address(roboshareTokens),
                address(partnerManager),
                address(router),
                address(0),
                address(usdc)
            )
        );
    }

    function testInitializationZeroUSDC() public {
        Marketplace newImpl = new Marketplace();
        vm.expectRevert(Marketplace.ZeroAddress.selector);
        new ERC1967Proxy(
            address(newImpl),
            abi.encodeWithSignature(
                "initialize(address,address,address,address,address,address)",
                admin,
                address(roboshareTokens),
                address(partnerManager),
                address(router),
                address(treasury),
                address(0)
            )
        );
    }

    // Admin Functions Tests

    function testUpdatePartnerManager() public {
        PartnerManager newPartnerManager = new PartnerManager();

        vm.startPrank(admin);
        marketplace.updatePartnerManager(address(newPartnerManager));
        vm.stopPrank();

        assertEq(address(marketplace.partnerManager()), address(newPartnerManager));
    }

    function testUpdatePartnerManagerZeroAddress() public {
        vm.expectRevert(Marketplace.ZeroAddress.selector);
        vm.startPrank(admin);
        marketplace.updatePartnerManager(address(0));
        vm.stopPrank();
    }

    function testUpdatePartnerManagerUnauthorizedCaller() public {
        PartnerManager newPartnerManager = new PartnerManager();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, marketplace.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(unauthorized);
        marketplace.updatePartnerManager(address(newPartnerManager));
    }

    function testUpdateRouter() public {
        RegistryRouter newRouter = new RegistryRouter();

        vm.startPrank(admin);
        marketplace.updateRouter(address(newRouter));
        vm.stopPrank();

        assertEq(address(marketplace.router()), address(newRouter));
    }

    function testUpdateRouterZeroAddress() public {
        vm.expectRevert(Marketplace.ZeroAddress.selector);
        vm.startPrank(admin);
        marketplace.updateRouter(address(0));
        vm.stopPrank();
    }

    function testUpdateRouterUnauthorizedCaller() public {
        RegistryRouter newRouter = new RegistryRouter();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, marketplace.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(unauthorized);
        marketplace.updateRouter(address(newRouter));
    }

    function testUpdateUSDC() public {
        MockUSDC newUsdc = new MockUSDC();

        vm.startPrank(admin);
        marketplace.updateUSDC(address(newUsdc));
        vm.stopPrank();

        assertEq(address(marketplace.usdc()), address(newUsdc));
    }

    function testUpdateUSDCZeroAddress() public {
        vm.expectRevert(Marketplace.ZeroAddress.selector);
        vm.startPrank(admin);
        marketplace.updateUSDC(address(0));
        vm.stopPrank();
    }

    function testUpdateUSDCUnauthorizedCaller() public {
        MockUSDC newUsdc = new MockUSDC();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, marketplace.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(unauthorized);
        marketplace.updateUSDC(address(newUsdc));
    }

    function testUpdateUSDCInvalidUSDCContractTotalSupply() public {
        MarketplaceBadTotalSupplyToken bad = new MarketplaceBadTotalSupplyToken();

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.InvalidUSDCContract.selector, address(bad)));
        marketplace.updateUSDC(address(bad));
        vm.stopPrank();
    }

    function testUpdateUSDCInvalidUSDCContractDecimals() public {
        MarketplaceBadDecimalsToken bad = new MarketplaceBadDecimalsToken();

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.InvalidUSDCContract.selector, address(bad)));
        marketplace.updateUSDC(address(bad));
        vm.stopPrank();
    }

    function testUpdateUSDCUnsupportedUSDCDecimals() public {
        MarketplaceWrongDecimalsToken bad = new MarketplaceWrongDecimalsToken();

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.UnsupportedUSDCDecimals.selector, uint8(18)));
        marketplace.updateUSDC(address(bad));
        vm.stopPrank();
    }

    function testUpdateRoboshareTokens() public {
        RoboshareTokens newRoboshareTokens = new RoboshareTokens();

        vm.startPrank(admin);
        marketplace.updateRoboshareTokens(address(newRoboshareTokens));
        vm.stopPrank();

        assertEq(address(marketplace.roboshareTokens()), address(newRoboshareTokens));
    }

    function testUpdateRoboshareTokensZeroAddress() public {
        vm.expectRevert(Marketplace.ZeroAddress.selector);
        vm.startPrank(admin);
        marketplace.updateRoboshareTokens(address(0));
        vm.stopPrank();
    }

    function testUpdateRoboshareTokensUnauthorizedCaller() public {
        RoboshareTokens newRoboshareTokens = new RoboshareTokens();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, marketplace.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(unauthorized);
        marketplace.updateRoboshareTokens(address(newRoboshareTokens));
    }

    function testCreateListingRevertsWhenPositionManagerUnset() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        MarketplaceRoboshareTokensStub stub = new MarketplaceRoboshareTokensStub();
        stub.setRevenueTokenSupply(SECONDARY_LISTING_AMOUNT);
        stub.setBalance(partner1, scenario.revenueTokenId, SECONDARY_LISTING_AMOUNT);

        vm.prank(admin);
        marketplace.updateRoboshareTokens(address(stub));

        vm.prank(partner1);
        vm.expectRevert(Marketplace.PositionManagerNotSet.selector);
        marketplace.createListing(
            scenario.revenueTokenId, SECONDARY_LISTING_AMOUNT, REVENUE_TOKEN_PRICE, LISTING_DURATION, true
        );
    }

    function testCreateListingRevertsWhenPositionManagerIsNotContract() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        MarketplaceRoboshareTokensStub stub = new MarketplaceRoboshareTokensStub();
        stub.setPositionManager(unauthorized);
        stub.setRevenueTokenSupply(SECONDARY_LISTING_AMOUNT);
        stub.setBalance(partner1, scenario.revenueTokenId, SECONDARY_LISTING_AMOUNT);

        vm.prank(admin);
        marketplace.updateRoboshareTokens(address(stub));

        vm.prank(partner1);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.InvalidPositionManager.selector, unauthorized));
        marketplace.createListing(
            scenario.revenueTokenId, SECONDARY_LISTING_AMOUNT, REVENUE_TOKEN_PRICE, LISTING_DURATION, true
        );
    }

    function testCreateListingUsesPositionManagerPenaltyAndLocking() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        MarketplaceRoboshareTokensStub tokenStub = new MarketplaceRoboshareTokensStub();
        MarketplacePositionManagerStub managerStub = new MarketplacePositionManagerStub();

        tokenStub.setPositionManager(address(managerStub));
        tokenStub.setRevenueTokenSupply(SECONDARY_LISTING_AMOUNT);
        tokenStub.setSalesPenalty(17e6);
        tokenStub.setBalance(partner1, scenario.revenueTokenId, SECONDARY_LISTING_AMOUNT);
        managerStub.setSalesPenalty(23e6);

        vm.prank(admin);
        marketplace.updateRoboshareTokens(address(tokenStub));

        vm.prank(partner1);
        uint256 listingId = marketplace.createListing(
            scenario.revenueTokenId, SECONDARY_LISTING_AMOUNT, REVENUE_TOKEN_PRICE, LISTING_DURATION, true
        );

        Marketplace.Listing memory listing = marketplace.getListing(listingId);
        assertEq(listing.earlySalePenalty, 23e6);
        assertEq(managerStub.getSalePenalty(listingId), 23e6);

        (address lockedHolder, uint256 lockedTokenId, uint256 lockedAmount) = managerStub.getLastLock();
        assertEq(lockedHolder, partner1);
        assertEq(lockedTokenId, scenario.revenueTokenId);
        assertEq(lockedAmount, SECONDARY_LISTING_AMOUNT);
    }

    function testBuyFromSecondaryListingRevertsWhenPositionManagerIsNotContract() public {
        _ensureState(SetupState.PrimaryPoolCreated);
        _purchasePrimaryPoolTokens(partner1, scenario.revenueTokenId, SECONDARY_LISTING_AMOUNT);

        vm.prank(partner1);
        uint256 listingId = marketplace.createListing(
            scenario.revenueTokenId, SECONDARY_LISTING_AMOUNT, REVENUE_TOKEN_PRICE, LISTING_DURATION, true
        );

        MarketplaceRoboshareTokensStub stub = new MarketplaceRoboshareTokensStub();
        stub.setPositionManager(unauthorized);
        stub.setSalesPenalty(0);

        vm.prank(admin);
        marketplace.updateRoboshareTokens(address(stub));

        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);
        (,, uint256 expectedPayment) = marketplace.previewSecondaryPurchase(listingId, SECONDARY_PURCHASE_AMOUNT);

        vm.startPrank(buyer);
        usdc.approve(address(marketplace), expectedPayment);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.InvalidPositionManager.selector, unauthorized));
        marketplace.buyFromSecondaryListing(listingId, SECONDARY_PURCHASE_AMOUNT);
        vm.stopPrank();

        assertEq(usdc.balanceOf(buyer), buyerUsdcBefore);
    }

    function testPreviewPrimaryRedemptionRevertsWhenPositionManagerUnset() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        MarketplaceRoboshareTokensStub stub = new MarketplaceRoboshareTokensStub();

        vm.prank(admin);
        marketplace.updateRoboshareTokens(address(stub));

        vm.expectRevert(Marketplace.PositionManagerNotSet.selector);
        marketplace.previewPrimaryRedemption(scenario.revenueTokenId, buyer, 1);
    }

    function testPreviewPrimaryRedemptionRevertsWhenPositionManagerIsNotContract() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        MarketplaceRoboshareTokensStub stub = new MarketplaceRoboshareTokensStub();
        stub.setPositionManager(unauthorized);

        vm.prank(admin);
        marketplace.updateRoboshareTokens(address(stub));

        vm.expectRevert(abi.encodeWithSelector(Marketplace.InvalidPositionManager.selector, unauthorized));
        marketplace.previewPrimaryRedemption(scenario.revenueTokenId, buyer, 1);
    }

    function testPreviewPrimaryRedemptionUsesPositionManagerViews() public {
        _ensureState(SetupState.PurchasedFromPrimaryPool);

        MarketplaceRoboshareTokensStub tokenStub = new MarketplaceRoboshareTokensStub();
        MarketplacePositionManagerStub managerStub = new MarketplacePositionManagerStub();

        tokenStub.setPositionManager(address(managerStub));
        managerStub.setRedemptionPreview(PRIMARY_PURCHASE_AMOUNT, PRIMARY_PURCHASE_AMOUNT);

        vm.prank(admin);
        marketplace.updateRoboshareTokens(address(tokenStub));

        (, uint256 investorLiquidity,,,,,,,,,) = treasury.assetCollateral(scenario.assetId);

        (uint256 payout,, uint256 redemptionSupply, uint256 eligibleBalance) =
            marketplace.previewPrimaryRedemption(scenario.revenueTokenId, buyer, PRIMARY_PURCHASE_AMOUNT);

        assertEq(payout, investorLiquidity);
        assertEq(redemptionSupply, PRIMARY_PURCHASE_AMOUNT);
        assertEq(eligibleBalance, PRIMARY_PURCHASE_AMOUNT);
    }

    function testUpdateTreasury() public {
        Treasury newTreasury = new Treasury();

        vm.startPrank(admin);
        marketplace.updateTreasury(address(newTreasury));
        vm.stopPrank();

        assertEq(address(marketplace.treasury()), address(newTreasury));
    }

    function testUpdateTreasuryZeroAddress() public {
        vm.expectRevert(Marketplace.ZeroAddress.selector);
        vm.startPrank(admin);
        marketplace.updateTreasury(address(0));
        vm.stopPrank();
    }

    function testUpdateTreasuryUnauthorizedCaller() public {
        Treasury newTreasury = new Treasury();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, marketplace.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(unauthorized);
        marketplace.updateTreasury(address(newTreasury));
    }

    function testUpgradeUnauthorizedCaller() public {
        Marketplace newImpl = new Marketplace();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, marketplace.UPGRADER_ROLE()
            )
        );
        vm.prank(unauthorized);
        marketplace.upgradeToAndCall(address(newImpl), "");
    }

    function testTransferUSDCFromBuyerZeroAmountNoOp() public {
        MarketplaceInternalHarness harness = new MarketplaceInternalHarness();
        uint256 buyerBalanceBefore = usdc.balanceOf(buyer);
        uint256 recipientBalanceBefore = usdc.balanceOf(partner1);

        harness.exposeTransferUSDCFromBuyer(buyer, partner1, 0);

        assertEq(usdc.balanceOf(buyer), buyerBalanceBefore);
        assertEq(usdc.balanceOf(partner1), recipientBalanceBefore);
    }

    function testTransferUSDCZeroAmountNoOp() public {
        MarketplaceInternalHarness harness = new MarketplaceInternalHarness();
        uint256 recipientBalanceBefore = usdc.balanceOf(partner1);

        harness.exposeTransferUSDC(partner1, 0);

        assertEq(usdc.balanceOf(partner1), recipientBalanceBefore);
    }

    function testRouteProtocolFeeZeroAmountNoOp() public {
        MarketplaceInternalHarness harness = new MarketplaceInternalHarness();
        uint256 treasuryBalanceBefore = usdc.balanceOf(address(treasury));
        uint256 feeRecipientPendingBefore = treasury.pendingWithdrawals(config.treasuryFeeRecipient);

        harness.exposeRouteProtocolFee(0);

        assertEq(usdc.balanceOf(address(treasury)), treasuryBalanceBefore);
        assertEq(treasury.pendingWithdrawals(config.treasuryFeeRecipient), feeRecipientPendingBefore);
    }
}
