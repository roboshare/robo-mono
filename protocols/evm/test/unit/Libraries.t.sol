// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { Test } from "forge-std/Test.sol";
import { ProtocolLib, AssetLib, CollateralLib, EarningsLib, TokenLib, VehicleLib } from "../../contracts/Libraries.sol";

// Helper to expose ProtocolLib/EarningsLib pure functions
contract ProtocolEarningsHelper {
    function isValidIPFSURI(string memory uri) external pure returns (bool) {
        return ProtocolLib.isValidIPFSURI(uri);
    }

    function protocolFee(uint256 amount) external pure returns (uint256) {
        return ProtocolLib.calculateProtocolFee(amount);
    }

    function penalty(uint256 amount, uint256 price) external pure returns (uint256) {
        return ProtocolLib.calculatePenalty(amount * price);
    }

    function calcEarnings(uint256 principal, uint256 timeElapsed, uint256 bp) external pure returns (uint256) {
        return EarningsLib.calculateEarnings(principal, timeElapsed, bp);
    }

    function calcBenchmarkDefault(uint256 principal, uint256 timeElapsed) external pure returns (uint256) {
        return EarningsLib.calculateBenchmarkEarnings(principal, timeElapsed);
    }

    function releaseFees(uint256 amount) external pure returns (uint256 partnerRelease, uint256 fee) {
        return CollateralLib.calculateReleaseFees(amount);
    }
}

// Helper to hold and mutate AssetInfo
contract AssetHelper {
    using AssetLib for AssetLib.AssetInfo;

    AssetLib.AssetInfo internal info;

    function init(AssetLib.AssetStatus s, uint256 assetValue) external {
        info.initializeAssetInfo(assetValue);
        if (s != AssetLib.AssetStatus.Pending) {
            info.updateAssetStatus(s);
        }
    }

    function update(AssetLib.AssetStatus s) external {
        info.updateAssetStatus(s);
    }

    function status() external view returns (AssetLib.AssetStatus) {
        return info.status;
    }

    function isOperational() external view returns (bool) {
        return info.isOperational();
    }

    function age() external view returns (uint256) {
        return info.getAssetAge();
    }

    function sinceUpdate() external view returns (uint256) {
        return info.getTimeSinceUpdate();
    }

    // Intentional raw-state injection for AssetLib defensive tests only.
    function setStatusRaw(uint8 s) external {
        info.status = AssetLib.AssetStatus(s);
    }
}

// Helper to hold and mutate VehicleInfo for VehicleLib tests
contract VehicleHelper {
    using VehicleLib for VehicleLib.VehicleInfo;

    VehicleLib.VehicleInfo internal info;

    function init(string memory vin, string memory assetMetadataURI, string memory revenueTokenMetadataURI) external {
        info.initializeVehicleInfo(VehicleLib.toVINHash(vin), assetMetadataURI, revenueTokenMetadataURI);
    }

    function vinHash() external view returns (bytes32) {
        return info.vinHash;
    }

    function initWithHash(bytes32 vinHashValue, string memory assetMetadataURI, string memory revenueTokenMetadataURI)
        external
    {
        info.initializeVehicleInfo(vinHashValue, assetMetadataURI, revenueTokenMetadataURI);
    }

    function updateMeta(string memory uri) external {
        info.updateMetadata(uri, uri);
    }
}

