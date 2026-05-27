// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @dev Protocol utilities and constants
 */
library ProtocolLib {
    // IPFS validation constants
    uint256 internal constant IPFS_HASH_LENGTH = 46; // "Qm" + 44 chars
    string internal constant IPFS_PREFIX = "ipfs://";

    // Time intervals
    uint256 internal constant MIN_EVENT_INTERVAL = 15 days;
    uint256 internal constant MONTHLY_INTERVAL = 30 days;
    uint256 internal constant QUARTERLY_INTERVAL = 90 days;
    uint256 internal constant YEARLY_INTERVAL = 365 days;

    // Protocol economic constants (basis points)
    uint256 internal constant BP_PRECISION = 10000;
    uint256 internal constant BENCHMARK_YIELD_BP = 1000; // 10%
    uint256 internal constant PROTOCOL_FEE_BP = 250; // 2.5%
    uint256 internal constant EARLY_SALE_PENALTY_BP = 500; // 5%
    uint256 internal constant DEPRECIATION_RATE_BP = 1200; // 12% annually
    uint256 internal constant MIN_PROTOCOL_FEE = 1 * 10 ** 6; // 1 USDC (assuming 6 decimals)
    uint256 internal constant MIN_EARLY_SALE_PENALTY = 1 * 10 ** 6; // 1 USDC (assuming 6 decimals)

    /**
     * @dev Validate IPFS URI format
     * @param uri IPFS URI to validate
     * @return True if valid IPFS URI
     */
    function isValidIPFSURI(string memory uri) internal pure returns (bool) {
        bytes memory uriBytes = bytes(uri);
        bytes memory prefix = bytes(IPFS_PREFIX);

        // Check minimum length
        if (uriBytes.length <= prefix.length) {
            return false;
        }

        // Check prefix
        for (uint256 i = 0; i < prefix.length; i++) {
            if (uriBytes[i] != prefix[i]) {
                return false;
            }
        }

        return true;
    }

    /**
     * @dev Calculate protocol fee
     * @param amount Amount to calculate fee on
     * @return Protocol fee amount
     */
    function calculateProtocolFee(uint256 amount) internal pure returns (uint256) {
        uint256 fee = (amount * PROTOCOL_FEE_BP) / BP_PRECISION;
        if (amount > 0 && fee < MIN_PROTOCOL_FEE) {
            return MIN_PROTOCOL_FEE;
        }
        return fee;
    }

    /**
     * @dev Calculate early sale penalty
     * @param amount Amount to calculate penalty on (tokenAmount * tokenPrice)
     * @return Penalty amount
     */
    function calculatePenalty(uint256 amount) internal pure returns (uint256) {
        uint256 penalty = (amount * EARLY_SALE_PENALTY_BP) / BP_PRECISION;
        if (amount > 0 && penalty < MIN_EARLY_SALE_PENALTY) {
            return MIN_EARLY_SALE_PENALTY;
        }
        return penalty;
    }
}

/**
 * @dev Generic asset management library for protocol-wide asset operations
 * Provides common structures and functionality for all asset types
 */
library AssetLib {
    // Errors
    error InvalidAssetStatus(AssetStatus status);
    error InvalidStatusTransition(AssetStatus from, AssetStatus to);

    // Asset status enumeration for lifecycle management
    enum AssetStatus {
        Pending, // Asset exists but not operational
        Active, // Asset is operational/tradable but earnings not yet enabled
        Earning, // Asset is operational and earnings-enabled
        Suspended, // Temporarily halted operations
        Expired, // Reached maturity without owner retirement
        Retired // Retired with settlement (Voluntary or Forced)
    }

    // Generic asset information structure
    struct AssetInfo {
        uint256 assetValue; // Total value of the asset in USDC
        AssetStatus status; // Current asset status
        uint256 createdAt; // Asset registration timestamp
        uint256 updatedAt; // Last status/metadata update
    }

    /**
     * @dev Initialize asset info
     * @param info Storage reference to asset info
     * @param assetValue Total value of the asset in USDC
     */
    function initializeAssetInfo(AssetInfo storage info, uint256 assetValue) internal {
        info.assetValue = assetValue;
        info.status = AssetStatus.Pending;
        info.createdAt = block.timestamp;
        info.updatedAt = block.timestamp;
    }

    /**
     * @dev Update asset status with validation
     * @param info Storage reference to asset info
     * @param newStatus New status to set
     */
    function updateAssetStatus(AssetInfo storage info, AssetStatus newStatus) internal {
        AssetStatus currentStatus = info.status;

        // Validate status transition
        if (!isValidStatusTransition(currentStatus, newStatus)) {
            revert InvalidStatusTransition(currentStatus, newStatus);
        }

        info.status = newStatus;
        info.updatedAt = block.timestamp;
    }

    /**
     * @dev Check if status transition is valid
     * @param from Current status
     * @param to Target status
     * @return Whether the transition is allowed
     */
    function isValidStatusTransition(AssetStatus from, AssetStatus to) internal pure returns (bool) {
        if (!isValidAssetStatus(to)) {
            revert InvalidAssetStatus(to);
        }

        if (!isValidAssetStatus(from)) {
            revert InvalidAssetStatus(from);
        }

        // Allow same status (no-op)
        if (from == to) return true;

        // Define valid transitions
        if (from == AssetStatus.Pending) {
            return to == AssetStatus.Active || to == AssetStatus.Expired;
        }

        if (from == AssetStatus.Active) {
            return to == AssetStatus.Earning || to == AssetStatus.Suspended || to == AssetStatus.Expired
                || to == AssetStatus.Retired;
        }

        if (from == AssetStatus.Earning) {
            return to == AssetStatus.Suspended || to == AssetStatus.Expired || to == AssetStatus.Retired;
        }

        if (from == AssetStatus.Suspended) {
            return to == AssetStatus.Active || to == AssetStatus.Earning || to == AssetStatus.Expired
                || to == AssetStatus.Retired;
        }

        if (from == AssetStatus.Expired) {
            return to == AssetStatus.Retired;
        }

        // Retired is final state
        if (from == AssetStatus.Retired) {
            return false;
        }

        return false;
    }

    function isValidAssetStatus(AssetStatus status) internal pure returns (bool) {
        return status >= AssetStatus.Pending && status <= AssetStatus.Retired;
    }

    /**
     * @dev Check if asset is operational (can earn/be used)
     * @param info Storage reference to asset info
     * @return Whether asset can be used for operations
     */
    function isOperational(AssetInfo storage info) internal view returns (bool) {
        return info.status == AssetStatus.Active || info.status == AssetStatus.Earning;
    }

    /**
     * @dev Get asset age in seconds
     * @param info Storage reference to asset info
     * @return Age since creation
     */
    function getAssetAge(AssetInfo storage info) internal view returns (uint256) {
        return block.timestamp - info.createdAt;
    }

    /**
     * @dev Get time since last update
     * @param info Storage reference to asset info
     * @return Time since last status update
     */
    function getTimeSinceUpdate(AssetInfo storage info) internal view returns (uint256) {
        return block.timestamp - info.updatedAt;
    }
}

