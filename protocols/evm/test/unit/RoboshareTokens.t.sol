// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { AssetMetadataBaseTest } from "../base/AssetMetadataBaseTest.t.sol";
import { TokenLib } from "../../contracts/Libraries.sol";
import { PositionManager } from "../../contracts/PositionManager.sol";
import { RoboshareTokens } from "../../contracts/RoboshareTokens.sol";

contract MockPositionManager {
    error HookBlocked();

    uint256 public callCount;
    address public lastFrom;
    address public lastTo;
    uint256 public lastTokenId;
    uint256 public lastAmount;
    bool public shouldRevert;

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function beforeRevenueTokenUpdate(address from, address to, uint256 tokenId, uint256 amount) external {
        if (shouldRevert) revert HookBlocked();

        callCount++;
        lastFrom = from;
        lastTo = to;
        lastTokenId = tokenId;
        lastAmount = amount;
    }

    function syncRevenueTokenPolicy(uint256, uint256, uint256) external { }

    function getLockedAmount(address, uint256) external pure returns (uint256) {
        return 0;
    }

    function getAvailableAmount(address, uint256, uint256 totalBalance) external pure returns (uint256) {
        return totalBalance;
    }

    function getUserPositions(uint256, address) external pure returns (TokenLib.TokenPosition[] memory positions) {
        positions = new TokenLib.TokenPosition[](0);
    }

    function getPrimaryRedemptionEligibleBalance(address, uint256) external pure returns (uint256) {
        return 0;
    }

    function getCurrentPrimaryRedemptionEpochSupply(uint256) external pure returns (uint256) {
        return 0;
    }

    function getCurrentPrimaryRedemptionBackedPrincipal(uint256) external pure returns (uint256) {
        return 0;
    }

    function getSalesPenalty(address, uint256, uint256) external pure returns (uint256) {
        return 0;
    }

    function lockForListing(address, uint256, uint256) external { }

    function unlockForListing(address, uint256, uint256) external { }

    function settleLockedTransfer(address, address, uint256, uint256) external { }

    function preparePrimaryRedemptionBurn(address, uint256) external { }

    function recordImmediateProceedsRelease(uint256, uint256, bytes32) external { }

    function recordPrimaryRedemptionPayout(uint256, uint256, bytes32) external { }
}

contract RevertingERC1155Receiver {
    error ReceiveBlocked();

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert ReceiveBlocked();
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert ReceiveBlocked();
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x4e2312e0 || interfaceId == 0x01ffc9a7;
    }
}

