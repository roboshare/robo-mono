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
import { IAssetRegistry } from "./interfaces/IAssetRegistry.sol";
import { ITreasury } from "./interfaces/ITreasury.sol";
import { IEarningsManager } from "./interfaces/IEarningsManager.sol";
import { IPositionManager } from "./interfaces/IPositionManager.sol";
import { ProtocolLib, TokenLib, CollateralLib, EarningsLib, AssetLib } from "./Libraries.sol";
import { RoboshareTokens } from "./RoboshareTokens.sol";
import { PartnerManager } from "./PartnerManager.sol";
import { RegistryRouter } from "./RegistryRouter.sol";

/**
 * @title Treasury
 * @notice Holds and accounts for USDC collateral, partner buffers, fee accrual, and settlement payouts.
 * @dev The treasury is the protocol's USDC ledger for each asset lifecycle:
 *      primary purchases credit investor principal, partners fund protocol/earnings buffers,
 *      earnings distributions may trigger collateral release, and settlement/liquidation
 *      convert remaining collateral into claimable withdrawals.
 */
contract Treasury is Initializable, AccessControlUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable, ITreasury {
    using CollateralLib for CollateralLib.CollateralInfo;
    using TokenLib for TokenLib.TokenInfo;
    using EarningsLib for EarningsLib.EarningsInfo;
    using SafeERC20 for IERC20;
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");
    bytes32 public constant AUTHORIZED_MARKETPLACE_ROLE = keccak256("AUTHORIZED_MARKETPLACE_ROLE");
    bytes32 public constant AUTHORIZED_ROUTER_ROLE = keccak256("AUTHORIZED_ROUTER_ROLE");
    bytes32 public constant AUTHORIZED_EARNINGS_MANAGER_ROLE = keccak256("AUTHORIZED_EARNINGS_MANAGER_ROLE");
    bytes32 private constant PRIMARY_REDEMPTION_CONSUMED_REASON = keccak256("PRIMARY_REDEMPTION_CONSUMED");

    // Core contracts
    PartnerManager public partnerManager;
    RoboshareTokens public roboshareTokens;
    RegistryRouter public router;
    IEarningsManager public earningsManager;
    IERC20 public usdc;

    // Treasury configuration
    address public treasuryFeeRecipient;

    // Treasury storage
    mapping(uint256 => CollateralLib.CollateralInfo) public assetCollateral; // assetId => CollateralInfo
    mapping(uint256 => CollateralLib.SettlementInfo) public assetSettlements; // assetId => SettlementInfo
    mapping(address => uint256) public pendingWithdrawals;
    uint256 public totalCollateralDeposited;
    uint256 public totalEarningsDeposited;

    // Internal Errors (not part of public API)
    error ZeroAddress();
    error InvalidUSDCContract(address token);
    error UnsupportedUSDCDecimals(uint8 decimals);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    modifier onlyAuthorizedAssetOwner(uint256 assetId) {
        _onlyAuthorizedAssetOwner(assetId);
        _;
    }

    function _requireAuthorizedAssetOwner(address partner, uint256 assetId) internal view {
        if (!partnerManager.isAuthorizedPartner(partner)) {
            revert PartnerManager.UnauthorizedPartner();
        }
        if (roboshareTokens.balanceOf(partner, assetId) == 0) {
            revert NotAssetOwner();
        }
    }

    function _requireAssetExists(uint256 assetId) internal view {
        if (!router.assetExists(assetId)) {
            revert AssetNotFound();
        }
    }

    function _onlyAuthorizedAssetOwner(uint256 assetId) internal view {
        _requireAssetExists(assetId);
        _requireAuthorizedAssetOwner(msg.sender, assetId);
    }

    function _requireEarningsManagerConfigured() internal view {
        if (address(earningsManager) == address(0)) {
            revert EarningsManagerNotSet();
        }
    }

    function _positionManager() internal view returns (IPositionManager) {
        return roboshareTokens.positionManager();
    }

    function _isSettlementConfigured(uint256 assetId) internal view returns (bool) {
        return _positionManager().getSettlementState(assetId).isConfigured;
    }

    function _isTerminalAssetStatus(AssetLib.AssetStatus status) internal pure returns (bool) {
        return status == AssetLib.AssetStatus.Retired || status == AssetLib.AssetStatus.Expired;
    }

    /**
     * @notice Initializes the treasury and wires its core protocol dependencies.
     * @param _admin Address receiving admin, upgrader, and treasurer roles
     * @param _roboshareTokens Revenue-token contract used for asset and pool metadata
     * @param _partnerManager Authorized partner registry
     * @param _router Registry router allowed to perform treasury-controlled asset actions
     * @param _usdc USDC-compatible settlement token with 6 decimals
     * @param _treasuryFeeRecipient Recipient for protocol fees accrued by treasury flows
     */
    function initialize(
        address _admin,
        address _roboshareTokens,
        address _partnerManager,
        address _router,
        address _usdc,
        address _treasuryFeeRecipient
    ) public initializer {
        if (
            _admin == address(0) || _roboshareTokens == address(0) || _partnerManager == address(0)
                || _router == address(0) || _usdc == address(0) || _treasuryFeeRecipient == address(0)
        ) {
            revert ZeroAddress();
        }

        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(UPGRADER_ROLE, _admin);
        _grantRole(TREASURER_ROLE, _admin);
        _grantRole(AUTHORIZED_ROUTER_ROLE, _router);

        roboshareTokens = RoboshareTokens(_roboshareTokens);
        partnerManager = PartnerManager(_partnerManager);
        router = RegistryRouter(_router);
        _validateUSDCContract(_usdc);
        usdc = IERC20(_usdc);
        treasuryFeeRecipient = _treasuryFeeRecipient;
    }

    function processPrimaryPoolPurchaseFor(
        address buyer,
        uint256 tokenId,
        uint256 amount,
        address partner,
        uint256 principal,
        uint256 protocolFee
    ) external onlyRole(AUTHORIZED_MARKETPLACE_ROLE) nonReentrant {
        if (!partnerManager.isAuthorizedPartner(partner)) {
            revert PartnerManager.UnauthorizedPartner();
        }
        uint256 assetId = TokenLib.getAssetIdFromTokenId(tokenId);
        _requireAssetExists(assetId);
        _requireAuthorizedAssetOwner(partner, assetId);

        _creditBaseCollateral(assetId, principal);

        if (protocolFee > 0) {
            pendingWithdrawals[treasuryFeeRecipient] += protocolFee;
        }

        _maybePromoteToEarning(assetId, tokenId);

        router.mintRevenueTokensToBuyerFromPrimaryPool(buyer, tokenId, amount);
    }

    function _creditBaseCollateral(uint256 assetId, uint256 amount) internal {
        CollateralLib.CollateralInfo storage collateralInfo = assetCollateral[assetId];

        collateralInfo.baseCollateral += amount;
        collateralInfo.unredeemedBasePrincipal += amount;
        totalCollateralDeposited += amount;

        if (collateralInfo.createdAt == 0) {
            collateralInfo.createdAt = block.timestamp;
        }
        collateralInfo.lastEventTimestamp = block.timestamp;
    }

    function _reconcileReleasedBaseCollateral(CollateralLib.CollateralInfo storage collateralInfo) internal {
        uint256 remainingTrackedPrincipal = collateralInfo.baseCollateral + collateralInfo.releasedProtectedBase;
        collateralInfo.releasedBaseCollateral = collateralInfo.unredeemedBasePrincipal > remainingTrackedPrincipal
            ? collateralInfo.unredeemedBasePrincipal - remainingTrackedPrincipal
            : 0;
    }

    function _maybePromoteToEarning(uint256 assetId, uint256 tokenId) internal returns (bool hasSufficientBuffers) {
        hasSufficientBuffers = _hasSufficientBuffers(assetId, tokenId);
        if (router.getAssetStatus(assetId) == AssetLib.AssetStatus.Active && hasSufficientBuffers) {
            router.setAssetStatus(assetId, AssetLib.AssetStatus.Earning);
        }
    }

    function _hasSufficientBuffers(uint256 assetId, uint256 tokenId) internal view returns (bool) {
        CollateralLib.CollateralInfo storage collateralInfo = assetCollateral[assetId];
        uint256 baseAmount = collateralInfo.baseCollateral;
        uint256 targetYieldBP = roboshareTokens.getTargetYieldBP(tokenId);
        bool protectionEnabled = roboshareTokens.getRevenueTokenProtectionEnabled(tokenId);
        (, uint256 requiredEarningsBuffer, uint256 requiredProtocolBuffer,) =
            CollateralLib.calculateCollateralRequirements(baseAmount, ProtocolLib.QUARTERLY_INTERVAL, targetYieldBP);

        bool protocolCovered = collateralInfo.protocolBuffer >= requiredProtocolBuffer;
        bool protectionCovered = !protectionEnabled || collateralInfo.earningsBuffer >= requiredEarningsBuffer;
        return protocolCovered && protectionCovered;
    }

    function processPrimaryRedemptionFor(address holder, uint256 tokenId, uint256 burnAmount, uint256 minPayout)
        external
        onlyRole(AUTHORIZED_MARKETPLACE_ROLE)
        nonReentrant
        returns (uint256 payout)
    {
        _requireEarningsManagerConfigured();
        uint256 assetId = TokenLib.getAssetIdFromTokenId(tokenId);
        _requireAssetExists(assetId);
        AssetLib.AssetStatus status = router.getAssetStatus(assetId);
        if (status != AssetLib.AssetStatus.Active && status != AssetLib.AssetStatus.Earning) {
            revert AssetNotOperational(assetId, status);
        }
        if (burnAmount == 0) {
            revert InsufficientPrimaryLiquidity();
        }

        IPositionManager manager = _positionManager();

        uint256 redemptionSupply = manager.getCurrentPrimaryRedemptionEpochSupply(tokenId);
        if (redemptionSupply == 0) {
            revert NoRedeemablePrimarySupply();
        }
        if (manager.getPrimaryRedemptionEligibleBalance(holder, tokenId) < burnAmount) {
            revert InsufficientTokenBalance();
        }

        // Preserve unclaimed earnings before burn to prevent earnings double-dipping.
        earningsManager.snapshotAndClaimEarnings(assetId, holder, false);

        uint256 investorLiquidity = assetCollateral[assetId].baseCollateral;
        payout = Math.mulDiv(burnAmount, investorLiquidity, redemptionSupply);
        if (payout == 0 || payout > investorLiquidity) {
            revert InsufficientPrimaryLiquidity();
        }
        if (payout < minPayout) {
            revert SlippageExceeded();
        }

        router.burnRevenueTokensFromHolderForPrimaryRedemption(holder, tokenId, burnAmount);

        uint256 redeemedPrincipal = burnAmount * roboshareTokens.getTokenPrice(tokenId);
        CollateralLib.CollateralInfo storage collateralInfo = assetCollateral[assetId];
        collateralInfo.baseCollateral -= payout;
        collateralInfo.unredeemedBasePrincipal = redeemedPrincipal >= collateralInfo.unredeemedBasePrincipal
            ? 0
            : collateralInfo.unredeemedBasePrincipal - redeemedPrincipal;
        _reconcileReleasedBaseCollateral(collateralInfo);
        totalCollateralDeposited = totalCollateralDeposited >= payout ? totalCollateralDeposited - payout : 0;
        usdc.safeTransfer(holder, payout);
        manager.consumePrimaryRedemption(holder, tokenId, burnAmount, payout, PRIMARY_REDEMPTION_CONSUMED_REASON);
    }

    function _getCoverableBaseCollateral(uint256 assetId) internal view returns (uint256 coverableBaseCollateral) {
        CollateralLib.CollateralInfo storage collateralInfo = assetCollateral[assetId];
        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        uint256 targetYieldBP = roboshareTokens.getTargetYieldBP(revenueTokenId);
        bool protectionEnabled = roboshareTokens.getRevenueTokenProtectionEnabled(revenueTokenId);
        bool immediateProceeds = roboshareTokens.getRevenueTokenImmediateProceedsEnabled(revenueTokenId);
        coverableBaseCollateral = CollateralLib.calculateCoverableBaseCollateral(
            collateralInfo, targetYieldBP, protectionEnabled, immediateProceeds
        );
    }

    function enableProceeds(uint256 assetId) external onlyAuthorizedAssetOwner(assetId) nonReentrant {
        uint256 tokenId = TokenLib.getTokenIdFromAssetId(assetId);
        bool immediateProceeds = roboshareTokens.getRevenueTokenImmediateProceedsEnabled(tokenId);
        bool protectionEnabled = roboshareTokens.getRevenueTokenProtectionEnabled(tokenId);
        CollateralLib.CollateralInfo storage collateralInfo = assetCollateral[assetId];
        uint256 baseAmount = collateralInfo.baseCollateral;
        if (immediateProceeds) {
            baseAmount += collateralInfo.releasedProtectedBase;
        }
        if (baseAmount == 0) {
            revert CollateralLib.InvalidCollateralAmount();
        }

        _fundCurrentBuffersFor(msg.sender, assetId, baseAmount, protectionEnabled);
    }

    /**
     * @notice Funds the currently required protocol and, when enabled, earnings buffers for an asset.
     * @dev Computes incremental buffer requirements from live covered principal, transfers only the
     *      still-due amount from `partner`, initializes earnings timestamps when needed, and then
     *      finalizes proceeds enablement using refreshed collateral coverage.
     * @param partner Asset owner supplying any newly required buffer capital
     * @param assetId Asset whose collateral buffers are being funded
     * @param baseAmount Principal exposure currently requiring coverage
     * @param protectionEnabled Whether the pool requires an earnings buffer in addition to the protocol buffer
     */
    function _fundCurrentBuffersFor(address partner, uint256 assetId, uint256 baseAmount, bool protectionEnabled)
        internal
    {
        _requireEarningsManagerConfigured();
        if (baseAmount == 0) {
            revert CollateralLib.InvalidCollateralAmount();
        }

        CollateralLib.CollateralInfo storage collateralInfo = assetCollateral[assetId];

        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        uint256 targetYieldBP = roboshareTokens.getTargetYieldBP(revenueTokenId);

        (, uint256 requiredEarningsBuffer, uint256 requiredProtocolBuffer,) =
            CollateralLib.calculateCollateralRequirements(baseAmount, ProtocolLib.QUARTERLY_INTERVAL, targetYieldBP);

        uint256 dueEarningsBuffer = protectionEnabled && requiredEarningsBuffer > collateralInfo.earningsBuffer
            ? requiredEarningsBuffer - collateralInfo.earningsBuffer
            : 0;
        uint256 dueProtocolBuffer = requiredProtocolBuffer > collateralInfo.protocolBuffer
            ? requiredProtocolBuffer - collateralInfo.protocolBuffer
            : 0;
        uint256 requiredBufferTotal = dueEarningsBuffer + dueProtocolBuffer;

        if (requiredBufferTotal == 0) {
            _finalizeProceedsEnablement(partner, assetId, revenueTokenId);
            return;
        }

        if (!CollateralLib.isInitialized(collateralInfo)) {
            CollateralLib.initializeCollateralInfo(collateralInfo, 0, dueEarningsBuffer, dueProtocolBuffer);
        } else {
            collateralInfo.earningsBuffer += dueEarningsBuffer;
            collateralInfo.protocolBuffer += dueProtocolBuffer;
            collateralInfo.isLocked = true;
            if (collateralInfo.lockedAt == 0) {
                collateralInfo.lockedAt = block.timestamp;
            }
        }
        collateralInfo.lastEventTimestamp = block.timestamp;
        earningsManager.initializeLastEventTimestampIfUnset(assetId);

        // Transfer USDC from partner to treasury (requires prior approval)
        usdc.safeTransferFrom(partner, address(this), requiredBufferTotal);

        totalCollateralDeposited += requiredBufferTotal;

        emit CollateralLocked(assetId, partner, requiredBufferTotal);

        _finalizeProceedsEnablement(partner, assetId, revenueTokenId);
    }

    function _finalizeProceedsEnablement(address partner, uint256 assetId, uint256 revenueTokenId) internal {
        _maybePromoteToEarning(assetId, revenueTokenId);
        if (roboshareTokens.getRevenueTokenImmediateProceedsEnabled(revenueTokenId)) {
            _releaseEnabledPartnerProceeds(assetId, partner);
        }
    }

    function _releaseEnabledPartnerProceeds(uint256 assetId, address partner) internal {
        CollateralLib.CollateralInfo storage collateralInfo = assetCollateral[assetId];
        uint256 releasedAmount = _getCoverableBaseCollateral(assetId);
        if (releasedAmount == 0) {
            return;
        }
        uint256 tokenId = TokenLib.getTokenIdFromAssetId(assetId);

        unchecked {
            collateralInfo.baseCollateral -= releasedAmount;
            totalCollateralDeposited -= releasedAmount;
            collateralInfo.releasedProtectedBase += releasedAmount;
            pendingWithdrawals[partner] += releasedAmount;
        }

        router.recordImmediateProceedsRelease(tokenId, releasedAmount);

        emit ImmediateProceedsReleased(assetId, partner, releasedAmount);
    }

    function creditEarningsWithdrawal(address account, uint256 amount)
        external
        onlyRole(AUTHORIZED_EARNINGS_MANAGER_ROLE)
    {
        if (amount > 0) {
            pendingWithdrawals[account] += amount;
        }
    }

    function processEarningsDistributionEffects(
        address partner,
        uint256 assetId,
        uint256 investorAmount,
        uint256 protocolFee,
        bool tryAutoRelease
    ) external onlyRole(AUTHORIZED_EARNINGS_MANAGER_ROLE) nonReentrant returns (uint256 collateralReleased) {
        if (investorAmount > 0) {
            totalEarningsDeposited += investorAmount;
        }
        if (protocolFee > 0) {
            pendingWithdrawals[treasuryFeeRecipient] += protocolFee;
        }
        if (tryAutoRelease) {
            collateralReleased = _tryReleaseCollateral(assetId, partner, true);
        }
    }

    function releaseCollateral(uint256 assetId) external onlyAuthorizedAssetOwner(assetId) nonReentrant {
        CollateralLib.CollateralInfo storage collateralInfo = assetCollateral[assetId];
        if (!collateralInfo.isLocked) {
            revert NoCollateralLocked();
        }

        _releaseCollateralFor(msg.sender, assetId);
    }

    function releaseCollateralFor(address partner, uint256 assetId)
        external
        onlyRole(AUTHORIZED_ROUTER_ROLE)
        nonReentrant
        returns (uint256 releasedCollateral)
    {
        CollateralLib.CollateralInfo storage collateralInfo = assetCollateral[assetId];

        if (collateralInfo.isLocked) {
            releasedCollateral = CollateralLib.getTotalCollateral(
                collateralInfo.baseCollateral, collateralInfo.earningsBuffer, collateralInfo.protocolBuffer
            );
            _releaseCollateralFor(partner, assetId);
        }
    }

    function _releaseCollateralFor(address recipient, uint256 assetId) internal {
        // Ensure no outstanding revenue tokens
        // Registry is responsible for burning tokens before calling retirement
        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        uint256 totalSupply = roboshareTokens.getRevenueTokenSupply(revenueTokenId);

        if (totalSupply > 0) {
            revert OutstandingRevenueTokens();
        }

        uint256 collateralAmount = _clearCollateral(assetId);

        // Add to pending withdrawals
        pendingWithdrawals[recipient] += collateralAmount;

        emit CollateralReleased(assetId, recipient, collateralAmount);
    }

    function recordPendingWithdrawalFor(address recipient, uint256 amount)
        external
        onlyRole(AUTHORIZED_MARKETPLACE_ROLE)
    {
        if (amount > 0) {
            pendingWithdrawals[recipient] += amount;
        }
    }

    function processWithdrawal() external nonReentrant {
        uint256 amount = _processWithdrawalFor(msg.sender);
        if (amount == 0) {
            revert NoPendingWithdrawals();
        }
    }

    /**
     * @notice Processes and transfers an account's pending-withdrawal balance.
     * @param account Account whose pending balance should be withdrawn
     * @return amount Amount of USDC transferred to `account`
     */
    function _processWithdrawalFor(address account) internal returns (uint256 amount) {
        amount = pendingWithdrawals[account];
        if (amount > 0) {
            pendingWithdrawals[account] = 0;
            usdc.safeTransfer(account, amount);
            emit WithdrawalProcessed(account, amount);
        }
    }

    function isAssetSolvent(uint256 assetId) external view override returns (bool) {
        AssetLib.AssetStatus status = router.getAssetStatus(assetId);
        if (_isTerminalAssetStatus(status) || _isSettlementConfigured(assetId)) {
            return false;
        }

        return CollateralLib.isSolvent(assetCollateral[assetId]);
    }

    function previewCollateralRelease(uint256 assetId, uint256 pendingNetEarnings)
        external
        view
        returns (uint256 releasedAmount)
    {
        _requireEarningsManagerConfigured();
        CollateralLib.ReleaseCalculation memory calc = _getReleasePreview(assetId, pendingNetEarnings);
        if (calc.status != CollateralLib.ReleaseEligibility.Eligible) {
            return 0;
        }
        return calc.partnerRelease;
    }

    function releasePartialCollateral(uint256 assetId) external onlyAuthorizedAssetOwner(assetId) nonReentrant {
        _tryReleaseCollateral(assetId, msg.sender, false);
    }

    /**
     * @notice Attempts to release eligible collateral for an earning asset using current release math.
     * @dev Applies release-preview math to storage, records any shortfall/replenishment side effects,
     *      syncs processed-period state with the earnings manager, and credits released collateral to
     *      pending withdrawals instead of transferring inline.
     * @param assetId Asset whose collateral release should be attempted
     * @param partner Asset owner to credit with any partner-facing release amount
     * @param allowSkip If true, returns 0 instead of reverting when the asset is currently ineligible
     * @return releasedAmount Partner-facing amount credited from the release attempt
     */
    function _tryReleaseCollateral(uint256 assetId, address partner, bool allowSkip)
        internal
        returns (uint256 releasedAmount)
    {
        CollateralLib.CollateralInfo storage collateralInfo = assetCollateral[assetId];
        CollateralLib.ReleaseCalculation memory calc = _getReleasePreview(assetId, 0);
        if (calc.status != CollateralLib.ReleaseEligibility.Eligible) {
            if (allowSkip) {
                return 0;
            }
            if (calc.status == CollateralLib.ReleaseEligibility.NoCollateralLocked) {
                revert NoCollateralLocked();
            }
            if (calc.status == CollateralLib.ReleaseEligibility.NoPriorEarnings) {
                revert NoPriorEarningsDistribution();
            }
            revert NoNewEarningsPeriods();
        }

        if (calc.shortfallAmount > 0) {
            emit ShortfallReserved(assetId, calc.shortfallAmount);
        }

        if (calc.replenishmentAmount > 0) {
            emit BufferReplenished(assetId, calc.replenishmentAmount, calc.replenishmentAmount);
        }

        // Apply buffer updates
        collateralInfo.earningsBuffer = calc.collateral.earningsBuffer;
        collateralInfo.protocolBuffer = calc.collateral.protocolBuffer;
        collateralInfo.reservedForLiquidation = calc.collateral.reservedForLiquidation;

        emit CollateralBuffersUpdated(assetId, collateralInfo.earningsBuffer, collateralInfo.reservedForLiquidation);

        // Update timestamps to mark that these periods and their time duration have been processed
        collateralInfo.lastEventTimestamp = block.timestamp;
        earningsManager.recordReleaseProcessing(assetId, calc.newLastProcessedPeriod, calc.excessEarnings);

        if (calc.grossRelease == 0) {
            return 0;
        }

        // Values are bounded by release-calculation guards; unchecked trims bytecode.
        unchecked {
            collateralInfo.baseCollateral -= calc.grossRelease;
            collateralInfo.releasedBaseCollateral += calc.grossRelease;
            totalCollateralDeposited -= calc.grossRelease;
            pendingWithdrawals[partner] += calc.partnerRelease;
            if (calc.protocolFee > 0) {
                pendingWithdrawals[treasuryFeeRecipient] += calc.protocolFee;
            }
        }

        emit CollateralReleased(assetId, partner, calc.partnerRelease);

        releasedAmount = calc.partnerRelease;
    }

    function _getReleasePreview(uint256 assetId, uint256 pendingNetEarnings)
        internal
        view
        returns (CollateralLib.ReleaseCalculation memory calc)
    {
        return pendingNetEarnings == 0
            ? _getCurrentReleasePreview(assetId)
            : _getPendingReleasePreview(assetId, pendingNetEarnings);
    }

    /**
     * @notice Builds a collateral-release preview using only already-recorded on-chain earnings state.
     * @param assetId Asset whose release eligibility should be previewed
     * @return calc Full release calculation, including updated collateral buffers and fee split
     */
    function _getCurrentReleasePreview(uint256 assetId)
        internal
        view
        returns (CollateralLib.ReleaseCalculation memory calc)
    {
        _requireEarningsManagerConfigured();
        CollateralLib.CollateralInfo memory collateralInfo = assetCollateral[assetId];
        IEarningsManager.EarningsSummary memory earningsSummary = earningsManager.getAssetEarningsSummary(assetId);
        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        bool protectionEnabled = roboshareTokens.getRevenueTokenProtectionEnabled(revenueTokenId);
        bool immediateProceeds = roboshareTokens.getRevenueTokenImmediateProceedsEnabled(revenueTokenId);
        uint256 targetYieldBP = roboshareTokens.getTargetYieldBP(revenueTokenId);
        if (!collateralInfo.isLocked) {
            calc.status = CollateralLib.ReleaseEligibility.NoCollateralLocked;
            return calc;
        }
        uint256 coveredBaseCollateral = CollateralLib.calculateCoverableBaseCollateral(
            collateralInfo, targetYieldBP, protectionEnabled, immediateProceeds
        );
        uint256 benchmarkEarnings;
        uint256 benchmarkPrincipal;
        uint256 realizedEarnings;
        if (
            earningsSummary.isInitialized && earningsSummary.currentPeriod > 0
                && earningsSummary.currentPeriod > earningsSummary.lastProcessedPeriod
        ) {
            uint256 timeSinceLastEvent = block.timestamp - collateralInfo.lastEventTimestamp;
            benchmarkPrincipal = CollateralLib.calculateBenchmarkEarningsPrincipal(
                collateralInfo, targetYieldBP, protectionEnabled, immediateProceeds
            );
            benchmarkEarnings = EarningsLib.calculateEarnings(benchmarkPrincipal, timeSinceLastEvent, targetYieldBP);
            realizedEarnings = earningsManager.sumRealizedEarnings(
                assetId, earningsSummary.lastProcessedPeriod, earningsSummary.currentPeriod
            );
        }

        calc = CollateralLib.calculateReleasePreview(
            collateralInfo,
            false,
            earningsSummary.isInitialized,
            earningsSummary.currentPeriod,
            earningsSummary.lastProcessedPeriod,
            realizedEarnings,
            benchmarkEarnings,
            benchmarkPrincipal,
            coveredBaseCollateral
        );

        if (
            calc.status == CollateralLib.ReleaseEligibility.Eligible
                && earningsSummary.currentPeriod > earningsSummary.lastProcessedPeriod
        ) {
            _finalizeEligibleReleasePreview(calc, true, targetYieldBP, protectionEnabled, immediateProceeds);
        }
    }

    /**
     * @notice Builds a collateral-release preview that simulates one additional pending earnings period.
     * @param assetId Asset whose release eligibility should be previewed
     * @param pendingNetEarnings Net investor earnings to inject as a simulated next period
     * @return calc Full release calculation, including updated collateral buffers and fee split
     */
    function _getPendingReleasePreview(uint256 assetId, uint256 pendingNetEarnings)
        internal
        view
        returns (CollateralLib.ReleaseCalculation memory calc)
    {
        _requireEarningsManagerConfigured();
        CollateralLib.CollateralInfo memory collateralInfo = assetCollateral[assetId];
        IEarningsManager.EarningsSummary memory earningsSummary = earningsManager.getAssetEarningsSummary(assetId);
        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        bool protectionEnabled = roboshareTokens.getRevenueTokenProtectionEnabled(revenueTokenId);
        bool immediateProceeds = roboshareTokens.getRevenueTokenImmediateProceedsEnabled(revenueTokenId);
        uint256 targetYieldBP = roboshareTokens.getTargetYieldBP(revenueTokenId);
        if (!collateralInfo.isLocked) {
            calc.status = CollateralLib.ReleaseEligibility.NoCollateralLocked;
            return calc;
        }
        uint256 coveredBaseCollateral = CollateralLib.calculateCoverableBaseCollateral(
            collateralInfo, targetYieldBP, protectionEnabled, immediateProceeds
        );
        (
            bool simulatedInitialized,
            uint256 simulatedCurrentPeriod,
            uint256 realizedEarnings,
            uint256 benchmarkEarnings,
            uint256 benchmarkPrincipal
        ) = _getPendingPreviewEarningsInputs(
            assetId,
            collateralInfo,
            earningsSummary,
            targetYieldBP,
            protectionEnabled,
            immediateProceeds,
            pendingNetEarnings
        );

        calc = CollateralLib.calculateReleasePreview(
            collateralInfo,
            false,
            simulatedInitialized,
            simulatedCurrentPeriod,
            earningsSummary.lastProcessedPeriod,
            realizedEarnings,
            benchmarkEarnings,
            benchmarkPrincipal,
            coveredBaseCollateral
        );

        if (calc.status == CollateralLib.ReleaseEligibility.Eligible) {
            _finalizeEligibleReleasePreview(
                calc,
                simulatedCurrentPeriod > earningsSummary.lastProcessedPeriod,
                targetYieldBP,
                protectionEnabled,
                immediateProceeds
            );
        }
    }

    /**
     * @notice Derives earnings inputs for a preview that simulates one additional unprocessed period.
     * @param assetId Asset whose pending preview is being constructed
     * @param collateralInfo Current collateral snapshot used for the preview
     * @param earningsSummary Current earnings-manager summary for the asset
     * @param targetYieldBP Target annualized benchmark yield in basis points
     * @param protectionEnabled Whether earnings-buffer protection is enabled
     * @param immediateProceeds Whether immediate proceeds affect benchmark principal
     * @param pendingNetEarnings Simulated net earnings for the next pending period
     */
    function _getPendingPreviewEarningsInputs(
        uint256 assetId,
        CollateralLib.CollateralInfo memory collateralInfo,
        IEarningsManager.EarningsSummary memory earningsSummary,
        uint256 targetYieldBP,
        bool protectionEnabled,
        bool immediateProceeds,
        uint256 pendingNetEarnings
    )
        internal
        view
        returns (
            bool simulatedInitialized,
            uint256 simulatedCurrentPeriod,
            uint256 realizedEarnings,
            uint256 benchmarkEarnings,
            uint256 benchmarkPrincipal
        )
    {
        simulatedInitialized = true;
        simulatedCurrentPeriod = earningsSummary.currentPeriod + 1;

        if (simulatedCurrentPeriod <= earningsSummary.lastProcessedPeriod) {
            return (simulatedInitialized, simulatedCurrentPeriod, 0, 0, 0);
        }

        uint256 timeSinceLastEvent = block.timestamp - collateralInfo.lastEventTimestamp;
        benchmarkPrincipal = CollateralLib.calculateBenchmarkEarningsPrincipal(
            collateralInfo, targetYieldBP, protectionEnabled, immediateProceeds
        );
        benchmarkEarnings = EarningsLib.calculateEarnings(benchmarkPrincipal, timeSinceLastEvent, targetYieldBP);

        if (earningsSummary.currentPeriod > earningsSummary.lastProcessedPeriod) {
            realizedEarnings = earningsManager.sumRealizedEarnings(
                assetId, earningsSummary.lastProcessedPeriod, earningsSummary.currentPeriod
            );
        }
        realizedEarnings += pendingNetEarnings;
    }

    /**
     * @notice Finalizes fee and gross-release outputs for an otherwise eligible release preview.
     * @dev Recomputes covered base after the preview's simulated collateral updates, clamps release
     *      to both covered base and total collateral, and derives the partner/protocol fee split.
     */
    function _finalizeEligibleReleasePreview(
        CollateralLib.ReleaseCalculation memory calc,
        bool hasUnprocessedPeriods,
        uint256 targetYieldBP,
        bool protectionEnabled,
        bool immediateProceeds
    ) internal view {
        if (!hasUnprocessedPeriods) {
            return;
        }

        uint256 coveredBaseCollateral = CollateralLib.calculateCoverableBaseCollateral(
            calc.collateral, targetYieldBP, protectionEnabled, immediateProceeds
        );
        calc.grossRelease = CollateralLib.calculateCollateralRelease(calc.collateral);
        if (calc.grossRelease > coveredBaseCollateral) {
            calc.grossRelease = coveredBaseCollateral;
        }
        uint256 totalCollateral = CollateralLib.getTotalCollateral(
            calc.collateral.baseCollateral, calc.collateral.earningsBuffer, calc.collateral.protocolBuffer
        );
        if (calc.grossRelease > totalCollateral) {
            calc.grossRelease = totalCollateral;
        }
        if (calc.grossRelease > 0) {
            (calc.partnerRelease, calc.protocolFee) = CollateralLib.calculateReleaseFees(calc.grossRelease);
        } else {
            calc.partnerRelease = 0;
            calc.protocolFee = 0;
        }
    }

    function previewLiquidationEligibility(uint256 assetId)
        external
        view
        override
        returns (bool eligible, uint8 reason)
    {
        AssetLib.AssetStatus status = router.getAssetStatus(assetId);
        if (_isTerminalAssetStatus(status) || _isSettlementConfigured(assetId)) {
            return (false, 2);
        }

        _requireEarningsManagerConfigured();
        CollateralLib.CollateralInfo memory simulatedCollateral = assetCollateral[assetId];
        IEarningsManager.EarningsSummary memory earningsSummary = earningsManager.getAssetEarningsSummary(assetId);
        if (simulatedCollateral.isLocked && earningsSummary.lastEventTimestamp > 0) {
            uint256 elapsed = block.timestamp - earningsSummary.lastEventTimestamp;
            if (elapsed > 0) {
                uint256 revenueTokenIdForYield = TokenLib.getTokenIdFromAssetId(assetId);
                bool protectionEnabled = roboshareTokens.getRevenueTokenProtectionEnabled(revenueTokenIdForYield);
                bool immediateProceeds = roboshareTokens.getRevenueTokenImmediateProceedsEnabled(revenueTokenIdForYield);
                uint256 targetYieldBP = roboshareTokens.getTargetYieldBP(revenueTokenIdForYield);
                uint256 benchmarkPrincipal = CollateralLib.calculateBenchmarkEarningsPrincipal(
                    simulatedCollateral, targetYieldBP, protectionEnabled, immediateProceeds
                );
                if (benchmarkPrincipal > 0) {
                    uint256 benchmarkEarnings =
                        EarningsLib.calculateEarnings(benchmarkPrincipal, elapsed, targetYieldBP);
                    simulatedCollateral = CollateralLib.previewCollateralAfterMissedEarningsShortfall(
                        simulatedCollateral, benchmarkEarnings
                    );
                }
            }
        }

        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(revenueTokenId);
        bool isMatured = block.timestamp >= maturityDate;
        bool isSolvent = CollateralLib.isSolventMemory(simulatedCollateral);

        if (isMatured) {
            return (true, 0);
        }
        if (!isSolvent) {
            return (true, 1);
        }

        return (false, 3);
    }

    function executeLiquidation(uint256 assetId)
        external
        override
        onlyRole(AUTHORIZED_ROUTER_ROLE)
        returns (uint256 liquidationAmount, uint256 settlementPerToken)
    {
        AssetLib.AssetStatus currentStatus = router.getAssetStatus(assetId);
        if (_isTerminalAssetStatus(currentStatus) || _isSettlementConfigured(assetId)) {
            revert IAssetRegistry.AssetAlreadySettled(assetId, currentStatus);
        }

        CollateralLib.SettlementInfo storage settlement = assetSettlements[assetId];

        _applyMissedEarningsShortfall(assetId);

        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(revenueTokenId);
        bool isMatured = block.timestamp >= maturityDate;
        bool isSolvent = CollateralLib.isSolvent(assetCollateral[assetId]);

        if (!isMatured && isSolvent) {
            revert IAssetRegistry.AssetNotEligibleForLiquidation(assetId);
        }

        // Settle asset (Liquidation)
        (liquidationAmount,) = _settleAsset(assetId, 0, true);

        uint256 totalSupply = roboshareTokens.getRevenueTokenSupply(revenueTokenId);

        if (totalSupply > 0) {
            settlement.settlementPerToken = liquidationAmount / totalSupply;
        }

        settlement.isSettled = true;
        settlement.totalSettlementPool = liquidationAmount;
        _positionManager()
            .recordSettlement(
                assetId,
                _positionManager().getCurrentPrimaryRedemptionEpoch(revenueTokenId),
                liquidationAmount,
                settlement.settlementPerToken,
                keccak256("LIQUIDATION_SETTLEMENT")
            );
        settlementPerToken = settlement.settlementPerToken;
        return (liquidationAmount, settlementPerToken);
    }

    function _applyMissedEarningsShortfall(uint256 assetId) internal {
        _requireEarningsManagerConfigured();
        CollateralLib.CollateralInfo storage collateralInfo = assetCollateral[assetId];
        IEarningsManager.EarningsSummary memory earningsSummary = earningsManager.getAssetEarningsSummary(assetId);

        if (!collateralInfo.isLocked) {
            return;
        }

        if (earningsSummary.lastEventTimestamp == 0) {
            return;
        }

        uint256 elapsed = block.timestamp - earningsSummary.lastEventTimestamp;
        if (elapsed == 0) {
            return;
        }

        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        bool protectionEnabled = roboshareTokens.getRevenueTokenProtectionEnabled(revenueTokenId);
        bool immediateProceeds = roboshareTokens.getRevenueTokenImmediateProceedsEnabled(revenueTokenId);
        uint256 targetYieldBP = roboshareTokens.getTargetYieldBP(revenueTokenId);
        uint256 benchmarkPrincipal = CollateralLib.calculateBenchmarkEarningsPrincipal(
            collateralInfo, targetYieldBP, protectionEnabled, immediateProceeds
        );
        if (benchmarkPrincipal == 0) {
            collateralInfo.lastEventTimestamp = block.timestamp;
            earningsManager.syncLastEventTimestamp(assetId);
            return;
        }
        uint256 benchmarkEarnings = EarningsLib.calculateEarnings(benchmarkPrincipal, elapsed, targetYieldBP);
        (uint256 shortfallAmount,,) = CollateralLib.applyRealizedVsBenchmarkToCollateralInStorage(
            collateralInfo, 0, benchmarkEarnings, benchmarkPrincipal
        );
        if (shortfallAmount > 0) {
            emit ShortfallReserved(assetId, shortfallAmount);
        }

        emit CollateralBuffersUpdated(assetId, collateralInfo.earningsBuffer, collateralInfo.reservedForLiquidation);

        collateralInfo.lastEventTimestamp = block.timestamp;
        earningsManager.syncLastEventTimestamp(assetId);
    }

    function previewSettlementClaim(uint256 assetId, address holder) external view returns (uint256) {
        _requireAssetExists(assetId);

        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        uint256 tokenBalance = roboshareTokens.balanceOf(holder, revenueTokenId);
        if (!_isSettlementConfigured(assetId) || tokenBalance == 0) {
            return 0;
        }

        return _positionManager().previewSettlementClaim(assetId, tokenBalance);
    }

    function initiateSettlement(address partner, uint256 assetId, uint256 topUpAmount)
        external
        override
        onlyRole(AUTHORIZED_ROUTER_ROLE)
        returns (uint256 settlementAmount, uint256 settlementPerToken)
    {
        AssetLib.AssetStatus currentStatus = router.getAssetStatus(assetId);
        if (_isTerminalAssetStatus(currentStatus) || _isSettlementConfigured(assetId)) {
            revert IAssetRegistry.AssetAlreadySettled(assetId, currentStatus);
        }

        CollateralLib.SettlementInfo storage settlement = assetSettlements[assetId];

        _applyMissedEarningsShortfall(assetId);

        uint256 requiredTopUp = _previewRequiredSettlementTopUp(assetId);
        if (topUpAmount < requiredTopUp) {
            revert ITreasury.InsufficientSettlementTopUp(assetId, requiredTopUp, topUpAmount);
        }

        // Transfer top-up if any
        if (topUpAmount > 0) {
            usdc.safeTransferFrom(partner, address(this), topUpAmount);
        }

        // Settle asset (Voluntary)
        uint256 partnerRefund;
        (settlementAmount, partnerRefund) = _settleAsset(assetId, topUpAmount, false);

        if (partnerRefund > 0) {
            pendingWithdrawals[partner] += partnerRefund;
        }

        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        uint256 totalSupply = roboshareTokens.getRevenueTokenSupply(revenueTokenId);

        if (totalSupply > 0) {
            settlement.settlementPerToken = settlementAmount / totalSupply;
        }

        settlement.isSettled = true;
        settlement.totalSettlementPool = settlementAmount;
        _positionManager()
            .recordSettlement(
                assetId,
                _positionManager().getCurrentPrimaryRedemptionEpoch(revenueTokenId),
                settlementAmount,
                settlement.settlementPerToken,
                keccak256("VOLUNTARY_SETTLEMENT")
            );
        settlementPerToken = settlement.settlementPerToken;
        return (settlementAmount, settlementPerToken);
    }

    function _previewRequiredSettlementTopUp(uint256 assetId) internal view returns (uint256 requiredTopUp) {
        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        if (!roboshareTokens.getRevenueTokenImmediateProceedsEnabled(revenueTokenId)) {
            return 0;
        }

        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(revenueTokenId);
        if (block.timestamp >= maturityDate) {
            return 0;
        }

        CollateralLib.CollateralInfo memory info = assetCollateral[assetId];
        uint256 residualBaseValue = _calculateResidualBaseValue(info);
        if (residualBaseValue <= info.baseCollateral) {
            return 0;
        }
        return residualBaseValue - info.baseCollateral;
    }

    function _calculateResidualBaseValue(CollateralLib.CollateralInfo memory info)
        internal
        view
        returns (uint256 residualBaseValue)
    {
        if (info.unredeemedBasePrincipal == 0) {
            return 0;
        }

        uint256 elapsedSinceLock = info.lockedAt == 0 ? 0 : block.timestamp - info.lockedAt;
        uint256 depreciated = CollateralLib.calculateDepreciation(info.unredeemedBasePrincipal, elapsedSinceLock);
        return depreciated >= info.unredeemedBasePrincipal ? 0 : info.unredeemedBasePrincipal - depreciated;
    }

    function processSettlementClaimFor(address recipient, uint256 assetId, uint256 amount)
        external
        override
        onlyRole(AUTHORIZED_ROUTER_ROLE)
        returns (uint256 claimedAmount)
    {
        if (!_isSettlementConfigured(assetId)) {
            revert IAssetRegistry.AssetNotSettled(assetId, router.getAssetStatus(assetId));
        }

        if (amount == 0) {
            return 0;
        }

        claimedAmount = _positionManager()
            .creditSettlementClaim(recipient, assetId, amount, keccak256("TREASURY_SETTLEMENT_CLAIM"));
        pendingWithdrawals[recipient] += claimedAmount;

        emit SettlementClaimed(assetId, recipient, claimedAmount);
    }

    /**
     * @notice Internal settlement routine shared by voluntary settlement and forced liquidation.
     * @dev Clears collateral storage, routes protocol buffer to treasury fees when required, and
     *      determines how much value belongs to investors versus the partner refund path based on
     *      maturity and whether the flow is a liquidation.
     * @param assetId Asset being settled
     * @param additionalAmount Extra USDC contributed to the investor pool during settlement
     * @param isLiquidation Whether the settlement path is forced liquidation
     * @return investorPool Amount reserved for token-holder settlement claims
     * @return partnerRefund Amount credited back to the partner, if any
     */
    function _settleAsset(uint256 assetId, uint256 additionalAmount, bool isLiquidation)
        internal
        returns (uint256 investorPool, uint256 partnerRefund)
    {
        CollateralLib.CollateralInfo storage info = assetCollateral[assetId];

        // Snapshot values before clearing
        uint256 protocolBuffer = info.protocolBuffer;
        uint256 earningsBuffer = info.earningsBuffer;
        uint256 claimable = info.baseCollateral + info.reservedForLiquidation;

        // Clear collateral state
        _clearCollateral(assetId);

        // Check for maturity
        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        uint256 maturityDate = roboshareTokens.getTokenMaturityDate(revenueTokenId);
        bool isMatured = block.timestamp >= maturityDate;

        if (!isLiquidation && isMatured) {
            // Voluntary settlement after maturity: Refund earnings AND protocol buffer to partner
            partnerRefund = earningsBuffer + protocolBuffer;
            // Investor pool gets base + reserved (earnings buffer excluded)
            investorPool = claimable + additionalAmount;
        } else {
            // Liquidation OR Not Matured: Protocol Buffer goes to Treasury
            if (protocolBuffer > 0) {
                pendingWithdrawals[treasuryFeeRecipient] += protocolBuffer;
            }

            if (isMatured) {
                // Liquidation after maturity: Partner refund (earnings buffer) is calculated but likely ignored by caller
                partnerRefund = earningsBuffer;
                investorPool = claimable + additionalAmount;
            } else {
                // Standard settlement / Liquidation before maturity
                investorPool = claimable + earningsBuffer + additionalAmount;
                partnerRefund = 0;
            }
        }
    }

    /**
     * @notice Clears all collateral state for an asset and updates global collateral totals.
     * @dev Returns the amount removed from the asset before adjusting `totalCollateralDeposited`.
     *      If global accounting has drifted below the asset's stored collateral, the return value is
     *      clamped to the remaining global total so callers never underflow global accounting.
     * @param assetId Asset whose collateral storage should be zeroed out
     * @return totalReleased Amount of collateral removed from treasury-wide accounting
     */
    function _clearCollateral(uint256 assetId) internal returns (uint256 totalReleased) {
        CollateralLib.CollateralInfo storage info = assetCollateral[assetId];
        totalReleased = CollateralLib.getTotalCollateral(info.baseCollateral, info.earningsBuffer, info.protocolBuffer);

        info.isLocked = false;
        info.unredeemedBasePrincipal = 0;
        info.baseCollateral = 0;
        info.earningsBuffer = 0;
        info.protocolBuffer = 0;
        info.reservedForLiquidation = 0;
        info.releasedProtectedBase = 0;
        info.releasedBaseCollateral = 0;

        if (totalCollateralDeposited >= totalReleased) {
            totalCollateralDeposited -= totalReleased;
        } else {
            totalReleased = totalCollateralDeposited;
            totalCollateralDeposited = 0;
        }
    }

    // Admin Functions

    function setEarningsManager(address _earningsManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_earningsManager == address(0)) {
            revert ZeroAddress();
        }
        address oldAddress = address(earningsManager);
        if (oldAddress != address(0)) {
            _revokeRole(AUTHORIZED_EARNINGS_MANAGER_ROLE, oldAddress);
        }
        earningsManager = IEarningsManager(_earningsManager);
        _grantRole(AUTHORIZED_EARNINGS_MANAGER_ROLE, _earningsManager);
        emit EarningsManagerUpdated(oldAddress, _earningsManager);
    }

    function updatePartnerManager(address _partnerManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_partnerManager == address(0)) {
            revert ZeroAddress();
        }
        address oldAddress = address(partnerManager);
        partnerManager = PartnerManager(_partnerManager);
        emit PartnerManagerUpdated(oldAddress, _partnerManager);
    }

    function updateRoboshareTokens(address _roboshareTokens) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_roboshareTokens == address(0)) {
            revert ZeroAddress();
        }
        address oldAddress = address(roboshareTokens);
        roboshareTokens = RoboshareTokens(_roboshareTokens);
        emit RoboshareTokensUpdated(oldAddress, _roboshareTokens);
    }

    function updateRouter(address _newRouter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_newRouter == address(0)) {
            revert ZeroAddress();
        }
        _revokeRole(AUTHORIZED_ROUTER_ROLE, address(router));
        router = RegistryRouter(_newRouter);
        _grantRole(AUTHORIZED_ROUTER_ROLE, _newRouter);
        emit RouterUpdated(_newRouter);
    }

    function updateUSDC(address _usdc) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_usdc == address(0)) {
            revert ZeroAddress();
        }
        _validateUSDCContract(_usdc);
        address oldAddress = address(usdc);
        usdc = IERC20(_usdc);
        emit UsdcUpdated(oldAddress, _usdc);
    }

    /**
     * @dev Validate that a token address is a USDC-compatible ERC20 (6 decimals).
     */
    function _validateUSDCContract(address token) internal view {
        // Ensure IERC20 interface surface is callable.
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

    function updateTreasuryFeeRecipient(address _treasuryFeeRecipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_treasuryFeeRecipient == address(0)) {
            revert ZeroAddress();
        }
        address oldAddress = treasuryFeeRecipient;
        treasuryFeeRecipient = _treasuryFeeRecipient;
        emit TreasuryFeeRecipientUpdated(oldAddress, _treasuryFeeRecipient);
    }

    // UUPS Upgrade authorization
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) { }
}
