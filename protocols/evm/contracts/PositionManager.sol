// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IERC1155 } from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import { ProtocolLib, TokenLib } from "./Libraries.sol";
import { IEarningsManager } from "./interfaces/IEarningsManager.sol";
import { IPositionManager } from "./interfaces/IPositionManager.sol";

interface IRoboshareTokenPriceReader {
    function getTokenPrice(uint256 revenueTokenId) external view returns (uint256);
}

interface IRoboshareTokenManager {
    function managerBurnCurrentEpoch(address holder, uint256 revenueTokenId, uint256 amount) external;

    function transferLockedForListing(
        address from,
        address to,
        uint256 revenueTokenId,
        uint256 amount,
        bytes memory data
    ) external;
}

/**
 * @title PositionManager
 * @notice Upgradeable boundary contract for position, lock, redemption-epoch, and settlement state.
 * @dev This scaffold intentionally keeps redemption and settlement responsibilities in the same manager.
 */
contract PositionManager is Initializable, AccessControlUpgradeable, UUPSUpgradeable, IPositionManager {
    struct SettlementStateInternal {
        bool isConfigured;
        uint256 epochId;
        uint256 settlementAmount;
        uint256 settlementPerToken;
        uint256 claimedBurnAmount;
        uint256 claimedPayout;
    }

    struct SettlementClaimStateInternal {
        uint256 burnedAmount;
        uint256 payout;
    }

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant POSITION_ADMIN_ROLE = keccak256("POSITION_ADMIN_ROLE");
    bytes32 public constant AUTHORIZED_ROUTER_ROLE = keccak256("AUTHORIZED_ROUTER_ROLE");
    bytes32 public constant AUTHORIZED_MARKETPLACE_ROLE = keccak256("AUTHORIZED_MARKETPLACE_ROLE");
    bytes32 public constant AUTHORIZED_TREASURY_ROLE = keccak256("AUTHORIZED_TREASURY_ROLE");

    address public registryRouter;
    address public roboshareTokens;
    address public partnerManager;
    address public marketplace;
    address public treasury;
    address public earningsManager;
    address public usdc;

    mapping(uint256 => TokenLib.TokenInfo) private _revenueTokenInfos;
    mapping(address => mapping(uint256 => uint256)) private _lockedAmounts;
    mapping(uint256 => uint256) private _listingSalePenalties;
    mapping(uint256 => SettlementStateInternal) private _settlementStates;
    mapping(uint256 => mapping(uint256 => mapping(address => SettlementClaimStateInternal))) private _settlementClaims;
    mapping(uint256 => mapping(address => mapping(uint256 => uint256))) private _positionHoldingStartedAt;
    bool private _currentEpochBurnActive;
    address private _currentEpochBurnHolder;
    uint256 private _currentEpochBurnTokenId;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address _registryRouter,
        address _roboshareTokens,
        address _partnerManager,
        address _marketplace,
        address _treasury,
        address _earningsManager,
        address _usdc
    ) external initializer {
        if (
            admin == address(0) || _registryRouter == address(0) || _roboshareTokens == address(0)
                || _partnerManager == address(0) || _marketplace == address(0) || _treasury == address(0)
                || _earningsManager == address(0) || _usdc == address(0)
        ) {
            revert ZeroAddress();
        }

        __AccessControl_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(POSITION_ADMIN_ROLE, admin);
        _setRoleAdmin(AUTHORIZED_ROUTER_ROLE, POSITION_ADMIN_ROLE);
        _setRoleAdmin(AUTHORIZED_MARKETPLACE_ROLE, POSITION_ADMIN_ROLE);
        _setRoleAdmin(AUTHORIZED_TREASURY_ROLE, POSITION_ADMIN_ROLE);
        _grantRole(AUTHORIZED_ROUTER_ROLE, _registryRouter);
        _grantRole(AUTHORIZED_MARKETPLACE_ROLE, _marketplace);
        _grantRole(AUTHORIZED_TREASURY_ROLE, _treasury);

        registryRouter = _registryRouter;
        roboshareTokens = _roboshareTokens;
        partnerManager = _partnerManager;
        marketplace = _marketplace;
        treasury = _treasury;
        earningsManager = _earningsManager;
        usdc = _usdc;

        emit PositionManagerInitialized(
            admin, _registryRouter, _roboshareTokens, _partnerManager, _marketplace, _treasury, _earningsManager, _usdc
        );
    }

    function updateRegistryRouter(address newRegistryRouter) external onlyRole(POSITION_ADMIN_ROLE) {
        if (newRegistryRouter == address(0)) {
            revert ZeroAddress();
        }

        address oldRegistryRouter = registryRouter;
        if (oldRegistryRouter != address(0)) {
            _revokeRole(AUTHORIZED_ROUTER_ROLE, oldRegistryRouter);
        }

        registryRouter = newRegistryRouter;
        _grantRole(AUTHORIZED_ROUTER_ROLE, newRegistryRouter);
        emit RegistryRouterUpdated(oldRegistryRouter, newRegistryRouter);
    }

    function updateRoboshareTokens(address newRoboshareTokens) external onlyRole(POSITION_ADMIN_ROLE) {
        if (newRoboshareTokens == address(0)) {
            revert ZeroAddress();
        }

        address oldRoboshareTokens = roboshareTokens;
        roboshareTokens = newRoboshareTokens;
        emit RoboshareTokensUpdated(oldRoboshareTokens, newRoboshareTokens);
    }

    function updatePartnerManager(address newPartnerManager) external onlyRole(POSITION_ADMIN_ROLE) {
        if (newPartnerManager == address(0)) {
            revert ZeroAddress();
        }

        address oldPartnerManager = partnerManager;
        partnerManager = newPartnerManager;
        emit PartnerManagerUpdated(oldPartnerManager, newPartnerManager);
    }

    function updateMarketplace(address newMarketplace) external onlyRole(POSITION_ADMIN_ROLE) {
        if (newMarketplace == address(0)) {
            revert ZeroAddress();
        }

        address oldMarketplace = marketplace;
        if (oldMarketplace != address(0)) {
            _revokeRole(AUTHORIZED_MARKETPLACE_ROLE, oldMarketplace);
        }

        marketplace = newMarketplace;
        _grantRole(AUTHORIZED_MARKETPLACE_ROLE, newMarketplace);
        emit MarketplaceUpdated(oldMarketplace, newMarketplace);
    }

    function updateTreasury(address newTreasury) external onlyRole(POSITION_ADMIN_ROLE) {
        if (newTreasury == address(0)) {
            revert ZeroAddress();
        }

        address oldTreasury = treasury;
        if (oldTreasury != address(0)) {
            _revokeRole(AUTHORIZED_TREASURY_ROLE, oldTreasury);
        }

        treasury = newTreasury;
        _grantRole(AUTHORIZED_TREASURY_ROLE, newTreasury);
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    function updateEarningsManager(address newEarningsManager) external onlyRole(POSITION_ADMIN_ROLE) {
        if (newEarningsManager == address(0)) {
            revert ZeroAddress();
        }

        address oldEarningsManager = earningsManager;
        earningsManager = newEarningsManager;
        emit EarningsManagerUpdated(oldEarningsManager, newEarningsManager);
    }

    function updateUsdc(address newUsdc) external onlyRole(POSITION_ADMIN_ROLE) {
        if (newUsdc == address(0)) {
            revert ZeroAddress();
        }

        address oldUsdc = usdc;
        usdc = newUsdc;
        emit UsdcUpdated(oldUsdc, newUsdc);
    }

    function recordPositionMutation(PositionMutation calldata mutation) external onlyRole(AUTHORIZED_MARKETPLACE_ROLE) {
        if (!TokenLib.isRevenueToken(mutation.tokenId)) {
            revert NotRevenueToken();
        }

        TokenLib.TokenInfo storage tokenInfo = _revenueTokenInfos[mutation.tokenId];
        if (tokenInfo.tokenId == 0) {
            tokenInfo.tokenId = mutation.tokenId;
        }

        if (mutation.mutationType == PositionMutationType.Mint) {
            tokenInfo.tokenSupply += mutation.amount;
            _appendPosition(
                tokenInfo,
                mutation.account,
                mutation.amount,
                block.timestamp,
                block.timestamp,
                tokenInfo.currentRedemptionEpoch
            );
            _increaseCurrentEpochState(tokenInfo, mutation.tokenId, mutation.amount);
        } else if (mutation.mutationType == PositionMutationType.Burn) {
            tokenInfo.tokenSupply -= mutation.amount;
            _burnPositionsFifo(tokenInfo, mutation.account, mutation.amount);
        } else {
            revert UnsupportedPositionMutation(mutation.mutationType);
        }

        emit PositionMutated(
            mutation.assetId,
            mutation.tokenId,
            mutation.account,
            mutation.amount,
            mutation.auxValue,
            mutation.mutationType,
            mutation.reason
        );
    }

    function syncRevenueTokenPolicy(uint256 revenueTokenId, uint256 tokenPrice, uint256 minHoldingPeriod) external {
        if (msg.sender != roboshareTokens && !hasRole(POSITION_ADMIN_ROLE, msg.sender)) {
            revert UnauthorizedTokenHookCaller(msg.sender);
        }

        _requireRevenueToken(revenueTokenId);

        TokenLib.TokenInfo storage tokenInfo = _revenueTokenInfos[revenueTokenId];
        if (tokenInfo.tokenId == 0) {
            tokenInfo.tokenId = revenueTokenId;
        }

        tokenInfo.tokenPrice = tokenPrice;
        tokenInfo.minHoldingPeriod =
            minHoldingPeriod < ProtocolLib.MONTHLY_INTERVAL ? ProtocolLib.MONTHLY_INTERVAL : minHoldingPeriod;
    }

    function beforeRevenueTokenUpdate(address from, address to, uint256 tokenId, uint256 amount) external {
        if (msg.sender != roboshareTokens) {
            revert UnauthorizedTokenHookCaller(msg.sender);
        }

        _requireRevenueToken(tokenId);

        TokenLib.TokenInfo storage tokenInfo = _revenueTokenInfos[tokenId];
        if (tokenInfo.tokenId == 0) {
            tokenInfo.tokenId = tokenId;
        }

        if (from == address(0)) {
            tokenInfo.tokenSupply += amount;
            _appendPosition(tokenInfo, to, amount, block.timestamp, block.timestamp, tokenInfo.currentRedemptionEpoch);
            _increaseCurrentEpochState(tokenInfo, tokenId, amount);
        } else if (to == address(0)) {
            _burnRevenueToken(tokenInfo, from, tokenId, amount);
        } else {
            _transferPositionsFifo(tokenInfo, from, to, amount);
        }
    }

    function getUserPositions(uint256 revenueTokenId, address holder)
        external
        view
        returns (TokenLib.TokenPosition[] memory positions)
    {
        _requireRevenueToken(revenueTokenId);

        TokenLib.PositionQueue storage queue = _revenueTokenInfos[revenueTokenId].positions[holder];
        uint256 size = queue.tail - queue.head;
        positions = new TokenLib.TokenPosition[](size);

        for (uint256 i = 0; i < size; i++) {
            positions[i] = queue.items[queue.head + i];
        }
    }

    function getLockedAmount(address holder, uint256 revenueTokenId) external view returns (uint256) {
        _requireRevenueToken(revenueTokenId);
        return _lockedAmounts[holder][revenueTokenId];
    }

    function getAvailableAmount(address holder, uint256 revenueTokenId, uint256 totalBalance)
        external
        view
        returns (uint256)
    {
        _requireRevenueToken(revenueTokenId);

        uint256 lockedAmount = _lockedAmounts[holder][revenueTokenId];
        if (lockedAmount >= totalBalance) {
            return 0;
        }
        return totalBalance - lockedAmount;
    }

    function getPrimaryRedemptionEligibleBalance(address holder, uint256 revenueTokenId)
        external
        view
        returns (uint256 eligibleBalance)
    {
        _requireRevenueToken(revenueTokenId);

        TokenLib.TokenInfo storage info = _revenueTokenInfos[revenueTokenId];
        TokenLib.PositionQueue storage queue = info.positions[holder];
        uint256 currentEpoch = info.currentRedemptionEpoch;

        for (uint256 i = queue.head; i < queue.tail; i++) {
            TokenLib.TokenPosition storage position = queue.items[i];
            if (position.amount > 0 && position.redemptionEpoch == currentEpoch) {
                eligibleBalance += position.amount;
            }
        }
    }

    function getCurrentPrimaryRedemptionEpoch(uint256 revenueTokenId) external view returns (uint256) {
        _requireRevenueToken(revenueTokenId);
        return _revenueTokenInfos[revenueTokenId].currentRedemptionEpoch;
    }

    function getCurrentPrimaryRedemptionEpochSupply(uint256 revenueTokenId) external view returns (uint256) {
        _requireRevenueToken(revenueTokenId);
        return _revenueTokenInfos[revenueTokenId].currentRedemptionEpochSupply;
    }

    function getCurrentPrimaryRedemptionBackedPrincipal(uint256 revenueTokenId) external view returns (uint256) {
        _requireRevenueToken(revenueTokenId);
        return _revenueTokenInfos[revenueTokenId].currentRedemptionBackedPrincipal;
    }

    function lockForListing(address holder, uint256 revenueTokenId, uint256 amount) external {
        _requireTokenOrMarketplaceCaller();
        _requireRevenueToken(revenueTokenId);
        if (amount == 0) revert InvalidAmount();

        uint256 lockedAmount = _lockedAmounts[holder][revenueTokenId];
        uint256 totalBalance = IERC1155(roboshareTokens).balanceOf(holder, revenueTokenId);
        if (totalBalance < lockedAmount + amount) revert InsufficientUnlockedBalance();

        _lockedAmounts[holder][revenueTokenId] = lockedAmount + amount;
        emit ListingLocked(holder, revenueTokenId, amount);
    }

    function unlockForListing(address holder, uint256 revenueTokenId, uint256 amount) external {
        _requireTokenOrMarketplaceCaller();
        _requireRevenueToken(revenueTokenId);
        if (amount == 0) revert InvalidAmount();

        uint256 lockedAmount = _lockedAmounts[holder][revenueTokenId];
        if (lockedAmount < amount) revert InsufficientLockedBalance();

        _lockedAmounts[holder][revenueTokenId] = lockedAmount - amount;
        emit ListingUnlocked(holder, revenueTokenId, amount);
    }

    function settleLockedTransfer(address from, address to, uint256 revenueTokenId, uint256 amount) external {
        _requireTokenOrMarketplaceCaller();
        _requireRevenueToken(revenueTokenId);
        if (amount == 0) revert InvalidAmount();

        uint256 lockedAmount = _lockedAmounts[from][revenueTokenId];
        if (lockedAmount < amount) revert InsufficientLockedBalance();

        _lockedAmounts[from][revenueTokenId] = lockedAmount - amount;
        emit ListingUnlocked(from, revenueTokenId, amount);
        emit LockedTransferSettled(from, to, revenueTokenId, amount);
    }

    function transferLockedForListing(address from, address to, uint256 revenueTokenId, uint256 amount)
        external
        onlyRole(AUTHORIZED_MARKETPLACE_ROLE)
    {
        _requireRevenueToken(revenueTokenId);
        if (amount == 0) revert InvalidAmount();

        _roboshareTokenManager().transferLockedForListing(from, to, revenueTokenId, amount, "");
    }

    function burnCurrentEpochForPrimaryRedemption(address holder, uint256 tokenId, uint256 amount)
        external
        onlyRole(AUTHORIZED_ROUTER_ROLE)
    {
        _requireRevenueToken(tokenId);
        if (amount == 0) revert InvalidAmount();

        _roboshareTokenManager().managerBurnCurrentEpoch(holder, tokenId, amount);
    }

    function bookSalePenalty(uint256 listingId, address seller, uint256 revenueTokenId, uint256 amount)
        external
        onlyRole(AUTHORIZED_MARKETPLACE_ROLE)
    {
        _requireRevenueToken(revenueTokenId);

        _listingSalePenalties[listingId] = amount;
        emit SalePenaltyBooked(listingId, seller, revenueTokenId, amount);
    }

    function clearSalePenalty(uint256 listingId) external onlyRole(AUTHORIZED_MARKETPLACE_ROLE) {
        delete _listingSalePenalties[listingId];
    }

    function getSalePenalty(uint256 listingId) external view returns (uint256) {
        return _listingSalePenalties[listingId];
    }

    function getSalesPenalty(address seller, uint256 revenueTokenId, uint256 amount)
        external
        view
        returns (uint256 penaltyAmount)
    {
        _requireRevenueToken(revenueTokenId);

        uint256 assetId = TokenLib.getAssetIdFromTokenId(revenueTokenId);
        if (IERC1155(roboshareTokens).balanceOf(seller, assetId) > 0) {
            return 0;
        }

        return _calculateSalesPenalty(_revenueTokenInfos[revenueTokenId], seller, amount);
    }

    function preparePrimaryRedemptionBurn(address holder, uint256 tokenId) external {
        if (msg.sender != roboshareTokens) {
            revert UnauthorizedTokenHookCaller(msg.sender);
        }

        _requireRevenueToken(tokenId);

        _currentEpochBurnActive = true;
        _currentEpochBurnHolder = holder;
        _currentEpochBurnTokenId = tokenId;
    }

    function recordPositionLock(uint256 assetId, uint256 tokenId, address account, uint256 lockUntil, bytes32 reason)
        external
        onlyRole(AUTHORIZED_ROUTER_ROLE)
    {
        emit PositionLockUpdated(assetId, tokenId, account, lockUntil, reason);
    }

    function recordRedemptionEpoch(
        uint256 tokenId,
        uint256 epochId,
        uint256 redeemableSupply,
        uint256 backedPrincipal,
        bytes32 reason
    ) external onlyRole(AUTHORIZED_TREASURY_ROLE) {
        _requireRevenueToken(tokenId);

        TokenLib.TokenInfo storage tokenInfo = _revenueTokenInfos[tokenId];
        if (tokenInfo.tokenId == 0) {
            tokenInfo.tokenId = tokenId;
        }

        tokenInfo.currentRedemptionEpoch = epochId;
        tokenInfo.currentRedemptionEpochSupply = redeemableSupply;
        tokenInfo.currentRedemptionBackedPrincipal = backedPrincipal;

        emit RedemptionStateUpdated(tokenId, epochId, redeemableSupply, backedPrincipal, reason);
    }

    function recordImmediateProceedsRelease(uint256 tokenId, uint256 releasedAmount, bytes32 reason) external {
        _requireTokenRouterOrTreasuryCaller();
        _recordPrincipalRelease(tokenId, releasedAmount, reason);
    }

    function recordPrimaryRedemptionPayout(uint256 tokenId, uint256 payoutAmount, bytes32 reason) external {
        _requireTokenRouterOrTreasuryCaller();
        _recordPrincipalRelease(tokenId, payoutAmount, reason);
    }

    function consumePrimaryRedemption(
        address holder,
        uint256 tokenId,
        uint256 burnAmount,
        uint256 payout,
        bytes32 reason
    ) external onlyRole(AUTHORIZED_TREASURY_ROLE) {
        _requireRevenueToken(tokenId);
        if (burnAmount == 0) {
            revert InvalidAmount();
        }

        TokenLib.TokenInfo storage tokenInfo = _revenueTokenInfos[tokenId];
        uint256 currentEpoch = tokenInfo.currentRedemptionEpoch;
        // Token-side burns already flow through beforeRevenueTokenUpdate(...), so this
        // transition only consumes the remaining backed principal and epoch aggregate state.
        uint256 backedPrincipal = tokenInfo.currentRedemptionBackedPrincipal;
        tokenInfo.currentRedemptionBackedPrincipal = payout >= backedPrincipal ? 0 : backedPrincipal - payout;

        _rollRedemptionEpochIfExhausted(tokenInfo);

        emit PrimaryRedemptionConsumed(tokenId, currentEpoch, holder, burnAmount, payout, reason);
        emit RedemptionStateUpdated(
            tokenId,
            tokenInfo.currentRedemptionEpoch,
            tokenInfo.currentRedemptionEpochSupply,
            tokenInfo.currentRedemptionBackedPrincipal,
            reason
        );
    }

    function recordSettlement(
        uint256 assetId,
        uint256 epochId,
        uint256 settlementAmount,
        uint256 settlementPerToken,
        bytes32 reason
    ) external onlyRole(AUTHORIZED_TREASURY_ROLE) {
        SettlementStateInternal storage state = _settlementStates[assetId];
        if (!state.isConfigured || state.epochId != epochId) {
            state.claimedBurnAmount = 0;
            state.claimedPayout = 0;
        }
        state.isConfigured = true;
        state.epochId = epochId;
        state.settlementAmount = settlementAmount;
        state.settlementPerToken = settlementPerToken;

        emit SettlementConfigured(assetId, epochId, settlementAmount, settlementPerToken, reason);
    }

    function recordSettlementClaim(
        uint256 assetId,
        uint256 tokenId,
        address account,
        uint256 burnAmount,
        uint256 payout,
        bytes32 reason
    ) external onlyRole(AUTHORIZED_TREASURY_ROLE) {
        _recordSettlementClaim(assetId, tokenId, account, burnAmount, payout, reason);
    }

    function creditSettlementClaim(address account, uint256 assetId, uint256 burnAmount, bytes32 reason)
        external
        onlyRole(AUTHORIZED_TREASURY_ROLE)
        returns (uint256 payout)
    {
        if (burnAmount == 0) {
            return 0;
        }

        SettlementStateInternal storage state = _settlementStates[assetId];
        if (!state.isConfigured) {
            revert SettlementNotConfigured(assetId);
        }

        payout = burnAmount * state.settlementPerToken;
        _recordSettlementClaim(assetId, TokenLib.getTokenIdFromAssetId(assetId), account, burnAmount, payout, reason);
    }

    function getSettlementState(uint256 assetId) external view returns (SettlementState memory state) {
        SettlementStateInternal storage settlement = _settlementStates[assetId];
        state = SettlementState({
            isConfigured: settlement.isConfigured,
            epochId: settlement.epochId,
            settlementAmount: settlement.settlementAmount,
            settlementPerToken: settlement.settlementPerToken,
            claimedBurnAmount: settlement.claimedBurnAmount,
            claimedPayout: settlement.claimedPayout
        });
    }

    function getSettlementClaimState(uint256 assetId, address account)
        external
        view
        returns (SettlementClaimState memory state)
    {
        uint256 epochId = _settlementStates[assetId].epochId;
        SettlementClaimStateInternal storage claimState = _settlementClaims[assetId][epochId][account];
        state = SettlementClaimState({ burnedAmount: claimState.burnedAmount, payout: claimState.payout });
    }

    function previewSettlementClaim(uint256 assetId, uint256 burnAmount) external view returns (uint256 payout) {
        SettlementStateInternal storage settlement = _settlementStates[assetId];
        if (!settlement.isConfigured || burnAmount == 0) {
            return 0;
        }
        return burnAmount * settlement.settlementPerToken;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) { }

    function _requireRevenueToken(uint256 revenueTokenId) internal pure {
        if (!TokenLib.isRevenueToken(revenueTokenId)) {
            revert NotRevenueToken();
        }
    }

    function _increaseCurrentEpochState(TokenLib.TokenInfo storage info, uint256 tokenId, uint256 amount) internal {
        uint256 tokenPrice = info.tokenPrice;
        if (tokenPrice == 0) {
            tokenPrice = IRoboshareTokenPriceReader(roboshareTokens).getTokenPrice(tokenId);
        }
        info.currentRedemptionEpochSupply += amount;
        info.currentRedemptionBackedPrincipal += amount * tokenPrice;
    }

    function _recordPrincipalRelease(uint256 tokenId, uint256 releasedAmount, bytes32 reason) internal {
        _requireRevenueToken(tokenId);
        if (releasedAmount == 0) {
            return;
        }

        TokenLib.TokenInfo storage tokenInfo = _revenueTokenInfos[tokenId];
        uint256 backedPrincipal = tokenInfo.currentRedemptionBackedPrincipal;
        if (backedPrincipal == 0) {
            return;
        }

        tokenInfo.currentRedemptionBackedPrincipal =
            releasedAmount >= backedPrincipal ? 0 : backedPrincipal - releasedAmount;

        _rollRedemptionEpochIfExhausted(tokenInfo);

        emit RedemptionStateUpdated(
            tokenId,
            tokenInfo.currentRedemptionEpoch,
            tokenInfo.currentRedemptionEpochSupply,
            tokenInfo.currentRedemptionBackedPrincipal,
            reason
        );
    }

    function _recordSettlementClaim(
        uint256 assetId,
        uint256 tokenId,
        address account,
        uint256 burnAmount,
        uint256 payout,
        bytes32 reason
    ) internal {
        SettlementStateInternal storage state = _settlementStates[assetId];
        if (!state.isConfigured) {
            revert SettlementNotConfigured(assetId);
        }

        SettlementClaimStateInternal storage claimState = _settlementClaims[assetId][state.epochId][account];
        claimState.burnedAmount += burnAmount;
        claimState.payout += payout;
        state.claimedBurnAmount += burnAmount;
        state.claimedPayout += payout;

        emit SettlementClaimRecorded(assetId, tokenId, account, burnAmount, payout, reason);
    }

    function _roboshareTokenManager() internal view returns (IRoboshareTokenManager manager) {
        address token = roboshareTokens;
        if (token.code.length == 0) revert InvalidRoboshareTokens(token);
        return IRoboshareTokenManager(token);
    }

    function _rollRedemptionEpochIfExhausted(TokenLib.TokenInfo storage info) internal {
        if (info.currentRedemptionEpochSupply > 0 && info.currentRedemptionBackedPrincipal > 0) {
            return;
        }

        info.currentRedemptionEpoch++;
        info.currentRedemptionEpochSupply = 0;
        info.currentRedemptionBackedPrincipal = 0;
    }

    function _burnRevenueToken(TokenLib.TokenInfo storage info, address holder, uint256 tokenId, uint256 amount)
        internal
    {
        info.tokenSupply -= amount;

        if (_currentEpochBurnActive && holder == _currentEpochBurnHolder && tokenId == _currentEpochBurnTokenId) {
            _currentEpochBurnActive = false;
            _currentEpochBurnHolder = address(0);
            _currentEpochBurnTokenId = 0;
            _burnCurrentEpochPositions(info, holder, amount);
            return;
        }

        _burnPositionsFifo(info, holder, amount);
    }

    function _burnPositionsFifo(TokenLib.TokenInfo storage info, address holder, uint256 amount) internal {
        TokenLib.PositionQueue storage queue = info.positions[holder];
        uint256 remaining = amount;
        uint256 currentEpoch = info.currentRedemptionEpoch;
        uint256 burnedFromCurrentEpoch = 0;

        for (uint256 i = queue.head; i < queue.tail && remaining > 0; i++) {
            TokenLib.TokenPosition storage pos = queue.items[i];
            if (pos.amount == 0) continue;

            uint256 toBurn = remaining > pos.amount ? pos.amount : remaining;
            if (pos.redemptionEpoch == currentEpoch) {
                burnedFromCurrentEpoch += toBurn;
            }

            pos.amount -= toBurn;
            if (pos.amount == 0) {
                pos.soldAt = block.timestamp;
            }
            remaining -= toBurn;
        }

        if (remaining > 0) {
            revert TokenLib.InsufficientTokenBalance();
        }

        if (burnedFromCurrentEpoch > 0) {
            info.currentRedemptionEpochSupply -= burnedFromCurrentEpoch;
        }
    }

    function _burnCurrentEpochPositions(TokenLib.TokenInfo storage info, address holder, uint256 amount) internal {
        TokenLib.PositionQueue storage queue = info.positions[holder];
        uint256 remaining = amount;
        uint256 currentEpoch = info.currentRedemptionEpoch;

        for (uint256 i = queue.head; i < queue.tail && remaining > 0; i++) {
            TokenLib.TokenPosition storage pos = queue.items[i];
            if (pos.amount == 0 || pos.redemptionEpoch != currentEpoch) continue;

            uint256 toBurn = remaining > pos.amount ? pos.amount : remaining;
            pos.amount -= toBurn;
            if (pos.amount == 0) {
                pos.soldAt = block.timestamp;
            }
            remaining -= toBurn;
        }

        if (remaining > 0) {
            revert TokenLib.InsufficientTokenBalance();
        }

        info.currentRedemptionEpochSupply -= amount;
    }

    function _transferPositionsFifo(TokenLib.TokenInfo storage info, address from, address to, uint256 amount)
        internal
    {
        TokenLib.PositionQueue storage queue = info.positions[from];
        uint256 remaining = amount;
        uint256 assetId = TokenLib.getAssetIdFromTokenId(info.tokenId);

        for (uint256 i = queue.head; i < queue.tail && remaining > 0; i++) {
            TokenLib.TokenPosition storage pos = queue.items[i];
            if (pos.amount == 0) continue;

            uint256 toMove = remaining > pos.amount ? pos.amount : remaining;
            uint256 epoch = pos.redemptionEpoch;

            pos.amount -= toMove;
            if (pos.amount == 0) {
                pos.soldAt = block.timestamp;
            }

            uint256 newPositionUid = _appendPosition(info, to, toMove, pos.acquiredAt, block.timestamp, epoch);
            IEarningsManager(earningsManager)
                .transferPositionClaimState(assetId, from, to, info.tokenId, pos.uid, newPositionUid);
            remaining -= toMove;
        }

        if (remaining > 0) {
            revert TokenLib.InsufficientTokenBalance();
        }
    }

    function _appendPosition(
        TokenLib.TokenInfo storage info,
        address holder,
        uint256 amount,
        uint256 acquiredAt,
        uint256 holdingStartedAt,
        uint256 redemptionEpoch
    ) internal returns (uint256 id) {
        TokenLib.PositionQueue storage queue = info.positions[holder];
        id = queue.tail;
        queue.items[id] = TokenLib.TokenPosition({
            uid: id,
            tokenId: info.tokenId,
            amount: amount,
            acquiredAt: acquiredAt,
            soldAt: 0,
            redemptionEpoch: redemptionEpoch
        });
        _positionHoldingStartedAt[info.tokenId][holder][id] = holdingStartedAt;
        queue.tail++;
    }

    function _calculateSalesPenalty(TokenLib.TokenInfo storage info, address holder, uint256 amountToSell)
        internal
        view
        returns (uint256 penaltyAmount)
    {
        if (amountToSell == 0) return 0;

        TokenLib.PositionQueue storage queue = info.positions[holder];
        uint256 remaining = amountToSell;
        uint256 totalPenalty;

        for (uint256 i = queue.head; i < queue.tail && remaining > 0; i++) {
            TokenLib.TokenPosition storage pos = queue.items[i];
            if (pos.amount == 0) continue;

            uint256 toConsider = remaining > pos.amount ? pos.amount : remaining;
            uint256 holdingStartedAt = _positionHoldingStartedAt[info.tokenId][holder][pos.uid];
            if (holdingStartedAt == 0) {
                holdingStartedAt = pos.acquiredAt;
            }

            if (block.timestamp < holdingStartedAt + info.minHoldingPeriod) {
                totalPenalty += ProtocolLib.calculatePenalty(toConsider * info.tokenPrice);
            }
            remaining -= toConsider;
        }

        return totalPenalty;
    }

    function _requireTokenRouterOrTreasuryCaller() internal view {
        if (
            msg.sender != roboshareTokens && !hasRole(AUTHORIZED_ROUTER_ROLE, msg.sender)
                && !hasRole(AUTHORIZED_TREASURY_ROLE, msg.sender)
        ) {
            revert UnauthorizedTokenHookCaller(msg.sender);
        }
    }

    function _requireTokenOrMarketplaceCaller() internal view {
        if (msg.sender != roboshareTokens && !hasRole(AUTHORIZED_MARKETPLACE_ROLE, msg.sender)) {
            revert UnauthorizedTokenHookCaller(msg.sender);
        }
    }
}
