// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { ERC1155Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import {
    ERC1155HolderUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC1155/utils/ERC1155HolderUpgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ProtocolLib, TokenLib } from "./Libraries.sol";
import { IPositionManager } from "./interfaces/IPositionManager.sol";

/**
 * @title RoboshareTokens
 * @dev ERC1155 token contract with automatic position tracking for Roboshare protocol
 * Handles revenue sharing rights as fungible tokens with FIFO position tracking
 */
contract RoboshareTokens is
    Initializable,
    ERC1155Upgradeable,
    ERC1155HolderUpgradeable,
    AccessControlUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant URI_SETTER_ROLE = keccak256("URI_SETTER_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant AUTHORIZED_CONTRACT_ROLE = keccak256("AUTHORIZED_CONTRACT_ROLE");

    // Errors
    error ZeroAddress();
    error NotRevenueToken();
    error RevenueTokenInfoAlreadySet();
    error InvalidLockAmount();
    error InsufficientUnlockedBalance();
    error InsufficientLockedBalance();
    error EmptyMetadataURI();
    error PositionManagerNotSet();

    // Events
    event RevenueTokenPositionsUpdated(
        uint256 indexed revenueTokenId, address indexed from, address indexed to, uint256 amount
    );
    event RevenueTokenInfoSet(
        uint256 indexed revenueTokenId,
        uint256 price,
        uint256 supply,
        uint256 maxSupply,
        uint256 maturityDate,
        bool immediateProceeds,
        bool protectionEnabled
    );
    event RevenueTokenLocked(uint256 indexed revenueTokenId, address indexed holder, uint256 amount);
    event RevenueTokenUnlocked(uint256 indexed revenueTokenId, address indexed holder, uint256 amount);
    event PrimaryRedemptionStateUpdated(
        uint256 indexed revenueTokenId, uint256 redemptionEpoch, uint256 epochSupply, uint256 backedPrincipal
    );
    event TokenMetadataURISet(uint256 indexed tokenId, string metadataURI);
    event PositionManagerUpdated(address indexed previousManager, address indexed newManager);

    // Token state
    uint256 private _tokenIdCounter;
    mapping(uint256 => TokenLib.TokenInfo) private _revenueTokenInfos;
    // Deprecated token-owned lock bookkeeping kept only for storage-layout compatibility.
    mapping(address => mapping(uint256 => uint256)) private _lockedRevenueTokenAmounts;
    mapping(uint256 => string) private _tokenMetadataURIs;
    IPositionManager public positionManager;
    // Deprecated token-owned redemption burn context kept only for storage-layout compatibility.
    bool private _currentEpochBurnActive;
    address private _currentEpochBurnHolder;
    uint256 private _currentEpochBurnTokenId;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address defaultAdmin) public initializer {
        if (defaultAdmin == address(0)) revert ZeroAddress();
        __ERC1155_init("");
        __ERC1155Holder_init();
        __AccessControl_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(MINTER_ROLE, defaultAdmin);
        _grantRole(BURNER_ROLE, defaultAdmin);
        _grantRole(URI_SETTER_ROLE, defaultAdmin);
        _grantRole(UPGRADER_ROLE, defaultAdmin);
        _grantRole(AUTHORIZED_CONTRACT_ROLE, defaultAdmin);

        _tokenIdCounter = 1; // Start from 1, 0 reserved.
    }

    /**
     * @dev Reserves a unique pair of token IDs for a new asset.
     * The asset ID will be an odd number, and the revenue token ID will be the next even number.
     * Only callable by accounts with the MINTER_ROLE (i.e., an Asset Registry).
     * @return assetId The unique ID for the new asset.
     * @return revenueTokenId The unique ID for the asset's corresponding revenue token.
     */
    function reserveNextTokenIdPair() external onlyRole(MINTER_ROLE) returns (uint256 assetId, uint256 revenueTokenId) {
        assetId = _tokenIdCounter;
        revenueTokenId = _tokenIdCounter + 1;
        _tokenIdCounter += 2;
    }

    /**
     * @dev Initializes the economic info for a new revenue token.
     * Must be called by a minter (i.e., an Asset Registry) BEFORE minting the new revenue token.
     * @param revenueTokenId The ID of the revenue token.
     * @param supply The total supply of the revenue token.
     * @param price The initial price per token.
     * @param maturityDate The date by which the revenue commitment ends.
     */
    function setRevenueTokenInfo(
        uint256 revenueTokenId,
        uint256 price,
        uint256 supply,
        uint256 maxSupply,
        uint256 maturityDate,
        uint256 revenueShareBP,
        uint256 targetYieldBP,
        bool immediateProceeds,
        bool protectionEnabled
    ) external onlyRole(MINTER_ROLE) {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        TokenLib.TokenInfo storage tokenInfo = _revenueTokenInfos[revenueTokenId];
        if (tokenInfo.tokenId != 0) {
            revert RevenueTokenInfoAlreadySet();
        }

        TokenLib.initializeTokenInfo(
            tokenInfo,
            revenueTokenId,
            price,
            maxSupply,
            ProtocolLib.MONTHLY_INTERVAL, // Default holding period
            maturityDate,
            revenueShareBP,
            targetYieldBP,
            immediateProceeds,
            protectionEnabled
        );
        if (address(positionManager) != address(0)) {
            positionManager.syncRevenueTokenPolicy(revenueTokenId, tokenInfo.tokenPrice, tokenInfo.minHoldingPeriod);
        }
        emit RevenueTokenInfoSet(
            revenueTokenId, price, supply, maxSupply, maturityDate, immediateProceeds, protectionEnabled
        );
    }

    /**
     * @dev Mint tokens to specified address. Requires MINTER_ROLE.
     * @param to The address to mint tokens to.
     * @param id The ID of the token to mint.
     * @param amount The amount of tokens to mint.
     * @param data Additional data to be passed to the ERC1155 hook.
     */
    function mint(address to, uint256 id, uint256 amount, bytes memory data) external onlyRole(MINTER_ROLE) {
        _mint(to, id, amount, data);
    }

    /**
     * @dev Mints a batch of tokens. Requires MINTER_ROLE.
     * @param to The address to mint tokens to.
     * @param ids An array of token IDs to mint.
     * @param amounts An array of amounts corresponding to each token ID.
     * @param data Additional data to be passed to the ERC1155 hook.
     */
    function mintBatch(address to, uint256[] memory ids, uint256[] memory amounts, bytes memory data)
        external
        onlyRole(MINTER_ROLE)
    {
        _mintBatch(to, ids, amounts, data);
    }

    /**
     * @dev Burns tokens from a specified address. Requires BURNER_ROLE.
     * @param from The address to burn tokens from.
     * @param id The ID of the token to burn.
     * @param amount The amount of tokens to burn.
     */
    function burn(address from, uint256 id, uint256 amount) external onlyRole(BURNER_ROLE) {
        _burn(from, id, amount);
    }

    /**
     * @dev Burns a batch of tokens from a specified address. Requires BURNER_ROLE.
     * @param from The address to burn tokens from.
     * @param ids An array of token IDs to burn.
     * @param amounts An array of amounts corresponding to each token ID.
     */
    function burnBatch(address from, uint256[] memory ids, uint256[] memory amounts) external onlyRole(BURNER_ROLE) {
        _burnBatch(from, ids, amounts);
    }

    function managerBurnCurrentEpoch(address holder, uint256 revenueTokenId, uint256 amount)
        external
        onlyRole(MANAGER_ROLE)
    {
        _managerBurnCurrentEpoch(holder, revenueTokenId, amount);
    }

    /**
     * @dev Sets the base URI for all token types. Requires URI_SETTER_ROLE.
     * @param newuri The new URI for tokens.
     */
    function setURI(string memory newuri) external onlyRole(URI_SETTER_ROLE) {
        _setURI(newuri);
    }

    function setPositionManager(address newPositionManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newPositionManager == address(0)) revert ZeroAddress();

        IPositionManager manager = IPositionManager(newPositionManager);
        _syncRevenueTokenPolicies(manager);

        address previousManager = address(positionManager);
        if (previousManager != address(0)) {
            _revokeRole(MANAGER_ROLE, previousManager);
        }

        positionManager = manager;
        _grantRole(MANAGER_ROLE, newPositionManager);

        emit PositionManagerUpdated(previousManager, newPositionManager);
    }

    /**
     * @dev Sets metadata URI for a specific token ID.
     * Can be called by token minters (registries) and URI setters (admin/ops).
     */
    function setTokenMetadataURI(uint256 tokenId, string calldata metadataURI) external {
        if (!hasRole(URI_SETTER_ROLE, msg.sender) && !hasRole(MINTER_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, URI_SETTER_ROLE);
        }
        if (bytes(metadataURI).length == 0) revert EmptyMetadataURI();
        _tokenMetadataURIs[tokenId] = metadataURI;
        emit TokenMetadataURISet(tokenId, metadataURI);
    }

    /**
     * @dev Returns metadata URI for a token ID if present, else falls back to ERC1155 base URI pattern.
     */
    function uri(uint256 id) public view override returns (string memory) {
        string memory tokenMetadataURI = _tokenMetadataURIs[id];
        if (bytes(tokenMetadataURI).length > 0) {
            return tokenMetadataURI;
        }
        return super.uri(id);
    }

    /**
     * @dev Gets the next available asset ID that would be assigned.
     * @return The next available token ID.
     */
    function getNextTokenId() external view returns (uint256) {
        return _tokenIdCounter;
    }

    /**
     * @dev Get asset ID from token ID
     */
    function getAssetIdFromTokenId(uint256 tokenId) external pure returns (uint256) {
        return TokenLib.getAssetIdFromTokenId(tokenId);
    }

    /**
     * @dev Get token ID from asset ID
     */
    function getTokenIdFromAssetId(uint256 assetId) external pure returns (uint256) {
        return TokenLib.getTokenIdFromAssetId(assetId);
    }

    /**
     * @dev Gets the total supply tracked in positions for a specific token ID.
     * @param revenueTokenId The ID of the token.
     * @return The total supply tracked in positions.
     */
    function getRevenueTokenSupply(uint256 revenueTokenId) external view returns (uint256) {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        return _revenueTokenInfos[revenueTokenId].tokenSupply;
    }

    /**
     * @dev Gets the price for a specific revenue token ID.
     * @param revenueTokenId The ID of the revenue token.
     * @return The price per token.
     */
    function getTokenPrice(uint256 revenueTokenId) external view returns (uint256) {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        return _revenueTokenInfos[revenueTokenId].tokenPrice;
    }

    /**
     * @dev Gets the maturity date for a specific revenue token ID.
     * @param revenueTokenId The ID of the revenue token.
     * @return The maturity date timestamp.
     */
    function getTokenMaturityDate(uint256 revenueTokenId) external view returns (uint256) {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        return _revenueTokenInfos[revenueTokenId].maturityDate;
    }

    /**
     * @dev Gets the revenue share cap (basis points) for a revenue token.
     */
    function getRevenueShareBP(uint256 revenueTokenId) external view returns (uint256) {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        return _revenueTokenInfos[revenueTokenId].revenueShareBP;
    }

    /**
     * @dev Gets the target yield (basis points) for buffer benchmarks.
     */
    function getTargetYieldBP(uint256 revenueTokenId) external view returns (uint256) {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        return _revenueTokenInfos[revenueTokenId].targetYieldBP;
    }

    function getRevenueTokenMaxSupply(uint256 revenueTokenId) external view returns (uint256) {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        return _revenueTokenInfos[revenueTokenId].maxSupply;
    }

    function getRevenueTokenImmediateProceedsEnabled(uint256 revenueTokenId) external view returns (bool) {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        return _revenueTokenInfos[revenueTokenId].immediateProceeds;
    }

    function getRevenueTokenProtectionEnabled(uint256 revenueTokenId) external view returns (bool) {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        return _revenueTokenInfos[revenueTokenId].protectionEnabled;
    }

    function getLockedAmount(address holder, uint256 revenueTokenId) external view returns (uint256) {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        return _requirePositionManager().getLockedAmount(holder, revenueTokenId);
    }

    function lockForListing(address holder, uint256 revenueTokenId, uint256 amount) external onlyRole(MANAGER_ROLE) {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        if (amount == 0) revert InvalidLockAmount();
        _requirePositionManager().lockForListing(holder, revenueTokenId, amount);
    }

    function unlockForListing(address holder, uint256 revenueTokenId, uint256 amount) external onlyRole(MANAGER_ROLE) {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        if (amount == 0) revert InvalidLockAmount();
        _requirePositionManager().unlockForListing(holder, revenueTokenId, amount);
    }

    function _managerBurnCurrentEpoch(address holder, uint256 revenueTokenId, uint256 amount) internal {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        if (amount == 0) revert InvalidLockAmount();
        _requirePositionManager().preparePrimaryRedemptionBurn(holder, revenueTokenId);
        _burn(holder, revenueTokenId, amount);
    }

    function transferLockedForListing(
        address from,
        address to,
        uint256 revenueTokenId,
        uint256 amount,
        bytes memory data
    ) external onlyRole(MANAGER_ROLE) {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        if (amount == 0) revert InvalidLockAmount();
        _requirePositionManager().settleLockedTransfer(from, to, revenueTokenId, amount);
        _safeTransferFrom(from, to, revenueTokenId, amount, data);
    }

    /**
     * @dev Gets a user's token positions for earnings calculations.
     * @param revenueTokenId The revenue token ID.
     * @param holder The address of the token holder.
     * @return positions An array of the user's token positions.
     */
    function getUserPositions(uint256 revenueTokenId, address holder)
        external
        view
        returns (TokenLib.TokenPosition[] memory positions)
    {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        return _requirePositionManager().getUserPositions(revenueTokenId, holder);
    }

    function getPrimaryRedemptionEligibleBalance(address holder, uint256 revenueTokenId)
        external
        view
        returns (uint256)
    {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        return _requirePositionManager().getPrimaryRedemptionEligibleBalance(holder, revenueTokenId);
    }

    function getCurrentPrimaryRedemptionEpochSupply(uint256 revenueTokenId) external view returns (uint256) {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        return _requirePositionManager().getCurrentPrimaryRedemptionEpochSupply(revenueTokenId);
    }

    function getCurrentPrimaryRedemptionBackedPrincipal(uint256 revenueTokenId) external view returns (uint256) {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        return _requirePositionManager().getCurrentPrimaryRedemptionBackedPrincipal(revenueTokenId);
    }

    /**
     * @dev Calculates the early sale penalty for a given amount of tokens without modifying state.
     * This function is intended to be called by the Marketplace contract before a sale.
     * @param seller The address of the seller.
     * @param revenueTokenId The ID of the revenue token being sold.
     * @param amount The amount of tokens being sold.
     * @return penaltyAmount The calculated early sale penalty.
     */
    function getSalesPenalty(address seller, uint256 revenueTokenId, uint256 amount)
        external
        view
        returns (uint256 penaltyAmount)
    {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
        return _requirePositionManager().getSalesPenalty(seller, revenueTokenId, amount);
    }

    /**
     * @dev Overrides _update to implement automatic position tracking for revenue tokens.
     * Called on all mints, burns, and transfers.
     */
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        IPositionManager manager;
        bool hasRevenueToken;
        for (uint256 i = 0; i < ids.length; i++) {
            if (TokenLib.isRevenueToken(ids[i])) {
                hasRevenueToken = true;
                break;
            }
        }
        if (hasRevenueToken) {
            manager = _requirePositionManager();
        }

        // Disallow transferring/burning listed (locked) revenue tokens through normal token paths.
        // Marketplace listing fills unlock before transfer via transferLockedForListing().
        if (hasRevenueToken && from != address(0)) {
            for (uint256 i = 0; i < ids.length; i++) {
                uint256 tokenId = ids[i];
                uint256 amount = values[i];
                if (!TokenLib.isRevenueToken(tokenId)) continue;

                uint256 cumulative = amount;
                for (uint256 j = 0; j < i; j++) {
                    if (ids[j] == tokenId) {
                        cumulative += values[j];
                    }
                }

                uint256 available = manager.getAvailableAmount(from, tokenId, balanceOf(from, tokenId));
                if (cumulative > available) revert InsufficientUnlockedBalance();
            }
        }

        for (uint256 i = 0; i < ids.length; i++) {
            uint256 tokenId = ids[i];
            if (hasRevenueToken && TokenLib.isRevenueToken(tokenId)) {
                manager.beforeRevenueTokenUpdate(from, to, tokenId, values[i]);
            }
        }

        // Call parent implementation first
        super._update(from, to, ids, values);

        // Update positions for revenue share tokens
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 tokenId = ids[i];
            uint256 amount = values[i];

            // Only track revenue share tokens (even IDs)
            if (TokenLib.isRevenueToken(tokenId)) {
                TokenLib.TokenInfo storage tokenInfo = _revenueTokenInfos[tokenId];

                // Update total supply
                if (from == address(0)) {
                    tokenInfo.tokenSupply += amount;
                } else if (to == address(0)) {
                    tokenInfo.tokenSupply -= amount;
                }

                emit RevenueTokenPositionsUpdated(tokenId, from, to, amount);
            }
        }
    }

    /**
     * @dev Override supportsInterface to include all inherited interfaces.
     */
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155Upgradeable, ERC1155HolderUpgradeable, AccessControlUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _requirePositionManager() internal view returns (IPositionManager manager) {
        manager = positionManager;
        if (address(manager) == address(0)) revert PositionManagerNotSet();
    }

    function _syncRevenueTokenPolicies(IPositionManager manager) internal {
        for (uint256 revenueTokenId = 2; revenueTokenId < _tokenIdCounter; revenueTokenId += 2) {
            TokenLib.TokenInfo storage tokenInfo = _revenueTokenInfos[revenueTokenId];
            if (tokenInfo.tokenId == 0) continue;

            manager.syncRevenueTokenPolicy(revenueTokenId, tokenInfo.tokenPrice, tokenInfo.minHoldingPeriod);
        }
    }

    /**
     * @dev Required override for UUPS upgrades.
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) { }
}
