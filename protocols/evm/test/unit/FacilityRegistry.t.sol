// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { BaseTest } from "../base/BaseTest.t.sol";
import { AssetLib } from "../../contracts/Libraries.sol";
import { FacilityRegistry } from "../../contracts/FacilityRegistry.sol";
import { IAssetRegistry } from "../../contracts/interfaces/IAssetRegistry.sol";
import { Marketplace } from "../../contracts/Marketplace.sol";

contract FacilityRegistryTest is BaseTest {
    FacilityRegistry public facilityRegistry;

    bytes32 internal constant FACILITY_COMMITMENT = keccak256("robomata-facility-commitment");
    bytes32 internal constant SECOND_FACILITY_COMMITMENT = keccak256("robomata-facility-commitment-2");
    string internal constant FACILITY_ASSET_METADATA_URI = "ipfs://QmYwAPJzv5CZsnA625b3Xm2fa12p45a8V34vG27s2p45a8";
    string internal constant FACILITY_REVENUE_TOKEN_METADATA_URI = "ipfs://QmRevenueTokenMetadata";

    function setUp() public {
        _ensureState(SetupState.InitialAccountsSetup);
        _deployFacilityRegistry();
    }

    function _setupAssetRegistered() internal pure override returns (uint256) {
        return 0;
    }

    function _setupPrimaryPoolCreated() internal pure override returns (uint256) {
        return 0;
    }

    function _setupPurchasedFromPrimaryPool() internal override { }

    function _setupBuffersFunded() internal override { }

    function _setupEarningsDistributed(uint256) internal override { }

    function testRegisterAssetStoresCommitmentMetadataAndTokenUris() public {
        vm.expectEmit(true, true, false, true, address(facilityRegistry));
        emit IAssetRegistry.AssetRegistered(1, partner1, ASSET_VALUE, AssetLib.AssetStatus.Pending);

        vm.expectEmit(true, true, true, true, address(facilityRegistry));
        emit FacilityRegistry.FacilityMetadataUpdated(
            1, FACILITY_COMMITMENT, FACILITY_ASSET_METADATA_URI, FACILITY_REVENUE_TOKEN_METADATA_URI
        );

        vm.prank(partner1);
        uint256 assetId = facilityRegistry.registerAsset(_facilityRegistrationData(FACILITY_COMMITMENT), ASSET_VALUE);

        assertEq(assetId, 1);
        assertTrue(facilityRegistry.assetExists(assetId));
        assertTrue(facilityRegistry.facilityCommitmentExists(FACILITY_COMMITMENT));
        assertEq(facilityRegistry.getRegistryForAsset(assetId), address(facilityRegistry));
        assertEq(router.getRegistryForAsset(assetId), address(facilityRegistry));
        assertEq(router.getRegistryForAsset(assetId + 1), address(facilityRegistry));
        assertEq(roboshareTokens.balanceOf(partner1, assetId), 1);
        assertEq(roboshareTokens.uri(assetId), FACILITY_ASSET_METADATA_URI);
        assertEq(roboshareTokens.uri(assetId + 1), FACILITY_REVENUE_TOKEN_METADATA_URI);

        (bytes32 storedCommitment, string memory assetMetadataURI, string memory revenueTokenMetadataURI) =
            facilityRegistry.getFacilityInfo(assetId);
        assertEq(storedCommitment, FACILITY_COMMITMENT);
        assertEq(assetMetadataURI, FACILITY_ASSET_METADATA_URI);
        assertEq(revenueTokenMetadataURI, FACILITY_REVENUE_TOKEN_METADATA_URI);
    }

    function testRegisterAssetRejectsDuplicateFacilityCommitment() public {
        vm.prank(partner1);
        facilityRegistry.registerAsset(_facilityRegistrationData(FACILITY_COMMITMENT), ASSET_VALUE);

        vm.expectRevert(FacilityRegistry.FacilityAlreadyExists.selector);
        vm.prank(partner2);
        facilityRegistry.registerAsset(_facilityRegistrationData(FACILITY_COMMITMENT), ASSET_VALUE);
    }

    function testCreateRevenueTokenPoolThroughRouter() public {
        vm.prank(partner1);
        uint256 assetId = facilityRegistry.registerAsset(_facilityRegistrationData(FACILITY_COMMITMENT), ASSET_VALUE);

        uint256 explicitSupply = (ASSET_VALUE / REVENUE_TOKEN_PRICE) / 2;

        vm.prank(partner1);
        (uint256 revenueTokenId, uint256 supply) = router.createRevenueTokenPool(
            assetId, REVENUE_TOKEN_PRICE, block.timestamp + 365 days, 10_000, 1_000, explicitSupply, false, false
        );

        assertEq(revenueTokenId, assetId + 1);
        assertEq(supply, explicitSupply);
        assertEq(uint8(facilityRegistry.getAssetStatus(assetId)), uint8(AssetLib.AssetStatus.Active));
        assertEq(roboshareTokens.getRevenueTokenMaxSupply(revenueTokenId), explicitSupply);

        Marketplace.PrimaryPool memory pool = marketplace.getPrimaryPool(revenueTokenId);
        assertEq(pool.tokenId, revenueTokenId);
        assertEq(pool.partner, partner1);
        assertEq(pool.pricePerToken, REVENUE_TOKEN_PRICE);
    }

    function testRegisterAssetAndCreateRevenueTokenPool() public {
        uint256 explicitSupply = (ASSET_VALUE / REVENUE_TOKEN_PRICE) / 2;

        vm.prank(partner1);
        (uint256 assetId, uint256 revenueTokenId, uint256 supply) = facilityRegistry.registerAssetAndCreateRevenueTokenPool(
            _facilityRegistrationData(SECOND_FACILITY_COMMITMENT),
            ASSET_VALUE,
            REVENUE_TOKEN_PRICE,
            block.timestamp + 365 days,
            10_000,
            1_000,
            explicitSupply,
            false,
            false
        );

        assertEq(assetId, 1);
        assertEq(revenueTokenId, 2);
        assertEq(supply, explicitSupply);
        assertEq(uint8(facilityRegistry.getAssetStatus(assetId)), uint8(AssetLib.AssetStatus.Active));
        assertEq(router.getRegistryForAsset(assetId), address(facilityRegistry));
        assertEq(router.getRegistryForAsset(revenueTokenId), address(facilityRegistry));
        assertEq(roboshareTokens.uri(assetId), FACILITY_ASSET_METADATA_URI);
        assertEq(roboshareTokens.uri(revenueTokenId), FACILITY_REVENUE_TOKEN_METADATA_URI);
    }

    function testPreviewCreateRevenueTokenPool() public {
        vm.prank(partner1);
        uint256 assetId = facilityRegistry.registerAsset(_facilityRegistrationData(FACILITY_COMMITMENT), ASSET_VALUE);

        uint256 explicitSupply = (ASSET_VALUE / REVENUE_TOKEN_PRICE) / 2;
        (uint256 revenueTokenId, uint256 supply) =
            facilityRegistry.previewCreateRevenueTokenPool(assetId, partner1, explicitSupply);

        assertEq(revenueTokenId, assetId + 1);
        assertEq(supply, explicitSupply);
    }

    function _deployFacilityRegistry() internal {
        FacilityRegistry implementation = new FacilityRegistry();
        bytes memory initData = abi.encodeWithSignature(
            "initialize(address,address,address,address)",
            admin,
            address(roboshareTokens),
            address(partnerManager),
            address(router)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
        facilityRegistry = FacilityRegistry(address(proxy));

        vm.startPrank(admin);
        router.grantRole(router.AUTHORIZED_REGISTRY_ROLE(), address(facilityRegistry));
        roboshareTokens.grantRole(roboshareTokens.MINTER_ROLE(), address(facilityRegistry));
        roboshareTokens.grantRole(roboshareTokens.BURNER_ROLE(), address(facilityRegistry));
        vm.stopPrank();
    }

    function _facilityRegistrationData(bytes32 facilityCommitment) internal pure returns (bytes memory) {
        return abi.encode(facilityCommitment, FACILITY_ASSET_METADATA_URI, FACILITY_REVENUE_TOKEN_METADATA_URI);
    }
}
