// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { AssetLib } from "../Libraries.sol";

/**
 * @title ITreasury
 * @dev Interface for the Treasury contract
 */
interface ITreasury {
    /**
     * @dev Events for cross-contract communication and indexing.
     * Ordered to match Treasury execution flow: collateral, earnings/settlement, then admin updates.
     */
    event CollateralLocked(uint256 indexed assetId, address indexed partner, uint256 amount);
    event BaseLiquidityCredited(uint256 indexed assetId, uint256 amount);
    event CollateralReleased(uint256 indexed assetId, address indexed recipient, uint256 amount);
    event WithdrawalProcessed(address indexed recipient, uint256 amount);
    event ShortfallReserved(uint256 indexed assetId, uint256 amount);
    event BufferReplenished(uint256 indexed assetId, uint256 amount, uint256 fromReserved);
    event CollateralBuffersUpdated(
        uint256 indexed assetId, uint256 newEarningsBuffer, uint256 newReservedForLiquidation
    );
    event ImmediateProceedsReleased(uint256 indexed assetId, address indexed partner, uint256 amount);
    event SettlementClaimed(uint256 indexed assetId, address indexed holder, uint256 amount);
    event EarningsManagerUpdated(address indexed oldAddress, address indexed newAddress);
    event PartnerManagerUpdated(address indexed oldAddress, address indexed newAddress);
    event UsdcUpdated(address indexed oldAddress, address indexed newAddress);
    event RoboshareTokensUpdated(address indexed oldAddress, address indexed newAddress);
    event RouterUpdated(address indexed newRouter);
    event TreasuryFeeRecipientUpdated(address indexed oldAddress, address indexed newAddress);

    /**
     * @dev Shared errors ordered by the main Treasury execution paths.
     */
    error AssetNotFound();
    error NotAssetOwner();
    error NoCollateralLocked();
    error OutstandingRevenueTokens();
    error NoPendingWithdrawals();
    error InvalidEarningsAmount();
    error AssetNotActive(uint256 assetId, AssetLib.AssetStatus currentStatus);
    error AssetNotOperational(uint256 assetId, AssetLib.AssetStatus status);
    error NoInvestors();
    error EarningsLessThanMinimumFee();
    error NoEarningsToClaim();
    error NoPriorEarningsDistribution();
    error NoNewEarningsPeriods();
    error NoEarningsToDistribute();
    error NoUnclaimedEarnings();
    error InsufficientTokenBalance();
    error NoRedeemablePrimarySupply();
    error InsufficientPrimaryLiquidity();
    error SlippageExceeded();
    error EarningsManagerNotSet();
    error AssetNotSettled(uint256 assetId, AssetLib.AssetStatus currentStatus);
    error AssetNotOperationalForSettlement(uint256 assetId, AssetLib.AssetStatus currentStatus);
    error AssetNotOperationalForLiquidation(uint256 assetId, AssetLib.AssetStatus currentStatus);
    error AssetNotEligibleForLiquidation(uint256 assetId);
    error InsufficientSettlementTopUp(uint256 assetId, uint256 requiredAmount, uint256 providedAmount);
    error CollateralAlreadyLocked();
    error InsufficientCollateral();
    error NotRouter();

    /**
     * @notice Returns the current stored collateral accounting for an asset.
     * @param assetId Asset whose collateral snapshot should be returned
     * @return unredeemedBasePrincipal Undepreciated principal represented by currently outstanding revenue tokens
     * @return baseCollateral Current base collateral still backing investors
     * @return earningsBuffer Current earnings buffer balance
     * @return protocolBuffer Current protocol buffer balance
     * @return isLocked Whether collateral is currently locked for the asset
     * @return lockedAt Timestamp when collateral locking began
     * @return lastEventTimestamp Last collateral-side accounting timestamp
     * @return reservedForLiquidation Amount reserved to cover missed-earnings shortfall
     * @return createdAt Collateral record creation timestamp
     * @return releasedProtectedBase Protected base amount already released as immediate proceeds
     * @return releasedBaseCollateral Base collateral cumulatively released through depreciation flows
     */
    function assetCollateral(uint256 assetId)
        external
        view
        returns (
            uint256 unredeemedBasePrincipal,
            uint256 baseCollateral,
            uint256 earningsBuffer,
            uint256 protocolBuffer,
            bool isLocked,
            uint256 lockedAt,
            uint256 lastEventTimestamp,
            uint256 reservedForLiquidation,
            uint256 createdAt,
            uint256 releasedProtectedBase,
            uint256 releasedBaseCollateral
        );

