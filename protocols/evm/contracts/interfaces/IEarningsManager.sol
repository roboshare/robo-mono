// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IEarningsManager
 * @dev Interface for the EarningsManager contract
 */
interface IEarningsManager {
    event EarningsDistributed(
        uint256 indexed assetId, address indexed partner, uint256 totalRevenue, uint256 investorEarnings, uint256 period
    );
    event EarningsClaimed(uint256 indexed assetId, address indexed holder, uint256 amount);
    event TreasuryUpdated(address indexed oldAddress, address indexed newAddress);
    event RouterUpdated(address indexed oldAddress, address indexed newAddress);
    event PositionManagerUpdated(address indexed oldAddress, address indexed newAddress);
    event PartnerManagerUpdated(address indexed oldAddress, address indexed newAddress);
    event RoboshareTokensUpdated(address indexed oldAddress, address indexed newAddress);
    event UsdcUpdated(address indexed oldAddress, address indexed newAddress);

    struct EarningsSummary {
        bool isInitialized;
        uint256 currentPeriod;
        uint256 lastEventTimestamp;
        uint256 lastProcessedPeriod;
        uint256 cumulativeBenchmarkEarnings;
        uint256 cumulativeExcessEarnings;
    }

    function assetEarnings(uint256 assetId)
        external
        view
        returns (
            uint256 totalRevenue,
            uint256 totalEarnings,
            uint256 totalEarningsPerToken,
            uint256 currentPeriod,
            uint256 lastEventTimestamp,
            uint256 lastProcessedPeriod,
            uint256 cumulativeBenchmarkEarnings,
            uint256 cumulativeExcessEarnings,
            bool isInitialized
        );

    function distributeEarnings(uint256 assetId, uint256 totalRevenue, bool tryAutoRelease)
        external
        returns (uint256 collateralReleased);

    function previewDistributeEarnings(address partner, uint256 assetId, uint256 totalRevenue, bool tryAutoRelease)
        external
        view
        returns (uint256 investorAmount, uint256 protocolFee, uint256 netEarnings, uint256 collateralReleased);

    function claimEarnings(uint256 assetId) external;

    function previewClaimEarnings(uint256 assetId, address holder) external view returns (uint256);

    function snapshotAndClaimEarnings(uint256 assetId, address holder, bool autoClaim)
        external
        returns (uint256 snapshotAmount);

    function transferPositionClaimState(
        uint256 assetId,
        address from,
        address to,
        uint256 tokenId,
        uint256 fromPositionUid,
        uint256 toPositionUid
    ) external;

    function getAssetEarningsSummary(uint256 assetId) external view returns (EarningsSummary memory);

    function sumRealizedEarnings(uint256 assetId, uint256 fromPeriodExclusive, uint256 toPeriodInclusive)
        external
        view
        returns (uint256 realizedEarnings);

    function initializeLastEventTimestampIfUnset(uint256 assetId) external;

    function recordReleaseProcessing(uint256 assetId, uint256 newLastProcessedPeriod, uint256 excessEarnings) external;

    function syncLastEventTimestamp(uint256 assetId) external;

    function updateTreasury(address _treasury) external;
    function updateRouter(address _router) external;
    function updatePartnerManager(address _partnerManager) external;
    function updateRoboshareTokens(address _roboshareTokens) external;
    function updateUSDC(address _usdc) external;
}
