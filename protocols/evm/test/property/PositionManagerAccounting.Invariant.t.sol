// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { Test } from "forge-std/Test.sol";
import { TokenLib } from "../../contracts/Libraries.sol";
import { PositionManager } from "../../contracts/PositionManager.sol";
import { RoboshareTokens } from "../../contracts/RoboshareTokens.sol";

contract PositionManagerAccountingHandler is Test {
    RoboshareTokens internal roboshareTokens;
    PositionManager internal positionManager;
    address internal admin;
    address internal managerActor;
    address internal proceedsActor;
    address[] internal actors;
    uint256 internal revenueTokenId;
    uint256 internal tokenPrice;
    uint256 internal maxSupply;

    uint256 public expectedCurrentEpoch;
    uint256 public expectedCurrentEpochSupply;
    uint256 public expectedBackedPrincipal;
    mapping(address => uint256) public expectedLocked;

    constructor(
        RoboshareTokens _roboshareTokens,
        PositionManager _positionManager,
        address _admin,
        address _proceedsActor,
        uint256 _revenueTokenId,
        uint256 _tokenPrice,
        uint256 _maxSupply,
        address[] memory _actors
    ) {
        roboshareTokens = _roboshareTokens;
        positionManager = _positionManager;
        admin = _admin;
        managerActor = address(_positionManager);
        proceedsActor = _proceedsActor;
        revenueTokenId = _revenueTokenId;
        tokenPrice = _tokenPrice;
        maxSupply = _maxSupply;
        actors = _actors;
    }

    function mint(uint256 actorSeed, uint256 amountSeed) external {
        uint256 currentSupply = roboshareTokens.getRevenueTokenSupply(revenueTokenId);
        if (currentSupply >= maxSupply) return;

        address holder = actors[actorSeed % actors.length];
        uint256 amount = bound(amountSeed, 1, maxSupply - currentSupply);

        vm.prank(admin);
        roboshareTokens.mint(holder, revenueTokenId, amount, "");

        expectedCurrentEpochSupply += amount;
        expectedBackedPrincipal += amount * tokenPrice;
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amountSeed) external {
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        if (from == to) return;

        uint256 balance = roboshareTokens.balanceOf(from, revenueTokenId);
        uint256 locked = expectedLocked[from];
        if (balance <= locked) return;

        uint256 amount = bound(amountSeed, 1, balance - locked);

        vm.prank(from);
        roboshareTokens.safeTransferFrom(from, to, revenueTokenId, amount, "");
    }

    function burn(uint256 actorSeed, uint256 amountSeed) external {
        address holder = actors[actorSeed % actors.length];
        uint256 balance = roboshareTokens.balanceOf(holder, revenueTokenId);
        uint256 locked = expectedLocked[holder];
        if (balance <= locked) return;

        uint256 amount = bound(amountSeed, 1, balance - locked);
        uint256 burnedFromCurrentEpoch = _previewBurnedFromCurrentEpoch(holder, amount);

        vm.prank(admin);
        roboshareTokens.burn(holder, revenueTokenId, amount);

        if (burnedFromCurrentEpoch > 0) {
            expectedCurrentEpochSupply -= burnedFromCurrentEpoch;
        }
    }

    function burnCurrentEpoch(uint256 actorSeed, uint256 amountSeed) external {
        address holder = actors[actorSeed % actors.length];
        uint256 eligibleBalance = roboshareTokens.getPrimaryRedemptionEligibleBalance(holder, revenueTokenId);
        uint256 balance = roboshareTokens.balanceOf(holder, revenueTokenId);
        uint256 locked = expectedLocked[holder];
        if (eligibleBalance == 0 || balance <= locked) return;

        uint256 amount = bound(amountSeed, 1, eligibleBalance < balance - locked ? eligibleBalance : balance - locked);

        vm.prank(managerActor);
        roboshareTokens.managerBurnCurrentEpoch(holder, revenueTokenId, amount);

        expectedCurrentEpochSupply -= amount;
    }

    function lock(uint256 actorSeed, uint256 amountSeed) external {
        address holder = actors[actorSeed % actors.length];
        uint256 balance = roboshareTokens.balanceOf(holder, revenueTokenId);
        uint256 locked = expectedLocked[holder];
        if (balance <= locked) return;

        uint256 amount = bound(amountSeed, 1, balance - locked);

        vm.prank(managerActor);
        roboshareTokens.lockForListing(holder, revenueTokenId, amount);

        expectedLocked[holder] += amount;
    }

    function unlock(uint256 actorSeed, uint256 amountSeed) external {
        address holder = actors[actorSeed % actors.length];
        uint256 locked = expectedLocked[holder];
        if (locked == 0) return;

        uint256 amount = bound(amountSeed, 1, locked);

        vm.prank(managerActor);
        roboshareTokens.unlockForListing(holder, revenueTokenId, amount);

        expectedLocked[holder] -= amount;
    }

    function transferLocked(uint256 fromSeed, uint256 toSeed, uint256 amountSeed) external {
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        if (from == to) return;

        uint256 locked = expectedLocked[from];
        if (locked == 0) return;

        uint256 amount = bound(amountSeed, 1, locked);

        vm.prank(managerActor);
        roboshareTokens.transferLockedForListing(from, to, revenueTokenId, amount, "");

        expectedLocked[from] -= amount;
    }

    function releaseImmediate(uint256 amountSeed) external {
        if (expectedBackedPrincipal == 0) return;

        uint256 amount = bound(amountSeed, 1, expectedBackedPrincipal);

        vm.prank(proceedsActor);
        positionManager.recordImmediateProceedsRelease(revenueTokenId, amount, keccak256("IMMEDIATE_PROCEEDS_RELEASE"));

        _applyPrincipalRelease(amount);
    }

    function payoutPrimary(uint256 amountSeed) external {
        if (expectedBackedPrincipal == 0) return;

        uint256 amount = bound(amountSeed, 1, expectedBackedPrincipal);

        vm.prank(proceedsActor);
        positionManager.recordPrimaryRedemptionPayout(revenueTokenId, amount, keccak256("PRIMARY_REDEMPTION_PAYOUT"));

        _applyPrincipalRelease(amount);
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 index) external view returns (address) {
        return actors[index];
    }

    function _applyPrincipalRelease(uint256 amount) internal {
        if (amount >= expectedBackedPrincipal) {
            expectedBackedPrincipal = 0;
        } else {
            expectedBackedPrincipal -= amount;
        }

        _rollEpochIfExhausted();
    }

    function _rollEpochIfExhausted() internal {
        if (expectedCurrentEpochSupply > 0 && expectedBackedPrincipal > 0) {
            return;
        }

        expectedCurrentEpoch++;
        expectedCurrentEpochSupply = 0;
        expectedBackedPrincipal = 0;
    }

    function _previewBurnedFromCurrentEpoch(address holder, uint256 amount) internal view returns (uint256 burned) {
        TokenLib.TokenPosition[] memory positions = roboshareTokens.getUserPositions(revenueTokenId, holder);
        uint256 remaining = amount;
        uint256 currentEpoch = positionManager.getCurrentPrimaryRedemptionEpoch(revenueTokenId);

        for (uint256 i = 0; i < positions.length && remaining > 0; i++) {
            if (positions[i].amount == 0) continue;

            uint256 toBurn = remaining > positions[i].amount ? positions[i].amount : remaining;
            if (positions[i].redemptionEpoch == currentEpoch) {
                burned += toBurn;
            }
            remaining -= toBurn;
        }
    }
}