contract RoboshareTokensTest is AssetMetadataBaseTest {
    address public minter;
    address public burner;
    address public manager;
    address public user1 = makeAddr("user1");
    address public user2 = makeAddr("user2");
    PositionManager public testPositionManager;

    function _setupBuffersFunded() internal override { }

    function _setupEarningsDistributed(uint256) internal override { }

    function setUp() public {
        _ensureState(SetupState.ContractsDeployed);
        testPositionManager = _deployPositionManager(address(roboshareTokens));
        vm.prank(admin);
        roboshareTokens.setPositionManager(address(testPositionManager));
        minter = admin; // Admin has minter role by default
        burner = admin; // Admin has burner role by default
        manager = address(testPositionManager); // PositionManager is the sole manager role holder

        // These helpers run against a fork in CI/local workflows, so ensure the
        // deterministic test users are EOAs even if the forked chain has code there.
        vm.etch(user1, bytes(""));
        vm.etch(user2, bytes(""));
    }

    function _deployPositionManager(address tokenAddress) internal returns (PositionManager) {
        PositionManager implementation = new PositionManager();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(
                PositionManager.initialize,
                (
                    admin,
                    address(router),
                    tokenAddress,
                    address(partnerManager),
                    address(marketplace),
                    address(treasury),
                    address(earningsManager),
                    address(usdc)
                )
            )
        );
        PositionManager manager = PositionManager(address(proxy));
        vm.prank(admin);
        earningsManager.updatePositionManager(address(manager));
        return manager;
    }

    function _setupRevenueTokenForLocks(address holder, uint256 amount) internal returns (uint256 tokenId) {
        tokenId = 102;
        uint256 maturityDate = block.timestamp + 365 days;

        vm.prank(minter);
        roboshareTokens.setRevenueTokenInfo(
            tokenId, 100 * 1e6, amount, amount, maturityDate, 10_000, 1_000, false, false
        );

        vm.prank(minter);
        roboshareTokens.mint(holder, tokenId, amount, "");
    }

    function _setupRevenueTokenForRedemptionEpochs(address holder, uint256 amount) internal returns (uint256 tokenId) {
        tokenId = 104;
        uint256 maturityDate = block.timestamp + 365 days;

        vm.prank(minter);
        roboshareTokens.setRevenueTokenInfo(
            tokenId, 100 * 1e6, amount, amount, maturityDate, 10_000, 1_000, true, false
        );

        vm.prank(minter);
        roboshareTokens.mint(holder, tokenId, amount, "");
    }

    function _warpPastHoldingPeriod() internal {
        vm.warp(block.timestamp + 30 days + 1);
    }

    function testInitialization() public view {
        assertTrue(roboshareTokens.hasRole(roboshareTokens.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(roboshareTokens.hasRole(roboshareTokens.UPGRADER_ROLE(), admin));
        assertTrue(roboshareTokens.hasRole(roboshareTokens.MINTER_ROLE(), admin));
        assertTrue(roboshareTokens.hasRole(roboshareTokens.MINTER_ROLE(), minter));
        assertTrue(roboshareTokens.hasRole(roboshareTokens.MANAGER_ROLE(), address(testPositionManager)));
        assertFalse(roboshareTokens.hasRole(roboshareTokens.MANAGER_ROLE(), admin));

        // Verify role hashes
        assertEq(roboshareTokens.MINTER_ROLE(), keccak256("MINTER_ROLE"), "Invalid MINTER_ROLE hash");
        assertEq(roboshareTokens.BURNER_ROLE(), keccak256("BURNER_ROLE"), "Invalid BURNER_ROLE hash");
        assertEq(roboshareTokens.MANAGER_ROLE(), keccak256("MANAGER_ROLE"), "Invalid MANAGER_ROLE hash");
        assertEq(roboshareTokens.URI_SETTER_ROLE(), keccak256("URI_SETTER_ROLE"), "Invalid URI_SETTER_ROLE hash");
        assertEq(roboshareTokens.UPGRADER_ROLE(), keccak256("UPGRADER_ROLE"), "Invalid UPGRADER_ROLE hash");
    }

    function testInitializationZeroAdmin() public {
        RoboshareTokens newImpl = new RoboshareTokens();
        vm.expectRevert(RoboshareTokens.ZeroAddress.selector);
        new ERC1967Proxy(address(newImpl), abi.encodeWithSignature("initialize(address)", address(0)));
    }

    function testMintSingleToken() public {
        uint256 tokenId = 101; // Use a high number to avoid collision
        uint256 amount = 100;
        bytes memory data = "";

        vm.prank(minter);
        roboshareTokens.mint(user1, tokenId, amount, data);

        assertEq(roboshareTokens.balanceOf(user1, tokenId), amount);
    }

    function testMintBatchTokens() public {
        uint256[] memory ids = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        ids[0] = 101; // Asset token
        ids[1] = 102; // Revenue token
        amounts[0] = 1;
        amounts[1] = 200;
        bytes memory data = "";

        vm.expectEmit(true, true, true, false);
        emit RoboshareTokens.RevenueTokenPositionsUpdated(ids[1], address(0), user1, amounts[1]);

        vm.prank(minter);
        roboshareTokens.mintBatch(user1, ids, amounts, data);

        assertEq(roboshareTokens.balanceOf(user1, 101), 1);
        assertEq(roboshareTokens.balanceOf(user1, 102), 200);
    }

    function testBurnSingleToken() public {
        // Setup: mint tokens first
        uint256 tokenId = 101;
        uint256 amount = 100;

        vm.prank(minter);
        roboshareTokens.mint(user1, tokenId, amount, "");

        // Test burn
        vm.prank(burner);
        roboshareTokens.burn(user1, tokenId, 50);

        assertEq(roboshareTokens.balanceOf(user1, tokenId), 50);
    }

    function testBurnBatchTokens() public {
        // Setup: mint tokens first
        uint256[] memory ids = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        ids[0] = 101;
        ids[1] = 102;
        amounts[0] = 100;
        amounts[1] = 200;

        vm.prank(minter);
        roboshareTokens.mintBatch(user1, ids, amounts, "");

        // Test burn batch
        uint256[] memory burnAmounts = new uint256[](2);
        burnAmounts[0] = 30;
        burnAmounts[1] = 50;

        vm.prank(burner);
        roboshareTokens.burnBatch(user1, ids, burnAmounts);

        assertEq(roboshareTokens.balanceOf(user1, 101), 70);
        assertEq(roboshareTokens.balanceOf(user1, 102), 150);
    }

    function testSetURI() public {
        string memory newURI = "https://api.roboshare.com/tokens/{id}.json";

        vm.prank(admin);
        roboshareTokens.setURI(newURI);

        assertEq(roboshareTokens.uri(1), newURI);
    }

    function testSetTokenMetadataURI() public {
        string memory tokenMetadata = "ipfs://QmTokenMetadata";

        vm.prank(admin);
        roboshareTokens.setTokenMetadataURI(1, tokenMetadata);

        assertEq(roboshareTokens.uri(1), tokenMetadata);
    }

    function testSetTokenMetadataURIUnauthorizedCaller() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                unauthorized,
                roboshareTokens.URI_SETTER_ROLE()
            )
        );
        vm.prank(unauthorized);
        roboshareTokens.setTokenMetadataURI(1, "ipfs://QmTokenMetadata");
    }

    function testSetTokenMetadataURIRejectsEmptyUri() public {
        vm.expectRevert(RoboshareTokens.EmptyMetadataURI.selector);
        vm.prank(admin);
        roboshareTokens.setTokenMetadataURI(1, "");
    }

    function testTransfers() public {
        // Setup: mint tokens to user1
        uint256 tokenId = 101;
        uint256 amount = 100;

        vm.prank(minter);
        roboshareTokens.mint(user1, tokenId, amount, "");

        // Transfer from user1 to user2
        vm.prank(user1);
        roboshareTokens.safeTransferFrom(user1, user2, tokenId, 30, "");

        assertEq(roboshareTokens.balanceOf(user1, tokenId), 70);
        assertEq(roboshareTokens.balanceOf(user2, tokenId), 30);
    }

    function testBatchTransfers() public {
        // Setup: mint multiple tokens to user1
        uint256[] memory ids = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        ids[0] = 101;
        ids[1] = 102;
        amounts[0] = 100;
        amounts[1] = 200;

        vm.prank(minter);
        roboshareTokens.mintBatch(user1, ids, amounts, "");

        // Batch transfer
        uint256[] memory transferAmounts = new uint256[](2);
        transferAmounts[0] = 30;
        transferAmounts[1] = 50;

        vm.prank(user1);
        roboshareTokens.safeBatchTransferFrom(user1, user2, ids, transferAmounts, "");

        assertEq(roboshareTokens.balanceOf(user1, 101), 70);
        assertEq(roboshareTokens.balanceOf(user1, 102), 150);
        assertEq(roboshareTokens.balanceOf(user2, 101), 30);
        assertEq(roboshareTokens.balanceOf(user2, 102), 50);
    }

    // Access Control Tests

    function testMintUnauthorizedCaller() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, roboshareTokens.MINTER_ROLE()
            )
        );
        vm.prank(unauthorized);
        roboshareTokens.mint(user1, 1, 100, "");
    }

    function testBurnUnauthorizedCaller() public {
        // Setup: mint token first
        vm.prank(minter);
        roboshareTokens.mint(user1, 1, 100, "");

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, roboshareTokens.BURNER_ROLE()
            )
        );
        vm.prank(unauthorized);
        roboshareTokens.burn(user1, 1, 50);
    }

    function testSetURIUnauthorizedCaller() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                unauthorized,
                roboshareTokens.URI_SETTER_ROLE()
            )
        );
        vm.prank(unauthorized);
        roboshareTokens.setURI("ipfs://new-uri");
    }

    function testRevenueTokenMintCallsPositionManagerHook() public {
        MockPositionManager mockManager = new MockPositionManager();

        vm.prank(admin);
        roboshareTokens.setPositionManager(address(mockManager));

        uint256 tokenId = _setupRevenueTokenForLocks(user1, 100);

        assertEq(mockManager.callCount(), 1);
        assertEq(mockManager.lastFrom(), address(0));
        assertEq(mockManager.lastTo(), user1);
        assertEq(mockManager.lastTokenId(), tokenId);
        assertEq(mockManager.lastAmount(), 100);
    }

    function testRevenueTokenTransferCallsPositionManagerHook() public {
        MockPositionManager mockManager = new MockPositionManager();

        vm.prank(admin);
        roboshareTokens.setPositionManager(address(mockManager));

        uint256 tokenId = _setupRevenueTokenForLocks(user1, 100);

        vm.prank(user1);
        roboshareTokens.safeTransferFrom(user1, user2, tokenId, 25, "");

        assertEq(mockManager.callCount(), 2);
        assertEq(mockManager.lastFrom(), user1);
        assertEq(mockManager.lastTo(), user2);
        assertEq(mockManager.lastTokenId(), tokenId);
        assertEq(mockManager.lastAmount(), 25);
    }

    function testRevenueTokenMintRevertsWhenPositionManagerHookReverts() public {
        MockPositionManager mockManager = new MockPositionManager();

        vm.prank(admin);
        roboshareTokens.setPositionManager(address(mockManager));

        uint256 tokenId = 106;
        uint256 amount = 100;
        uint256 maturityDate = block.timestamp + 365 days;

        vm.prank(minter);
        roboshareTokens.setRevenueTokenInfo(
            tokenId, 100 * 1e6, amount, amount, maturityDate, 10_000, 1_000, false, false
        );

        mockManager.setShouldRevert(true);

        vm.expectRevert(MockPositionManager.HookBlocked.selector);
        vm.prank(minter);
        roboshareTokens.mint(user1, tokenId, amount, "");

        assertEq(roboshareTokens.balanceOf(user1, tokenId), 0);
        assertEq(mockManager.callCount(), 0);
    }

    function testRevenueTokenTransferRevertsWhenPositionManagerHookReverts() public {
        MockPositionManager mockManager = new MockPositionManager();

        vm.prank(admin);
        roboshareTokens.setPositionManager(address(mockManager));

        uint256 tokenId = _setupRevenueTokenForLocks(user1, 100);
        mockManager.setShouldRevert(true);

        vm.expectRevert(MockPositionManager.HookBlocked.selector);
        vm.prank(user1);
        roboshareTokens.safeTransferFrom(user1, user2, tokenId, 25, "");

        assertEq(roboshareTokens.balanceOf(user1, tokenId), 100);
        assertEq(roboshareTokens.balanceOf(user2, tokenId), 0);
        assertEq(mockManager.callCount(), 1);
    }

    function testRevenueTokenBurnRevertsWhenPositionManagerHookReverts() public {
        MockPositionManager mockManager = new MockPositionManager();

        vm.prank(admin);
        roboshareTokens.setPositionManager(address(mockManager));

        uint256 tokenId = _setupRevenueTokenForLocks(user1, 100);

        mockManager.setShouldRevert(true);

        vm.expectRevert(MockPositionManager.HookBlocked.selector);
        vm.prank(burner);
        roboshareTokens.burn(user1, tokenId, 10);

        assertEq(roboshareTokens.balanceOf(user1, tokenId), 100);
    }

    function testSetPositionManagerBackfillsExistingRevenueTokenPolicy() public {
        RoboshareTokens freshToken = RoboshareTokens(
            address(
                new ERC1967Proxy(address(new RoboshareTokens()), abi.encodeWithSignature("initialize(address)", admin))
            )
        );
        PositionManager freshManager = _deployPositionManager(address(freshToken));

        vm.prank(admin);
        (, uint256 tokenId) = freshToken.reserveNextTokenIdPair();
        uint256 amount = 100;
        uint256 maturityDate = block.timestamp + 365 days;

        vm.prank(admin);
        freshToken.setRevenueTokenInfo(tokenId, 100 * 1e6, amount, amount, maturityDate, 10_000, 1_000, false, false);

        vm.prank(admin);
        freshToken.setPositionManager(address(freshManager));

        assertTrue(freshToken.hasRole(freshToken.MANAGER_ROLE(), address(freshManager)));
        assertFalse(freshToken.hasRole(freshToken.MANAGER_ROLE(), admin));

        vm.prank(admin);
        freshToken.mint(user1, tokenId, amount, "");

        uint256 penalty = freshToken.getSalesPenalty(user1, tokenId, amount);
        assertGt(penalty, 0, "Penalty should use backfilled manager policy after late manager attach");
    }

    function testSetPositionManagerSkipsUnsetRevenueTokenSlots() public {
        RoboshareTokens freshToken = RoboshareTokens(
            address(
                new ERC1967Proxy(address(new RoboshareTokens()), abi.encodeWithSignature("initialize(address)", admin))
            )
        );
        PositionManager freshManager = _deployPositionManager(address(freshToken));

        vm.startPrank(admin);
        freshToken.reserveNextTokenIdPair();
        (, uint256 configuredTokenId) = freshToken.reserveNextTokenIdPair();
        vm.stopPrank();

        uint256 amount = 100;
        uint256 maturityDate = block.timestamp + 365 days;

        vm.prank(admin);
        freshToken.setRevenueTokenInfo(
            configuredTokenId, 100 * 1e6, amount, amount, maturityDate, 10_000, 1_000, false, false
        );

        vm.prank(admin);
        freshToken.setPositionManager(address(freshManager));

        vm.prank(admin);
        freshToken.mint(user1, configuredTokenId, amount, "");

        uint256 penalty = freshToken.getSalesPenalty(user1, configuredTokenId, amount);
        assertGt(penalty, 0, "Configured revenue token should still sync when earlier slots are unset");
    }

    function testSetPositionManagerZeroAddress() public {
        vm.expectRevert(RoboshareTokens.ZeroAddress.selector);
        vm.prank(admin);
        roboshareTokens.setPositionManager(address(0));
    }

    function testManagerRequiredTokenPathsRevertWhenPositionManagerNotSet() public {
        RoboshareTokens freshToken = RoboshareTokens(
            address(
                new ERC1967Proxy(address(new RoboshareTokens()), abi.encodeWithSignature("initialize(address)", admin))
            )
        );

        vm.prank(admin);
        (, uint256 tokenId) = freshToken.reserveNextTokenIdPair();
        uint256 amount = 100;
        uint256 maturityDate = block.timestamp + 365 days;

        vm.prank(admin);
        freshToken.setRevenueTokenInfo(tokenId, 100 * 1e6, amount, amount, maturityDate, 10_000, 1_000, false, false);

        vm.expectRevert(RoboshareTokens.PositionManagerNotSet.selector);
        freshToken.getLockedAmount(user1, tokenId);
    }

    function testGetUserPositionsAndBalance() public {
        uint256 tokenId = 102;
        uint256 amount = 100;
        uint256 maturityDate = block.timestamp + 365 days;

        vm.prank(minter);
        roboshareTokens.setRevenueTokenInfo(
            tokenId, 100 * 1e6, amount, amount, maturityDate, 10_000, 1_000, false, false
        );

        vm.prank(minter);
        roboshareTokens.mint(user1, tokenId, amount, "");

        TokenLib.TokenPosition[] memory positions = roboshareTokens.getUserPositions(tokenId, user1);

        assertEq(positions.length, 1, "Should have exactly one position");
        assertEq(positions[0].tokenId, tokenId, "Token ID mismatch in position");
        assertEq(positions[0].amount, amount, "Position amount mismatch");
        assertEq(roboshareTokens.balanceOf(user1, tokenId), amount);
    }

    function testGetRevenueTokenSupplyNotRevenueToken() public {
        uint256 assetId = 101; // An odd number, not a revenue token

        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.getRevenueTokenSupply(assetId);
    }

    function testGetTokenMaturityDateNotRevenueToken() public {
        uint256 assetId = 101; // An odd number, not a revenue token

        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.getTokenMaturityDate(assetId);
    }

    function testGetRevenueShareBPNotRevenueToken() public {
        uint256 assetId = 101; // An odd number, not a revenue token

        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.getRevenueShareBP(assetId);
    }

    function testGetTargetYieldBPNotRevenueToken() public {
        uint256 assetId = 101; // An odd number, not a revenue token

        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.getTargetYieldBP(assetId);
    }

    function testGetRevenueTokenMaxSupplyNotRevenueToken() public {
        uint256 assetId = 101; // An odd number, not a revenue token

        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.getRevenueTokenMaxSupply(assetId);
    }

    function testGetRevenueTokenImmediateProceedsEnabledNotRevenueToken() public {
        uint256 assetId = 101; // An odd number, not a revenue token

        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.getRevenueTokenImmediateProceedsEnabled(assetId);
    }

    function testGetRevenueTokenProtectionEnabledNotRevenueToken() public {
        uint256 assetId = 101; // An odd number, not a revenue token

        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.getRevenueTokenProtectionEnabled(assetId);
    }

    function testGetLockedAmountNotRevenueToken() public {
        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.getLockedAmount(user1, 101);
    }

    function testLockForListingNotRevenueToken() public {
        vm.prank(manager);
        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.lockForListing(user1, 101, 1);
    }

    function testLockForListingZeroAmount() public {
        uint256 tokenId = _setupRevenueTokenForLocks(user1, 100);
        vm.prank(manager);
        vm.expectRevert(RoboshareTokens.InvalidLockAmount.selector);
        roboshareTokens.lockForListing(user1, tokenId, 0);
    }

    function testLockForListingRejectsLegacyAuthorizedAndBurnerRoles() public {
        address legacyActor = makeAddr("legacyActor");
        uint256 tokenId = _setupRevenueTokenForLocks(user1, 100);

        vm.startPrank(admin);
        roboshareTokens.grantRole(roboshareTokens.AUTHORIZED_CONTRACT_ROLE(), legacyActor);
        roboshareTokens.grantRole(roboshareTokens.BURNER_ROLE(), legacyActor);
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, legacyActor, roboshareTokens.MANAGER_ROLE()
            )
        );
        vm.prank(legacyActor);
        roboshareTokens.lockForListing(user1, tokenId, 1);
    }

    function testLockForListingInsufficientUnlockedBalance() public {
        uint256 tokenId = _setupRevenueTokenForLocks(user1, 100);

        vm.prank(manager);
        roboshareTokens.lockForListing(user1, tokenId, 80);

        vm.prank(manager);
        vm.expectRevert(RoboshareTokens.InsufficientUnlockedBalance.selector);
        roboshareTokens.lockForListing(user1, tokenId, 30);
    }

    function testLockForListingAndGetLockedAmount() public {
        uint256 tokenId = _setupRevenueTokenForLocks(user1, 100);

        vm.prank(manager);
        roboshareTokens.lockForListing(user1, tokenId, 25);

        assertEq(roboshareTokens.getLockedAmount(user1, tokenId), 25);
    }

    function testUnlockForListingNotRevenueToken() public {
        vm.prank(manager);
        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.unlockForListing(user1, 101, 1);
    }

    function testUnlockForListingZeroAmount() public {
        uint256 tokenId = _setupRevenueTokenForLocks(user1, 100);
        vm.prank(manager);
        roboshareTokens.lockForListing(user1, tokenId, 10);

        vm.prank(manager);
        vm.expectRevert(RoboshareTokens.InvalidLockAmount.selector);
        roboshareTokens.unlockForListing(user1, tokenId, 0);
    }

    function testUnlockForListingInsufficientLockedBalance() public {
        uint256 tokenId = _setupRevenueTokenForLocks(user1, 100);
        vm.prank(manager);
        vm.expectRevert(RoboshareTokens.InsufficientLockedBalance.selector);
        roboshareTokens.unlockForListing(user1, tokenId, 1);
    }

    function testTransferLockedForListingNotRevenueToken() public {
        vm.prank(manager);
        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.transferLockedForListing(user1, user2, 101, 1, "");
    }

    function testTransferLockedForListingZeroAmount() public {
        uint256 tokenId = _setupRevenueTokenForLocks(user1, 100);
        vm.prank(manager);
        vm.expectRevert(RoboshareTokens.InvalidLockAmount.selector);
        roboshareTokens.transferLockedForListing(user1, user2, tokenId, 0, "");
    }

    function testTransferLockedForListingInsufficientLockedBalance() public {
        uint256 tokenId = _setupRevenueTokenForLocks(user1, 100);
        vm.prank(manager);
        vm.expectRevert(RoboshareTokens.InsufficientLockedBalance.selector);
        roboshareTokens.transferLockedForListing(user1, user2, tokenId, 1, "");
    }

    function testTransferLockedForListingMovesTokensAndUnlocks() public {
        uint256 tokenId = _setupRevenueTokenForLocks(user1, 100);

        vm.prank(manager);
        roboshareTokens.lockForListing(user1, tokenId, 40);
        assertEq(roboshareTokens.getLockedAmount(user1, tokenId), 40);

        vm.prank(manager);
        roboshareTokens.transferLockedForListing(user1, user2, tokenId, 15, "");

        assertEq(roboshareTokens.getLockedAmount(user1, tokenId), 25);
        assertEq(roboshareTokens.balanceOf(user1, tokenId), 85);
        assertEq(roboshareTokens.balanceOf(user2, tokenId), 15);
    }

    function testTransferLockedForListingRollsBackUnlockWhenReceiverRejects() public {
        RevertingERC1155Receiver receiver = new RevertingERC1155Receiver();
        uint256 tokenId = _setupRevenueTokenForLocks(user1, 100);

        vm.prank(manager);
        roboshareTokens.lockForListing(user1, tokenId, 40);

        vm.expectRevert();
        vm.prank(manager);
        roboshareTokens.transferLockedForListing(user1, address(receiver), tokenId, 15, "");

        assertEq(roboshareTokens.getLockedAmount(user1, tokenId), 40);
        assertEq(roboshareTokens.balanceOf(user1, tokenId), 100);
        assertEq(roboshareTokens.balanceOf(address(receiver), tokenId), 0);
    }

    function testManagerBurnCurrentEpochNotRevenueToken() public {
        vm.prank(manager);
        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.managerBurnCurrentEpoch(user1, 101, 1);
    }

    function testManagerBurnCurrentEpochZeroAmount() public {
        uint256 tokenId = _setupRevenueTokenForRedemptionEpochs(user1, 100);

        vm.prank(manager);
        vm.expectRevert(RoboshareTokens.InvalidLockAmount.selector);
        roboshareTokens.managerBurnCurrentEpoch(user1, tokenId, 0);
    }

    function testManagerBurnCurrentEpochUnauthorizedCaller() public {
        uint256 tokenId = _setupRevenueTokenForRedemptionEpochs(user1, 100);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, roboshareTokens.MANAGER_ROLE()
            )
        );
        vm.prank(unauthorized);
        roboshareTokens.managerBurnCurrentEpoch(user1, tokenId, 1);
    }

    function testManagerBurnCurrentEpochRequiresEligibleEpochBalance() public {
        uint256 tokenId = _setupRevenueTokenForRedemptionEpochs(user1, 100);
        uint256 backedPrincipal = roboshareTokens.getCurrentPrimaryRedemptionBackedPrincipal(tokenId);

        vm.prank(address(router));
        testPositionManager.recordImmediateProceedsRelease(
            tokenId, backedPrincipal, keccak256("IMMEDIATE_PROCEEDS_RELEASE")
        );

        vm.prank(manager);
        vm.expectRevert(TokenLib.InsufficientTokenBalance.selector);
        roboshareTokens.managerBurnCurrentEpoch(user1, tokenId, 1);
    }

    function testBurnRevenueTokenSkipsConsumedHeadPositions() public {
        uint256 tokenId = _setupRevenueTokenForRedemptionEpochs(user1, 100);

        vm.prank(user1);
        roboshareTokens.safeTransferFrom(user1, user2, tokenId, 100, "");

        vm.prank(minter);
        roboshareTokens.mint(user1, tokenId, 50, "");

        vm.prank(burner);
        roboshareTokens.burn(user1, tokenId, 10);

        assertEq(roboshareTokens.balanceOf(user1, tokenId), 40);
    }

    function testTransferBlockedWhenLockedAmountExceedsUnlockedBalance() public {
        uint256 tokenId = _setupRevenueTokenForLocks(user1, 100);
        vm.prank(manager);
        roboshareTokens.lockForListing(user1, tokenId, 80);

        vm.expectRevert(RoboshareTokens.InsufficientUnlockedBalance.selector);
        vm.prank(user1);
        roboshareTokens.safeTransferFrom(user1, user2, tokenId, 30, "");
    }

    function testBatchTransferDuplicateRevenueTokenIdsRespectsCumulativeLockedCheck() public {
        uint256 tokenId = _setupRevenueTokenForLocks(user1, 100);
        vm.prank(manager);
        roboshareTokens.lockForListing(user1, tokenId, 10); // Available = 90

        uint256[] memory ids = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        ids[0] = tokenId;
        ids[1] = tokenId;
        amounts[0] = 60;
        amounts[1] = 40;

        vm.expectRevert(RoboshareTokens.InsufficientUnlockedBalance.selector);
        vm.prank(user1);
        roboshareTokens.safeBatchTransferFrom(user1, user2, ids, amounts, "");
    }

    function testGetSalesPenaltyAssetOwner() public {
        _ensureState(SetupState.PrimaryPoolCreated);

        uint256 penalty = roboshareTokens.getSalesPenalty(partner1, scenario.revenueTokenId, 1);
        assertEq(penalty, 0);
    }

    function testSupportsInterface() public view {
        // ERC1155 and ERC165 should be supported, random interface should not
        assertTrue(roboshareTokens.supportsInterface(0xd9b67a26));
        assertTrue(roboshareTokens.supportsInterface(0x01ffc9a7));
        assertFalse(roboshareTokens.supportsInterface(0xffffffff));
    }

    // Fuzz Tests

    function testFuzzMint(address to, uint256 tokenId, uint256 amount) public {
        vm.assume(to != address(0));
        vm.assume(amount > 0 && amount < type(uint128).max);
        vm.assume(tokenId > 100 && tokenId < type(uint64).max); // Avoid collisions
        // Exclude contracts that might not implement ERC1155Receiver
        vm.assume(to.code.length == 0);

        vm.prank(minter);
        roboshareTokens.mint(to, tokenId, amount, "");

        assertEq(roboshareTokens.balanceOf(to, tokenId), amount);
    }

    function testFuzzBurn(uint256 mintAmount, uint256 burnAmount) public {
        vm.assume(mintAmount > 0 && mintAmount < type(uint128).max);
        vm.assume(burnAmount <= mintAmount);

        uint256 tokenId = 101;

        // Mint first
        vm.prank(minter);
        roboshareTokens.mint(user1, tokenId, mintAmount, "");

        // Then burn
        vm.prank(burner);
        roboshareTokens.burn(user1, tokenId, burnAmount);

        assertEq(roboshareTokens.balanceOf(user1, tokenId), mintAmount - burnAmount);
    }

    function testFuzzTransfer(uint256 mintAmount, uint256 transferAmount) public {
        vm.assume(mintAmount > 0 && mintAmount < type(uint128).max);
        vm.assume(transferAmount <= mintAmount);

        uint256 tokenId = 101;

        // Mint to user1
        vm.prank(minter);
        roboshareTokens.mint(user1, tokenId, mintAmount, "");

        // Transfer to user2
        vm.prank(user1);
        roboshareTokens.safeTransferFrom(user1, user2, tokenId, transferAmount, "");

        assertEq(roboshareTokens.balanceOf(user1, tokenId), mintAmount - transferAmount);
        assertEq(roboshareTokens.balanceOf(user2, tokenId), transferAmount);
    }

    function testFuzzTransferLockedForListingPreservesLockAccounting(
        uint256 mintAmount,
        uint256 lockAmount,
        uint256 transferAmount
    ) public {
        mintAmount = bound(mintAmount, 1, type(uint96).max);
        uint256 tokenId = _setupRevenueTokenForLocks(user1, mintAmount);

        lockAmount = bound(lockAmount, 1, mintAmount);
        transferAmount = bound(transferAmount, 1, lockAmount);

        vm.prank(manager);
        roboshareTokens.lockForListing(user1, tokenId, lockAmount);

        vm.prank(manager);
        roboshareTokens.transferLockedForListing(user1, user2, tokenId, transferAmount, "");

        assertEq(roboshareTokens.getLockedAmount(user1, tokenId), lockAmount - transferAmount);
        assertEq(roboshareTokens.balanceOf(user1, tokenId), mintAmount - transferAmount);
        assertEq(roboshareTokens.balanceOf(user2, tokenId), transferAmount);
    }

    // Edge Cases

    function testMintZeroAmount() public {
        // ERC1155 allows minting 0 amount by default
        vm.prank(minter);
        roboshareTokens.mint(user1, 1, 0, "");

        assertEq(roboshareTokens.balanceOf(user1, 1), 0);
    }

    function testBurnMoreThanBalance() public {
        vm.prank(minter);
        roboshareTokens.mint(user1, 1, 100, "");

        vm.expectRevert();
        vm.prank(burner);
        roboshareTokens.burn(user1, 1, 150);
    }

    function testTransferMoreThanBalance() public {
        vm.prank(minter);
        roboshareTokens.mint(user1, 1, 100, "");

        vm.expectRevert();
        vm.prank(user1);
        roboshareTokens.safeTransferFrom(user1, user2, 1, 150, "");
    }

    function testGetUserPositionsNotRevenueToken() public {
        _ensureState(SetupState.PrimaryPoolCreated); // Creates assetId (odd) and revenueTokenId (even)

        // Attempt to get positions for the vehicle NFT ID, which is not a revenue token
        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.getUserPositions(scenario.assetId, partner1);
    }

    function testGetPrimaryRedemptionEligibleBalanceNotRevenueToken() public {
        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.getPrimaryRedemptionEligibleBalance(user1, 101);
    }

    function testGetCurrentPrimaryRedemptionEpochSupplyNotRevenueToken() public {
        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.getCurrentPrimaryRedemptionEpochSupply(101);
    }

    function testGetCurrentPrimaryRedemptionBackedPrincipalNotRevenueToken() public {
        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.getCurrentPrimaryRedemptionBackedPrincipal(101);
    }

    function testSetRevenueTokenInfoNotRevenueToken() public {
        uint256 assetId = 101; // An odd number, not a revenue token
        uint256 price = 1e6;
        uint256 supply = 1000;

        vm.prank(minter);
        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.setRevenueTokenInfo(
            assetId, price, supply, supply, block.timestamp + 365 days, 10_000, 1_000, false, false
        );
    }

    function testSetRevenueTokenInfoAlreadySet() public {
        uint256 revenueTokenId = 102; // An even number, a revenue token
        uint256 price = 1e6;
        uint256 supply = 1000;

        vm.prank(minter);
        roboshareTokens.setRevenueTokenInfo(
            revenueTokenId, price, supply, supply, block.timestamp + 365 days, 10_000, 1_000, false, false
        );

        vm.startPrank(minter);
        vm.expectRevert(RoboshareTokens.RevenueTokenInfoAlreadySet.selector);
        roboshareTokens.setRevenueTokenInfo(
            revenueTokenId, price, supply, supply, block.timestamp + 365 days, 10_000, 1_000, false, false
        );
        vm.stopPrank();
    }

    function testGetTokenPriceNotRevenueToken() public {
        uint256 assetId = 101; // An odd number, not a revenue token

        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.getTokenPrice(assetId);
    }

    function testGetSalesPenaltyNotRevenueToken() public {
        uint256 assetId = 101; // An odd number, not a revenue token
        vm.expectRevert(RoboshareTokens.NotRevenueToken.selector);
        roboshareTokens.getSalesPenalty(user1, assetId, 100);
    }

    function testGetSalesPenaltyHoldingPeriod() public {
        uint256 tokenId = 102;
        uint256 amount = 100;
        uint256 maturityDate = block.timestamp + 365 days;

        vm.prank(minter);
        roboshareTokens.setRevenueTokenInfo(
            tokenId, 100 * 1e6, amount, amount, maturityDate, 10_000, 1_000, false, false
        );

        // Mint tokens to user1 (who does not own the asset)
        vm.prank(minter);
        roboshareTokens.mint(user1, tokenId, amount, "");

        // Immediately after receiving, there should be a penalty for user1
        uint256 penalty = roboshareTokens.getSalesPenalty(user1, tokenId, amount);
        assertGt(penalty, 0, "Should have penalty immediately after acquisition");

        // Warp past holding period (30 days + 1)
        _warpPastHoldingPeriod();

        // Penalty should now be 0
        penalty = roboshareTokens.getSalesPenalty(user1, tokenId, amount);
        assertEq(penalty, 0, "Penalty should be zero after holding period");
    }

    // ID Conversion Tests

    function testGetAssetIdFromTokenId() public view {
        // Happy path: registered or unregistered (logic is dumb)
        uint256 tokenId = 1002;
        uint256 expectedAssetId = 1001;
        assertEq(roboshareTokens.getAssetIdFromTokenId(tokenId), expectedAssetId);
    }

    function testGetAssetIdFromTokenIdInvalidRevenueTokenIdZero() public {
        vm.expectRevert(TokenLib.InvalidRevenueTokenId.selector);
        roboshareTokens.getAssetIdFromTokenId(0);
    }

    function testGetAssetIdFromTokenIdInvalidRevenueTokenIdOdd() public {
        vm.expectRevert(TokenLib.InvalidRevenueTokenId.selector);
        roboshareTokens.getAssetIdFromTokenId(1001);
    }

    function testGetTokenIdFromAssetId() public view {
        // Happy path: registered or unregistered (logic is dumb)
        uint256 assetId = 1001;
        uint256 expectedTokenId = 1002;
        assertEq(roboshareTokens.getTokenIdFromAssetId(assetId), expectedTokenId);
    }

    function testGetTokenIdFromAssetIdInvalidAssetIdZero() public {
        vm.expectRevert(TokenLib.InvalidAssetId.selector);
        roboshareTokens.getTokenIdFromAssetId(0);
    }

    function testGetTokenIdFromAssetIdInvalidAssetIdEven() public {
        vm.expectRevert(TokenLib.InvalidAssetId.selector);
        roboshareTokens.getTokenIdFromAssetId(1002);
    }

    function testUpgradeUnauthorizedCaller() public {
        RoboshareTokens newImpl = new RoboshareTokens();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, roboshareTokens.UPGRADER_ROLE()
            )
        );
        vm.prank(unauthorized);
        roboshareTokens.upgradeToAndCall(address(newImpl), "");
    }
}