    /**
     * @notice Settles a primary-pool purchase into treasury accounting and mints the purchased revenue tokens.
     * @param buyer Recipient of the purchased revenue tokens
     * @param tokenId Revenue token being purchased
     * @param amount Quantity of revenue tokens purchased
     * @param partner Asset owner for the purchased pool
     * @param principal Investor principal portion of the purchase, excluding protocol fee
     * @param protocolFee Protocol fee accrued on the purchase
     */
    function processPrimaryPoolPurchaseFor(
        address buyer,
        uint256 tokenId,
        uint256 amount,
        address partner,
        uint256 principal,
        uint256 protocolFee
    ) external;

    /**
     * @notice Processes a primary redemption by burning eligible revenue tokens and paying out base collateral.
     * @param holder Revenue-token holder redeeming from the primary pool
     * @param tokenId Revenue token whose current primary-redemption epoch is being redeemed against
     * @param burnAmount Amount of redemption-eligible revenue tokens to burn
     * @param minPayout Minimum acceptable payout used for slippage protection
     * @return payout USDC transferred directly to `holder`
     */
    function processPrimaryRedemptionFor(address holder, uint256 tokenId, uint256 burnAmount, uint256 minPayout)
        external
        returns (uint256 payout);

    /**
     * @notice Locks any currently required partner buffers for an asset and enables proceeds.
     * @param assetId Asset whose current collateral requirements should be funded
     */
    function enableProceeds(uint256 assetId) external;

    /**
     * @notice Credits claimable earnings to an account on behalf of the earnings manager.
     * @param account Account whose pending-withdrawal balance should increase
     * @param amount Amount of earnings to credit
     */
    function creditEarningsWithdrawal(address account, uint256 amount) external;

    /**
     * @notice Applies treasury-side side effects of an earnings distribution.
     * @param partner Asset owner credited with any released collateral
     * @param assetId Asset whose earnings distribution is being settled
     * @param investorAmount Gross investor earnings amount deposited into treasury
     * @param protocolFee Fee amount accrued to the treasury fee recipient
     * @param tryAutoRelease Whether to attempt collateral auto-release instead of skipping silently
     * @return collateralReleased Partner-facing collateral amount released during auto-release
     */
    function processEarningsDistributionEffects(
        address partner,
        uint256 assetId,
        uint256 investorAmount,
        uint256 protocolFee,
        bool tryAutoRelease
    ) external returns (uint256 collateralReleased);

    /**
     * @notice Previews how much collateral would be released if a release were attempted now.
     * @param assetId Asset to inspect
     * @param pendingNetEarnings Net investor earnings to simulate as a pending new period. Pass 0 to use only current state
     * @return releasedAmount Estimated partner-facing release amount after protocol fee
     */
    function previewCollateralRelease(uint256 assetId, uint256 pendingNetEarnings)
        external
        view
        returns (uint256 releasedAmount);

    /**
     * @notice Manually releases the currently eligible portion of collateral for an earning asset.
     * @param assetId Asset whose collateral release should be processed
     */
    function releasePartialCollateral(uint256 assetId) external;

    /**
     * @notice Releases all remaining collateral for an asset once no revenue tokens remain outstanding.
     * @param assetId Asset whose collateral should be cleared
     */
    function releaseCollateral(uint256 assetId) external;

    /**
     * @notice Releases any locked collateral for an asset on behalf of the router-controlled retirement flow.
     * @param partner Recipient credited with the released collateral
     * @param assetId Asset whose collateral should be cleared
     * @return releasedCollateral Total collateral moved into `partner`'s pending withdrawals
     */
    function releaseCollateralFor(address partner, uint256 assetId) external returns (uint256 releasedCollateral);

    /**
     * @notice Credits an account with a new pending withdrawal balance.
     * @param recipient Account whose pending withdrawal balance should increase
     * @param amount Amount of USDC to credit
     */
    function recordPendingWithdrawalFor(address recipient, uint256 amount) external;