/**
 * @dev Vehicle-related data structures and functions.
 * Keeps only protocol anchors and token-facing metadata pointers on-chain.
 */
library VehicleLib {
    // Errors
    error InvalidVINLength();
    error InvalidMetadataURI();

    /**
     * @dev Protocol-trusted vehicle identity anchor plus token metadata pointers.
     */
    struct VehicleInfo {
        bytes32 vinHash; // Uniqueness anchor for vehicle identity
        string assetMetadataURI; // Asset NFT presentation metadata pointer
        string revenueTokenMetadataURI; // Revenue-token presentation metadata pointer
    }

    /**
     * @dev Main vehicle struct for protocol operations
     */
    struct Vehicle {
        uint256 vehicleId; // Unique vehicle identifier
        AssetLib.AssetInfo assetInfo; // Standard asset management
        VehicleInfo vehicleInfo; // Uniqueness anchor + metadata pointers
    }

    /**
     * @dev Initialize complete vehicle with asset info and token metadata pointers.
     */
    function initializeVehicle(
        Vehicle storage vehicle,
        uint256 vehicleId,
        uint256 assetValue,
        bytes32 vinHash,
        string memory assetMetadataURI,
        string memory revenueTokenMetadataURI
    ) internal {
        vehicle.vehicleId = vehicleId;
        AssetLib.initializeAssetInfo(vehicle.assetInfo, assetValue);
        initializeVehicleInfo(vehicle.vehicleInfo, vinHash, assetMetadataURI, revenueTokenMetadataURI);
    }

    /**
     * @dev Build VIN hash and validate VIN format.
     */
    function toVINHash(string memory vin) internal pure returns (bytes32) {
        bytes memory vinBytes = bytes(vin);
        if (vinBytes.length < 10 || vinBytes.length > 17) {
            revert InvalidVINLength();
        }

        bytes32 vinHash;
        assembly ("memory-safe") {
            vinHash := keccak256(add(vinBytes, 0x20), mload(vinBytes))
        }
        return vinHash;
    }

    /**
     * @dev Initialize vehicle info with validation.
     */
    function initializeVehicleInfo(
        VehicleInfo storage info,
        bytes32 vinHash,
        string memory assetMetadataURI,
        string memory revenueTokenMetadataURI
    ) internal {
        if (vinHash == bytes32(0)) {
            revert InvalidVINLength();
        }
        _validateMetadataURI(assetMetadataURI);
        _validateMetadataURI(revenueTokenMetadataURI);

        info.vinHash = vinHash;
        info.assetMetadataURI = assetMetadataURI;
        info.revenueTokenMetadataURI = revenueTokenMetadataURI;
    }

    /**
     * @dev Update token metadata pointers.
     */
    function updateMetadata(
        VehicleInfo storage info,
        string memory assetMetadataURI,
        string memory revenueTokenMetadataURI
    ) internal {
        _validateMetadataURI(assetMetadataURI);
        _validateMetadataURI(revenueTokenMetadataURI);
        info.assetMetadataURI = assetMetadataURI;
        info.revenueTokenMetadataURI = revenueTokenMetadataURI;
    }

    function _validateMetadataURI(string memory metadataURI) private pure {
        if (!ProtocolLib.isValidIPFSURI(metadataURI)) {
            revert InvalidMetadataURI();
        }
    }
}

/**
 * @dev Generic token library for position tracking and management
 * Handles ERC1155 token positions, transfers, and holding periods
 */