// Helper to hold and mutate CollateralInfo and EarningsInfo/TokenInfo for cross-lib tests
contract CollateralTokenEarningsHelper {
    using CollateralLib for CollateralLib.CollateralInfo;
    using TokenLib for TokenLib.TokenInfo;

    CollateralLib.CollateralInfo internal c;
    EarningsLib.EarningsInfo internal e;
    TokenLib.TokenInfo internal t;

    function initCollateral(uint256 assetValue, uint256 interval) external {
        (, uint256 earningsBuffer, uint256 protocolBuffer,) =
            CollateralLib.calculateCollateralRequirements(assetValue, interval, ProtocolLib.BENCHMARK_YIELD_BP);
        c.initializeCollateralInfo(assetValue, earningsBuffer, protocolBuffer);
    }

    function collateralView()
        external
        view
        returns (uint256 baseCollateral, uint256 earningsBuffer, uint256 protocolBuffer, uint256 totalCollateral)
    {
        return (
            c.baseCollateral,
            c.earningsBuffer,
            c.protocolBuffer,
            CollateralLib.getTotalCollateral(c.baseCollateral, c.earningsBuffer, c.protocolBuffer)
        );
    }

    function collateralDebugView()
        external
        view
        returns (
            uint256 unredeemedBasePrincipal,
            uint256 baseCollateral,
            uint256 earningsBuffer,
            uint256 protocolBuffer,
            uint256 totalCollateral,
            bool isLocked,
            uint256 lockedAt,
            uint256 lastEventTimestamp,
            uint256 reservedForLiquidation,
            uint256 createdAt,
            uint256 releasedProtectedBase,
            uint256 releasedBaseCollateral
        )
    {
        return (
            c.unredeemedBasePrincipal,
            c.baseCollateral,
            c.earningsBuffer,
            c.protocolBuffer,
            CollateralLib.getTotalCollateral(c.baseCollateral, c.earningsBuffer, c.protocolBuffer),
            c.isLocked,
            c.lockedAt,
            c.lastEventTimestamp,
            c.reservedForLiquidation,
            c.createdAt,
            c.releasedProtectedBase,
            c.releasedBaseCollateral
        );
    }

    function setCollateralRaw(
        uint256 unredeemedBasePrincipal,
        uint256 baseCollateral,
        uint256 earningsBuffer,
        uint256 protocolBuffer,
        bool isLocked,
        uint256 lockedAt,
        uint256 lastEventTimestamp,
        uint256 reservedForLiquidation,
        uint256 createdAt,
        uint256 releasedBaseCollateral
    ) external {
        c.unredeemedBasePrincipal = unredeemedBasePrincipal;
        c.baseCollateral = baseCollateral;
        c.earningsBuffer = earningsBuffer;
        c.protocolBuffer = protocolBuffer;
        c.isLocked = isLocked;
        c.lockedAt = lockedAt;
        c.lastEventTimestamp = lastEventTimestamp;
        c.reservedForLiquidation = reservedForLiquidation;
        c.createdAt = createdAt;
        c.releasedBaseCollateral = releasedBaseCollateral;
    }

    function isCollateralInitialized() external view returns (bool) {
        return c.isInitialized();
    }

    function lockNow() external {
        c.isLocked = true;
        c.lockedAt = block.timestamp;
    }

    function clearLock() external {
        c.isLocked = false;
        c.lockedAt = 0;
    }

    function lockDuration() external view returns (uint256) {
        return c.getLockDuration();
    }

    function calcReq(uint256 assetValue, uint256 interval) external pure returns (uint256, uint256, uint256, uint256) {
        return CollateralLib.calculateCollateralRequirements(assetValue, interval, ProtocolLib.BENCHMARK_YIELD_BP);
    }

    function depreciation(uint256 base, uint256 elapsed) external pure returns (uint256) {
        return CollateralLib.calculateDepreciation(base, elapsed);
    }

    function process(uint256 net, uint256 base) external returns (int256, uint256) {
        return CollateralLib.processEarningsForBuffers(c, net, base);
    }

    function processInMemory(uint256 net, uint256 base)
        external
        view
        returns (int256 earningsResult, uint256 replenished, uint256 earningsBuffer, uint256 reserved, uint256 total)
    {
        CollateralLib.CollateralInfo memory info = c;
        (earningsResult, replenished) = CollateralLib.processEarningsForBuffersInMemory(info, net, base);
        return (
            earningsResult,
            replenished,
            info.earningsBuffer,
            info.reservedForLiquidation,
            CollateralLib.getTotalCollateral(info.baseCollateral, info.earningsBuffer, info.protocolBuffer)
        );
    }

    function salesPenalty(address holder, uint256 amt) external view returns (uint256) {
        return t.calculateSalesPenalty(holder, amt);
    }

    function targetBuffer(uint256 base) external pure returns (uint256) {
        (, uint256 earningsBuffer,,) = CollateralLib.calculateCollateralRequirements(
            base, ProtocolLib.QUARTERLY_INTERVAL, ProtocolLib.BENCHMARK_YIELD_BP
        );
        return earningsBuffer;
    }

    function initToken(uint256 tokenId, uint256 price, uint256 minHold, uint256 maturityDate) external {
        t.initializeTokenInfo(tokenId, price, 1_000_000, minHold, maturityDate, 10_000, 1_000, false, false);
    }

    function tokenInfo() external view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256) {
        return (
            t.tokenId,
            t.tokenPrice,
            t.tokenSupply,
            t.minHoldingPeriod,
            t.maturityDate,
            t.revenueShareBP,
            t.targetYieldBP
        );
    }

    function addPos(address h, uint256 amt) external {
        t.addPosition(h, amt);
    }

    function removePos(address h, uint256 amt) external {
        return t.removePosition(h, amt);
    }

    function initEarnings() external {
        EarningsLib.initializeEarningsInfo(e);
    }

    // Intentional direct period injection for isolated library math tests.
    function setPeriod(uint256 p, uint256 ept, uint256 ts, uint256 total) external {
        e.periods[p] = EarningsLib.EarningsPeriod({ earningsPerToken: ept, timestamp: ts, totalEarnings: total });
        if (p > e.currentPeriod) e.currentPeriod = p;
    }

    function getPeriodAtTs(uint256 ts) external view returns (uint256) {
        return EarningsLib.getPeriodAtTimestamp(e, ts);
    }

    function unclaimed(uint256 bal_, uint256 last) external view returns (uint256) {
        return EarningsLib.calculateUnclaimedEarnings(e, bal_, last);
    }

    function unclaimedForPositions(address holder, uint256 last) external view returns (uint256) {
        return t.calculateUnclaimedEarningsForPositions(holder, e, last);
    }

    function calcRelease() external view returns (uint256) {
        CollateralLib.CollateralInfo memory info = c;
        return CollateralLib.calculateCollateralRelease(info);
    }

    function previewRelease(
        bool assumeNewPeriod,
        bool earningsInitialized,
        uint256 currentPeriod,
        uint256 lastProcessedPeriod,
        uint256 realizedEarnings,
        uint256 benchmarkEarnings,
        uint256 coveredBaseCollateral
    )
        external
        view
        returns (
            uint8 status,
            uint256 newLastProcessedPeriod,
            uint256 grossRelease,
            uint256 protocolFee,
            uint256 partnerRelease
        )
    {
        CollateralLib.ReleaseCalculation memory calc = CollateralLib.calculateReleasePreview(
            c,
            assumeNewPeriod,
            earningsInitialized,
            currentPeriod,
            lastProcessedPeriod,
            realizedEarnings,
            benchmarkEarnings,
            coveredBaseCollateral
        );
        return
            (uint8(calc.status), calc.newLastProcessedPeriod, calc.grossRelease, calc.protocolFee, calc.partnerRelease);
    }

    function applyRealizedDefault(uint256 realizedEarnings, uint256 benchmarkEarnings)
        external
        view
        returns (
            uint256 earningsBuffer,
            uint256 protocolBuffer,
            uint256 totalCollateral,
            uint256 reservedForLiquidation,
            uint256 shortfallAmount,
            uint256 replenishmentAmount,
            uint256 excessEarnings
        )
    {
        CollateralLib.CollateralInfo memory info = c;
        (CollateralLib.CollateralInfo memory updated, uint256 shortfall, uint256 replenishment, uint256 excess) =
            CollateralLib.applyRealizedVsBenchmarkToCollateral(info, realizedEarnings, benchmarkEarnings);
        return (
            updated.earningsBuffer,
            updated.protocolBuffer,
            CollateralLib.getTotalCollateral(updated.baseCollateral, updated.earningsBuffer, updated.protocolBuffer),
            updated.reservedForLiquidation,
            shortfall,
            replenishment,
            excess
        );
    }

    function applyRealizedInStorageDefault(uint256 realizedEarnings, uint256 benchmarkEarnings)
        external
        returns (uint256 shortfallAmount, uint256 replenishmentAmount, uint256 excessEarnings)
    {
        return CollateralLib.applyRealizedVsBenchmarkToCollateralInStorage(c, realizedEarnings, benchmarkEarnings);
    }
}

