// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IAssetRegistry } from "./interfaces/IAssetRegistry.sol";
import { IPositionManager } from "./interfaces/IPositionManager.sol";
import { AssetLib, ProtocolLib, TokenLib } from "./Libraries.sol";
import { RoboshareTokens } from "./RoboshareTokens.sol";
import { PartnerManager } from "./PartnerManager.sol";
import { RegistryRouter } from "./RegistryRouter.sol";

/**
 * @dev Facility-level registry for Robomata borrowing-base submissions.
 * Uses a submission commitment as the uniqueness anchor instead of vehicle VIN semantics.
 */
contract FacilityRegistry is Initializable, AccessControlUpgradeable, UUPSUpgradeable, IAssetRegistry {
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant ROUTER_ROLE = keccak256("ROUTER_ROLE");

    struct FacilityInfo {
        bytes32 facilityCommitment;
        string assetMetadataURI;
        string revenueTokenMetadataURI;
    }

    struct Facility {
        uint256 facilityId;
        AssetLib.AssetInfo assetInfo;
        FacilityInfo facilityInfo;
    }

    RoboshareTokens public roboshareTokens;
    PartnerManager public partnerManager;
    RegistryRouter public router;

    mapping(uint256 => Facility) public facilities;
    mapping(bytes32 => bool) public facilityCommitmentExists;

    error ZeroAddress();
    error FacilityAlreadyExists();
    error FacilityDoesNotExist();
    error InvalidFacilityCommitment();
    error InvalidMetadataURI();
    error OutstandingTokensHeldByOthers();
    error PositionManagerNotSet();
    error InvalidPositionManager(address manager);
    error UnsupportedFacilityRegistrationPayload();
    error SettlementPayoutMismatch(uint256 expected, uint256 actual);

    event FacilityRegistered(uint256 indexed facilityId, address indexed partner, bytes32 indexed facilityCommitment);
    event FacilityMetadataUpdated(
        uint256 indexed facilityId,
        bytes32 indexed facilityCommitment,
        string assetMetadataURI,
        string revenueTokenMetadataURI
    );
    event RoboshareTokensUpdated(address indexed oldAddress, address indexed newAddress);
    event PartnerManagerUpdated(address indexed oldAddress, address indexed newAddress);
    event RouterUpdated(address indexed oldAddress, address indexed newAddress);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

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

    modifier onlyAuthorizedPartner() {
        _onlyAuthorizedPartner();
        _;
    }

    modifier onlyAuthorizedAssetOwner(uint256 assetId) {
        _onlyAuthorizedAssetOwner(assetId);
        _;
    }

    function getFacilityInfo(uint256 facilityId)
        external
        view
        returns (bytes32 facilityCommitment, string memory assetMetadataURI, string memory revenueTokenMetadataURI)
    {
        Facility storage facility = facilities[facilityId];
        if (facility.facilityId == 0) {
            revert FacilityDoesNotExist();
        }

        FacilityInfo storage info = facility.facilityInfo;
        return (info.facilityCommitment, info.assetMetadataURI, info.revenueTokenMetadataURI);
    }

    function registerAsset(bytes calldata data, uint256 assetValue)
        external
        override
        onlyAuthorizedPartner
        returns (uint256 assetId)
    {
        (assetId,) = _registerFacility(data, assetValue);
        roboshareTokens.mint(msg.sender, assetId, 1, "");
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
        (assetId, revenueTokenId) = _registerFacility(data, assetValue);
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

    function updateFacilityMetadata(
        uint256 facilityId,
        string memory assetMetadataURI,
        string memory revenueTokenMetadataURI
    ) external {
        Facility storage facility = facilities[facilityId];
        if (facility.facilityId == 0) {
            revert FacilityDoesNotExist();
        }
        _requireAuthorizedAssetOwner(msg.sender, facilityId);

        _updateMetadata(facility.facilityInfo, assetMetadataURI, revenueTokenMetadataURI);
        roboshareTokens.setTokenMetadataURI(facilityId, assetMetadataURI);
        roboshareTokens.setTokenMetadataURI(TokenLib.getTokenIdFromAssetId(facilityId), revenueTokenMetadataURI);

        emit FacilityMetadataUpdated(
            facilityId, facility.facilityInfo.facilityCommitment, assetMetadataURI, revenueTokenMetadataURI
        );
    }

    function burnRevenueTokens(uint256 assetId, uint256 amount) public override onlyAuthorizedPartner {
        if (!assetExists(assetId)) {
            revert AssetNotFound(assetId);
        }

        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        roboshareTokens.burn(msg.sender, revenueTokenId, amount);
    }

    function settleAsset(uint256 assetId, uint256 topUpAmount) external override onlyAuthorizedAssetOwner(assetId) {
        if (!AssetLib.isOperational(facilities[assetId].assetInfo)) {
            revert AssetNotActive(assetId, facilities[assetId].assetInfo.status);
        }

        (uint256 settlementAmount, uint256 settlementPerToken) =
            router.initiateSettlement(msg.sender, assetId, topUpAmount);

        emit AssetSettled(assetId, msg.sender, settlementAmount, settlementPerToken);
    }

    function liquidateAsset(uint256 assetId) external override {
        if (!assetExists(assetId)) {
            revert AssetNotFound(assetId);
        }

        AssetLib.AssetInfo storage info = facilities[assetId].assetInfo;
        if (info.status == AssetLib.AssetStatus.Retired || info.status == AssetLib.AssetStatus.Expired) {
            revert AssetAlreadySettled(assetId, info.status);
        }

        (uint256 liquidationAmount, uint256 settlementPerToken) = router.executeLiquidation(assetId);

        emit AssetExpired(assetId, liquidationAmount, settlementPerToken);
    }

    function executeSettlementClaimFor(address account, uint256 assetId, bool autoClaimEarnings)
        external
        override
        onlyRole(ROUTER_ROLE)
        returns (uint256 claimedAmount, uint256 earningsClaimed)
    {
        return _claimSettlementFor(account, assetId, autoClaimEarnings);
    }

    function retireAsset(uint256 assetId) external override onlyAuthorizedAssetOwner(assetId) {
        _retireAsset(assetId, msg.sender, 0);
    }

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

        _retireAsset(assetId, msg.sender, burnedTokens);
    }

    function setAssetStatus(uint256 assetId, AssetLib.AssetStatus status) external override onlyRole(ROUTER_ROLE) {
        if (!assetExists(assetId)) {
            revert AssetNotFound(assetId);
        }

        _setAssetStatus(assetId, status);
    }

    function assetExists(uint256 assetId) public view override returns (bool) {
        return facilities[assetId].facilityId != 0;
    }

    function getAssetInfo(uint256 assetId) external view override returns (AssetLib.AssetInfo memory) {
        if (!assetExists(assetId)) {
            revert AssetNotFound(assetId);
        }
        return facilities[assetId].assetInfo;
    }

    function getAssetStatus(uint256 assetId) external view override returns (AssetLib.AssetStatus) {
        if (!assetExists(assetId)) {
            revert AssetNotFound(assetId);
        }
        return facilities[assetId].assetInfo.status;
    }

    function getRegistryForAsset(uint256 assetId) external view override returns (address) {
        if (assetExists(assetId)) {
            return address(this);
        }
        return address(0);
    }

    function getRegistryType() external pure override returns (string memory) {
        return "FacilityRegistry";
    }

    function getRegistryVersion() external pure override returns (uint256) {
        return 1;
    }

    function updateRoboshareTokens(address _roboshareTokens) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_roboshareTokens == address(0)) {
            revert ZeroAddress();
        }
        address oldAddress = address(roboshareTokens);
        roboshareTokens = RoboshareTokens(_roboshareTokens);
        emit RoboshareTokensUpdated(oldAddress, _roboshareTokens);
    }

    function updatePartnerManager(address _partnerManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_partnerManager == address(0)) {
            revert ZeroAddress();
        }
        address oldAddress = address(partnerManager);
        partnerManager = PartnerManager(_partnerManager);
        emit PartnerManagerUpdated(oldAddress, _partnerManager);
    }

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

    function _registerFacility(bytes calldata data, uint256 assetValue)
        internal
        returns (uint256 facilityId, uint256 revenueTokenId)
    {
        (bytes32 facilityCommitment, string memory assetMetadataURI, string memory revenueTokenMetadataURI) =
            _decodeFacilityRegistrationData(data);

        if (facilityCommitment == bytes32(0)) {
            revert InvalidFacilityCommitment();
        }
        if (facilityCommitmentExists[facilityCommitment]) {
            revert FacilityAlreadyExists();
        }

        (facilityId, revenueTokenId) = router.reserveNextTokenIdPair();

        Facility storage facility = facilities[facilityId];
        facility.facilityId = facilityId;
        AssetLib.initializeAssetInfo(facility.assetInfo, assetValue);
        _initializeFacilityInfo(facility.facilityInfo, facilityCommitment, assetMetadataURI, revenueTokenMetadataURI);

        facilityCommitmentExists[facilityCommitment] = true;
        roboshareTokens.setTokenMetadataURI(facilityId, assetMetadataURI);
        roboshareTokens.setTokenMetadataURI(revenueTokenId, revenueTokenMetadataURI);

        emit AssetRegistered(facilityId, msg.sender, assetValue, facility.assetInfo.status);
        emit FacilityRegistered(facilityId, msg.sender, facilityCommitment);
        emit FacilityMetadataUpdated(facilityId, facilityCommitment, assetMetadataURI, revenueTokenMetadataURI);
    }

    function _claimSettlementFor(address account, uint256 assetId, bool autoClaimEarnings)
        internal
        returns (uint256 claimedAmount, uint256 earningsClaimed)
    {
        if (!assetExists(assetId)) {
            revert AssetNotFound(assetId);
        }

        AssetLib.AssetInfo storage info = facilities[assetId].assetInfo;
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

    function _retireAsset(uint256 assetId, address partner, uint256 burnedTokens) internal {
        if (!AssetLib.isOperational(facilities[assetId].assetInfo)) {
            revert AssetNotActive(assetId, facilities[assetId].assetInfo.status);
        }

        _setAssetStatus(assetId, AssetLib.AssetStatus.Retired);
        uint256 releasedCollateral = router.releaseCollateralFor(partner, assetId);

        emit AssetRetired(assetId, partner, burnedTokens, releasedCollateral);
    }

    function _setAssetStatus(uint256 assetId, AssetLib.AssetStatus status) internal {
        AssetLib.AssetStatus oldStatus = facilities[assetId].assetInfo.status;
        AssetLib.updateAssetStatus(facilities[assetId].assetInfo, status);
        emit AssetStatusUpdated(assetId, oldStatus, status);
    }

    function _initializeFacilityInfo(
        FacilityInfo storage info,
        bytes32 facilityCommitment,
        string memory assetMetadataURI,
        string memory revenueTokenMetadataURI
    ) internal {
        _validateMetadataURI(assetMetadataURI);
        _validateMetadataURI(revenueTokenMetadataURI);

        info.facilityCommitment = facilityCommitment;
        info.assetMetadataURI = assetMetadataURI;
        info.revenueTokenMetadataURI = revenueTokenMetadataURI;
    }

    function _updateMetadata(
        FacilityInfo storage info,
        string memory assetMetadataURI,
        string memory revenueTokenMetadataURI
    ) internal {
        _validateMetadataURI(assetMetadataURI);
        _validateMetadataURI(revenueTokenMetadataURI);
        info.assetMetadataURI = assetMetadataURI;
        info.revenueTokenMetadataURI = revenueTokenMetadataURI;
    }

    function _decodeFacilityRegistrationData(bytes calldata data)
        internal
        pure
        returns (bytes32 facilityCommitment, string memory assetMetadataURI, string memory revenueTokenMetadataURI)
    {
        if (data.length < 0x60) {
            revert UnsupportedFacilityRegistrationPayload();
        }

        uint256 firstStringOffset;
        assembly ("memory-safe") {
            firstStringOffset := calldataload(add(data.offset, 0x20))
        }

        if (firstStringOffset != 0x60) {
            revert UnsupportedFacilityRegistrationPayload();
        }

        return abi.decode(data, (bytes32, string, string));
    }

    function _validateMetadataURI(string memory metadataURI) internal pure {
        if (!ProtocolLib.isValidIPFSURI(metadataURI)) {
            revert InvalidMetadataURI();
        }
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

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) { }
}
