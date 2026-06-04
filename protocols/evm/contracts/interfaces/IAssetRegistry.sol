// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { AssetLib } from "../Libraries.sol";

/**
 * @title IAssetRegistry
 * @dev Generic Asset Registry interface for protocol-wide asset management
 * Designed to be implemented by different asset registries (Vehicle, Equipment, Real Estate, etc.)
 * Provides standardized access to asset information and token position management
 */
interface IAssetRegistry {
    /**
     * @dev Events for cross-contract communication and indexing.
     * Ordered by the main asset lifecycle flows.
     */
    event AssetRegistered(
        uint256 indexed assetId, address indexed owner, uint256 assetValue, AssetLib.AssetStatus status
    );
    event AssetStatusUpdated(
        uint256 indexed assetId, AssetLib.AssetStatus indexed oldStatus, AssetLib.AssetStatus indexed newStatus
    );
    event AssetSettled(
        uint256 indexed assetId, address indexed partner, uint256 settlementAmount, uint256 settlementPerToken
    );
    event AssetExpired(uint256 indexed assetId, uint256 liquidationAmount, uint256 settlementPerToken);
    event SettlementClaimed(uint256 indexed assetId, address indexed holder, uint256 amount, uint256 payout);
    event AssetRetired(
        uint256 indexed assetId, address indexed partner, uint256 burnedTokens, uint256 releasedCollateral
    );

    /**
     * @dev Shared errors ordered by the main registry execution paths.
     */
    error AssetNotFound(uint256 assetId);
    error NotAssetOwner();
    error AssetNotActive(uint256 assetId, AssetLib.AssetStatus currentStatus);
    error RevenueTokensAlreadyMinted();
    error RevenueTokensNotMinted(uint256 assetId);
    error AssetAlreadySettled(uint256 assetId, AssetLib.AssetStatus currentStatus);
    error AssetNotEligibleForLiquidation(uint256 assetId);
    error AssetNotSettled(uint256 assetId, AssetLib.AssetStatus currentStatus);
    error InsufficientTokenBalance(uint256 tokenId, uint256 required, uint256 available);
    error InvalidPoolSupply();

    /**
     * @dev Asset registration and revenue token pool creation.
     * @param data Registry-specific ABI payload. VehicleRegistry expects
     *        abi.encode(string vin, string assetMetadataURI, string revenueTokenMetadataURI).
     */
    function registerAsset(bytes calldata data, uint256 assetValue) external returns (uint256 assetId);

    function registerAssetAndCreateRevenueTokenPool(
        bytes calldata data,
        uint256 assetValue,
        uint256 tokenPrice,
        uint256 maturityDate,
        uint256 revenueShareBP,
        uint256 targetYieldBP,
        uint256 maxSupply,
        bool immediateProceeds,
        bool protectionEnabled
    ) external returns (uint256 assetId, uint256 tokenId, uint256 supply);

    function createRevenueTokenPool(
        uint256 assetId,
        uint256 tokenPrice,
        uint256 maturityDate,
        uint256 revenueShareBP,
        uint256 targetYieldBP,
        uint256 maxSupply,
        bool immediateProceeds,
        bool protectionEnabled
    ) external returns (uint256 tokenId, uint256 supply);

    /**
     * @dev Preview revenue token pool creation for an asset.
     * Reverts if the asset is invalid or caller is not authorized.
     * @param assetId The asset ID
     * @param partner The partner initiating the pool creation
     * @param requestedSupply Explicit pool size to validate
     * @return tokenId The revenue token ID
     * @return supply The approved token supply
     */
    function previewCreateRevenueTokenPool(uint256 assetId, address partner, uint256 requestedSupply)
        external
        view
        returns (uint256 tokenId, uint256 supply);

    /**
     * @dev Asset lifecycle operations.
     */
    function settleAsset(uint256 assetId, uint256 topUpAmount) external;
    function liquidateAsset(uint256 assetId) external;
    function executeSettlementClaimFor(address account, uint256 assetId, bool autoClaimEarnings)
        external
        returns (uint256 claimedAmount, uint256 earningsClaimed);
    function burnRevenueTokens(uint256 assetId, uint256 amount) external;
    function retireAsset(uint256 assetId) external;
    function retireAssetAndBurnTokens(uint256 assetId) external;

    /**
     * @dev State management.
     */
    function setAssetStatus(uint256 assetId, AssetLib.AssetStatus status) external;

    /**
     * @dev Asset existence and validation views.
     */
    function assetExists(uint256 assetId) external view returns (bool);
    function getAssetInfo(uint256 assetId) external view returns (AssetLib.AssetInfo memory);
    function getAssetStatus(uint256 assetId) external view returns (AssetLib.AssetStatus);
    function getRegistryForAsset(uint256 assetId) external view returns (address);

    /**
     * @dev Registry metadata and capabilities.
     */
    function getRegistryType() external pure returns (string memory);
    function getRegistryVersion() external pure returns (uint256);
}