library TokenLib {
    /**
     * @dev Individual token position
     */
    struct TokenPosition {
        uint256 uid; // Unique position ID (Queue Index)
        uint256 tokenId; // ERC1155 token ID
        uint256 amount; // Number of tokens in this position
        uint256 acquiredAt; // Timestamp when position was acquired
        uint256 soldAt; // Timestamp when position was sold (0 if still held)
        uint256 redemptionEpoch; // Primary-redemption tranche this position belongs to
    }

    /**
     * @dev Mapping-based Queue for positions
     */
    struct PositionQueue {
        uint128 head;
        uint128 tail;
        mapping(uint256 => TokenPosition) items;
    }

    /**
     * @dev Token information for tracking
     */
    struct TokenInfo {
        uint256 tokenId; // ERC1155 token ID
        uint256 tokenPrice; // Price per token in USDC (6 decimals), synced to PositionManager for live policy reads
        uint256 maxSupply; // Max primary-pool supply used for revenue split bounds
        uint256 tokenSupply; // Total number of tokens issued
        uint256 minHoldingPeriod; // Minimum holding period before penalty-free transfer, synced to PositionManager
        uint256 maturityDate; // Date by which the revenue commitment ends
        uint256 revenueShareBP; // Max investor share of reported revenue (basis points)
        uint256 targetYieldBP; // Target yield for buffer benchmarks (basis points)
        bool immediateProceeds; // True: higher-upside profile, False: earlier-liquidity profile
        bool protectionEnabled; // True when protection buffer policy is enabled
        uint256 currentRedemptionEpoch; // Manager-owned live state once PositionManager is wired
        uint256 currentRedemptionEpochSupply; // Manager-owned live state once PositionManager is wired
        uint256 currentRedemptionBackedPrincipal; // Manager-owned live state once PositionManager is wired
        // Track positions per user using Queue; live ownership moves to PositionManager after the split.
        mapping(address => PositionQueue) positions;
    }

    error InsufficientTokenBalance();
    error InvalidAssetId();
    error InvalidRevenueTokenId();

    /**
     * @dev Checks if a token ID corresponds to a revenue share token (even numbers).
     * @param tokenId The ID of the token to check.
     * @return True if the token is a revenue share token, false otherwise.
     */
    function isRevenueToken(uint256 tokenId) internal pure returns (bool) {
        return tokenId != 0 && tokenId % 2 == 0;
    }

    /**
     * @dev Get asset ID from token ID
     */
    function getAssetIdFromTokenId(uint256 tokenId) internal pure returns (uint256) {
        if (!isRevenueToken(tokenId)) {
            revert InvalidRevenueTokenId();
        }

        return tokenId - 1;
    }

    /**
     * @dev Get token ID from asset ID
     */
    function getTokenIdFromAssetId(uint256 assetId) internal pure returns (uint256) {
        if (isRevenueToken(assetId) || assetId == 0) {
            revert InvalidAssetId();
        }

        return assetId + 1;
    }

    /**
     * @dev Initialize token info
     * @param info Storage reference to token info
     * @param tokenId ERC1155 token ID
     * @param tokenPrice Price per token in USDC
     * @param minHoldingPeriod Minimum holding period (defaults to MONTHLY_INTERVAL)
     * @param maturityDate Date by which the revenue commitment ends
     */
    function initializeTokenInfo(
        TokenInfo storage info,
        uint256 tokenId,
        uint256 tokenPrice,
        uint256 maxSupply,
        uint256 minHoldingPeriod,
        uint256 maturityDate,
        uint256 revenueShareBP,
        uint256 targetYieldBP,
        bool immediateProceeds,
        bool protectionEnabled
    ) internal {
        info.tokenId = tokenId;
        info.tokenPrice = tokenPrice;
        info.maxSupply = maxSupply;
        info.tokenSupply = 0; // Initialize to 0, will be updated by minting/burning
        info.minHoldingPeriod =
            minHoldingPeriod < ProtocolLib.MONTHLY_INTERVAL ? ProtocolLib.MONTHLY_INTERVAL : minHoldingPeriod;
        info.maturityDate = maturityDate;
        info.revenueShareBP = revenueShareBP;
        info.targetYieldBP =
            targetYieldBP < ProtocolLib.BENCHMARK_YIELD_BP ? ProtocolLib.BENCHMARK_YIELD_BP : targetYieldBP;
        info.immediateProceeds = immediateProceeds;
        info.protectionEnabled = protectionEnabled;
        info.currentRedemptionEpoch = 0;
        info.currentRedemptionEpochSupply = 0;
        info.currentRedemptionBackedPrincipal = 0;
        // mappings are automatically initialized
    }

    /**
     * @dev Add a new position for a token holder (Push to Tail)
     * @param info Storage reference to token info
     * @param holder Address of the token holder
     * @param amount Number of tokens in the position
     */
    function addPosition(TokenInfo storage info, address holder, uint256 amount) internal {
        PositionQueue storage queue = info.positions[holder];
        uint256 id = queue.tail;

        queue.items[id] = TokenPosition({
            uid: id,
            tokenId: info.tokenId,
            amount: amount,
            acquiredAt: block.timestamp,
            soldAt: 0,
            redemptionEpoch: info.currentRedemptionEpoch
        });
        queue.tail++;
    }

    /**
     * @dev Remove positions when tokens are transferred/sold (Consume from Head)
     * @param info Storage reference to token info
     * @param holder Address of the token holder
     * @param amount Number of tokens to remove
     */
    function removePosition(TokenInfo storage info, address holder, uint256 amount) internal {
        PositionQueue storage queue = info.positions[holder];
        uint256 remaining = amount;

        // Start from oldest position (FIFO) - Head to Tail
        for (uint256 i = queue.head; i < queue.tail && remaining > 0; i++) {
            TokenPosition storage pos = queue.items[i];

            if (pos.amount > 0) {
                uint256 toRemove = remaining > pos.amount ? pos.amount : remaining;

                // In-place update
                pos.amount -= toRemove;
                if (pos.amount == 0) {
                    pos.soldAt = block.timestamp;
                }

                remaining -= toRemove;
            }
        }

        if (remaining > 0) {
            revert InsufficientTokenBalance();
        }
    }

    /**
     * @dev Calculates the early sale penalty for a given amount of tokens without modifying state.
     * This function is intended to be called by the Marketplace contract before a sale.
     * @param info Storage reference to token info.
     * @param holder Address of the token holder.
     * @param amountToSell Number of tokens being sold.
     * @return penaltyAmount The calculated early sale penalty.
     */
    function calculateSalesPenalty(TokenInfo storage info, address holder, uint256 amountToSell)
        internal
        view
        returns (uint256 penaltyAmount)
    {
        if (amountToSell == 0) return 0;

        PositionQueue storage queue = info.positions[holder];
        uint256 remaining = amountToSell;
        uint256 totalPenalty;

        // Start from oldest position (FIFO)
        for (uint256 i = queue.head; i < queue.tail && remaining > 0; i++) {
            TokenPosition storage pos = queue.items[i];

            if (pos.amount > 0) {
                // Only consider active positions
                uint256 toConsider = remaining > pos.amount ? pos.amount : remaining;

                // Calculate penalty if holding period not met
                if (block.timestamp < pos.acquiredAt + info.minHoldingPeriod) {
                    totalPenalty += ProtocolLib.calculatePenalty(toConsider * info.tokenPrice);
                }
                remaining -= toConsider;
            }
        }
        return totalPenalty;
    }

    /**
     * @dev Calculate unclaimed earnings for positions between periods
     * @param info Storage reference to token info
     * @param holder Address of the token holder
     * @param earningsInfo Reference to earnings info for period data
     * @param lastClaimedPeriod Last period claimed by holder
     * @return unclaimedAmount Total unclaimed earnings
     */
    function calculateUnclaimedEarningsForPositions(
        TokenInfo storage info,
        address holder,
        EarningsLib.EarningsInfo storage earningsInfo,
        uint256 lastClaimedPeriod
    ) internal view returns (uint256 unclaimedAmount) {
        PositionQueue storage queue = info.positions[holder];

        for (uint256 i = queue.head; i < queue.tail; i++) {
            TokenPosition storage position = queue.items[i];
            if (position.amount > 0) {
                // Active position
                // Calculate earnings for this position across unclaimed periods
                for (uint256 period = lastClaimedPeriod + 1; period <= earningsInfo.currentPeriod; period++) {
                    // Only count earnings for periods where the position was held
                    uint256 periodTimestamp = earningsInfo.periods[period].timestamp;
                    bool wasHeldDuringPeriod = position.acquiredAt <= periodTimestamp
                        && (position.soldAt == 0 || position.soldAt >= periodTimestamp);

                    if (wasHeldDuringPeriod) {
                        unclaimedAmount += earningsInfo.periods[period].earningsPerToken * position.amount;
                    }
                }
            }
        }

        return unclaimedAmount;
    }
}

/**
 * @dev Collateral management library for USDC-based collateral operations
 */
