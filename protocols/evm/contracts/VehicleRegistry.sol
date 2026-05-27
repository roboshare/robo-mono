// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IAssetRegistry } from "./interfaces/IAssetRegistry.sol";
import { IPositionManager } from "./interfaces/IPositionManager.sol";
import { TokenLib, AssetLib, VehicleLib } from "./Libraries.sol";
import { RoboshareTokens } from "./RoboshareTokens.sol";
import { PartnerManager } from "./PartnerManager.sol";
import { RegistryRouter } from "./RegistryRouter.sol";

/**
 * @dev Vehicle registration and management with token metadata pointers
 * Coordinates with RoboshareTokens for minting and PartnerManager for authorization
 * Implements IAssetsRegistry for generic asset management capabilities
 */
contract VehicleRegistry is Initializable, AccessControlUpgradeable, UUPSUpgradeable, IAssetRegistry {
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant ROUTER_ROLE = keccak256("ROUTER_ROLE");

    // Core contracts
    RoboshareTokens public roboshareTokens;
    PartnerManager public partnerManager;
    RegistryRouter public router;

    // Vehicle storage
    mapping(uint256 => VehicleLib.Vehicle) public vehicles;
    mapping(bytes32 => bool) public vinHashExists; // VIN hash uniqueness tracking

    // Errors
    error ZeroAddress();
    error VehicleAlreadyExists();
    error VehicleDoesNotExist();
    error OutstandingTokensHeldByOthers();
    error PositionManagerNotSet();
    error InvalidPositionManager(address manager);
    error UnsupportedVehicleRegistrationPayload();
    error SettlementPayoutMismatch(uint256 expected, uint256 actual);

    // Events
    event VehicleRegistered(uint256 indexed vehicleId, address indexed partner, bytes32 indexed vinHash);

    event VehicleMetadataUpdated(uint256 indexed vehicleId, string assetMetadataURI, string revenueTokenMetadataURI);
    event RoboshareTokensUpdated(address indexed oldAddress, address indexed newAddress);
    event PartnerManagerUpdated(address indexed oldAddress, address indexed newAddress);
    event RouterUpdated(address indexed oldAddress, address indexed newAddress);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initialize contract with references to core contracts
     */
    function initialize(address _admin, address _roboshareTokens, address _partnerManager, address _router)
        public
        initializer
    {
        if (
            _admin == address(0) || _roboshareTokens == address(0) || _partnerManager == address(0)
                || _router == address(0)
        ) {
            revert ZeroAddress();
        }

        __AccessControl_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(UPGRADER_ROLE, _admin);
        _grantRole(ROUTER_ROLE, _router);

        roboshareTokens = RoboshareTokens(_roboshareTokens);
        partnerManager = PartnerManager(_partnerManager);
        router = RegistryRouter(_router);
    }

    /**
     * @dev Modifier to ensure only authorized partners can call functions
     */
    modifier onlyAuthorizedPartner() {
        _onlyAuthorizedPartner();
        _;
    }

    modifier onlyAuthorizedAssetOwner(uint256 assetId) {
        _onlyAuthorizedAssetOwner(assetId);
        _;
    }

    function _onlyAuthorizedPartner() internal view {
        if (!partnerManager.isAuthorizedPartner(msg.sender)) {
            revert PartnerManager.UnauthorizedPartner();
        }
    }

    function _onlyAuthorizedAssetOwner(uint256 assetId) internal view {
        _requireAuthorizedAssetOwner(msg.sender, assetId);
    }

    function _requireAuthorizedAssetOwner(address partner, uint256 assetId) internal view {
        if (!partnerManager.isAuthorizedPartner(partner)) {
            revert PartnerManager.UnauthorizedPartner();
        }
        if (roboshareTokens.balanceOf(partner, assetId) == 0) {
            revert NotAssetOwner();
        }
    }

    // View Functions

    /**
     * @dev Get protocol-trusted vehicle information and token metadata pointers.
     */
    function getVehicleInfo(uint256 vehicleId)
        external
        view
        returns (bytes32 vinHash, string memory assetMetadataURI, string memory revenueTokenMetadataURI)
    {
        VehicleLib.Vehicle storage vehicle = vehicles[vehicleId];
        if (vehicle.vehicleId == 0) {
            revert VehicleDoesNotExist();
        }

        VehicleLib.VehicleInfo storage info = vehicle.vehicleInfo;
        return (info.vinHash, info.assetMetadataURI, info.revenueTokenMetadataURI);
    }

    // IAssetRegistry implementation

    function registerAsset(bytes calldata data, uint256 assetValue)
        external
        override
        onlyAuthorizedPartner
        returns (uint256 assetId)
    {
        (assetId,) = _registerVehicle(data, assetValue);

        roboshareTokens.mint(msg.sender, assetId, 1, ""); // Mint 1 vehicle NFT to partner
    }

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
    ) external override onlyAuthorizedPartner returns (uint256 assetId, uint256 revenueTokenId, uint256 supply) {
        (assetId, revenueTokenId) = _registerVehicle(data, assetValue);
        roboshareTokens.mint(msg.sender, assetId, 1, "");
        (revenueTokenId, supply) = router.createRevenueTokenPoolFor(
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

    function createRevenueTokenPool(
        uint256 assetId,
        uint256 tokenPrice,
        uint256 maturityDate,
        uint256 revenueShareBP,
        uint256 targetYieldBP,
        uint256 maxSupply,
        bool immediateProceeds,
        bool protectionEnabled
    ) external override onlyAuthorizedPartner returns (uint256 revenueTokenId, uint256 supply) {
        (revenueTokenId, supply) = router.createRevenueTokenPoolFor(
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

    function previewCreateRevenueTokenPool(uint256 assetId, address partner, uint256 requestedSupply)
        external
        view
        override
        returns (uint256 revenueTokenId, uint256 supply)
    {
        if (!assetExists(assetId)) {
            revert AssetNotFound(assetId);
        }
        if (!partnerManager.isAuthorizedPartner(partner)) {
            revert PartnerManager.UnauthorizedPartner();
        }
        if (roboshareTokens.balanceOf(partner, assetId) == 0) {
            revert NotAssetOwner();
        }

        revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);

        if (roboshareTokens.getRevenueTokenSupply(revenueTokenId) > 0) {
            revert RevenueTokensAlreadyMinted();
        }
        if (requestedSupply == 0) {
            revert InvalidPoolSupply();
        }

        supply = requestedSupply;
    }

    /**
     * @dev Update asset NFT and revenue-token metadata pointers for a vehicle.
     */
    function updateVehicleMetadata(
        uint256 vehicleId,
        string memory assetMetadataURI,
        string memory revenueTokenMetadataURI
    ) external {
        VehicleLib.Vehicle storage vehicle = vehicles[vehicleId];
        if (vehicle.vehicleId == 0) {
            revert VehicleDoesNotExist();
        }
        _requireAuthorizedAssetOwner(msg.sender, vehicleId);

        VehicleLib.updateMetadata(vehicle.vehicleInfo, assetMetadataURI, revenueTokenMetadataURI);
        roboshareTokens.setTokenMetadataURI(vehicleId, assetMetadataURI);
        roboshareTokens.setTokenMetadataURI(TokenLib.getTokenIdFromAssetId(vehicleId), revenueTokenMetadataURI);

        emit VehicleMetadataUpdated(vehicleId, assetMetadataURI, revenueTokenMetadataURI);
    }

    /**
     * @dev Burn revenue tokens.
     * Can be called by partner to reduce supply or internally by retireAssetAndBurnTokens.
     */
    function burnRevenueTokens(uint256 assetId, uint256 amount) public override onlyAuthorizedPartner {
        if (!assetExists(assetId)) {
            revert AssetNotFound(assetId);
        }

        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);

        // Burn tokens
        roboshareTokens.burn(msg.sender, revenueTokenId, amount);
    }

    /**
     * @dev Voluntarily settle and retire an asset.
     * Partner can optionally top up the settlement pool to offer a higher payout.
     * Updates status to Retired and triggers settlement via Router.
     */
    function settleAsset(uint256 assetId, uint256 topUpAmount) external override onlyAuthorizedAssetOwner(assetId) {
        // Verify asset is active
        if (!AssetLib.isOperational(vehicles[assetId].assetInfo)) {
            revert AssetNotActive(assetId, vehicles[assetId].assetInfo.status);
        }

        // Trigger Treasury Settlement via Router
        (uint256 settlementAmount, uint256 settlementPerToken) =
            router.initiateSettlement(msg.sender, assetId, topUpAmount);

        emit AssetSettled(assetId, msg.sender, settlementAmount, settlementPerToken);
    }

    /**
     * @dev Force liquidation of an asset.
     * Publicly callable if asset is expired or insolvent.
     * Updates status to Expired and triggers liquidation via Router.
     */
    function liquidateAsset(uint256 assetId) external override {
        if (!assetExists(assetId)) {
            revert AssetNotFound(assetId);
        }

        AssetLib.AssetInfo storage info = vehicles[assetId].assetInfo;

        // Check if asset is already settled/retired
        if (info.status == AssetLib.AssetStatus.Retired || info.status == AssetLib.AssetStatus.Expired) {
            revert AssetAlreadySettled(assetId, info.status);
        }

        // Trigger Treasury Liquidation via Router
        (uint256 liquidationAmount, uint256 settlementPerToken) = router.executeLiquidation(assetId);

        emit AssetExpired(assetId, liquidationAmount, settlementPerToken);
    }

    /**
     * @dev Router-only settlement claim execution preserving original caller identity.
     * @param account The end-user claiming settlement
     * @param assetId The ID of the settled asset
     * @param autoClaimEarnings If true, claims any unclaimed earnings before settlement in same tx.
     * @return claimedAmount The settlement USDC amount received
     * @return earningsClaimed The earnings USDC amount received (0 if autoClaimEarnings is false)
     */
    function executeSettlementClaimFor(address account, uint256 assetId, bool autoClaimEarnings)
        external
        override
        onlyRole(ROUTER_ROLE)
        returns (uint256 claimedAmount, uint256 earningsClaimed)
    {
        return _claimSettlementFor(account, assetId, autoClaimEarnings);
    }

    /**
     * @dev Retire an asset.
     * Requires 0 revenue token supply.
     * Updates status and triggers settlement via Router.
     */
    function retireAsset(uint256 assetId) external override onlyAuthorizedAssetOwner(assetId) {
        _retireAsset(assetId, msg.sender, 0);
    }

    /**
     * @dev Retire an asset and burn all partner's revenue tokens.
     * Convenience function for the full retirement flow when the partner already holds all outstanding tokens.
     * Burns the partner-held outstanding supply first, then retires the asset. Treasury will verify 0 supply.
     */
    function retireAssetAndBurnTokens(uint256 assetId) external override {
        if (!assetExists(assetId)) {
            revert AssetNotFound(assetId);
        }
        _onlyAuthorizedAssetOwner(assetId);

        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        uint256 totalSupply = roboshareTokens.getRevenueTokenSupply(revenueTokenId);

        uint256 burnedTokens = 0;
        if (totalSupply > 0) {
            uint256 partnerBalance = roboshareTokens.balanceOf(msg.sender, revenueTokenId);
            if (partnerBalance != totalSupply) {
                revert OutstandingTokensHeldByOthers();
            }

            burnRevenueTokens(assetId, partnerBalance);
            burnedTokens = partnerBalance;
        }

        // Call internal _retireAsset (Treasury will verify 0 token supply)
        _retireAsset(assetId, msg.sender, burnedTokens);
    }

    /**
     * @dev Update asset status. Only callable by Router.
     */
    function setAssetStatus(uint256 assetId, AssetLib.AssetStatus status) external override onlyRole(ROUTER_ROLE) {
        if (!assetExists(assetId)) {
            revert AssetNotFound(assetId);
        }

        _setAssetStatus(assetId, status);
    }

    /**
     * @dev Check if asset exists
     */
    function assetExists(uint256 assetId) public view override returns (bool) {
        return vehicles[assetId].vehicleId != 0;
    }

    /**
     * @dev Get asset information
     */
    function getAssetInfo(uint256 assetId) external view override returns (AssetLib.AssetInfo memory) {
        if (!assetExists(assetId)) {
            revert AssetNotFound(assetId);
        }
        return vehicles[assetId].assetInfo;
    }

    /**
     * @dev Get asset status
     */
    function getAssetStatus(uint256 assetId) external view override returns (AssetLib.AssetStatus) {
        if (!assetExists(assetId)) {
            revert AssetNotFound(assetId);
        }
        return vehicles[assetId].assetInfo.status;
    }

    function getRegistryForAsset(uint256 assetId) external view override returns (address) {
        if (assetExists(assetId)) {
            return address(this);
        }
        return address(0);
    }

    /**
     * @dev Get registry type
     */
    function getRegistryType() external pure override returns (string memory) {
        return "VehicleRegistry";
    }

    /**
     * @dev Get registry version
     */
    function getRegistryVersion() external pure override returns (uint256) {
        return 1;
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
     * @dev Update PartnerManager contract reference
     * @param _partnerManager New PartnerManager contract address
     */
    function updatePartnerManager(address _partnerManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_partnerManager == address(0)) {
            revert ZeroAddress();
        }
        address oldAddress = address(partnerManager);
        partnerManager = PartnerManager(_partnerManager);
        emit PartnerManagerUpdated(oldAddress, _partnerManager);
    }

    /**
     * @dev Update RegistryRouter contract reference
     * @param _router New RegistryRouter contract address
     */
    function updateRouter(address _router) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_router == address(0)) {
            revert ZeroAddress();
        }
        address oldAddress = address(router);
        _revokeRole(ROUTER_ROLE, oldAddress);
        router = RegistryRouter(_router);
        _grantRole(ROUTER_ROLE, _router);
        emit RouterUpdated(oldAddress, _router);
    }

    function _claimSettlementFor(address account, uint256 assetId, bool autoClaimEarnings)
        internal
        returns (uint256 claimedAmount, uint256 earningsClaimed)
    {
        if (!assetExists(assetId)) {
            revert AssetNotFound(assetId);
        }

        AssetLib.AssetInfo storage info = vehicles[assetId].assetInfo;
        if (info.status != AssetLib.AssetStatus.Retired && info.status != AssetLib.AssetStatus.Expired) {
            revert AssetNotSettled(assetId, info.status);
        }

        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        uint256 balance = roboshareTokens.balanceOf(account, revenueTokenId);
        if (balance == 0) {
            revert InsufficientTokenBalance(revenueTokenId, 1, balance);
        }

        IPositionManager positionManager = _positionManager();
        IPositionManager.SettlementState memory settlementState = positionManager.getSettlementState(assetId);
        if (!settlementState.isConfigured) {
            revert AssetNotSettled(assetId, info.status);
        }
        uint256 expectedPayout = positionManager.previewSettlementClaim(assetId, balance);

        uint256 snapshotAmount = router.snapshotAndClaimEarnings(assetId, account, autoClaimEarnings);
        if (autoClaimEarnings) {
            earningsClaimed = snapshotAmount;
        }

        roboshareTokens.burn(account, revenueTokenId, balance);
        claimedAmount = router.processSettlementClaimFor(account, assetId, balance);
        if (claimedAmount != expectedPayout) {
            revert SettlementPayoutMismatch(expectedPayout, claimedAmount);
        }

        emit SettlementClaimed(assetId, account, balance, claimedAmount);
    }

    function _positionManager() internal view returns (IPositionManager manager) {
        manager = roboshareTokens.positionManager();
        if (address(manager) == address(0)) revert PositionManagerNotSet();
        if (address(manager).code.length == 0) revert InvalidPositionManager(address(manager));
    }

    /**
     * @dev Internal function to handle asset retirement logic.
     */
    function _retireAsset(uint256 assetId, address partner, uint256 burnedTokens) internal {
        if (!AssetLib.isOperational(vehicles[assetId].assetInfo)) {
            revert AssetNotActive(assetId, vehicles[assetId].assetInfo.status);
        }

        _setAssetStatus(assetId, AssetLib.AssetStatus.Retired);
        uint256 releasedCollateral = router.releaseCollateralFor(partner, assetId);

        emit AssetRetired(assetId, partner, burnedTokens, releasedCollateral);
    }

    /**
     * @dev Internal helper to update asset status and emit event.
     */
    function _setAssetStatus(uint256 assetId, AssetLib.AssetStatus status) internal {
        AssetLib.AssetStatus oldStatus = vehicles[assetId].assetInfo.status;
        AssetLib.updateAssetStatus(vehicles[assetId].assetInfo, status);
        emit AssetStatusUpdated(assetId, oldStatus, status);
    }

    /**
     * @dev Internal function to register vehicle data only.
     */
    function _registerVehicle(bytes calldata data, uint256 assetValue)
        internal
        returns (uint256 vehicleId, uint256 revenueTokenId)
    {
        (string memory vin, string memory assetMetadataURI, string memory revenueTokenMetadataURI) =
            _decodeVehicleRegistrationData(data);

        bytes32 vinHash = VehicleLib.toVINHash(vin);
        if (vinHashExists[vinHash]) revert VehicleAlreadyExists();

        (vehicleId, revenueTokenId) = router.reserveNextTokenIdPair();

        VehicleLib.Vehicle storage vehicle = vehicles[vehicleId];
        VehicleLib.initializeVehicle(vehicle, vehicleId, assetValue, vinHash, assetMetadataURI, revenueTokenMetadataURI);

        vinHashExists[vinHash] = true;
        roboshareTokens.setTokenMetadataURI(vehicleId, assetMetadataURI);
        roboshareTokens.setTokenMetadataURI(revenueTokenId, revenueTokenMetadataURI);

        emit AssetRegistered(vehicleId, msg.sender, assetValue, vehicle.assetInfo.status);
        emit VehicleRegistered(vehicleId, msg.sender, vinHash);
    }

    function _decodeVehicleRegistrationData(bytes calldata data)
        internal
        pure
        returns (string memory vin, string memory assetMetadataURI, string memory revenueTokenMetadataURI)
    {
        uint256 firstOffset;
        assembly ("memory-safe") {
            firstOffset := calldataload(data.offset)
        }

        if (firstOffset == 0x60) {
            return abi.decode(data, (string, string, string));
        }

        revert UnsupportedVehicleRegistrationPayload();
    }

    // UUPS Upgrade authorization
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) { }
}
