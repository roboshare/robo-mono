// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { TreasuryFlowBaseTest } from "../base/TreasuryFlowBaseTest.t.sol";
import { MockUSDC } from "../../contracts/mocks/MockUSDC.sol";
import { RoboshareTokens } from "../../contracts/RoboshareTokens.sol";
import { PartnerManager } from "../../contracts/PartnerManager.sol";
import { EarningsManager } from "../../contracts/EarningsManager.sol";

contract EarningsManagerTest is TreasuryFlowBaseTest {
    function setUp() public {
        _ensureState(SetupState.ContractsDeployed);
    }

    function testInitialization() public view {
        assertEq(address(earningsManager.roboshareTokens()), address(roboshareTokens));
        assertEq(address(earningsManager.partnerManager()), address(partnerManager));
        assertEq(address(earningsManager.router()), address(router));
        assertEq(address(earningsManager.treasury()), address(treasury));
        assertEq(earningsManager.positionManager(), address(positionManager));
        assertEq(address(earningsManager.usdc()), address(usdc));

        assertTrue(earningsManager.hasRole(earningsManager.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(earningsManager.hasRole(earningsManager.UPGRADER_ROLE(), admin));
        assertTrue(earningsManager.hasRole(earningsManager.AUTHORIZED_CONTRACT_ROLE(), address(treasury)));
        assertTrue(earningsManager.hasRole(earningsManager.AUTHORIZED_CONTRACT_ROLE(), address(router)));
        assertTrue(earningsManager.hasRole(earningsManager.AUTHORIZED_CONTRACT_ROLE(), address(positionManager)));
    }

    function testInitializationZeroAddress() public {
        EarningsManager impl = new EarningsManager();
        vm.expectRevert(EarningsManager.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
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

    function testSnapshotAndClaimEarningsAllowsRouter() public {
        vm.prank(address(router));
        uint256 amount = earningsManager.snapshotAndClaimEarnings(999, buyer, false);
        assertEq(amount, 0);
    }

    function testSnapshotAndClaimEarningsAllowsTreasury() public {
        vm.prank(address(treasury));
        uint256 amount = earningsManager.snapshotAndClaimEarnings(999, buyer, false);
        assertEq(amount, 0);
    }

    function testTransferPositionClaimStateAllowsPositionManager() public {
        vm.prank(address(positionManager));
        earningsManager.transferPositionClaimState(999, buyer, unauthorized, 2, 0, 0);
    }

    function testSnapshotAndClaimEarningsUnauthorizedCaller() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                unauthorized,
                earningsManager.AUTHORIZED_CONTRACT_ROLE()
            )
        );
        vm.prank(unauthorized);
        earningsManager.snapshotAndClaimEarnings(999, buyer, false);
    }

    function testUpdateTreasury() public {
        address newTreasury = makeAddr("newTreasury");
        address oldTreasury = address(earningsManager.treasury());

        vm.prank(admin);
        earningsManager.updateTreasury(newTreasury);

        assertEq(address(earningsManager.treasury()), newTreasury);
        assertFalse(earningsManager.hasRole(earningsManager.AUTHORIZED_CONTRACT_ROLE(), oldTreasury));
        assertTrue(earningsManager.hasRole(earningsManager.AUTHORIZED_CONTRACT_ROLE(), newTreasury));
    }

    function testUpdateTreasuryZeroAddress() public {
        vm.expectRevert(EarningsManager.ZeroAddress.selector);
        vm.prank(admin);
        earningsManager.updateTreasury(address(0));
    }

    function testUpdateTreasuryUnauthorizedCaller() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                unauthorized,
                earningsManager.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(unauthorized);
        earningsManager.updateTreasury(makeAddr("newTreasury"));
    }

    function testUpdatePositionManager() public {
        address newPositionManager = makeAddr("newPositionManager");
        address oldPositionManager = earningsManager.positionManager();

        vm.prank(admin);
        earningsManager.updatePositionManager(newPositionManager);

        assertEq(earningsManager.positionManager(), newPositionManager);
        assertFalse(earningsManager.hasRole(earningsManager.AUTHORIZED_CONTRACT_ROLE(), oldPositionManager));
        assertTrue(earningsManager.hasRole(earningsManager.AUTHORIZED_CONTRACT_ROLE(), newPositionManager));
    }

    function testUpdateRouter() public {
        address newRouter = makeAddr("newRouter");
        address oldRouter = address(earningsManager.router());

        vm.prank(admin);
        earningsManager.updateRouter(newRouter);

        assertEq(address(earningsManager.router()), newRouter);
        assertFalse(earningsManager.hasRole(earningsManager.AUTHORIZED_CONTRACT_ROLE(), oldRouter));
        assertTrue(earningsManager.hasRole(earningsManager.AUTHORIZED_CONTRACT_ROLE(), newRouter));
    }

    function testUpdateRouterZeroAddress() public {
        vm.expectRevert(EarningsManager.ZeroAddress.selector);
        vm.prank(admin);
        earningsManager.updateRouter(address(0));
    }

    function testUpdatePartnerManager() public {
        PartnerManager newPartnerManager = new PartnerManager();

        vm.prank(admin);
        earningsManager.updatePartnerManager(address(newPartnerManager));

        assertEq(address(earningsManager.partnerManager()), address(newPartnerManager));
    }

    function testUpdatePartnerManagerZeroAddress() public {
        vm.expectRevert(EarningsManager.ZeroAddress.selector);
        vm.prank(admin);
        earningsManager.updatePartnerManager(address(0));
    }

    function testUpdateRoboshareTokens() public {
        RoboshareTokens newRoboshareTokens = new RoboshareTokens();

        vm.prank(admin);
        earningsManager.updateRoboshareTokens(address(newRoboshareTokens));

        assertEq(address(earningsManager.roboshareTokens()), address(newRoboshareTokens));
    }

    function testUpdateRoboshareTokensZeroAddress() public {
        vm.expectRevert(EarningsManager.ZeroAddress.selector);
        vm.prank(admin);
        earningsManager.updateRoboshareTokens(address(0));
    }

    function testUpdateUSDC() public {
        MockUSDC newUsdc = new MockUSDC();

        vm.prank(admin);
        earningsManager.updateUSDC(address(newUsdc));

        assertEq(address(earningsManager.usdc()), address(newUsdc));
    }

    function testUpdateUSDCZeroAddress() public {
        vm.expectRevert(EarningsManager.ZeroAddress.selector);
        vm.prank(admin);
        earningsManager.updateUSDC(address(0));
    }

    function testUpgradeAuthorizedCaller() public {
        EarningsManager newImpl = new EarningsManager();

        vm.prank(admin);
        earningsManager.upgradeToAndCall(address(newImpl), "");
    }

    function testUpgradeUnauthorizedCaller() public {
        EarningsManager newImpl = new EarningsManager();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, unauthorized, earningsManager.UPGRADER_ROLE()
            )
        );
        vm.prank(unauthorized);
        earningsManager.upgradeToAndCall(address(newImpl), "");
    }
}