library CollateralLib {
    using SafeCast for uint256;
    using SafeCast for int256;

    // Errors
    error InsufficientCollateral();
    error InvalidCollateralAmount();
    error CollateralAlreadyLocked();
    error NoCollateralLocked();
    error CollateralAlreadyInitialized();

    /**
     * @dev Collateral information for vehicles with time-based calculations
     */
    struct CollateralInfo {
        uint256 unredeemedBasePrincipal; // Undepreciated principal represented by currently outstanding tokens
        uint256 baseCollateral; // Escrowed base amount in USDC
        uint256 earningsBuffer; // Current earnings buffer amount
        uint256 protocolBuffer; // Current protocol buffer amount
        bool isLocked; // Whether collateral is currently locked
        uint256 lockedAt; // Timestamp when collateral was locked
        uint256 lastEventTimestamp; // Last collateral event timestamp
        uint256 reservedForLiquidation; // Tracks shortfalls reserved for liquidation
        uint256 createdAt; // When collateral info was initialized
        uint256 releasedProtectedBase; // Protected exposure already released as immediate proceeds
        uint256 releasedBaseCollateral; // Base unlocked to partner through depreciation-based release paths
    }

    /**
     * @dev Settlement information for retired/expired assets
     */
    struct SettlementInfo {
        bool isSettled;
        uint256 settlementPerToken;
        uint256 totalSettlementPool;
    }

    enum ReleaseEligibility {
        Eligible,
        NoCollateralLocked,
        NoPriorEarnings,
        NoNewEarningsPeriods
    }

    struct ReleaseCalculation {
        ReleaseEligibility status;
        CollateralInfo collateral;
        uint256 newLastProcessedPeriod;
        uint256 shortfallAmount;
        uint256 replenishmentAmount;
        uint256 excessEarnings;
        uint256 grossRelease;
        uint256 protocolFee;
        uint256 partnerRelease;
    }

    function getTotalCollateral(uint256 baseCollateral, uint256 earningsBuffer, uint256 protocolBuffer)
        internal
        pure
        returns (uint256 totalCollateral)
    {
        return baseCollateral + earningsBuffer + protocolBuffer;
    }

    /**
     * @dev Initialize collateral info for an asset with explicit base/buffer amounts.
     * @param info Collateral info storage reference
     * @param baseAmount Base collateral amount (can be zero when buffers are funded first)
     * @param earningsBuffer Earnings buffer amount
     * @param protocolBuffer Protocol buffer amount
     */
    function initializeCollateralInfo(
        CollateralInfo storage info,
        uint256 baseAmount,
        uint256 earningsBuffer,
        uint256 protocolBuffer
    ) internal {
        if (isInitialized(info)) {
            revert CollateralAlreadyInitialized();
        }
        if (baseAmount == 0 && earningsBuffer == 0 && protocolBuffer == 0) {
            revert InvalidCollateralAmount();
        }

        info.unredeemedBasePrincipal = baseAmount;
        info.baseCollateral = baseAmount;
        info.earningsBuffer = earningsBuffer;
        info.protocolBuffer = protocolBuffer;
        info.isLocked = true;
        info.lockedAt = info.isLocked ? block.timestamp : 0;
        info.lastEventTimestamp = block.timestamp;
        info.reservedForLiquidation = 0;
        info.createdAt = block.timestamp;
        info.releasedProtectedBase = 0;
        info.releasedBaseCollateral = 0;
    }

    /**
     * @dev Calculate collateral requirements with separate buffer components
     * @param baseAmount Base amount used for buffer sizing
     * @param bufferTimeInterval Time interval for buffer calculations (e.g., 90 days)
     * @param yieldBP Yield in basis points (clamped to protocol minimum before calling)
     * @return baseAmountOut Base collateral amount (echo)
     * @return earningsBuffer Earnings buffer amount
     * @return protocolBuffer Protocol buffer amount
     * @return totalCollateral Total collateral requirement
     */
    function calculateCollateralRequirements(uint256 baseAmount, uint256 bufferTimeInterval, uint256 yieldBP)
        internal
        pure
        returns (uint256 baseAmountOut, uint256 earningsBuffer, uint256 protocolBuffer, uint256 totalCollateral)
    {
        baseAmountOut = baseAmount;
        // Calculate buffers for investor protection over the time interval
        earningsBuffer = EarningsLib.calculateEarnings(baseAmountOut, bufferTimeInterval, yieldBP);
        protocolBuffer = EarningsLib.calculateProtocolEarnings(baseAmountOut, bufferTimeInterval);

        // Total collateral is sum of base and buffers
        totalCollateral = baseAmountOut + earningsBuffer + protocolBuffer;
    }

    /**
     * @dev Check if collateral info is properly initialized
     * @param info Collateral info to check
     * @return True if initialized
     */
    function isInitialized(CollateralInfo storage info) internal view returns (bool) {
        return info.baseCollateral > 0 || info.earningsBuffer > 0 || info.protocolBuffer > 0;
    }

    /**
     * @dev Get collateral lock duration
     * @param info Collateral info storage reference
     * @return Duration in seconds since lock
     */
    function getLockDuration(CollateralInfo storage info) internal view returns (uint256) {
        if (!info.isLocked || info.lockedAt == 0) {
            return 0;
        }
        return block.timestamp - info.lockedAt;
    }

    /**
     * @dev Check if asset collateral is solvent
     * @param info Storage reference to collateral info
     * @return True if solvent (has buffer remaining OR no deficit)
     */
    function isSolvent(CollateralInfo storage info) internal view returns (bool) {
        return _isSolvent(info.earningsBuffer, info.reservedForLiquidation);
    }

    /**
     * @dev In-memory solvency check for preview/simulation paths.
     * @param info Memory copy of collateral info
     * @return True if solvent (has buffer remaining OR no deficit)
     */
    function isSolventMemory(CollateralInfo memory info) internal pure returns (bool) {
        return _isSolvent(info.earningsBuffer, info.reservedForLiquidation);
    }

    function _isSolvent(uint256 earningsBuffer, uint256 reservedForLiquidation) private pure returns (bool) {
        return earningsBuffer > 0 || reservedForLiquidation == 0;
    }

    /**
     * @dev Calculate linear base collateral release amount based on undepreciated outstanding principal and elapsed time.
     *      Depreciation is linear at 12% per year, prorated by time, and does not compound.
     *      Buffers are not considered here; caller is responsible for gating and buffer processing.
     */
    function calculateCollateralRelease(CollateralInfo memory info) internal view returns (uint256 releaseAmount) {
        return _calculateCollateralRelease(
            info.unredeemedBasePrincipal,
            info.baseCollateral,
            info.releasedBaseCollateral,
            info.earningsBuffer,
            info.reservedForLiquidation,
            info.lockedAt
        );
    }

    function _calculateCollateralRelease(
        uint256 unredeemedBasePrincipal,
        uint256 baseCollateral,
        uint256 releasedBaseCollateral,
        uint256 earningsBuffer,
        uint256 reservedForLiquidation,
        uint256 lockedAt
    ) private view returns (uint256 releaseAmount) {
        // Performance gate: Don't release base collateral if the protection buffer is empty
        // AND there is an outstanding deficit reserved for liquidation.
        if (earningsBuffer == 0 && reservedForLiquidation > 0) {
            return 0;
        }

        // Cumulative allowed release from outstanding undepreciated principal.
        uint256 elapsedSinceLock = block.timestamp - lockedAt;
        uint256 cumulativeAllowed = calculateDepreciation(unredeemedBasePrincipal, elapsedSinceLock);

        if (cumulativeAllowed <= releasedBaseCollateral) {
            return 0;
        }

        releaseAmount = cumulativeAllowed - releasedBaseCollateral;
        if (releaseAmount > baseCollateral) {
            releaseAmount = baseCollateral;
        }
    }

    /**
     * @dev Calculate depreciation based on time elapsed
     * @param baseAmount Base collateral amount
     * @param timeElapsed Time elapsed since last event
     * @return Depreciation amount
     */
    function calculateDepreciation(uint256 baseAmount, uint256 timeElapsed) internal pure returns (uint256) {
        return (baseAmount * ProtocolLib.DEPRECIATION_RATE_BP * timeElapsed)
            / (ProtocolLib.BP_PRECISION * ProtocolLib.YEARLY_INTERVAL);
    }

    /**
     * @dev Process earnings distribution and handle buffer replenishment/shortfall
     * @param info Collateral info storage reference
     * @param netEarnings Actual earnings received for the period
     * @param baseEarnings Expected base earnings for the period
     * @return earningsResult Positive: remaining excess earnings, Negative: shortfall amount, Zero: exact match
     * @return replenishmentAmount Amount replenished to earnings buffer from reserved funds
     */
    function processEarningsForBuffers(CollateralInfo storage info, uint256 netEarnings, uint256 baseEarnings)
        internal
        returns (int256 earningsResult, uint256 replenishmentAmount)
    {
        return processEarningsForBuffers(info, netEarnings, baseEarnings, info.unredeemedBasePrincipal);
    }

    function processEarningsForBuffers(
        CollateralInfo storage info,
        uint256 netEarnings,
        uint256 baseEarnings,
        uint256 benchmarkPrincipal
    ) internal returns (int256 earningsResult, uint256 replenishmentAmount) {
        // Handle shortfall (when netEarnings < baseEarnings)
        if (netEarnings < baseEarnings) {
            uint256 shortfallAmount = baseEarnings - netEarnings;

            if (info.earningsBuffer >= shortfallAmount) {
                // Earnings buffer can cover the shortfall
                info.earningsBuffer -= shortfallAmount;
                info.reservedForLiquidation += shortfallAmount;
            } else {
                // Earnings buffer can't fully cover shortfall
                info.reservedForLiquidation += info.earningsBuffer;
                info.earningsBuffer = 0;
            }
            // Return negative value to indicate shortfall
            return (-shortfallAmount.toInt256(), 0);
        }
        // Handle excess earnings (when netEarnings > baseEarnings)
        else if (netEarnings > baseEarnings) {
            uint256 excessEarnings = netEarnings - baseEarnings;

            // Calculate benchmark buffer amount (what buffer should be)
            (, uint256 benchmarkEarningsBuffer,,) = calculateCollateralRequirements(
                benchmarkPrincipal, ProtocolLib.QUARTERLY_INTERVAL, ProtocolLib.BENCHMARK_YIELD_BP
            );
            uint256 bufferDeficit =
                benchmarkEarningsBuffer > info.earningsBuffer ? benchmarkEarningsBuffer - info.earningsBuffer : 0;

            uint256 replenished = 0;
            if (info.reservedForLiquidation > 0) {
                // Replenish from reservedForLiquidation first
                uint256 toReplenish =
                    bufferDeficit < info.reservedForLiquidation ? bufferDeficit : info.reservedForLiquidation;
                toReplenish = toReplenish < excessEarnings ? toReplenish : excessEarnings;

                if (toReplenish > 0) {
                    info.earningsBuffer += toReplenish;
                    info.reservedForLiquidation -= toReplenish;
                    excessEarnings -= toReplenish;
                    replenished = toReplenish;
                }
            }

            // Return remaining excess earnings and replenishment amount
            return (excessEarnings.toInt256(), replenished);
        }

        // Perfect match: netEarnings == baseEarnings
        return (0, 0);
    }

    /**
     * @dev View-only/in-memory variant of processEarningsForBuffers.
     *      Mirrors buffer shortfall/replenishment math without mutating storage.
     * @param info Collateral info memory copy (will be mutated in-memory)
     * @param netEarnings Actual earnings received for the period
     * @param baseEarnings Expected base earnings for the period
     * @return earningsResult Positive: remaining excess earnings, Negative: shortfall amount, Zero: exact match
     * @return replenishmentAmount Amount replenished to earnings buffer from reserved funds
     */
    function processEarningsForBuffersInMemory(CollateralInfo memory info, uint256 netEarnings, uint256 baseEarnings)
        internal
        pure
        returns (int256 earningsResult, uint256 replenishmentAmount)
    {
        return processEarningsForBuffersInMemory(info, netEarnings, baseEarnings, info.unredeemedBasePrincipal);
    }

    function processEarningsForBuffersInMemory(
        CollateralInfo memory info,
        uint256 netEarnings,
        uint256 baseEarnings,
        uint256 benchmarkPrincipal
    ) internal pure returns (int256 earningsResult, uint256 replenishmentAmount) {
        // Handle shortfall (when netEarnings < baseEarnings)
        if (netEarnings < baseEarnings) {
            uint256 shortfallAmount = baseEarnings - netEarnings;

            if (info.earningsBuffer >= shortfallAmount) {
                info.earningsBuffer -= shortfallAmount;
                info.reservedForLiquidation += shortfallAmount;
            } else {
                info.reservedForLiquidation += info.earningsBuffer;
                info.earningsBuffer = 0;
            }

            return (-shortfallAmount.toInt256(), 0);
        } else if (netEarnings > baseEarnings) {
            uint256 excessEarnings = netEarnings - baseEarnings;

            (, uint256 benchmarkEarningsBuffer,,) = calculateCollateralRequirements(
                benchmarkPrincipal, ProtocolLib.QUARTERLY_INTERVAL, ProtocolLib.BENCHMARK_YIELD_BP
            );
            uint256 bufferDeficit =
                benchmarkEarningsBuffer > info.earningsBuffer ? benchmarkEarningsBuffer - info.earningsBuffer : 0;

            uint256 replenished = 0;
            if (info.reservedForLiquidation > 0) {
                uint256 toReplenish =
                    bufferDeficit < info.reservedForLiquidation ? bufferDeficit : info.reservedForLiquidation;
                toReplenish = toReplenish < excessEarnings ? toReplenish : excessEarnings;

                if (toReplenish > 0) {
                    info.earningsBuffer += toReplenish;
                    info.reservedForLiquidation -= toReplenish;
                    excessEarnings -= toReplenish;
                    replenished = toReplenish;
                }
            }

            return (excessEarnings.toInt256(), replenished);
        }

        return (0, 0);
    }

    function calculateReleaseFees(uint256 releaseAmount) internal pure returns (uint256 partnerRelease, uint256 fee) {
        fee = ProtocolLib.calculateProtocolFee(releaseAmount);
        if (fee > releaseAmount) {
            fee = releaseAmount;
        }
        partnerRelease = releaseAmount - fee;
    }

    function previewCollateralAfterMissedEarningsShortfall(CollateralInfo memory info, uint256 benchmarkEarnings)
        internal
        pure
        returns (CollateralInfo memory)
    {
        processEarningsForBuffersInMemory(info, 0, benchmarkEarnings);
        return info;
    }

    function applyRealizedVsBenchmarkToCollateral(
        CollateralInfo memory info,
        uint256 realizedEarnings,
        uint256 benchmarkEarnings
    )
        internal
        pure
        returns (
            CollateralInfo memory updated,
            uint256 shortfallAmount,
            uint256 replenishmentAmount,
            uint256 excessEarnings
        )
    {
        return applyRealizedVsBenchmarkToCollateral(
            info, realizedEarnings, benchmarkEarnings, info.unredeemedBasePrincipal
        );
    }

    function applyRealizedVsBenchmarkToCollateral(
        CollateralInfo memory info,
        uint256 realizedEarnings,
        uint256 benchmarkEarnings,
        uint256 benchmarkPrincipal
    )
        internal
        pure
        returns (
            CollateralInfo memory updated,
            uint256 shortfallAmount,
            uint256 replenishmentAmount,
            uint256 excessEarnings
        )
    {
        updated = info;

        if (realizedEarnings < benchmarkEarnings) {
            shortfallAmount = benchmarkEarnings - realizedEarnings;

            if (updated.earningsBuffer >= shortfallAmount) {
                updated.earningsBuffer -= shortfallAmount;
                updated.reservedForLiquidation += shortfallAmount;
            } else {
                updated.reservedForLiquidation += updated.earningsBuffer;
                updated.earningsBuffer = 0;
            }

            return (updated, shortfallAmount, 0, 0);
        }

        if (realizedEarnings > benchmarkEarnings) {
            excessEarnings = realizedEarnings - benchmarkEarnings;
            (, uint256 benchmarkEarningsBuffer,,) = calculateCollateralRequirements(
                benchmarkPrincipal, ProtocolLib.QUARTERLY_INTERVAL, ProtocolLib.BENCHMARK_YIELD_BP
            );
            uint256 bufferDeficit =
                benchmarkEarningsBuffer > updated.earningsBuffer ? benchmarkEarningsBuffer - updated.earningsBuffer : 0;

            if (updated.reservedForLiquidation > 0) {
                uint256 toReplenish =
                    bufferDeficit < updated.reservedForLiquidation ? bufferDeficit : updated.reservedForLiquidation;
                toReplenish = toReplenish < excessEarnings ? toReplenish : excessEarnings;

                if (toReplenish > 0) {
                    updated.earningsBuffer += toReplenish;
                    updated.reservedForLiquidation -= toReplenish;
                    replenishmentAmount = toReplenish;
                    excessEarnings -= toReplenish;
                }
            }
        }
    }

    function applyRealizedVsBenchmarkToCollateralInStorage(
        CollateralInfo storage info,
        uint256 realizedEarnings,
        uint256 benchmarkEarnings
    ) internal returns (uint256 shortfallAmount, uint256 replenishmentAmount, uint256 excessEarnings) {
        return applyRealizedVsBenchmarkToCollateralInStorage(
            info, realizedEarnings, benchmarkEarnings, info.unredeemedBasePrincipal
        );
    }

    function applyRealizedVsBenchmarkToCollateralInStorage(
        CollateralInfo storage info,
        uint256 realizedEarnings,
        uint256 benchmarkEarnings,
        uint256 benchmarkPrincipal
    ) internal returns (uint256 shortfallAmount, uint256 replenishmentAmount, uint256 excessEarnings) {
        (CollateralInfo memory updated, uint256 shortfall, uint256 replenishment, uint256 excess) =
            applyRealizedVsBenchmarkToCollateral(info, realizedEarnings, benchmarkEarnings, benchmarkPrincipal);

        info.earningsBuffer = updated.earningsBuffer;
        info.protocolBuffer = updated.protocolBuffer;
        info.reservedForLiquidation = updated.reservedForLiquidation;
        return (shortfall, replenishment, excess);
    }

    function calculateReleasePreview(
        CollateralInfo memory collateralInfo,
        bool assumeNewPeriod,
        bool earningsInitialized,
        uint256 currentPeriod,
        uint256 lastProcessedPeriod,
        uint256 realizedEarnings,
        uint256 benchmarkEarnings,
        uint256 coveredBaseCollateral
    ) internal view returns (ReleaseCalculation memory calc) {
        return calculateReleasePreview(
            collateralInfo,
            assumeNewPeriod,
            earningsInitialized,
            currentPeriod,
            lastProcessedPeriod,
            realizedEarnings,
            benchmarkEarnings,
            collateralInfo.unredeemedBasePrincipal,
            coveredBaseCollateral
        );
    }

    function calculateReleasePreview(
        CollateralInfo memory collateralInfo,
        bool assumeNewPeriod,
        bool earningsInitialized,
        uint256 currentPeriod,
        uint256 lastProcessedPeriod,
        uint256 realizedEarnings,
        uint256 benchmarkEarnings,
        uint256 benchmarkPrincipal,
        uint256 coveredBaseCollateral
    ) internal view returns (ReleaseCalculation memory calc) {
        if (!collateralInfo.isLocked) {
            calc.status = ReleaseEligibility.NoCollateralLocked;
            return calc;
        }

        calc.collateral = collateralInfo;

        if (!earningsInitialized || currentPeriod == 0) {
            if (!assumeNewPeriod) {
                calc.status = ReleaseEligibility.NoPriorEarnings;
                return calc;
            }

            calc.status = ReleaseEligibility.Eligible;
            calc.newLastProcessedPeriod = currentPeriod + 1;
            calc.grossRelease = calculateCollateralRelease(calc.collateral);
            if (calc.grossRelease > coveredBaseCollateral) {
                calc.grossRelease = coveredBaseCollateral;
            }
            if (calc.grossRelease > 0) {
                (calc.partnerRelease, calc.protocolFee) = calculateReleaseFees(calc.grossRelease);
            }
            return calc;
        }

        if (currentPeriod <= lastProcessedPeriod) {
            if (!assumeNewPeriod) {
                calc.status = ReleaseEligibility.NoNewEarningsPeriods;
                return calc;
            }

            calc.status = ReleaseEligibility.Eligible;
            calc.newLastProcessedPeriod = currentPeriod + 1;
            calc.grossRelease = calculateCollateralRelease(calc.collateral);
            if (calc.grossRelease > coveredBaseCollateral) {
                calc.grossRelease = coveredBaseCollateral;
            }
            if (calc.grossRelease > 0) {
                (calc.partnerRelease, calc.protocolFee) = calculateReleaseFees(calc.grossRelease);
            }
            return calc;
        }

        calc.status = ReleaseEligibility.Eligible;
        calc.newLastProcessedPeriod = currentPeriod;

        (calc.collateral, calc.shortfallAmount, calc.replenishmentAmount, calc.excessEarnings) =
            applyRealizedVsBenchmarkToCollateral(
                calc.collateral, realizedEarnings, benchmarkEarnings, benchmarkPrincipal
            );

        calc.grossRelease = calculateCollateralRelease(calc.collateral);
        if (calc.grossRelease > coveredBaseCollateral) {
            calc.grossRelease = coveredBaseCollateral;
        }
        uint256 totalCollateral = getTotalCollateral(
            calc.collateral.baseCollateral, calc.collateral.earningsBuffer, calc.collateral.protocolBuffer
        );
        if (calc.grossRelease > totalCollateral) {
            calc.grossRelease = totalCollateral;
        }
        if (calc.grossRelease > 0) {
            (calc.partnerRelease, calc.protocolFee) = calculateReleaseFees(calc.grossRelease);
        }
    }

    function calculateCoverableBaseCollateral(
        CollateralInfo memory collateralInfo,
        uint256 targetYieldBP,
        bool protectionEnabled,
        bool immediateProceeds
    ) internal pure returns (uint256 coverableBaseCollateral) {
        uint256 coverableExposure = calculateCoverableProtectedExposure(
            collateralInfo, targetYieldBP, protectionEnabled, immediateProceeds
        );
        if (coverableExposure == 0) {
            return 0;
        }

        if (immediateProceeds) {
            if (coverableExposure <= collateralInfo.releasedProtectedBase) {
                return 0;
            }
            coverableBaseCollateral = coverableExposure - collateralInfo.releasedProtectedBase;
        } else {
            coverableBaseCollateral = coverableExposure;
        }

        if (coverableBaseCollateral > collateralInfo.baseCollateral) {
            coverableBaseCollateral = collateralInfo.baseCollateral;
        }
    }

    function calculateCoverableProtectedExposure(
        CollateralInfo memory collateralInfo,
        uint256 targetYieldBP,
        bool protectionEnabled,
        bool immediateProceeds
    ) internal pure returns (uint256 coverableExposure) {
        uint256 protectedExposure = collateralInfo.baseCollateral;
        if (immediateProceeds) {
            protectedExposure += collateralInfo.releasedProtectedBase;
        }
        if (protectedExposure == 0) {
            return 0;
        }

        (, uint256 requiredEarningsBuffer, uint256 requiredProtocolBuffer,) =
            calculateCollateralRequirements(protectedExposure, ProtocolLib.QUARTERLY_INTERVAL, targetYieldBP);

        uint256 protocolCoverCapacity = requiredProtocolBuffer == 0
            ? type(uint256).max
            : Math.mulDiv(collateralInfo.protocolBuffer, protectedExposure, requiredProtocolBuffer);
        coverableExposure = protocolCoverCapacity;

        if (protectionEnabled) {
            uint256 protectionCoverCapacity = requiredEarningsBuffer == 0
                ? type(uint256).max
                : Math.mulDiv(collateralInfo.earningsBuffer, protectedExposure, requiredEarningsBuffer);
            coverableExposure = Math.min(coverableExposure, protectionCoverCapacity);
        }

        if (coverableExposure > protectedExposure) {
            coverableExposure = protectedExposure;
        }
    }

    function calculateBenchmarkEarningsPrincipal(
        CollateralInfo memory collateralInfo,
        uint256 targetYieldBP,
        bool protectionEnabled,
        bool immediateProceeds
    ) internal pure returns (uint256 benchmarkPrincipal) {
        if (!protectionEnabled) {
            return 0;
        }

        uint256 protectedExposure = collateralInfo.baseCollateral;
        if (immediateProceeds) {
            protectedExposure += collateralInfo.releasedProtectedBase;
        }
        if (protectedExposure == 0) {
            return 0;
        }

        (,, uint256 requiredProtocolBuffer,) =
            calculateCollateralRequirements(protectedExposure, ProtocolLib.QUARTERLY_INTERVAL, targetYieldBP);

        benchmarkPrincipal = requiredProtocolBuffer == 0
            ? protectedExposure
            : Math.mulDiv(collateralInfo.protocolBuffer, protectedExposure, requiredProtocolBuffer);

        if (benchmarkPrincipal > protectedExposure) {
            benchmarkPrincipal = protectedExposure;
        }
    }
}

