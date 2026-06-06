// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { BaseTest } from "./BaseTest.t.sol";

abstract contract AssetMetadataBaseTest is BaseTest {
    string constant TEST_VIN = "1HGCM82633A123456";
    string constant TEST_MAKE = "Honda";
    string constant TEST_MODEL = "Civic";
    uint256 constant TEST_YEAR = 2024;
    uint256 constant TEST_MANUFACTURER_ID = 1;
    string constant TEST_OPTION_CODES = "EX-L,NAV,HSS";
    string constant TEST_METADATA_URI = "ipfs://QmYwAPJzv5CZsnA625b3Xm2fa12p45a8V34vG27s2p45a8";
    string constant TEST_REVENUE_TOKEN_METADATA_URI = "ipfs://QmRevenueTokenMetadata";

    function _setupAssetRegistered() internal virtual override returns (uint256 assetId) {
        vm.prank(partner1);
        assetId = assetRegistry.registerAsset(_vehicleRegistrationData(TEST_VIN), ASSET_VALUE);
    }

    function _setupPrimaryPoolCreated() internal virtual override returns (uint256 revenueTokenId) {
        uint256 maturityDate = block.timestamp + 365 days;
        uint256 supply = ASSET_VALUE / REVENUE_TOKEN_PRICE;

        vm.prank(partner1);
        (revenueTokenId,) = assetRegistry.createRevenueTokenPool(
            scenario.assetId, REVENUE_TOKEN_PRICE, maturityDate, 10_000, 1_000, supply, false, false
        );
    }

    function _setupPurchasedFromPrimaryPool() internal virtual override {
        _purchasePrimaryPoolTokens(buyer, scenario.revenueTokenId, PRIMARY_PURCHASE_AMOUNT);
    }

    function _purchasePrimaryPoolTokens(address purchaser, uint256 revenueTokenId, uint256 amount) internal {
        if (amount == 0) {
            return;
        }

        (uint256 expectedPayment,,) = marketplace.previewPrimaryPurchase(revenueTokenId, amount);
        if (usdc.balanceOf(purchaser) < expectedPayment) {
            deal(address(usdc), purchaser, expectedPayment);
        }

        vm.startPrank(purchaser);
        usdc.approve(address(marketplace), expectedPayment);
        marketplace.buyFromPrimaryPool(revenueTokenId, amount);
        vm.stopPrank();
    }

    function _generateVin(uint256 seed) internal pure returns (string memory) {
        string[10] memory vinPrefixes = [
            "1HGCM82633A",
            "2FMDK3GC1D",
            "3FA6P0H75H",
            "4T1BF1FK6G",
            "5NPE24AF3F",
            "6G2VX12G0L",
            "1N4AL3AP0G",
            "2T1BURHE3H",
            "3C4PDCAB0F",
            "4F4YR16U8V"
        ];

        uint256 prefixIndex = seed % 10;
        uint256 suffix = (seed % 900000) + 100000;
        return string(abi.encodePacked(vinPrefixes[prefixIndex], vm.toString(suffix)));
    }

    function _generateVehicleData(uint256 seed) internal pure returns (string memory vin, string memory metadataURI) {
        vin = _generateVin(seed);
        metadataURI = "ipfs://QmYwAPJzv5CZsnAzt8auVTLpG1bG6dkprdFM5ocTyBCQb";
    }

    function _createMultipleTestVehicles(address partner, uint256 count) internal returns (uint256[] memory assetIds) {
        assetIds = new uint256[](count);

        vm.startPrank(partner);
        for (uint256 i = 0; i < count; i++) {
            (string memory vin, string memory metadataURI) =
                _generateVehicleData(i + uint256(keccak256(abi.encodePacked(partner, block.timestamp))));

            assetIds[i] = assetRegistry.registerAsset(
                _vehicleRegistrationData(vin, metadataURI, TEST_REVENUE_TOKEN_METADATA_URI), ASSET_VALUE
            );
        }
        vm.stopPrank();

        return assetIds;
    }

    function _vehicleRegistrationData(string memory vin) internal pure returns (bytes memory) {
        return _vehicleRegistrationData(vin, TEST_METADATA_URI, TEST_REVENUE_TOKEN_METADATA_URI);
    }

    function _vehicleRegistrationData(
        string memory vin,
        string memory assetMetadataURI,
        string memory revenueTokenMetadataURI
    ) internal pure returns (bytes memory) {
        return abi.encode(vin, assetMetadataURI, revenueTokenMetadataURI);
    }

    function _legacyVehicleRegistrationData(string memory vin, string memory metadataURI)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(vin, TEST_MAKE, TEST_MODEL, TEST_YEAR, TEST_MANUFACTURER_ID, TEST_OPTION_CODES, metadataURI);
    }
}