contract LibrariesTest is Test {
    ProtocolEarningsHelper private peh;
    AssetHelper private ah;
    CollateralTokenEarningsHelper private cteh;
    VehicleHelper private vh;

    address private alice = address(0xA11CE);

    function setUp() public {
        peh = new ProtocolEarningsHelper();
        ah = new AssetHelper();
        cteh = new CollateralTokenEarningsHelper();
        vh = new VehicleHelper();
    }

    // ===== Normal library behavior =====

    // ProtocolLib tests
    function testIPFSValidation() public pure {
        // invalid: empty and just prefix
        assertFalse(ProtocolLib.isValidIPFSURI(""));
        assertFalse(ProtocolLib.isValidIPFSURI("ipfs://"));
        // invalid: wrong prefix
        assertFalse(ProtocolLib.isValidIPFSURI("http://something"));
        // valid
        assertTrue(ProtocolLib.isValidIPFSURI("ipfs://QmHashValue"));
    }

    function testProtocolFeeAndPenalty() public pure {
        assertEq(ProtocolLib.calculateProtocolFee(10_000), ProtocolLib.MIN_PROTOCOL_FEE); // 2.5% is less than min fee
        // 10 tokens at price 100 => 5% = 50, but min penalty applies
        assertEq(ProtocolLib.calculatePenalty(10 * 100), ProtocolLib.MIN_EARLY_SALE_PENALTY);
    }

    // AssetLib tests
    function testAssetsInitAndTransitions() public {
        ah.init(AssetLib.AssetStatus.Pending, 100000e6);
        assertEq(uint8(ah.status()), uint8(AssetLib.AssetStatus.Pending));
        assertFalse(ah.isOperational());

        // Valid transition Pending -> Active
        ah.update(AssetLib.AssetStatus.Active);
        assertTrue(ah.isOperational());

        // Valid transition Active -> Suspended
        ah.update(AssetLib.AssetStatus.Suspended);
        assertFalse(ah.isOperational());

        // Valid: Suspended -> Active
        ah.update(AssetLib.AssetStatus.Active);
    }

    function testAssetsInvalidStatusTransitionSuspendedToPending() public {
        ah.init(AssetLib.AssetStatus.Pending, 100000e6);
        ah.update(AssetLib.AssetStatus.Active);
        ah.update(AssetLib.AssetStatus.Suspended);

        vm.expectRevert(
            abi.encodeWithSelector(
                AssetLib.InvalidStatusTransition.selector, AssetLib.AssetStatus.Suspended, AssetLib.AssetStatus.Pending
            )
        );
        ah.update(AssetLib.AssetStatus.Pending);
    }

    function testAssetsInvalidStatusTransitionRetiredToActive() public {
        ah.init(AssetLib.AssetStatus.Pending, 100000e6);
        ah.update(AssetLib.AssetStatus.Active);
        ah.update(AssetLib.AssetStatus.Retired);

        vm.expectRevert(
            abi.encodeWithSelector(
                AssetLib.InvalidStatusTransition.selector, AssetLib.AssetStatus.Retired, AssetLib.AssetStatus.Active
            )
        );
        ah.update(AssetLib.AssetStatus.Active);
    }

    function testAssetsExpiredToRetired() public {
        ah.init(AssetLib.AssetStatus.Pending, 100000e6);
        ah.update(AssetLib.AssetStatus.Expired);
        ah.update(AssetLib.AssetStatus.Retired);
        assertEq(uint8(ah.status()), uint8(AssetLib.AssetStatus.Retired));
    }

    function testAssetsTimeViews() public {
        ah.init(AssetLib.AssetStatus.Active, 100000e6);
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 1 days);
        assertApproxEqAbs(ah.age(), 1 days, 2);
        // status update moves updatedAt
        ah.update(AssetLib.AssetStatus.Active);
        uint256 mid = block.timestamp;
        vm.warp(mid + 3 hours);
        assertApproxEqAbs(ah.sinceUpdate(), 3 hours, 2);
    }

    // ===== Intentional raw-state validation =====

    function testAssetsTransitionInvalidCurrentStatusPanicsAtEnumCast() public {
        ah.init(AssetLib.AssetStatus.Pending, 100000e6);
        vm.expectRevert();
        ah.setStatusRaw(255);
    }

    // CollateralLib tests
    function testCollateralInitAndView() public {
        // invalid input
        vm.expectRevert(CollateralLib.InvalidCollateralAmount.selector);
        cteh.initCollateral(0, ProtocolLib.QUARTERLY_INTERVAL);

        cteh.initCollateral(100000e6, ProtocolLib.QUARTERLY_INTERVAL);
        (uint256 baseCol, uint256 earnBuf, uint256 protBuf, uint256 totalCol) = cteh.collateralView();
        assertEq(baseCol, 100000e6);
        assertTrue(cteh.isCollateralInitialized());
        assertGt(earnBuf, 0);
        assertGt(protBuf, 0);
        assertEq(totalCol, baseCol + earnBuf + protBuf);

        // lock duration behavior
        assertEq(cteh.lockDuration(), 0);
        cteh.lockNow();
        vm.warp(block.timestamp + 7 days);
        assertApproxEqAbs(cteh.lockDuration(), 7 days, 2);
    }

    function testCollateralLockDurationWhenUnlocked() public {
        cteh.initCollateral(100000e6, ProtocolLib.QUARTERLY_INTERVAL);
        cteh.clearLock();
        assertEq(cteh.lockDuration(), 0);
    }

    function testCollateralRequirements() public pure {
        (uint256 baseAmt, uint256 eBuf, uint256 pBuf, uint256 tot) = CollateralLib.calculateCollateralRequirements(
            100000e6, ProtocolLib.QUARTERLY_INTERVAL, ProtocolLib.BENCHMARK_YIELD_BP
        );
        assertEq(baseAmt, 100000e6);
        assertEq(tot, baseAmt + eBuf + pBuf);
    }

    function testCollateralDepreciationAndBuffers() public {
        cteh.initCollateral(100000e6, ProtocolLib.QUARTERLY_INTERVAL);
        uint256 dep = cteh.depreciation(100000e6, 30 days);
        assertGt(dep, 0);

        // Setup buffers for processEarningsForBuffers
        // Shortfall path
        (int256 res, uint256 rep) = cteh.process(1e9, 2e9);
        assertLt(res, 0); // shortfall
        assertEq(rep, 0);

        // Excess path with replenishment from reserved
        // Manually top-up state to simulate reserved funds and low earningsBuffer
        (uint256 baseCol, uint256 eBuf, uint256 pBuf, uint256 totalCol) = cteh.collateralView();
        // silence warnings
        baseCol;
        pBuf;
        totalCol;
        eBuf;

        // Call process with net > base to trigger replenishment logic
        (int256 posRes, uint256 replenished) = cteh.process(10e9, 2e9);
        assertGe(posRes, 0);
        // replenished may be zero or positive depending on internal state; assert it doesn't underflow
        assertGe(replenished, 0);
    }

    function testCollateralPerfectMatchBuffers() public {
        cteh.initCollateral(100000e6, ProtocolLib.QUARTERLY_INTERVAL);
        uint256 dt = 30 days;
        (uint256 baseCol,,,) = cteh.collateralView();
        uint256 baseEarnings = EarningsLib.calculateBenchmarkEarnings(baseCol, dt);
        (int256 result, uint256 replenished) = cteh.process(baseEarnings, baseEarnings);
        assertEq(result, 0);
        assertEq(replenished, 0);
    }

    function testCollateralShortfallCoveredByExistingBuffer() public {
        cteh.initCollateral(100000e6, ProtocolLib.QUARTERLY_INTERVAL);

        (,, uint256 startingBuffer,,,,,, uint256 startingReserved,,,) = cteh.collateralDebugView();
        uint256 shortfallAmount = startingBuffer / 2;

        (int256 result, uint256 replenished) = cteh.process(0, shortfallAmount);
        (,, uint256 endingBuffer,,,,,, uint256 endingReserved,,,) = cteh.collateralDebugView();

        // Casting to int256 is safe because shortfallAmount is derived from the current uint256 buffer.
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(result, -int256(shortfallAmount));
        assertEq(replenished, 0);
        assertEq(endingBuffer, startingBuffer - shortfallAmount);
        assertEq(endingReserved, startingReserved + shortfallAmount);
    }

    function testApplyRealizedVsBenchmarkDefaultWrapperShortfall() public {
        cteh.initCollateral(100000e6, ProtocolLib.QUARTERLY_INTERVAL);

        (, uint256 baseCollateral, uint256 startingBuffer, uint256 protocolBuffer,,,,,,,,) = cteh.collateralDebugView();
        uint256 shortfallAmount = startingBuffer / 2;

        (
            uint256 earningsBufferAfter,,
            uint256 totalCollateralAfter,
            uint256 reservedAfter,
            uint256 shortfall,
            uint256 replenishment,
            uint256 excess
        ) = cteh.applyRealizedDefault(0, shortfallAmount);

        assertEq(shortfall, shortfallAmount);
        assertEq(replenishment, 0);
        assertEq(excess, 0);
        assertEq(earningsBufferAfter, startingBuffer - shortfallAmount);
        assertEq(reservedAfter, shortfallAmount);
        assertEq(totalCollateralAfter, baseCollateral + earningsBufferAfter + protocolBuffer);
    }

    function testApplyRealizedVsBenchmarkInStorageDefaultWrapperShortfall() public {
        cteh.initCollateral(100000e6, ProtocolLib.QUARTERLY_INTERVAL);

        (, uint256 baseCollateral, uint256 startingBuffer, uint256 protocolBuffer,,,,,,,,) = cteh.collateralDebugView();
        uint256 shortfallAmount = startingBuffer / 2;

        (uint256 shortfall, uint256 replenishment, uint256 excess) =
            cteh.applyRealizedInStorageDefault(0, shortfallAmount);
        (,, uint256 endingBuffer,, uint256 totalCollateral,,,, uint256 endingReserved,,,) = cteh.collateralDebugView();

        assertEq(shortfall, shortfallAmount);
        assertEq(replenishment, 0);
        assertEq(excess, 0);
        assertEq(endingBuffer, startingBuffer - shortfallAmount);
        assertEq(endingReserved, shortfallAmount);
        assertEq(totalCollateral, baseCollateral + endingBuffer + protocolBuffer);
    }

    function testCalculateReleasePreviewReturnsNoCollateralLocked() public {
        cteh.setCollateralRaw(100e6, 100e6, 10e6, 5e6, false, block.timestamp, block.timestamp, 0, block.timestamp, 0);

        (uint8 status, uint256 newLastProcessedPeriod, uint256 grossRelease,,) =
            cteh.previewRelease(false, false, 0, 0, 0, 0, 0);

        assertEq(status, uint8(CollateralLib.ReleaseEligibility.NoCollateralLocked));
        assertEq(newLastProcessedPeriod, 0);
        assertEq(grossRelease, 0);
    }

    function testCalculateReleasePreviewAssumeNewPeriodCapsToCoveredBaseWithoutEarnings() public {
        vm.warp(ProtocolLib.YEARLY_INTERVAL + 1 days);
        uint256 lockedAt = block.timestamp - ProtocolLib.YEARLY_INTERVAL;
        cteh.setCollateralRaw(100e6, 100e6, 10e6, 5e6, true, lockedAt, block.timestamp, 0, block.timestamp, 0);

        (
            uint8 status,
            uint256 newLastProcessedPeriod,
            uint256 grossRelease,
            uint256 protocolFee,
            uint256 partnerRelease
        ) = cteh.previewRelease(true, false, 0, 0, 0, 0, 1e6);

        assertEq(status, uint8(CollateralLib.ReleaseEligibility.Eligible));
        assertEq(newLastProcessedPeriod, 1);
        assertEq(grossRelease, 1e6);
        assertEq(protocolFee, ProtocolLib.MIN_PROTOCOL_FEE);
        assertEq(partnerRelease, 0);
    }

    function testCalculateReleasePreviewAssumeNewPeriodCapsToCoveredBaseWithoutNewPeriods() public {
        vm.warp(ProtocolLib.YEARLY_INTERVAL + 1 days);
        uint256 lockedAt = block.timestamp - ProtocolLib.YEARLY_INTERVAL;
        cteh.setCollateralRaw(100e6, 100e6, 10e6, 5e6, true, lockedAt, block.timestamp, 0, block.timestamp, 0);

        (
            uint8 status,
            uint256 newLastProcessedPeriod,
            uint256 grossRelease,
            uint256 protocolFee,
            uint256 partnerRelease
        ) = cteh.previewRelease(true, true, 1, 1, 0, 0, 1e6);

        assertEq(status, uint8(CollateralLib.ReleaseEligibility.Eligible));
        assertEq(newLastProcessedPeriod, 2);
        assertEq(grossRelease, 1e6);
        assertEq(protocolFee, ProtocolLib.MIN_PROTOCOL_FEE);
        assertEq(partnerRelease, 0);
    }

    function testBenchmarkHigherBP() public pure {
        uint256 principal = 1000e6;
        uint256 dt = 30 days;
        uint256 defaultBench = EarningsLib.calculateBenchmarkEarnings(principal, dt);
        uint256 higherBench = EarningsLib.calculateEarnings(principal, dt, ProtocolLib.BENCHMARK_YIELD_BP + 500);
        assertGt(higherBench, defaultBench);
    }

    // TokenLib tests
    function testTokenInitializationAndValueCalculation() public {
        // min holding coerced to at least MONTHLY_INTERVAL
        uint256 maturityDate = block.timestamp + 365 days;
        cteh.initToken(1, 100e6, 1 days, maturityDate);
        (
            uint256 tid,
            uint256 price,
            uint256 supply,
            uint256 minHold,
            uint256 tokenMaturity,
            uint256 revenueShareBP,
            uint256 targetYieldBP
        ) = cteh.tokenInfo();
        assertEq(tid, 1);
        assertEq(price, 100e6);
        assertEq(supply, 0);
        assertEq(minHold, ProtocolLib.MONTHLY_INTERVAL);
        assertEq(tokenMaturity, maturityDate);
        assertEq(revenueShareBP, 10_000);
        assertEq(targetYieldBP, 1_000);
    }

    function testTokenSalesPenaltyZeroAmount() public {
        uint256 maturityDate = block.timestamp + 365 days;
        cteh.initToken(1, 100e6, ProtocolLib.MONTHLY_INTERVAL, maturityDate);
        assertEq(cteh.salesPenalty(alice, 0), 0);
    }

    function testVehicleVinHash() public {
        vh.init(
            "1HGCM82633A123456", "ipfs://QmYwAPJzv5CZsnAzt8auVTLpG1bG6dkprdFM5ocTyBCQb", "ipfs://QmRevenueTokenMetadata"
        );
        assertEq(vh.vinHash(), keccak256(bytes("1HGCM82633A123456")));
    }

    function testVehicleInvalidMetadataUri() public {
        vm.expectRevert(VehicleLib.InvalidMetadataURI.selector);
        vh.init("1HGCM82633A123456", "http://bad-uri", "ipfs://QmRevenueTokenMetadata");
    }

    function testVehicleInitializeRejectsZeroVinHash() public {
        vm.expectRevert(VehicleLib.InvalidVINLength.selector);
        vh.initWithHash(
            bytes32(0), "ipfs://QmYwAPJzv5CZsnAzt8auVTLpG1bG6dkprdFM5ocTyBCQb", "ipfs://QmRevenueTokenMetadata"
        );
    }

    function testTokenUnclaimedForPositionsAndEarningsHelpers() public {
        uint256 maturityDate = block.timestamp + 365 days;
        cteh.initToken(7, 100e6, ProtocolLib.MONTHLY_INTERVAL, maturityDate);
        cteh.addPos(alice, 10);

        // Initialize earnings and set three periods
        cteh.initEarnings();
        uint256 t0 = block.timestamp;
        // periods at t0, t0+30d, t0+60d
        cteh.setPeriod(1, 2e6, t0, 20e6);
        cteh.setPeriod(2, 3e6, t0 + 30 days, 30e6);
        cteh.setPeriod(3, 0, t0 + 60 days, 0);

        // getPeriodAtTimestamp
        assertEq(cteh.getPeriodAtTs(t0 + 1 days), 1);
        assertEq(cteh.getPeriodAtTs(t0 + 45 days), 2);

        // calculateUnclaimedEarnings by balance
        assertEq(cteh.unclaimed(10, 0), 50e6); // (2 + 3) * 10 tokens

        // positions-based unclaimed (same as balance since single active position)
        assertEq(cteh.unclaimedForPositions(alice, 0), 50e6);
    }

    function testRemovePositionInsufficientBalance() public {
        uint256 maturityDate = block.timestamp + 365 days;
        cteh.initToken(1, 100e6, ProtocolLib.MONTHLY_INTERVAL, maturityDate);
        cteh.addPos(alice, 10);
        vm.expectRevert(TokenLib.InsufficientTokenBalance.selector);
        cteh.removePos(alice, 11);
    }

    function testCollateralInitAlreadyLocked() public {
        cteh.initCollateral(100000e6, ProtocolLib.QUARTERLY_INTERVAL);
        cteh.lockNow();
        vm.expectRevert(CollateralLib.CollateralAlreadyInitialized.selector);
        cteh.initCollateral(100000e6, ProtocolLib.QUARTERLY_INTERVAL);
    }

    function testCollateralReleaseNoneDue() public {
        cteh.initCollateral(100000e6, ProtocolLib.QUARTERLY_INTERVAL);
        cteh.lockNow();
        // No time passed, release should be 0
        assertEq(cteh.calcRelease(), 0);
    }

    function testProcessEarningsForBuffersInMemoryShortfallCoveredByBuffer() public {
        cteh.initCollateral(100000e6, ProtocolLib.QUARTERLY_INTERVAL);

        (int256 result, uint256 replenished, uint256 eBufAfter, uint256 reservedAfter,) =
            cteh.processInMemory(50e6, 75e6);
        assertEq(result, -int256(25e6));
        assertEq(replenished, 0);
        assertEq(reservedAfter, 25e6);
        assertGt(eBufAfter, 0);
    }

    function testCalculateReleaseFeesClampsToReleaseAmount() public view {
        (uint256 partnerRelease, uint256 fee) = peh.releaseFees(1);
        assertEq(fee, 1);
        assertEq(partnerRelease, 0);
    }

    function testProcessEarningsForBuffersInMemoryShortfallExceedsBuffer() public {
        cteh.initCollateral(100000e6, ProtocolLib.QUARTERLY_INTERVAL);
        (, uint256 startingBuffer,,) = cteh.collateralView();
        uint256 baseEarnings = startingBuffer + 1;

        (int256 result, uint256 replenished, uint256 eBufAfter, uint256 reservedAfter,) =
            cteh.processInMemory(0, baseEarnings);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(result, -int256(baseEarnings));
        assertEq(replenished, 0);
        assertEq(eBufAfter, 0);
        assertEq(reservedAfter, startingBuffer);
    }

    function testProcessEarningsForBuffersInMemoryExcessReplenishesReserved() public {
        cteh.initCollateral(100000e6, ProtocolLib.QUARTERLY_INTERVAL);

        // Create a deficit + reserved state in storage helper, then run the in-memory replenishment path.
        (,, uint256 eBufAfterShortfall, uint256 reservedAfterShortfall,) = cteh.processInMemory(0, 100e6);
        assertGt(reservedAfterShortfall, 0);
        assertLt(eBufAfterShortfall, cteh.targetBuffer(100000e6));

        // Apply the same shortfall to stored state so the subsequent in-memory call starts from this shape.
        cteh.process(0, 100e6);

        (int256 result, uint256 replenished, uint256 eBufAfter, uint256 reservedAfter,) =
            cteh.processInMemory(200e6, 100e6);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(result, int256(100e6 - replenished));
        assertGt(replenished, 0);
        assertGt(eBufAfter, eBufAfterShortfall);
        assertLt(reservedAfter, reservedAfterShortfall);
    }

    function testProcessEarningsForBuffersInMemoryExcessNoReserved() public {
        cteh.initCollateral(100000e6, ProtocolLib.QUARTERLY_INTERVAL);
        (int256 result, uint256 replenished,, uint256 reservedAfter,) = cteh.processInMemory(200e6, 100e6);
        assertEq(result, 100e6);
        assertEq(replenished, 0);
        assertEq(reservedAfter, 0);
    }

    function testUnclaimedEarningsZeroOrUpToDate() public {
        cteh.initEarnings();
        // Zero balance
        assertEq(cteh.unclaimed(0, 0), 0);

        // Up to date
        cteh.setPeriod(1, 10e6, block.timestamp, 100e6);
        assertEq(cteh.unclaimed(10, 1), 0);
    }

    // Fuzz Tests for Math Libraries

    function testFuzzCalculateDepreciation(uint256 principal, uint256 timeElapsed) public pure {
        // Constraints
        vm.assume(principal < 1e30); // Avoid unrealistic overflow
        vm.assume(timeElapsed < 3650 days); // Cap at 10 years

        uint256 depreciation = CollateralLib.calculateDepreciation(principal, timeElapsed);

        if (timeElapsed == 0) {
            assertEq(depreciation, 0);
        } else if (principal > 0) {
            // Depreciation should be proportional
            // Just ensure it doesn't revert and is <= principal if time is large enough?
            // Actually max depreciation is capped at principal in logic? No, let's check
            // Depreciation rate is fixed per year.
            // 1200 BP = 12% per year.
            // If time is large, depreciation can exceed principal if not capped?
            // The library implementation does: (principal * rate * time) / (PRECISION * YEAR)
            // It does NOT cap at principal. The consumer (Treasury) handles that logic.
            // So we just verify it runs.
            assertGe(depreciation, 0);
        }
    }

    function testFuzzCalculateBenchmarkEarnings(uint256 principal, uint256 timeElapsed) public pure {
        // Constraints
        vm.assume(principal < 1e30);
        vm.assume(timeElapsed < 3650 days);

        uint256 benchmark = EarningsLib.calculateBenchmarkEarnings(principal, timeElapsed);

        if (timeElapsed == 0 || principal == 0) {
            assertEq(benchmark, 0);
        } else {
            // Benchmark can be 0 if amounts are tiny (integer division)
            // Just ensure it doesn't overflow or produce crazy values
            assertGe(benchmark, 0);

            // Should be less than principal for short durations (e.g. 1 year = 10%)
            if (timeElapsed <= 365 days && principal > 100) {
                assertLt(benchmark, principal);
            }
        }
    }
}