/**
 * @dev Earnings distribution library for USDC-based earnings calculations
 * Contains pure calculation functions for earnings and benchmark tracking
 */
library EarningsLib {
    /**
     * @dev Earnings period information
     */
    struct EarningsPeriod {
        uint256 earningsPerToken; // USDC earnings per revenue token
        uint256 timestamp; // When earnings were distributed
        uint256 totalEarnings; // Total USDC distributed in this period
    }

    /**
     * @dev Vehicle earnings tracking information
     */
    struct EarningsInfo {
        uint256 totalRevenue; // Total reported revenue
        uint256 totalEarnings; // Total net USDC earnings distributed
        uint256 totalEarningsPerToken; // Cumulative USDC earnings per token across all periods
        uint256 currentPeriod; // Current earnings period number
        uint256 lastEventTimestamp; // Last collateral event timestamp
        uint256 lastProcessedPeriod; // Last period processed for collateral release
        uint256 cumulativeBenchmarkEarnings; // Cumulative benchmark earnings for investor protection
        uint256 cumulativeExcessEarnings; // Cumulative excess earnings for performance bonus calculations
        bool isInitialized; // Whether earnings tracking is initialized
        mapping(uint256 => EarningsPeriod) periods; // period => earnings data
        // Track last claimed period for each individual position
        mapping(address => mapping(uint256 => mapping(uint256 => uint256))) positionsLastClaimedPeriod; // holder => tokenId => positionId => lastClaimedPeriod
        // Settlement earnings snapshot - allows claiming earnings after tokens are burned
        mapping(address => uint256) settledEarningsSnapshot; // holder => unclaimed earnings at settlement
        mapping(address => bool) hasClaimedSettledEarnings; // holder => whether they claimed snapshot
    }

    /**
     * @dev Initialize earnings tracking for a vehicle
     * @param earningsInfo Storage reference to earnings info
     */
    function initializeEarningsInfo(EarningsInfo storage earningsInfo) internal {
        earningsInfo.totalRevenue = 0;
        earningsInfo.totalEarnings = 0;
        earningsInfo.totalEarningsPerToken = 0;
        earningsInfo.currentPeriod = 0;
        earningsInfo.lastEventTimestamp = block.timestamp;
        earningsInfo.lastProcessedPeriod = 0;
        earningsInfo.cumulativeBenchmarkEarnings = 0;
        earningsInfo.isInitialized = true;
    }

    /**
     * @dev Calculate earnings based on principal, time elapsed, and earnings rate
     * @param principal Base amount
     * @param timeElapsed Time elapsed in seconds
     * @param earningsBP Earnings rate in basis points
     * @return Earnings amount
     */
    function calculateEarnings(uint256 principal, uint256 timeElapsed, uint256 earningsBP)
        internal
        pure
        returns (uint256)
    {
        return (principal * timeElapsed * earningsBP) / (ProtocolLib.YEARLY_INTERVAL * ProtocolLib.BP_PRECISION);
    }

    /**
     * @dev Calculate benchmark earnings for investor protection
     * @param principal Base amount (revenue token price * total tokens)
     * @param timeElapsed Time elapsed in seconds
     * @return Benchmark earnings amount for investor safety
     */
    function calculateProtocolEarnings(uint256 principal, uint256 timeElapsed) internal pure returns (uint256) {
        return calculateEarnings(principal, timeElapsed, ProtocolLib.PROTOCOL_FEE_BP);
    }

    /**
     * @dev Calculate benchmark earnings for investor protection
     * @param principal Base amount (revenue token price * total tokens)
     * @param timeElapsed Time elapsed in seconds
     * @return Benchmark earnings amount for investor safety
     */
    function calculateBenchmarkEarnings(uint256 principal, uint256 timeElapsed) internal pure returns (uint256) {
        return calculateEarnings(principal, timeElapsed, ProtocolLib.BENCHMARK_YIELD_BP);
    }

    /**
     * @dev Get period number at specific timestamp
     * @param earningsInfo Storage reference to earnings info
     * @param timestamp Timestamp to find period for
     * @return period Period number at timestamp
     */
    function getPeriodAtTimestamp(EarningsInfo storage earningsInfo, uint256 timestamp)
        internal
        view
        returns (uint256 period)
    {
        period = earningsInfo.currentPeriod;
        while (period > 0 && earningsInfo.periods[period].timestamp > timestamp) {
            period--;
        }
        return period;
    }

    /**
     * @dev Calculate unclaimed earnings for a token holder
     * @param earningsInfo Storage reference to earnings info
     * @param tokenBalance Current token balance
     * @param lastClaimedPeriod Last period claimed by holder
     * @return unclaimedAmount Unclaimed USDC earnings
     */
    function calculateUnclaimedEarnings(
        EarningsInfo storage earningsInfo,
        uint256 tokenBalance,
        uint256 lastClaimedPeriod
    ) internal view returns (uint256 unclaimedAmount) {
        if (tokenBalance == 0 || earningsInfo.currentPeriod <= lastClaimedPeriod) {
            return 0;
        }

        // Sum earnings from all unclaimed periods
        for (uint256 i = lastClaimedPeriod + 1; i <= earningsInfo.currentPeriod; i++) {
            unclaimedAmount += earningsInfo.periods[i].earningsPerToken * tokenBalance;
        }

        return unclaimedAmount;
    }

    /**
     * @dev Calculate earnings for positions with per-position claim tracking
     * @param earningsInfo Storage reference to earnings info
     * @param holder Address of the token holder
     * @param positions Memory array of user's positions
     * @return totalEarnings Total claimable earnings
     */
    function calculateEarningsForPositions(
        EarningsInfo storage earningsInfo,
        address holder,
        TokenLib.TokenPosition[] memory positions
    ) internal view returns (uint256 totalEarnings) {
        for (uint256 i = 0; i < positions.length; i++) {
            TokenLib.TokenPosition memory position = positions[i];
            if (position.amount > 0) {
                uint256 lastClaimedPeriod =
                    earningsInfo.positionsLastClaimedPeriod[holder][position.tokenId][position.uid];
                uint256 endPeriod = position.soldAt > 0
                    ? getPeriodAtTimestamp(earningsInfo, position.soldAt)
                    : earningsInfo.currentPeriod;

                // Calculate unclaimed earnings for this position
                for (uint256 period = lastClaimedPeriod + 1; period <= endPeriod; period++) {
                    uint256 periodTimestamp = earningsInfo.periods[period].timestamp;
                    bool wasHeldDuringPeriod = position.acquiredAt <= periodTimestamp
                        && (position.soldAt == 0 || position.soldAt >= periodTimestamp);

                    if (wasHeldDuringPeriod) {
                        totalEarnings += earningsInfo.periods[period].earningsPerToken * position.amount;
                    }
                }
            }
        }
        return totalEarnings;
    }

    /**
     * @dev Update claim periods for all positions
     * @param earningsInfo Storage reference to earnings info
     * @param holder Address of the token holder
     * @param positions Memory array of user's positions
     */
    function updateClaimPeriods(
        EarningsInfo storage earningsInfo,
        address holder,
        TokenLib.TokenPosition[] memory positions
    ) internal {
        for (uint256 i = 0; i < positions.length; i++) {
            TokenLib.TokenPosition memory position = positions[i];
            earningsInfo.positionsLastClaimedPeriod[holder][position.tokenId][position.uid] = earningsInfo.currentPeriod;
        }
    }

    /**
     * @dev Snapshot a holder's unclaimed earnings at settlement time.
     * Called before tokens are burned so earnings can be claimed later.
     * @param earningsInfo Storage reference to earnings info
     * @param holder Address of the token holder
     * @param positions Memory array of user's positions (before burn)
     * @return snapshotAmount Amount of unclaimed earnings snapshotted
     */
    function snapshotHolderEarnings(
        EarningsInfo storage earningsInfo,
        address holder,
        TokenLib.TokenPosition[] memory positions
    ) internal returns (uint256 snapshotAmount) {
        // Calculate unclaimed earnings for all positions
        snapshotAmount = calculateEarningsForPositions(earningsInfo, holder, positions);

        // Accumulate snapshots so repeated pre-settlement burns cannot overwrite prior preserved earnings.
        earningsInfo.settledEarningsSnapshot[holder] += snapshotAmount;

        // Mark claim periods as updated (to prevent double claiming via positions)
        updateClaimPeriods(earningsInfo, holder, positions);

        return snapshotAmount;
    }

    function sumRealizedEarnings(
        EarningsInfo storage earningsInfo,
        uint256 fromPeriodExclusive,
        uint256 toPeriodInclusive
    ) internal view returns (uint256 realizedEarnings) {
        for (uint256 i = fromPeriodExclusive + 1; i <= toPeriodInclusive; i++) {
            realizedEarnings += earningsInfo.periods[i].totalEarnings;
        }
    }

    function previewSettledEarnings(EarningsInfo storage earningsInfo, address holder) internal view returns (uint256) {
        if (earningsInfo.hasClaimedSettledEarnings[holder]) {
            return 0;
        }
        return earningsInfo.settledEarningsSnapshot[holder];
    }

    function previewEarningsForHolder(
        EarningsInfo storage earningsInfo,
        address holder,
        TokenLib.TokenPosition[] memory positions
    ) internal view returns (uint256) {
        return calculateEarningsForPositions(earningsInfo, holder, positions);
    }

    /**
     * @dev Claim settled earnings from snapshot and mark as claimed.
     * @param earningsInfo Storage reference to earnings info
     * @param holder Address of the token holder
     * @return claimedAmount Amount of earnings claimed from snapshot
     */
    function claimSettledEarnings(EarningsInfo storage earningsInfo, address holder)
        internal
        returns (uint256 claimedAmount)
    {
        // Get snapshot and verify not already claimed
        claimedAmount = earningsInfo.settledEarningsSnapshot[holder];
        bool hasClaimed = earningsInfo.hasClaimedSettledEarnings[holder];

        if (claimedAmount > 0 && !hasClaimed) {
            // Mark as claimed
            earningsInfo.hasClaimedSettledEarnings[holder] = true;
            return claimedAmount;
        }

        return 0;
    }
}
