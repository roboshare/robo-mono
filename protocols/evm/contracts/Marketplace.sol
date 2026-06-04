// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ProtocolLib, TokenLib, AssetLib, CollateralLib } from "./Libraries.sol";
import { ITreasury } from "./interfaces/ITreasury.sol";
import { IMarketplace } from "./interfaces/IMarketplace.sol";
import { IPositionManager } from "./interfaces/IPositionManager.sol";
import { RoboshareTokens } from "./RoboshareTokens.sol";
import { PartnerManager } from "./PartnerManager.sol";
import { RegistryRouter } from "./RegistryRouter.sol";

/**
 * @title Marketplace
 * @dev Manages secondary listings and continuous primary pools for revenue tokens.
 */
contract Marketplace is
    IMarketplace,
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    struct PrimaryPool {
        uint256 tokenId;
        address partner;
        uint256 pricePerToken;
        bool isPaused;
        bool isClosed;
        uint256 createdAt;
        uint256 pausedAt;
        uint256 closedAt;
    }

    struct Listing {
        uint256 listingId;
        uint256 tokenId;
        uint256 amount;
        uint256 soldAmount;
        uint256 pricePerToken;
        address seller;
        uint256 expiresAt;
        bool isActive;
        uint256 createdAt;
        bool buyerPaysFee;
        uint256 earlySalePenalty;
    }

    struct PrimaryPurchaseQuote {
        uint256 grossPrincipal;
        uint256 protocolFee;
        uint256 totalCost;
    }

    struct SecondaryPurchaseQuote {
        uint256 grossProceeds;
        uint256 protocolFee;
        uint256 earlySalePenalty;
        uint256 sellerNet;
        uint256 totalCost;
    }

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant AUTHORIZED_CONTRACT_ROLE = keccak256("AUTHORIZED_CONTRACT_ROLE");

    RoboshareTokens public roboshareTokens;
    PartnerManager public partnerManager;
    RegistryRouter public router;
    ITreasury public treasury;
    IERC20 public usdc;
    uint256 private _listingIdCounter;
    mapping(uint256 => PrimaryPool) public primaryPools;
    mapping(uint256 => bool) public primaryPoolCreated;
    mapping(uint256 => Listing) public listings;
    mapping(uint256 => uint256[]) public assetListings;

    error ZeroAddress();
    error InvalidUSDCContract(address token);
    error UnsupportedUSDCDecimals(uint8 decimals);
    error InvalidTokenType();
    error InvalidPrice();
    error InvalidMaxSupply();
    error PrimaryPoolAlreadyCreated();
    error AssetNotMarketOperational();
    error NotPoolPartner();
    error PrimaryPoolNotFound();
    error PrimaryPoolAlreadyClosed();
    error PrimaryPoolNotActive();
    error InvalidAmount();
    error AssetNotActive();
    error InsufficientPayment();
    error InsufficientTokenBalance();
    error ListingNotActive();
    error ListingNotFound();
    error FeesExceedPrice();
    error NotListingOwner();
    error InvalidDuration();
    error ListingOwnerCannotPurchase();
    error PrimaryRedemptionNotAllowed();
    error PositionManagerNotSet();
    error InvalidPositionManager(address manager);

    event PrimaryPoolCreated(
        uint256 indexed tokenId,
        address indexed partner,
        uint256 pricePerToken,
        uint256 maxSupply,
        bool immediateProceeds,
        bool protectionEnabled
    );
    event PrimaryPoolPaused(uint256 indexed tokenId);
    event PrimaryPoolUnpaused(uint256 indexed tokenId);
    event PrimaryPoolClosed(uint256 indexed tokenId);
    event PrimaryPoolPurchased(
        uint256 indexed tokenId,
        address indexed buyer,
        uint256 amount,
        uint256 totalCost,
        uint256 protocolFee,
        uint256 partnerProceeds
    );
    event PrimaryPoolRedeemed(
        uint256 indexed tokenId,
        address indexed holder,
        uint256 amountBurned,
        uint256 payout,
        uint256 investorLiquidityAfter
    );
    event ListingCreated(
        uint256 indexed listingId,
        uint256 indexed tokenId,
        uint256 indexed assetId,
        address seller,
        uint256 amount,
        uint256 pricePerToken,
        uint256 expiresAt,
        bool buyerPaysFee
    );
    event RevenueTokensTraded(
        uint256 indexed tokenId,
        address indexed from,
        address indexed to,
        uint256 amount,
        uint256 listingId,
        uint256 totalPrice
    );
    event ListingEnded(uint256 indexed listingId, address indexed seller);
    event ListingExtended(uint256 indexed listingId, uint256 newExpiresAt);
    event PartnerManagerUpdated(address indexed oldAddress, address indexed newAddress);
    event UsdcUpdated(address indexed oldAddress, address indexed newAddress);
    event RoboshareTokensUpdated(address indexed oldAddress, address indexed newAddress);
    event RouterUpdated(address indexed oldAddress, address indexed newAddress);
    event TreasuryUpdated(address indexed oldAddress, address indexed newAddress);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initializes core dependencies and admin roles.
     */
    function initialize(
        address _admin,
        address _roboshareTokens,
        address _partnerManager,
        address _router,
        address _treasury,
        address _usdc
    ) public initializer {
        if (
            _admin == address(0) || _roboshareTokens == address(0) || _partnerManager == address(0)
                || _router == address(0) || _treasury == address(0) || _usdc == address(0)
        ) {
            revert ZeroAddress();
        }

        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(UPGRADER_ROLE, _admin);

        roboshareTokens = RoboshareTokens(_roboshareTokens);
        partnerManager = PartnerManager(_partnerManager);
        router = RegistryRouter(_router);
        treasury = ITreasury(_treasury);
        _validateUSDCContract(_usdc);
        usdc = IERC20(_usdc);

        _listingIdCounter = 1;
    }

    /**
     * @dev Creates a primary pool for the caller as partner.
     */
    function createPrimaryPool(uint256 tokenId, uint256 pricePerToken) external nonReentrant {
        _createPrimaryPoolFor(msg.sender, tokenId, pricePerToken);
    }

    /**
     * @dev Creates a primary pool on behalf of a partner.
     */
    function createPrimaryPoolFor(address partner, uint256 tokenId, uint256 pricePerToken)
        external
        onlyRole(AUTHORIZED_CONTRACT_ROLE)
        nonReentrant
    {
        _createPrimaryPoolFor(partner, tokenId, pricePerToken);
    }

    /**
     * @dev Pauses a primary pool.
     */
    function pausePrimaryPool(uint256 tokenId) external {
        PrimaryPool storage pool = _getPrimaryPool(tokenId);
        _onlyAuthorizedPoolPartnerOrAdmin(pool.partner);
        if (pool.isClosed) revert PrimaryPoolAlreadyClosed();
        pool.isPaused = true;
        pool.pausedAt = block.timestamp;
        emit PrimaryPoolPaused(tokenId);
    }

    /**
     * @dev Unpauses a previously paused primary pool.
     */
    function unpausePrimaryPool(uint256 tokenId) external {
        PrimaryPool storage pool = _getPrimaryPool(tokenId);
        _onlyAuthorizedPoolPartnerOrAdmin(pool.partner);
        if (pool.isClosed) revert PrimaryPoolAlreadyClosed();
        pool.isPaused = false;
        emit PrimaryPoolUnpaused(tokenId);
    }

    /**
     * @dev Permanently closes a primary pool.
     */
    function closePrimaryPool(uint256 tokenId) external {
        PrimaryPool storage pool = _getPrimaryPool(tokenId);
        if (!hasRole(AUTHORIZED_CONTRACT_ROLE, msg.sender)) {
            _onlyAuthorizedPoolPartnerOrAdmin(pool.partner);
        }
        if (pool.isClosed) revert PrimaryPoolAlreadyClosed();
        pool.isClosed = true;
        pool.closedAt = block.timestamp;
        emit PrimaryPoolClosed(tokenId);
    }

    /**
     * @dev Previews primary pool purchase breakdown.
     */
    function previewPrimaryPurchase(uint256 tokenId, uint256 amount)
        external
        view
        returns (uint256 totalCost, uint256 protocolFee, uint256 partnerProceeds)
    {
        PrimaryPool storage pool = _getPrimaryPool(tokenId);
        if (amount == 0) return (0, 0, 0);

        uint256 grossPrincipal = amount * pool.pricePerToken;
        protocolFee = ProtocolLib.calculateProtocolFee(grossPrincipal);
        totalCost = grossPrincipal + protocolFee;

        if (roboshareTokens.getRevenueTokenImmediateProceedsEnabled(tokenId)) {
            partnerProceeds = grossPrincipal;
        }
    }

    /**
     * @dev Previews protocol/protection buffer requirements for a primary pool.
     */
    function previewPrimaryPoolBufferRequirements(uint256 tokenId, uint256 baseAmount)
        external
        view
        returns (uint256 protocolBuffer, uint256 protectionBuffer, uint256 totalBuffer)
    {
        _getPrimaryPool(tokenId);
        uint256 targetYieldBP = roboshareTokens.getTargetYieldBP(tokenId);
        bool protectionEnabled = roboshareTokens.getRevenueTokenProtectionEnabled(tokenId);
        (, uint256 requiredEarningsBuffer, uint256 requiredProtocolBuffer,) =
            CollateralLib.calculateCollateralRequirements(baseAmount, ProtocolLib.QUARTERLY_INTERVAL, targetYieldBP);

        protocolBuffer = requiredProtocolBuffer;
        protectionBuffer = protectionEnabled ? requiredEarningsBuffer : 0;
        totalBuffer = protocolBuffer + protectionBuffer;
    }

    /**
     * @dev Buys tokens from a primary pool and settles immediately.
     */
    function buyFromPrimaryPool(uint256 tokenId, uint256 amount) external nonReentrant {
        PrimaryPool storage pool = _getValidatedPrimaryPool(tokenId, amount);
        PrimaryPurchaseQuote memory quote = _buildPrimaryPurchaseQuote(pool.pricePerToken, amount);

        _collectBuyerPayment(msg.sender, quote.totalCost, address(treasury));
        _executePrimaryPurchase(msg.sender, tokenId, amount, pool, quote);
    }

    /**
     * @dev Previews redemption payout from a primary pool.
     */
    function previewPrimaryRedemption(uint256 tokenId, address holder, uint256 amount)
        external
        view
        returns (uint256 payout, uint256 investorLiquidity, uint256 redemptionSupply, uint256 holderEligibleBalance)
    {
        _getPrimaryPool(tokenId);
        IPositionManager manager = _positionManager();
        holderEligibleBalance = manager.getPrimaryRedemptionEligibleBalance(holder, tokenId);
        if (amount == 0) return (0, 0, 0, holderEligibleBalance);

        redemptionSupply = manager.getCurrentPrimaryRedemptionEpochSupply(tokenId);
        uint256 assetId = TokenLib.getAssetIdFromTokenId(tokenId);
        (, investorLiquidity,,,,,,,,,) = treasury.assetCollateral(assetId);
        if (amount > holderEligibleBalance || redemptionSupply == 0 || investorLiquidity == 0) {
            return (0, investorLiquidity, redemptionSupply, holderEligibleBalance);
        }
        payout = Math.mulDiv(amount, investorLiquidity, redemptionSupply);
    }

    /**
     * @dev Redeems pool tokens for investor liquidity.
     */
    function redeemPrimaryPool(uint256 tokenId, uint256 amount, uint256 minPayout)
        external
        nonReentrant
        returns (uint256 payout)
    {
        PrimaryPool storage pool = _getPrimaryPool(tokenId);
        if (pool.isPaused || pool.isClosed) revert PrimaryPoolNotActive();
        if (amount == 0) revert InvalidAmount();

        uint256 assetId = TokenLib.getAssetIdFromTokenId(tokenId);
        if (!isAssetMarketOperational(assetId)) revert AssetNotActive();

        payout = treasury.processPrimaryRedemptionFor(msg.sender, tokenId, amount, minPayout);

        (, uint256 investorLiquidityAfter,,,,,,,,,) = treasury.assetCollateral(assetId);
        emit PrimaryPoolRedeemed(tokenId, msg.sender, amount, payout, investorLiquidityAfter);
    }

    /**
     * @dev Creates a secondary listing for caller-owned tokens.
     */
    function createListing(uint256 tokenId, uint256 amount, uint256 pricePerToken, uint256 duration, bool buyerPaysFee)
        external
        nonReentrant
        returns (uint256 listingId)
    {
        address seller = msg.sender;
        if (!TokenLib.isRevenueToken(tokenId)) revert InvalidTokenType();
        if (pricePerToken == 0) revert InvalidPrice();

        uint256 assetId = TokenLib.getAssetIdFromTokenId(tokenId);
        if (!isAssetMarketOperational(assetId)) revert AssetNotMarketOperational();

        uint256 tokenSupply = roboshareTokens.getRevenueTokenSupply(tokenId);
        if (amount == 0 || amount > tokenSupply) revert InvalidAmount();

        uint256 sellerBalance = roboshareTokens.balanceOf(seller, tokenId);
        if (sellerBalance < amount) revert InsufficientTokenBalance();
        IPositionManager manager = _positionManager();
        uint256 earlySalePenalty = manager.getSalesPenalty(seller, tokenId, amount);

        listingId = _listingIdCounter++;
        uint256 expiresAt = block.timestamp + duration;

        listings[listingId] = Listing({
            listingId: listingId,
            tokenId: tokenId,
            amount: amount,
            soldAmount: 0,
            pricePerToken: pricePerToken,
            seller: seller,
            expiresAt: expiresAt,
            isActive: true,
            createdAt: block.timestamp,
            buyerPaysFee: buyerPaysFee,
            earlySalePenalty: earlySalePenalty
        });

        assetListings[assetId].push(listingId);
        manager.lockForListing(seller, tokenId, amount);
        manager.bookSalePenalty(listingId, seller, tokenId, earlySalePenalty);

        emit ListingCreated(listingId, tokenId, assetId, seller, amount, pricePerToken, expiresAt, buyerPaysFee);
        return listingId;
    }

    /**
     * @dev Purchases tokens from a secondary listing with immediate settlement.
     */
    function buyFromSecondaryListing(uint256 listingId, uint256 amount) external nonReentrant {
        Listing storage listingForExpiry = listings[listingId];
        if (listingForExpiry.listingId == 0) revert ListingNotFound();
        if (block.timestamp > listingForExpiry.expiresAt) {
            if (_expireListingIfNeeded(listingForExpiry)) {
                emit ListingEnded(listingId, listingForExpiry.seller);
            }
            return;
        }

        Listing storage listing = _getValidatedSecondaryListing(listingId, amount);
        SecondaryPurchaseQuote memory quote = _buildSecondaryPurchaseQuote(listing, amount);

        _collectBuyerPayment(msg.sender, quote.totalCost, address(this));
        _executeSecondaryPurchase(msg.sender, listingId, amount, listing, quote);
    }

    /**
     * @dev Ends an active listing and returns unsold inventory to seller.
     */
    function endListing(uint256 listingId) public nonReentrant {
        Listing storage listing = listings[listingId];

        if (listing.listingId == 0) revert ListingNotFound();
        if (listing.seller != msg.sender && block.timestamp <= listing.expiresAt) revert NotListingOwner();
        _expireListingIfNeeded(listing);

        bool isSoldOut = (!listing.isActive && listing.amount == 0);
        if (!listing.isActive && !isSoldOut) revert ListingNotActive();

        listing.isActive = false;

        if (listing.amount > 0) {
            IPositionManager manager = _positionManager();
            manager.unlockForListing(listing.seller, listing.tokenId, listing.amount);
            manager.clearSalePenalty(listingId);
            listing.amount = 0;
        }

        emit ListingEnded(listingId, listing.seller);
    }

    /**
     * @dev Extends expiration for an active listing.
     */
    function extendListing(uint256 listingId, uint256 additionalDuration) external nonReentrant {
        Listing storage listing = listings[listingId];

        if (listing.listingId == 0) revert ListingNotFound();
        if (_expireListingIfNeeded(listing)) {
            emit ListingEnded(listingId, listing.seller);
            return;
        }
        if (listing.seller != msg.sender) revert NotListingOwner();
        if (!listing.isActive) revert ListingNotActive();
        if (additionalDuration == 0) revert InvalidDuration();

        listing.expiresAt += additionalDuration;

        emit ListingExtended(listingId, listing.expiresAt);
    }

    /**
     * @dev Returns listing details.
     */
    function getListing(uint256 listingId) external view returns (Listing memory) {
        return listings[listingId];
    }

    /**
     * @dev Returns primary pool details.
     */
    function getPrimaryPool(uint256 tokenId) external view returns (PrimaryPool memory) {
        return _getPrimaryPool(tokenId);
    }

    /**
     * @dev Returns whether primary pool exists and is active.
     */
    function isPrimaryPoolActive(uint256 tokenId) external view returns (bool) {
        if (!primaryPoolCreated[tokenId]) return false;
        PrimaryPool storage pool = primaryPools[tokenId];
        return !pool.isPaused && !pool.isClosed;
    }

    /**
     * @dev Returns active listings for an asset.
     */
    function getAssetListings(uint256 assetId) external view returns (uint256[] memory activeListings) {
        uint256[] memory allListings = assetListings[assetId];
        uint256 activeCount = 0;

        for (uint256 i = 0; i < allListings.length; i++) {
            Listing storage listing = listings[allListings[i]];
            if (listing.isActive && block.timestamp <= listing.expiresAt) {
                activeCount++;
            }
        }

        activeListings = new uint256[](activeCount);
        uint256 index = 0;
        for (uint256 i = 0; i < allListings.length; i++) {
            Listing storage listing = listings[allListings[i]];
            if (listing.isActive && block.timestamp <= listing.expiresAt) {
                activeListings[index] = allListings[i];
                index++;
            }
        }

        return activeListings;
    }

    /**
     * @dev Calculates purchase cost and fees for listing buy.
     */
    function previewSecondaryPurchase(uint256 listingId, uint256 amount)
        external
        view
        returns (uint256 totalCost, uint256 protocolFee, uint256 expectedPayment)
    {
        Listing storage listing = listings[listingId];

        totalCost = amount * listing.pricePerToken;
        protocolFee = ProtocolLib.calculateProtocolFee(totalCost);
        expectedPayment = listing.buyerPaysFee ? totalCost + protocolFee : totalCost;

        return (totalCost, protocolFee, expectedPayment);
    }

    /**
     * @dev Returns current listing id counter.
     */
    function getCurrentListingId() external view returns (uint256) {
        return _listingIdCounter;
    }

    /**
     * @dev Returns whether asset is operational for market activity.
     */
    function isAssetMarketOperational(uint256 assetId) public view returns (bool) {
        if (!router.assetExists(assetId)) return false;

        AssetLib.AssetStatus status = router.getAssetStatus(assetId);
        if (status != AssetLib.AssetStatus.Active && status != AssetLib.AssetStatus.Earning) return false;

        return true;
    }

    /**
     * @dev Updates PartnerManager reference.
     */
    function updatePartnerManager(address _partnerManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_partnerManager == address(0)) revert ZeroAddress();
        address oldAddress = address(partnerManager);
        partnerManager = PartnerManager(_partnerManager);
        emit PartnerManagerUpdated(oldAddress, _partnerManager);
    }

    /**
     * @dev Updates payment token reference after validation.
     */
    function updateUSDC(address _usdc) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_usdc == address(0)) revert ZeroAddress();
        _validateUSDCContract(_usdc);
        address oldAddress = address(usdc);
        usdc = IERC20(_usdc);
        emit UsdcUpdated(oldAddress, _usdc);
    }

    /**
     * @dev Updates RoboshareTokens reference.
     */
    function updateRoboshareTokens(address _roboshareTokens) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_roboshareTokens == address(0)) revert ZeroAddress();
        address oldAddress = address(roboshareTokens);
        roboshareTokens = RoboshareTokens(_roboshareTokens);
        emit RoboshareTokensUpdated(oldAddress, _roboshareTokens);
    }

    /**
     * @dev Updates RegistryRouter reference.
     */
    function updateRouter(address _newRouter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_newRouter == address(0)) revert ZeroAddress();
        address oldAddress = address(router);
        router = RegistryRouter(_newRouter);
        emit RouterUpdated(oldAddress, _newRouter);
    }

    /**
     * @dev Updates Treasury reference.
     */
    function updateTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_treasury == address(0)) revert ZeroAddress();
        address oldAddress = address(treasury);
        treasury = ITreasury(_treasury);
        emit TreasuryUpdated(oldAddress, _treasury);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) { }

    function _getValidatedPrimaryPool(uint256 tokenId, uint256 amount)
        internal
        view
        returns (PrimaryPool storage pool)
    {
        pool = _getPrimaryPool(tokenId);
        if (pool.isPaused || pool.isClosed) revert PrimaryPoolNotActive();
        if (amount == 0) revert InvalidAmount();

        uint256 assetId = TokenLib.getAssetIdFromTokenId(tokenId);
        if (!_isAssetMarketOperational(assetId)) revert AssetNotActive();

        uint256 currentSupply = roboshareTokens.getRevenueTokenSupply(tokenId);
        if (currentSupply + amount > roboshareTokens.getRevenueTokenMaxSupply(tokenId)) revert InvalidAmount();
    }

    function _getValidatedSecondaryListing(uint256 listingId, uint256 amount)
        internal
        view
        returns (Listing storage listing)
    {
        listing = listings[listingId];
        if (listing.listingId == 0) revert ListingNotFound();

        uint256 assetId = TokenLib.getAssetIdFromTokenId(listing.tokenId);
        if (!_isAssetMarketOperational(assetId)) revert AssetNotActive();
        if (msg.sender == listing.seller) revert ListingOwnerCannotPurchase();
        if (block.timestamp > listing.expiresAt) revert ListingNotActive();
        if (!listing.isActive) revert ListingNotActive();
        if (amount == 0 || amount > listing.amount) revert InvalidAmount();
    }

    function _buildPrimaryPurchaseQuote(uint256 pricePerToken, uint256 amount)
        internal
        pure
        returns (PrimaryPurchaseQuote memory quote)
    {
        quote.grossPrincipal = amount * pricePerToken;
        quote.protocolFee = ProtocolLib.calculateProtocolFee(quote.grossPrincipal);
        quote.totalCost = quote.grossPrincipal + quote.protocolFee;
    }

    function _buildSecondaryPurchaseQuote(Listing storage listing, uint256 amount)
        internal
        view
        returns (SecondaryPurchaseQuote memory quote)
    {
        quote.grossProceeds = amount * listing.pricePerToken;
        quote.protocolFee = ProtocolLib.calculateProtocolFee(quote.grossProceeds);
        quote.earlySalePenalty = _positionManager().getSalesPenalty(listing.seller, listing.tokenId, amount);

        if (listing.buyerPaysFee) {
            if (quote.earlySalePenalty > quote.grossProceeds) revert FeesExceedPrice();
            quote.totalCost = quote.grossProceeds + quote.protocolFee;
            quote.sellerNet = quote.grossProceeds - quote.earlySalePenalty;
        } else {
            uint256 totalFees = quote.protocolFee + quote.earlySalePenalty;
            if (totalFees > quote.grossProceeds) revert FeesExceedPrice();
            quote.totalCost = quote.grossProceeds;
            quote.sellerNet = quote.grossProceeds - totalFees;
        }
    }

    function _executePrimaryPurchase(
        address buyer,
        uint256 tokenId,
        uint256 amount,
        PrimaryPool storage pool,
        PrimaryPurchaseQuote memory quote
    ) internal {
        treasury.processPrimaryPoolPurchaseFor(
            buyer, tokenId, amount, pool.partner, quote.grossPrincipal, quote.protocolFee
        );

        emit PrimaryPoolPurchased(tokenId, buyer, amount, quote.totalCost, quote.protocolFee, 0);
    }

    function _executeSecondaryPurchase(
        address buyer,
        uint256 listingId,
        uint256 amount,
        Listing storage listing,
        SecondaryPurchaseQuote memory quote
    ) internal {
        listing.amount -= amount;
        listing.soldAmount += amount;
        if (listing.amount == 0) {
            listing.isActive = false;
            _positionManager().clearSalePenalty(listingId);
        }

        if (quote.sellerNet > 0) {
            _transferUSDC(listing.seller, quote.sellerNet);
        }

        _routeProtocolFee(quote.protocolFee + quote.earlySalePenalty);
        _positionManager().transferLockedForListing(listing.seller, buyer, listing.tokenId, amount);

        emit RevenueTokensTraded(listing.tokenId, listing.seller, buyer, amount, listingId, quote.grossProceeds);
    }

    function _expireListingIfNeeded(Listing storage listing) internal returns (bool didExpire) {
        if (!listing.isActive || block.timestamp <= listing.expiresAt) return false;

        listing.isActive = false;
        if (listing.amount > 0) {
            IPositionManager manager = _positionManager();
            manager.unlockForListing(listing.seller, listing.tokenId, listing.amount);
            manager.clearSalePenalty(listing.listingId);
            listing.amount = 0;
        }
        return true;
    }

    function _collectBuyerPayment(address buyer, uint256 amount, address recipient) internal {
        if (usdc.balanceOf(buyer) < amount) revert InsufficientPayment();
        _transferUSDCFromBuyer(buyer, recipient, amount);
    }

    function _transferUSDCFromBuyer(address buyer, address recipient, uint256 amount) internal {
        if (amount == 0) return;
        usdc.safeTransferFrom(buyer, recipient, amount);
    }

    function _transferUSDC(address to, uint256 amount) internal {
        if (amount == 0) return;
        usdc.safeTransfer(to, amount);
    }

    function _routeProtocolFee(uint256 amount) internal {
        if (amount == 0) return;
        _transferUSDC(address(treasury), amount);
        treasury.recordPendingWithdrawalFor(treasury.treasuryFeeRecipient(), amount);
    }

    function _positionManager() internal view returns (IPositionManager) {
        IPositionManager manager = roboshareTokens.positionManager();
        if (address(manager) == address(0)) revert PositionManagerNotSet();
        if (address(manager).code.length == 0) revert InvalidPositionManager(address(manager));
        return manager;
    }

    function _isAssetMarketOperational(uint256 assetId) internal view returns (bool) {
        return isAssetMarketOperational(assetId);
    }

    /**
     * @dev Internal primary pool creation path with validations.
     */
    function _createPrimaryPoolFor(address partner, uint256 tokenId, uint256 pricePerToken) internal {
        if (!TokenLib.isRevenueToken(tokenId)) revert InvalidTokenType();
        if (pricePerToken == 0) revert InvalidPrice();
        uint256 maxSupply = roboshareTokens.getRevenueTokenMaxSupply(tokenId);
        if (maxSupply == 0) revert InvalidMaxSupply();
        if (primaryPoolCreated[tokenId]) revert PrimaryPoolAlreadyCreated();

        uint256 assetId = TokenLib.getAssetIdFromTokenId(tokenId);
        if (!isAssetMarketOperational(assetId)) revert AssetNotMarketOperational();
        if (roboshareTokens.balanceOf(partner, assetId) == 0) revert NotPoolPartner();

        primaryPools[tokenId] = PrimaryPool({
            tokenId: tokenId,
            partner: partner,
            pricePerToken: pricePerToken,
            isPaused: false,
            isClosed: false,
            createdAt: block.timestamp,
            pausedAt: 0,
            closedAt: 0
        });
        primaryPoolCreated[tokenId] = true;

        emit PrimaryPoolCreated(
            tokenId,
            partner,
            pricePerToken,
            maxSupply,
            roboshareTokens.getRevenueTokenImmediateProceedsEnabled(tokenId),
            roboshareTokens.getRevenueTokenProtectionEnabled(tokenId)
        );
    }

    function _getPrimaryPool(uint256 tokenId) internal view returns (PrimaryPool storage pool) {
        if (!primaryPoolCreated[tokenId]) revert PrimaryPoolNotFound();
        pool = primaryPools[tokenId];
    }

    function _onlyAuthorizedPoolPartnerOrAdmin(address partner) internal view {
        if (hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) return;
        if (!partnerManager.isAuthorizedPartner(msg.sender)) {
            revert PartnerManager.UnauthorizedPartner();
        }
        if (msg.sender != partner) revert NotPoolPartner();
    }

    /**
     * @dev Validates USDC-compatible ERC20 contract (6 decimals).
     */
    function _validateUSDCContract(address token) internal view {
        try IERC20(token).totalSupply() returns (uint256) { }
        catch {
            revert InvalidUSDCContract(token);
        }

        uint8 tokenDecimals;
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            tokenDecimals = d;
        } catch {
            revert InvalidUSDCContract(token);
        }

        if (tokenDecimals != 6) {
            revert UnsupportedUSDCDecimals(tokenDecimals);
        }
    }
}
