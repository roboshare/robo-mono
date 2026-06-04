// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IAssetRegistry } from "./interfaces/IAssetRegistry.sol";
import { IEarningsManager } from "./interfaces/IEarningsManager.sol";
import { ITreasury } from "./interfaces/ITreasury.sol";
import { IMarketplace } from "./interfaces/IMarketplace.sol";
import { IPositionManager } from "./interfaces/IPositionManager.sol";
import { AssetLib, TokenLib } from "./Libraries.sol";
import { RoboshareTokens } from "./RoboshareTokens.sol";
import { PartnerManager } from "./PartnerManager.sol";

/**
 * @title RegistryRouter
 * @dev Central router for all asset registries in the Roboshare Protocol
 * Routes asset-specific calls to the appropriate registry based on asset ID
 * Manages the global asset ID counter via RoboshareTokens
 * Also routes Treasury and Marketplace operations on behalf of asset registries
 */
contract RegistryRouter is Initializable, AccessControlUpgradeable, UUPSUpgradeable, IAssetRegistry {
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant REGISTRY_ADMIN_ROLE = keccak256("REGISTRY_ADMIN_ROLE");
    bytes32 public constant AUTHORIZED_REGISTRY_ROLE = keccak256("AUTHORIZED_REGISTRY_ROLE");

    // Core contracts
    RoboshareTokens public roboshareTokens;
    PartnerManager public partnerManager;
    address public treasury;
    address public earningsManager;
    address public marketplace;

    // Registry management
    mapping(uint256 => address) public idToRegistry;

    // Errors
    error ZeroAddress();
    error RegistryNotFound(uint256 id);
    error RegistryNotBoundToAsset();
    error TreasuryNotSet();
    error EarningsManagerNotSet();
    error MarketplaceNotSet();
    error InvalidMarketplace(address marketplace);
    error NotTreasury();
    error NotMarketplace();
    error DirectCallNotAllowed();
    error InvalidTokenPrice();
    error PositionManagerNotSet();
    error InvalidPositionManager(address manager);

    // Events
    event IdBoundToRegistry(uint256 indexed id, address indexed registry);
    event RevenueTokenPoolCreated(
        uint256 indexed assetId,
        uint256 indexed revenueTokenId,
        address indexed partner,
        uint256 assetValue,
        uint256 supply
    );
    event RoboshareTokensUpdated(address indexed oldAddress, address indexed newAddress);
    event PartnerManagerUpdated(address indexed oldAddress, address indexed newAddress);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _admin, address _roboshareTokens, address _partnerManager) public initializer {
        if (_admin == address(0) || _roboshareTokens == address(0) || _partnerManager == address(0)) {
            revert ZeroAddress();
        }

        __AccessControl_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(UPGRADER_ROLE, _admin);
        _grantRole(REGISTRY_ADMIN_ROLE, _admin);

        // Set REGISTRY_ADMIN_ROLE as the admin of AUTHORIZED_REGISTRY_ROLE
        // This allows registry managers to grant/revoke the authorized registry role
        _setRoleAdmin(AUTHORIZED_REGISTRY_ROLE, REGISTRY_ADMIN_ROLE);

        roboshareTokens = RoboshareTokens(_roboshareTokens);
        partnerManager = PartnerManager(_partnerManager);
    }

    /**
     * @dev Reserve a new token ID pair from RoboshareTokens.
     * Callable by authorized registries to get a new ID.
     */
    function reserveNextTokenIdPair()
        external
        onlyRole(AUTHORIZED_REGISTRY_ROLE)
        returns (uint256 assetId, uint256 revenueTokenId)
    {
        // Router must have MINTER_ROLE on RoboshareTokens
        (assetId, revenueTokenId) = roboshareTokens.reserveNextTokenIdPair();

        // Automatically bind both IDs to the caller registry
        _bindId(assetId, msg.sender);
        _bindId(revenueTokenId, msg.sender);
    }

    // IAssetRegistry Implementation (Routing)

    /**
     * @dev Register asset (generic).
     * Note: Specific registries should use their own typed register functions and call bindAsset/reserveNextTokenIdPair.
     * This function is here for interface compliance but might not be the primary entry point.
     */
    function registerAsset(bytes calldata, uint256) external pure override returns (uint256) {
        // If called directly, we don't know which registry to use unless encoded in data or we have a default.
        // For now, we revert as this should be called on specific registries.
        revert DirectCallNotAllowed();
    }

    function createRevenueTokenPool(
        uint256 assetId,
        uint256 tokenPrice,
        uint256 maturityDate,
        uint256 revenueShareBP,
        uint256 targetYieldBP,
        uint256 maxSupply,
        bool immediateProceeds,
        bool protectionEnabled
    ) external override onlyAuthorizedPartner returns (uint256 tokenId, uint256 supply) {
        return _createRevenueTokenPoolFor(
            msg.sender,
            assetId,
            tokenPrice,
            maturityDate,
            revenueShareBP,
            targetYieldBP,
            maxSupply,
            immediateProceeds,
            protectionEnabled
        );
    }

    function createRevenueTokenPoolFor(
        address partner,
        uint256 assetId,
        uint256 tokenPrice,
        uint256 maturityDate,
        uint256 revenueShareBP,
        uint256 targetYieldBP,
        uint256 maxSupply,
        bool immediateProceeds,
        bool protectionEnabled
    ) external onlyRole(AUTHORIZED_REGISTRY_ROLE) returns (uint256 tokenId, uint256 supply) {
        return _createRevenueTokenPoolFor(
                partner,
                assetId,
                tokenPrice,
                maturityDate,
                revenueShareBP,
                targetYieldBP,
                maxSupply,
                immediateProceeds,
                protectionEnabled
            );
    }

    function previewCreateRevenueTokenPool(uint256 assetId, address partner, uint256 requestedSupply)
        external
        view
        override
        returns (uint256 tokenId, uint256 supply)
    {
        address registry = idToRegistry[assetId];
        if (registry == address(0)) {
            revert RegistryNotFound(assetId);
        }
        return IAssetRegistry(registry).previewCreateRevenueTokenPool(assetId, partner, requestedSupply);
    }

    function registerAssetAndCreateRevenueTokenPool(
        bytes calldata,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256,
        bool,
        bool
    ) external pure override returns (uint256, uint256, uint256) {
        revert DirectCallNotAllowed();
    }

    function assetExists(uint256 assetId) external view override returns (bool) {
        address registry = idToRegistry[assetId];
        if (registry == address(0)) return false;
        return IAssetRegistry(registry).assetExists(assetId);
    }

    function getAssetInfo(uint256 assetId) external view override returns (AssetLib.AssetInfo memory) {
        address registry = idToRegistry[assetId];
        if (registry == address(0)) {
            revert RegistryNotFound(assetId);
        }
        return IAssetRegistry(registry).getAssetInfo(assetId);
    }

    function getAssetStatus(uint256 assetId) external view override returns (AssetLib.AssetStatus) {
        address registry = idToRegistry[assetId];
        if (registry == address(0)) {
            revert RegistryNotFound(assetId);
        }
        return IAssetRegistry(registry).getAssetStatus(assetId);
    }

    function setAssetStatus(uint256 assetId, AssetLib.AssetStatus status) external override {
        if (msg.sender != treasury) {
            revert NotTreasury();
        }
        address registry = idToRegistry[assetId];
        if (registry == address(0)) {
            revert RegistryNotFound(assetId);
        }
        IAssetRegistry(registry).setAssetStatus(assetId, status);
    }

    /**
     * @dev Forward settlement initialization from Registry to Treasury.
     * Callable only by authorized registries.
     */
    function initiateSettlement(address partner, uint256 assetId, uint256 topUpAmount)
        external
        onlyRole(AUTHORIZED_REGISTRY_ROLE)
        returns (uint256 settlementAmount, uint256 settlementPerToken)
    {
        // Verify this registry owns the asset
        if (idToRegistry[assetId] != msg.sender) {
            revert RegistryNotBoundToAsset();
        }

        if (treasury == address(0)) {
            revert TreasuryNotSet();
        }

        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        ITreasury(treasury).initiateSettlement(partner, assetId, topUpAmount);
        IPositionManager.SettlementState memory settlementState = _getConfiguredSettlementState(assetId);
        IAssetRegistry(idToRegistry[assetId]).setAssetStatus(assetId, AssetLib.AssetStatus.Retired);

        // Best-effort: settlement should close primary pool if it exists.
        _closePrimaryPoolIfMarketplaceConfigured(revenueTokenId);

        settlementAmount = settlementState.settlementAmount;
        settlementPerToken = settlementState.settlementPerToken;
    }

    /**
     * @dev Forward liquidation execution from Registry to Treasury.
     * Callable only by authorized registries.
     */
    function executeLiquidation(uint256 assetId)
        external
        onlyRole(AUTHORIZED_REGISTRY_ROLE)
        returns (uint256 liquidationAmount, uint256 settlementPerToken)
    {
        // Verify this registry owns the asset
        if (idToRegistry[assetId] != msg.sender) {
            revert RegistryNotBoundToAsset();
        }

        if (treasury == address(0)) {
            revert TreasuryNotSet();
        }

        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        ITreasury(treasury).executeLiquidation(assetId);
        IPositionManager.SettlementState memory settlementState = _getConfiguredSettlementState(assetId);
        IAssetRegistry(idToRegistry[assetId]).setAssetStatus(assetId, AssetLib.AssetStatus.Expired);

        // Best-effort: liquidation should close primary pool if it exists.
        _closePrimaryPoolIfMarketplaceConfigured(revenueTokenId);

        liquidationAmount = settlementState.settlementAmount;
        settlementPerToken = settlementState.settlementPerToken;
    }

    /**
     * @dev Forward settlement claim processing from Registry to Treasury.
     * Callable only by authorized registries.
     */
    function processSettlementClaimFor(address recipient, uint256 assetId, uint256 amount)
        external
        onlyRole(AUTHORIZED_REGISTRY_ROLE)
        returns (uint256 claimedAmount)
    {
        // Verify this registry owns the asset
        address registry = idToRegistry[assetId];
        if (registry != msg.sender) {
            revert RegistryNotBoundToAsset();
        }

        if (treasury == address(0)) {
            revert TreasuryNotSet();
        }

        return ITreasury(treasury).processSettlementClaimFor(recipient, assetId, amount);
    }

    /**
     * @dev Forward earnings snapshot (and optionally claim) request from Registry to EarningsManager.
     * Called before burning tokens to preserve unclaimed earnings.
     * Callable only by authorized registries.
     */
    function snapshotAndClaimEarnings(uint256 assetId, address holder, bool autoClaim)
        external
        onlyRole(AUTHORIZED_REGISTRY_ROLE)
        returns (uint256 snapshotAmount)
    {
        // Verify this registry owns the asset
        if (idToRegistry[assetId] != msg.sender) {
            revert RegistryNotBoundToAsset();
        }

        if (earningsManager == address(0)) {
            revert EarningsManagerNotSet();
        }

        return IEarningsManager(earningsManager).snapshotAndClaimEarnings(assetId, holder, autoClaim);
    }

    /**
     * @dev Check asset solvency via Treasury.
     */
    function isAssetSolvent(uint256 assetId) external view returns (bool) {
        if (treasury == address(0)) {
            revert TreasuryNotSet();
        }
        return ITreasury(treasury).isAssetSolvent(assetId);
    }

    /**
     * @dev Preview liquidation eligibility via Treasury using simulated shortfall accrual.
     */
    function previewLiquidationEligibility(uint256 assetId) external view returns (bool eligible, uint8 reason) {
        if (treasury == address(0)) {
            revert TreasuryNotSet();
        }
        return ITreasury(treasury).previewLiquidationEligibility(assetId);
    }

    function settleAsset(uint256 assetId, uint256 topUpAmount) external override {
        address registry = idToRegistry[assetId];
        if (registry == address(0)) {
            revert RegistryNotFound(assetId);
        }
        IAssetRegistry(registry).settleAsset(assetId, topUpAmount);
    }

    function liquidateAsset(uint256 assetId) external override {
        address registry = idToRegistry[assetId];
        if (registry == address(0)) {
            revert RegistryNotFound(assetId);
        }
        IAssetRegistry(registry).liquidateAsset(assetId);
    }

    function claimSettlement(uint256 assetId, bool autoClaimEarnings)
        external
        returns (uint256 claimedAmount, uint256 earningsClaimed)
    {
        address registry = idToRegistry[assetId];
        if (registry == address(0)) {
            revert RegistryNotFound(assetId);
        }
        return IAssetRegistry(registry).executeSettlementClaimFor(msg.sender, assetId, autoClaimEarnings);
    }

    function executeSettlementClaimFor(address, uint256, bool)
        external
        pure
        override
        returns (uint256 claimedAmount, uint256 earningsClaimed)
    {
        claimedAmount;
        earningsClaimed;
        revert DirectCallNotAllowed();
    }

    function burnRevenueTokens(uint256 assetId, uint256 amount) external override {
        address registry = idToRegistry[assetId];
        if (registry == address(0)) {
            revert RegistryNotFound(assetId);
        }
        IAssetRegistry(registry).burnRevenueTokens(assetId, amount);
    }

    function retireAsset(uint256 assetId) external override {
        address registry = idToRegistry[assetId];
        if (registry == address(0)) {
            revert RegistryNotFound(assetId);
        }
        IAssetRegistry(registry).retireAsset(assetId);
    }

    function retireAssetAndBurnTokens(uint256 assetId) external override {
        address registry = idToRegistry[assetId];
        if (registry == address(0)) {
            revert RegistryNotFound(assetId);
        }
        IAssetRegistry(registry).retireAssetAndBurnTokens(assetId);
    }

    /**
     * @dev Forward retirement signal from Registry to Treasury.
     * Callable only by authorized registries.
     */
    function releaseCollateralFor(address partner, uint256 assetId)
        external
        onlyRole(AUTHORIZED_REGISTRY_ROLE)
        returns (uint256 releasedCollateral)
    {
        // Verify this registry owns the asset
        if (idToRegistry[assetId] != msg.sender) {
            revert RegistryNotBoundToAsset();
        }

        // Call Treasury
        if (treasury == address(0)) {
            revert TreasuryNotSet();
        }

        return ITreasury(treasury).releaseCollateralFor(partner, assetId);
    }

    function mintRevenueTokensToBuyerFromPrimaryPool(address buyer, uint256 tokenId, uint256 amount) external {
        if (msg.sender != treasury) {
            revert NotTreasury();
        }
        if (!TokenLib.isRevenueToken(tokenId)) {
            revert RegistryNotFound(tokenId);
        }
        if (idToRegistry[tokenId] == address(0)) {
            revert RegistryNotFound(tokenId);
        }
        roboshareTokens.mint(buyer, tokenId, amount, "");
    }

    function burnRevenueTokensFromHolderForPrimaryRedemption(address holder, uint256 tokenId, uint256 amount) external {
        if (msg.sender != treasury) {
            revert NotTreasury();
        }
        if (!TokenLib.isRevenueToken(tokenId)) {
            revert RegistryNotFound(tokenId);
        }
        if (idToRegistry[tokenId] == address(0)) {
            revert RegistryNotFound(tokenId);
        }
        _positionManager().burnCurrentEpochForPrimaryRedemption(holder, tokenId, amount);
    }

    function recordImmediateProceedsRelease(uint256 tokenId, uint256 releasedAmount) external {
        if (msg.sender != treasury) {
            revert NotTreasury();
        }
        if (!TokenLib.isRevenueToken(tokenId)) {
            revert RegistryNotFound(tokenId);
        }
        if (idToRegistry[tokenId] == address(0)) {
            revert RegistryNotFound(tokenId);
        }
        _positionManager()
            .recordImmediateProceedsRelease(tokenId, releasedAmount, keccak256("IMMEDIATE_PROCEEDS_RELEASE"));
    }

    function recordPrimaryRedemptionPayout(uint256 tokenId, uint256 payoutAmount) external {
        if (msg.sender != treasury) {
            revert NotTreasury();
        }
        if (!TokenLib.isRevenueToken(tokenId)) {
            revert RegistryNotFound(tokenId);
        }
        if (idToRegistry[tokenId] == address(0)) {
            revert RegistryNotFound(tokenId);
        }
        _positionManager().recordPrimaryRedemptionPayout(tokenId, payoutAmount, keccak256("PRIMARY_REDEMPTION_PAYOUT"));
    }

    function _positionManager() internal view returns (IPositionManager) {
        IPositionManager manager = roboshareTokens.positionManager();
        if (address(manager) == address(0)) revert PositionManagerNotSet();
        if (address(manager).code.length == 0) revert InvalidPositionManager(address(manager));
        return manager;
    }

    function _getConfiguredSettlementState(uint256 assetId)
        internal
        view
        returns (IPositionManager.SettlementState memory settlementState)
    {
        settlementState = _positionManager().getSettlementState(assetId);
        if (!settlementState.isConfigured) {
            revert IPositionManager.SettlementNotConfigured(assetId);
        }
    }

    function getRegistryForAsset(uint256 assetId) external view override returns (address) {
        return idToRegistry[assetId];
    }

    function getRegistryType() external pure override returns (string memory) {
        return "RegistryRouter";
    }

    function getRegistryVersion() external pure override returns (uint256) {
        return 1;
    }

    /**
     * @dev Set the Treasury address
     */
    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    function setEarningsManager(address _earningsManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_earningsManager == address(0)) revert ZeroAddress();
        earningsManager = _earningsManager;
    }

    /**
     * @dev Set the Marketplace address
     */
    function setMarketplace(address _marketplace) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_marketplace == address(0)) revert ZeroAddress();
        marketplace = _marketplace;
    }

    /**
     * @dev Update RoboshareTokens contract reference
     * @param _roboshareTokens New RoboshareTokens contract address
     */
    function updateRoboshareTokens(address _roboshareTokens) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_roboshareTokens == address(0)) {
            revert ZeroAddress();
        }
        address oldAddress = address(roboshareTokens);
        roboshareTokens = RoboshareTokens(_roboshareTokens);
        emit RoboshareTokensUpdated(oldAddress, _roboshareTokens);
    }

    /**
     * @dev Update PartnerManager address
     * @param _partnerManager New PartnerManager contract address
     */
    function updatePartnerManager(address _partnerManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_partnerManager == address(0)) revert ZeroAddress();
        address oldPartnerManager = address(partnerManager);
        partnerManager = PartnerManager(_partnerManager);
        emit PartnerManagerUpdated(oldPartnerManager, _partnerManager);
    }

    modifier onlyAuthorizedPartner() {
        _onlyAuthorizedPartner();
        _;
    }

    function _onlyAuthorizedPartner() internal view {
        if (!partnerManager.isAuthorizedPartner(msg.sender)) {
            revert PartnerManager.UnauthorizedPartner();
        }
    }

    /**
     * @dev Internal helper to bind ID to registry.
     */
    function _bindId(uint256 id, address registry) internal {
        idToRegistry[id] = registry;
        emit IdBoundToRegistry(id, registry);
    }

    function _createRevenueTokenPoolFor(
        address partner,
        uint256 assetId,
        uint256 tokenPrice,
        uint256 maturityDate,
        uint256 revenueShareBP,
        uint256 targetYieldBP,
        uint256 maxSupply,
        bool immediateProceeds,
        bool protectionEnabled
    ) internal returns (uint256 tokenId, uint256 supply) {
        address registry = idToRegistry[assetId];
        if (registry == address(0)) {
            revert RegistryNotFound(assetId);
        }
        if (tokenPrice == 0) {
            revert InvalidTokenPrice();
        }

        uint256 assetValue = IAssetRegistry(registry).getAssetInfo(assetId).assetValue;
        uint256 maxSupportedSupply = assetValue / tokenPrice;
        if (maxSupply == 0 || maxSupply > maxSupportedSupply) {
            revert IAssetRegistry.InvalidPoolSupply();
        }

        (tokenId, supply) = IAssetRegistry(registry).previewCreateRevenueTokenPool(assetId, partner, maxSupply);

        roboshareTokens.setRevenueTokenInfo(
            tokenId,
            tokenPrice,
            supply,
            supply,
            maturityDate,
            revenueShareBP,
            targetYieldBP,
            immediateProceeds,
            protectionEnabled
        );
        emit RevenueTokenPoolCreated(assetId, tokenId, partner, supply * tokenPrice, supply);
        IAssetRegistry(registry).setAssetStatus(assetId, AssetLib.AssetStatus.Active);

        _requireMarketplace().createPrimaryPoolFor(partner, tokenId, tokenPrice);
    }

    function _requireMarketplace() internal view returns (IMarketplace market) {
        address marketAddress = marketplace;
        if (marketAddress == address(0)) revert MarketplaceNotSet();
        if (marketAddress.code.length == 0) revert InvalidMarketplace(marketAddress);
        return IMarketplace(marketAddress);
    }

    function _closePrimaryPoolIfMarketplaceConfigured(uint256 tokenId) internal {
        address marketAddress = marketplace;
        if (marketAddress == address(0)) return;
        if (marketAddress.code.length == 0) revert InvalidMarketplace(marketAddress);
        try IMarketplace(marketAddress).closePrimaryPool(tokenId) { } catch { }
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) { }
}