contract PositionManagerAccountingInvariantTest is StdInvariant, Test {
    PositionManagerAccountingHandler internal handler;
    RoboshareTokens internal roboshareTokens;
    PositionManager internal positionManager;

    address internal admin = makeAddr("admin");
    address internal registryRouter = makeAddr("registryRouter");
    address internal partnerManager = makeAddr("partnerManager");
    address internal marketplace = makeAddr("marketplace");
    address internal treasury = makeAddr("treasury");
    address internal earningsManager = makeAddr("earningsManager");
    address internal usdc = makeAddr("usdc");

    uint256 internal constant REVENUE_TOKEN_ID = 102;
    uint256 internal constant TOKEN_PRICE = 10e6;
    uint256 internal constant MAX_SUPPLY = 500;

    function setUp() public {
        vm.etch(earningsManager, hex"00");
        roboshareTokens = RoboshareTokens(
            address(
                new ERC1967Proxy(address(new RoboshareTokens()), abi.encodeCall(RoboshareTokens.initialize, (admin)))
            )
        );
        positionManager = PositionManager(
            address(
                new ERC1967Proxy(
                    address(new PositionManager()),
                    abi.encodeCall(
                        PositionManager.initialize,
                        (
                            admin,
                            registryRouter,
                            address(roboshareTokens),
                            partnerManager,
                            marketplace,
                            treasury,
                            earningsManager,
                            usdc
                        )
                    )
                )
            )
        );

        vm.prank(admin);
        roboshareTokens.setPositionManager(address(positionManager));

        vm.prank(admin);
        roboshareTokens.setRevenueTokenInfo(
            REVENUE_TOKEN_ID,
            TOKEN_PRICE,
            MAX_SUPPLY,
            MAX_SUPPLY,
            block.timestamp + 365 days,
            10_000,
            1_000,
            false,
            false
        );

        address[] memory actors = new address[](4);
        actors[0] = makeAddr("alice");
        actors[1] = makeAddr("bob");
        actors[2] = makeAddr("carol");
        actors[3] = makeAddr("dave");

        for (uint256 i = 0; i < actors.length; i++) {
            vm.etch(actors[i], bytes(""));
        }

        handler = new PositionManagerAccountingHandler(
            roboshareTokens, positionManager, admin, registryRouter, REVENUE_TOKEN_ID, TOKEN_PRICE, MAX_SUPPLY, actors
        );
        targetContract(address(handler));
    }

    function invariantLockedAmountsMatchAccountingAndBalances() public view {
        uint256 actorCount = handler.actorCount();
        for (uint256 i = 0; i < actorCount; i++) {
            address actor = handler.actorAt(i);
            uint256 locked = positionManager.getLockedAmount(actor, REVENUE_TOKEN_ID);
            assertEq(locked, handler.expectedLocked(actor), "locked amount drifted");
            assertLe(locked, roboshareTokens.balanceOf(actor, REVENUE_TOKEN_ID), "locked exceeds balance");
        }
    }

    function invariantCurrentEpochSupplyMatchesEligibleBalances() public view {
        uint256 eligibleSum;
        uint256 actorCount = handler.actorCount();

        for (uint256 i = 0; i < actorCount; i++) {
            eligibleSum += positionManager.getPrimaryRedemptionEligibleBalance(handler.actorAt(i), REVENUE_TOKEN_ID);
        }

        assertEq(
            positionManager.getCurrentPrimaryRedemptionEpoch(REVENUE_TOKEN_ID),
            handler.expectedCurrentEpoch(),
            "current epoch drifted"
        );
        assertEq(
            positionManager.getCurrentPrimaryRedemptionEpochSupply(REVENUE_TOKEN_ID),
            handler.expectedCurrentEpochSupply(),
            "current epoch supply drifted"
        );
        assertEq(
            positionManager.getCurrentPrimaryRedemptionEpochSupply(REVENUE_TOKEN_ID),
            eligibleSum,
            "eligible balances do not match epoch supply"
        );
    }

    function invariantBackedPrincipalMatchesAccounting() public view {
        uint256 backedPrincipal = positionManager.getCurrentPrimaryRedemptionBackedPrincipal(REVENUE_TOKEN_ID);
        assertEq(backedPrincipal, handler.expectedBackedPrincipal(), "backed principal drifted");
    }
}
