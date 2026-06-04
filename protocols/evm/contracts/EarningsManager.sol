// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IEarningsManager } from "./interfaces/IEarningsManager.sol";
import { IPositionManager } from "./interfaces/IPositionManager.sol";
import { ITreasury } from "./interfaces/ITreasury.sol";
import { ProtocolLib, TokenLib, EarningsLib, AssetLib } from "./Libraries.sol";
import { RoboshareTokens } from "./RoboshareTokens.sol";
import { PartnerManager } from "./PartnerManager.sol";
import { RegistryRouter } from "./RegistryRouter.sol";

contract EarningsManager is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    IEarningsManager
{
    using EarningsLib for EarningsLib.EarningsInfo;
    using SafeERC20 for IERC20;

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant AUTHORIZED_CONTRACT_ROLE = keccak256("AUTHORIZED_CONTRACT_ROLE");

    RoboshareTokens public roboshareTokens;
    PartnerManager public partnerManager;
    RegistryRouter public router;
    ITreasury public treasury;
    IERC20 public usdc;

    mapping(uint256 => EarningsLib.EarningsInfo) private _assetEarnings;

    error ZeroAddress();
    error UnauthorizedPositionManager(address caller, address activeManager);

    constructor() {
        _disableInitializers();
    }

    modifier onlyAuthorizedAssetOwner(uint256 assetId) {
        _onlyAuthorizedAssetOwner(assetId);
        _;
    }

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
        _grantRole(AUTHORIZED_CONTRACT_ROLE, _treasury);
        _grantRole(AUTHORIZED_CONTRACT_ROLE, _router);

        roboshareTokens = RoboshareTokens(_roboshareTokens);
        partnerManager = PartnerManager(_partnerManager);
        router = RegistryRouter(_router);
        treasury = ITreasury(_treasury);
        usdc = IERC20(_usdc);
    }

    function _requireAssetExists(uint256 assetId) internal view {
        if (!router.assetExists(assetId)) {
            revert ITreasury.AssetNotFound();
        }
    }

    function _requireAuthorizedAssetOwner(address partner, uint256 assetId) internal view {
        if (!partnerManager.isAuthorizedPartner(partner)) {
            revert PartnerManager.UnauthorizedPartner();
        }
        if (roboshareTokens.balanceOf(partner, assetId) == 0) {
            revert ITreasury.NotAssetOwner();
        }
    }

    function _onlyAuthorizedAssetOwner(uint256 assetId) internal view {
        _requireAssetExists(assetId);
        _requireAuthorizedAssetOwner(msg.sender, assetId);
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
        )
    {
        EarningsLib.EarningsInfo storage earningsInfo = _assetEarnings[assetId];
        return (
            earningsInfo.totalRevenue,
            earningsInfo.totalEarnings,
            earningsInfo.totalEarningsPerToken,
            earningsInfo.currentPeriod,
            earningsInfo.lastEventTimestamp,
            earningsInfo.lastProcessedPeriod,
            earningsInfo.cumulativeBenchmarkEarnings,
            earningsInfo.cumulativeExcessEarnings,
            earningsInfo.isInitialized
        );
    }

    function getAssetEarningsSummary(uint256 assetId) external view returns (EarningsSummary memory summary) {
        EarningsLib.EarningsInfo storage earningsInfo = _assetEarnings[assetId];
        summary = EarningsSummary({
            isInitialized: earningsInfo.isInitialized,
            currentPeriod: earningsInfo.currentPeriod,
            lastEventTimestamp: earningsInfo.lastEventTimestamp,
            lastProcessedPeriod: earningsInfo.lastProcessedPeriod,
            cumulativeBenchmarkEarnings: earningsInfo.cumulativeBenchmarkEarnings,
            cumulativeExcessEarnings: earningsInfo.cumulativeExcessEarnings
        });
    }

    function sumRealizedEarnings(uint256 assetId, uint256 fromPeriodExclusive, uint256 toPeriodInclusive)
        external
        view
        returns (uint256 realizedEarnings)
    {
        return EarningsLib.sumRealizedEarnings(_assetEarnings[assetId], fromPeriodExclusive, toPeriodInclusive);
    }

    function previewDistributeEarnings(address partner, uint256 assetId, uint256 totalRevenue, bool tryAutoRelease)
        external
        view
        returns (uint256 investorAmount, uint256 protocolFee, uint256 netEarnings, uint256 collateralReleased)
    {
        _requireAssetExists(assetId);
        _requireAuthorizedAssetOwner(partner, assetId);

        if (totalRevenue == 0) {
            return (0, 0, 0, 0);
        }

        AssetLib.AssetStatus status = router.getAssetStatus(assetId);
        if (status != AssetLib.AssetStatus.Earning) {
            return (0, 0, 0, 0);
        }

        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        uint256 tokenTotalSupply = roboshareTokens.getRevenueTokenSupply(revenueTokenId);
        uint256 partnerTokenBalance = roboshareTokens.balanceOf(partner, revenueTokenId);
        if (partnerTokenBalance >= tokenTotalSupply) {
            return (0, 0, 0, 0);
        }

        uint256 investorSupply;
        unchecked {
            investorSupply = tokenTotalSupply - partnerTokenBalance;
        }

        (investorAmount, protocolFee, netEarnings) =
            _getDistributionAmounts(revenueTokenId, investorSupply, totalRevenue);
        if (investorAmount < ProtocolLib.MIN_PROTOCOL_FEE) {
            return (investorAmount, 0, 0, 0);
        }

        if (tryAutoRelease) {
            collateralReleased = treasury.previewCollateralRelease(assetId, netEarnings);
        }
    }

    function initializeLastEventTimestampIfUnset(uint256 assetId) external onlyRole(AUTHORIZED_CONTRACT_ROLE) {
        EarningsLib.EarningsInfo storage earningsInfo = _assetEarnings[assetId];
        if (earningsInfo.lastEventTimestamp == 0) {
            earningsInfo.lastEventTimestamp = block.timestamp;
        }
    }

    function recordReleaseProcessing(uint256 assetId, uint256 newLastProcessedPeriod, uint256 excessEarnings)
        external
        onlyRole(AUTHORIZED_CONTRACT_ROLE)
    {
        EarningsLib.EarningsInfo storage earningsInfo = _assetEarnings[assetId];
        if (excessEarnings > 0) {
            earningsInfo.cumulativeExcessEarnings += excessEarnings;
        }
        earningsInfo.lastEventTimestamp = block.timestamp;
        earningsInfo.lastProcessedPeriod = newLastProcessedPeriod;
    }

    function syncLastEventTimestamp(uint256 assetId) external onlyRole(AUTHORIZED_CONTRACT_ROLE) {
        _assetEarnings[assetId].lastEventTimestamp = block.timestamp;
    }

    function distributeEarnings(uint256 assetId, uint256 totalRevenue, bool tryAutoRelease)
        external
        onlyAuthorizedAssetOwner(assetId)
        nonReentrant
        returns (uint256 collateralReleased)
    {
        if (totalRevenue == 0) revert ITreasury.InvalidEarningsAmount();

        AssetLib.AssetStatus status = router.getAssetStatus(assetId);
        if (status != AssetLib.AssetStatus.Earning) {
            revert ITreasury.AssetNotActive(assetId, status);
        }

        uint256 investorSupply;
        uint256 investorAmount;
        uint256 protocolFee;
        uint256 netEarnings;
        {
            uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
            uint256 tokenTotalSupply = roboshareTokens.getRevenueTokenSupply(revenueTokenId);
            uint256 partnerTokenBalance = roboshareTokens.balanceOf(msg.sender, revenueTokenId);
            if (partnerTokenBalance >= tokenTotalSupply) {
                revert ITreasury.NoInvestors();
            }

            unchecked {
                investorSupply = tokenTotalSupply - partnerTokenBalance;
            }

            (investorAmount, protocolFee, netEarnings) =
                _getDistributionAmounts(revenueTokenId, investorSupply, totalRevenue);
        }

        if (investorAmount < ProtocolLib.MIN_PROTOCOL_FEE) {
            revert ITreasury.EarningsLessThanMinimumFee();
        }

        usdc.safeTransferFrom(msg.sender, address(treasury), investorAmount);
        _recordDistribution(assetId, totalRevenue, netEarnings, investorSupply);

        collateralReleased = treasury.processEarningsDistributionEffects(
            msg.sender, assetId, investorAmount, protocolFee, tryAutoRelease
        );
    }

    function _getDistributionAmounts(uint256 revenueTokenId, uint256 investorSupply, uint256 totalRevenue)
        internal
        view
        returns (uint256 investorAmount, uint256 protocolFee, uint256 netEarnings)
    {
        investorAmount = _calculateInvestorAmount(revenueTokenId, investorSupply, totalRevenue);
        if (investorAmount < ProtocolLib.MIN_PROTOCOL_FEE) {
            return (investorAmount, 0, 0);
        }

        protocolFee = ProtocolLib.calculateProtocolFee(investorAmount);
        netEarnings = investorAmount - protocolFee;
    }

    function _calculateInvestorAmount(uint256 revenueTokenId, uint256 investorSupply, uint256 totalRevenue)
        internal
        view
        returns (uint256 investorAmount)
    {
        uint256 cap =
            (totalRevenue * roboshareTokens.getRevenueShareBP(revenueTokenId)) / ProtocolLib.BP_PRECISION;
        investorAmount = (totalRevenue * investorSupply) / roboshareTokens.getRevenueTokenMaxSupply(revenueTokenId);
        if (investorAmount > cap) {
            investorAmount = cap;
        }
    }

    function _recordDistribution(uint256 assetId, uint256 totalRevenue, uint256 netEarnings, uint256 investorSupply)
        internal
    {
        EarningsLib.EarningsInfo storage earningsInfo = _assetEarnings[assetId];
        if (!earningsInfo.isInitialized) {
            EarningsLib.initializeEarningsInfo(earningsInfo);
        }

        uint256 earningsPerToken = netEarnings / investorSupply;
        unchecked {
            earningsInfo.totalRevenue += totalRevenue;
            earningsInfo.totalEarnings += netEarnings;
            earningsInfo.totalEarningsPerToken += earningsPerToken;
            earningsInfo.currentPeriod++;
        }

        uint256 currentPeriod = earningsInfo.currentPeriod;
        earningsInfo.periods[currentPeriod] = EarningsLib.EarningsPeriod({
            earningsPerToken: earningsPerToken, timestamp: block.timestamp, totalEarnings: netEarnings
        });
        earningsInfo.lastEventTimestamp = block.timestamp;

        emit EarningsDistributed(assetId, msg.sender, totalRevenue, netEarnings, currentPeriod);
    }

    function _positionManager() internal view returns (IPositionManager manager) {
        manager = roboshareTokens.positionManager();
        if (address(manager) == address(0)) {
            revert RoboshareTokens.PositionManagerNotSet();
        }
    }

    modifier onlyActivePositionManager() {
        _onlyActivePositionManager();
        _;
    }

    function _onlyActivePositionManager() internal view {
        IPositionManager activeManager = _positionManager();
        if (msg.sender != address(activeManager)) {
            revert UnauthorizedPositionManager(msg.sender, address(activeManager));
        }
    }

    function _getRevenuePositions(uint256 revenueTokenId, address holder)
        internal
        view
        returns (TokenLib.TokenPosition[] memory positions)
    {
        positions = _positionManager().getUserPositions(revenueTokenId, holder);
    }

    function claimEarnings(uint256 assetId) external nonReentrant {
        uint256 claimedAmount = _claimEarningsFor(msg.sender, assetId);
        if (claimedAmount == 0) {
            revert ITreasury.NoEarningsToClaim();
        }
        treasury.creditEarningsWithdrawal(msg.sender, claimedAmount);
        emit EarningsClaimed(assetId, msg.sender, claimedAmount);
    }

    function previewClaimEarnings(uint256 assetId, address holder) external view returns (uint256) {
        if (!router.assetExists(assetId)) {
            revert ITreasury.AssetNotFound();
        }

        EarningsLib.EarningsInfo storage earningsInfo = _assetEarnings[assetId];
        if (!earningsInfo.isInitialized || earningsInfo.currentPeriod == 0) {
            return 0;
        }

        uint256 transferredCredit = earningsInfo.transferredEarningsCredit[holder];

        AssetLib.AssetStatus status = router.getAssetStatus(assetId);
        bool isSettled = status == AssetLib.AssetStatus.Retired || status == AssetLib.AssetStatus.Expired;
        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);

        if (isSettled) {
            uint256 totalPreview = EarningsLib.previewSettledEarnings(earningsInfo, holder) + transferredCredit;
            if (
                roboshareTokens.balanceOf(holder, assetId) == 0 && roboshareTokens.balanceOf(holder, revenueTokenId) > 0
            ) {
                TokenLib.TokenPosition[] memory settledPositions = _getRevenuePositions(revenueTokenId, holder);
                totalPreview += EarningsLib.previewEarningsForHolder(earningsInfo, holder, settledPositions);
            }
            return totalPreview;
        }

        if (roboshareTokens.balanceOf(holder, assetId) > 0) {
            return transferredCredit;
        }

        if (roboshareTokens.balanceOf(holder, revenueTokenId) == 0) {
            return transferredCredit;
        }

        TokenLib.TokenPosition[] memory positions = _getRevenuePositions(revenueTokenId, holder);
        return transferredCredit + EarningsLib.previewEarningsForHolder(earningsInfo, holder, positions);
    }

    function snapshotAndClaimEarnings(uint256 assetId, address holder, bool autoClaim)
        external
        onlyRole(AUTHORIZED_CONTRACT_ROLE)
        returns (uint256 snapshotAmount)
    {
        EarningsLib.EarningsInfo storage earningsInfo = _assetEarnings[assetId];
        if (!earningsInfo.isInitialized || earningsInfo.currentPeriod == 0) {
            return 0;
        }

        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);
        TokenLib.TokenPosition[] memory positions = _getRevenuePositions(revenueTokenId, holder);
        snapshotAmount = EarningsLib.snapshotHolderEarnings(earningsInfo, holder, positions);

        if (autoClaim) {
            uint256 transferredCredit = earningsInfo.transferredEarningsCredit[holder];
            if (transferredCredit > 0) {
                earningsInfo.transferredEarningsCredit[holder] = 0;
                snapshotAmount += transferredCredit;
            }
        }

        if (autoClaim && snapshotAmount > 0) {
            earningsInfo.hasClaimedSettledEarnings[holder] = true;
            treasury.creditEarningsWithdrawal(holder, snapshotAmount);
            emit EarningsClaimed(assetId, holder, snapshotAmount);
        }
    }

    function transferPositionClaimState(
        uint256 assetId,
        address from,
        address to,
        uint256 tokenId,
        uint256 fromPositionUid,
        uint256 toPositionUid
    ) external onlyActivePositionManager {
        EarningsLib.EarningsInfo storage earningsInfo = _assetEarnings[assetId];
        uint256 senderLastClaimed = earningsInfo.positionsLastClaimedPeriod[from][tokenId][fromPositionUid];
        uint256 recipientLastClaimed = earningsInfo.positionsLastClaimedPeriod[to][tokenId][toPositionUid];

        uint256 baseline = senderLastClaimed > recipientLastClaimed ? senderLastClaimed : recipientLastClaimed;
        uint256 cutoffPeriod = EarningsLib.getPeriodAtTimestamp(earningsInfo, block.timestamp);
        uint256 updatedLastClaimed = baseline > cutoffPeriod ? baseline : cutoffPeriod;
        earningsInfo.positionsLastClaimedPeriod[to][tokenId][toPositionUid] = updatedLastClaimed;
    }

    function preserveTransferredPositionEarnings(
        uint256 assetId,
        address holder,
        uint256 tokenId,
        uint256 positionUid,
        uint256 transferredAmount,
        uint256 acquiredAt
    ) external onlyActivePositionManager {
        if (transferredAmount == 0) {
            return;
        }

        EarningsLib.EarningsInfo storage earningsInfo = _assetEarnings[assetId];
        if (!earningsInfo.isInitialized || earningsInfo.currentPeriod == 0) {
            return;
        }

        if (roboshareTokens.balanceOf(holder, assetId) > 0) {
            return;
        }

        uint256 lastClaimedPeriod = earningsInfo.positionsLastClaimedPeriod[holder][tokenId][positionUid];
        uint256 cutoffPeriod = EarningsLib.getPeriodAtTimestamp(earningsInfo, block.timestamp);
        if (cutoffPeriod <= lastClaimedPeriod) {
            return;
        }

        uint256 preservedAmount;
        for (uint256 period = lastClaimedPeriod + 1; period <= cutoffPeriod; period++) {
            uint256 periodTimestamp = earningsInfo.periods[period].timestamp;
            if (acquiredAt <= periodTimestamp) {
                preservedAmount += earningsInfo.periods[period].earningsPerToken * transferredAmount;
            }
        }

        if (preservedAmount > 0) {
            earningsInfo.transferredEarningsCredit[holder] += preservedAmount;
        }
    }

    function _claimEarningsFor(address holder, uint256 assetId) internal returns (uint256 unclaimedAmount) {
        if (!router.assetExists(assetId)) {
            revert ITreasury.AssetNotFound();
        }

        EarningsLib.EarningsInfo storage earningsInfo = _assetEarnings[assetId];
        if (!earningsInfo.isInitialized || earningsInfo.currentPeriod == 0) {
            revert ITreasury.NoEarningsToClaim();
        }

        uint256 transferredCredit = earningsInfo.transferredEarningsCredit[holder];

        AssetLib.AssetStatus status = router.getAssetStatus(assetId);
        bool isSettled = status == AssetLib.AssetStatus.Retired || status == AssetLib.AssetStatus.Expired;
        uint256 revenueTokenId = TokenLib.getTokenIdFromAssetId(assetId);

        if (isSettled) {
            unclaimedAmount = EarningsLib.claimSettledEarnings(earningsInfo, holder);
            if (roboshareTokens.balanceOf(holder, assetId) == 0) {
                uint256 tokenBalance = roboshareTokens.balanceOf(holder, revenueTokenId);
                if (tokenBalance > 0) {
                    TokenLib.TokenPosition[] memory positions = _getRevenuePositions(revenueTokenId, holder);
                    uint256 positionEarnings =
                        EarningsLib.calculateEarningsForPositions(earningsInfo, holder, positions);
                    if (positionEarnings > 0) {
                        EarningsLib.updateClaimPeriods(earningsInfo, holder, positions);
                        unclaimedAmount += positionEarnings;
                    }
                }
            }
        } else {
            if (roboshareTokens.balanceOf(holder, assetId) > 0 && transferredCredit == 0) {
                revert ITreasury.NoEarningsToClaim();
            }

            uint256 tokenBalance = roboshareTokens.balanceOf(holder, revenueTokenId);
            if (tokenBalance == 0) {
                if (transferredCredit == 0) {
                    revert ITreasury.InsufficientTokenBalance();
                }
            } else if (roboshareTokens.balanceOf(holder, assetId) == 0) {
                TokenLib.TokenPosition[] memory positions = _getRevenuePositions(revenueTokenId, holder);
                uint256 positionEarnings = EarningsLib.calculateEarningsForPositions(earningsInfo, holder, positions);

                if (positionEarnings > 0) {
                    EarningsLib.updateClaimPeriods(earningsInfo, holder, positions);
                    unclaimedAmount += positionEarnings;
                }
            }
        }

        if (transferredCredit > 0) {
            earningsInfo.transferredEarningsCredit[holder] = 0;
            unclaimedAmount += transferredCredit;
        }
    }

    function updateTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_treasury == address(0)) revert ZeroAddress();
        address oldTreasury = address(treasury);
        _revokeRole(AUTHORIZED_CONTRACT_ROLE, oldTreasury);
        treasury = ITreasury(_treasury);
        _grantRole(AUTHORIZED_CONTRACT_ROLE, _treasury);
        emit TreasuryUpdated(oldTreasury, _treasury);
    }

    function updateRouter(address _router) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_router == address(0)) revert ZeroAddress();
        address oldRouter = address(router);
        _revokeRole(AUTHORIZED_CONTRACT_ROLE, oldRouter);
        router = RegistryRouter(_router);
        _grantRole(AUTHORIZED_CONTRACT_ROLE, _router);
        emit RouterUpdated(oldRouter, _router);
    }

    function updatePartnerManager(address _partnerManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_partnerManager == address(0)) revert ZeroAddress();
        address oldPartnerManager = address(partnerManager);
        partnerManager = PartnerManager(_partnerManager);
        emit PartnerManagerUpdated(oldPartnerManager, _partnerManager);
    }

    function updateRoboshareTokens(address _roboshareTokens) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_roboshareTokens == address(0)) revert ZeroAddress();
        address oldRoboshareTokens = address(roboshareTokens);
        roboshareTokens = RoboshareTokens(_roboshareTokens);
        emit RoboshareTokensUpdated(oldRoboshareTokens, _roboshareTokens);
    }

    function updateUSDC(address _usdc) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_usdc == address(0)) revert ZeroAddress();
        address oldUsdc = address(usdc);
        usdc = IERC20(_usdc);
        emit UsdcUpdated(oldUsdc, _usdc);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) { }
}