    /**
     * @notice Withdraws the caller's full pending-withdrawal balance.
     */
    function processWithdrawal() external;

    /**
     * @notice Returns whether an asset is solvent using currently stored collateral state.
     * @dev This does not simulate missed-shortfall accrual for elapsed time since the last earnings event.
     * @param assetId Asset to inspect
     * @return True when the asset is not settled and current stored collateral is solvent
     */
    function isAssetSolvent(uint256 assetId) external view returns (bool);

    /**
     * @notice Previews whether an asset is currently eligible for liquidation using simulated missed-shortfall accrual.
     * @param assetId Asset to inspect
     * @return eligible True if liquidation would be allowed
     * @return reason Encoded reason: 0=EligibleByMaturity, 1=EligibleByInsolvency, 2=AlreadySettled, 3=NotEligible
     */
    function previewLiquidationEligibility(uint256 assetId) external view returns (bool eligible, uint8 reason);

    /**
     * @notice Forces liquidation for an eligible asset and computes the settlement pool for holders.
     * @param assetId Asset to liquidate
     * @return liquidationAmount Total USDC placed into the liquidation settlement pool
     * @return settlementPerToken Integer per-token settlement rate recorded in the manager for later claims
     */
    function executeLiquidation(uint256 assetId)
        external
        returns (uint256 liquidationAmount, uint256 settlementPerToken);

    /**
     * @notice Previews the current claimable settlement amount for a holder.
     * @param assetId Settled asset to inspect
     * @param holder Account to preview for
     * @return Amount of USDC currently claimable through the settlement flow
     */
    function previewSettlementClaim(uint256 assetId, address holder) external view returns (uint256);

    /**
     * @notice Previews the minimum additional USDC a partner must contribute for voluntary early settlement.
     * @dev Non-immediate-proceeds pools and matured assets return zero.
     * @param assetId Asset to inspect
     * @return Amount of USDC required before `initiateSettlement` can proceed
     */
    function previewRequiredSettlementTopUp(uint256 assetId) external view returns (uint256);

    /**
     * @notice Settles an asset through the voluntary settlement path.
     * @param partner Asset owner responsible for any settlement top-up and recipient of any partner refund
     * @param assetId Asset being voluntarily settled
     * @param topUpAmount Additional USDC contributed by the partner before settlement
     * @return settlementAmount Total USDC made available to token holders through settlement
     * @return settlementPerToken Integer per-token settlement rate recorded in the manager for later claims
     */
    function initiateSettlement(address partner, uint256 assetId, uint256 topUpAmount)
        external
        returns (uint256 settlementAmount, uint256 settlementPerToken);

    /**
     * @notice Records a settlement claim for a holder after the router burns the claimed tokens.
     * @param recipient Holder receiving the settlement claim
     * @param assetId Settled asset being claimed against
     * @param amount Amount of revenue tokens burned for settlement
     * @return claimedAmount USDC credited to `recipient`
     */
    function processSettlementClaimFor(address recipient, uint256 assetId, uint256 amount)
        external
        returns (uint256 claimedAmount);

    /**
     * @notice Returns the current treasury fee recipient.
     */
    function treasuryFeeRecipient() external view returns (address);

    /**
     * @notice Sets the earnings-manager dependency and its authorized role.
     * @param _earningsManager Address of the earnings manager contract
     */
    function setEarningsManager(address _earningsManager) external;

    /**
     * @notice Updates the partner-manager dependency.
     * @param _partnerManager New partner-manager address
     */
    function updatePartnerManager(address _partnerManager) external;

    /**
     * @notice Updates the revenue-token contract dependency.
     * @param _roboshareTokens New RoboshareTokens address
     */
    function updateRoboshareTokens(address _roboshareTokens) external;

    /**
     * @notice Updates the registry router and refreshes its authorized role.
     * @param _newRouter Address of the new router contract
     */
    function updateRouter(address _newRouter) external;

    /**
     * @notice Updates the settlement token reference after validating USDC compatibility.
     * @param _usdc New USDC-compatible token address
     */
    function updateUSDC(address _usdc) external;

    /**
     * @notice Updates the recipient for treasury-accrued protocol fees.
     * @param _treasuryFeeRecipient New fee-recipient address
     */
    function updateTreasuryFeeRecipient(address _treasuryFeeRecipient) external;
}
