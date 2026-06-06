// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { AssetMetadataBaseTest } from "./AssetMetadataBaseTest.t.sol";

abstract contract VehicleRegistryBaseTest is AssetMetadataBaseTest {
    enum OwnerAction {
        Retire,
        RetireAndBurn,
        Settle
    }

    function _performOwnerAction(OwnerAction action) internal {
        if (action == OwnerAction.Retire) {
            assetRegistry.retireAsset(scenario.assetId);
        } else if (action == OwnerAction.RetireAndBurn) {
            assetRegistry.retireAssetAndBurnTokens(scenario.assetId);
        } else {
            assetRegistry.settleAsset(scenario.assetId, 0);
        }
    }

    function _expectOwnerActionRevert(address caller, bytes4 selector, OwnerAction action) internal {
        _ensureState(SetupState.PrimaryPoolCreated);
        vm.prank(caller);
        vm.expectRevert(selector);
        _performOwnerAction(action);
    }

    function _assertAssetState(uint256 assetId, address expectedOwner, bool shouldExist) internal view {
        if (shouldExist) {
            assertEq(roboshareTokens.balanceOf(expectedOwner, assetId), 1, "Asset owner mismatch");
            assertTrue(assetRegistry.assetExists(assetId), "assetExists should be true");
        } else {
            assertEq(roboshareTokens.balanceOf(expectedOwner, assetId), 0, "Asset should not be owned");
            assertFalse(assetRegistry.assetExists(assetId), "assetExists should be false");
        }
    }

    function _assertVehicleState(uint256 assetId, address expectedOwner, string memory expectedVin, bool shouldExist)
        internal
        view
    {
        _assertAssetState(assetId, expectedOwner, shouldExist);

        if (shouldExist && bytes(expectedVin).length > 0) {
            (bytes32 vinHash,,) = assetRegistry.getVehicleInfo(assetId);
            assertEq(vinHash, keccak256(bytes(expectedVin)), "Vehicle VIN hash mismatch");
        }
    }
}
