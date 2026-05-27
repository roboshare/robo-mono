import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts"
import {
  RoboshareTokens,
  TransferSingle as RoboshareTokensTransferSingleEvent,
  RevenueTokenInfoSet as RevenueTokenInfoSetEvent
} from "../generated/RoboshareTokens/RoboshareTokens"
import {
  RegistryRouter,
  IdBoundToRegistry as IdBoundToRegistryEvent
} from "../generated/RegistryRouter/RegistryRouter"
import {
  VehicleRegistry,
  AssetRegistered as AssetRegisteredEvent,
  VehicleRegistered as VehicleRegisteredEvent
} from "../generated/VehicleRegistry/VehicleRegistry"
import {
  Treasury,
  CollateralLocked as CollateralLockedEvent
} from "../generated/Treasury/Treasury"
import {
  EarningsDistributed as EarningsDistributedEvent
} from "../generated/EarningsManager/EarningsManager"
import {
  Marketplace,
  ListingCreated as ListingCreatedEvent,
  RevenueTokensTraded as RevenueTokensTradedEvent,
  ListingExtended as ListingExtendedEvent,
  ListingEnded as ListingEndedEvent,
  PrimaryPoolCreated as PrimaryPoolCreatedEvent,
  PrimaryPoolPaused as PrimaryPoolPausedEvent,
  PrimaryPoolUnpaused as PrimaryPoolUnpausedEvent,
  PrimaryPoolClosed as PrimaryPoolClosedEvent,
  PrimaryPoolPurchased as PrimaryPoolPurchasedEvent,
  PrimaryPoolRedeemed as PrimaryPoolRedeemedEvent
} from "../generated/Marketplace/Marketplace"

import {
  RoboshareTokensContract,
  RoboshareToken,
  TransferSingleEvent,
  RegistryRouterContract,
  BoundId,
  VehicleRegistryContract,
  Vehicle,
  TreasuryContract,
  CollateralLock,
  MarketplaceContract,
  Listing,
  EarningsDistribution,
  AssetEarning,
  PrimaryPool,
  PrimaryPoolPurchase,
  PrimaryPoolRedemption
} from "../generated/schema"

const ZERO_ADDRESS = Address.fromString("0x0000000000000000000000000000000000000000")
const ZERO_BIGINT = BigInt.fromI32(0)

function assetIdFromTokenId(tokenId: BigInt): BigInt {
  const one = BigInt.fromI32(1)
  if (tokenId.le(one)) return BigInt.fromI32(0)
  return tokenId.minus(one)
}

function isAssetTokenId(tokenId: BigInt): bool {
  return tokenId.mod(BigInt.fromI32(2)).equals(BigInt.fromI32(1))
}

function getOrCreateVehicle(id: string, event: ethereum.Event): Vehicle {
  let vehicle = Vehicle.load(id)

  if (!vehicle) {
    vehicle = new Vehicle(id)
    vehicle.partner = ZERO_ADDRESS
    vehicle.vin = null
    vehicle.vinHash = null
    vehicle.make = null
    vehicle.model = null
    vehicle.year = null
    vehicle.assetValue = ZERO_BIGINT
    vehicle.metadataURI = null
    vehicle.blockNumber = event.block.number
    vehicle.blockTimestamp = event.block.timestamp
    vehicle.transactionHash = event.transaction.hash
  }

  return vehicle
}

function eventEntityId(event: ethereum.Event): string {
  return event.transaction.hash.concatI32(event.logIndex.toI32()).toHexString()
}

export function handleRoboshareTokensTransferSingle(
  event: RoboshareTokensTransferSingleEvent
): void {
  let entity = new TransferSingleEvent(eventEntityId(event))
  entity.operator = event.params.operator
  entity.from = event.params.from
  entity.to = event.params.to
  entity.tokenId = event.params.id
  entity.value = event.params.value
  entity.blockNumber = event.block.number
  entity.blockTimestamp = event.block.timestamp
  entity.transactionHash = event.transaction.hash
  entity.save()

  let contract = RoboshareTokensContract.load("1")
  if (!contract) {
    contract = new RoboshareTokensContract("1")
    contract.address = event.address
    contract.save()
  }
}

export function handleRevenueTokenInfoSet(event: RevenueTokenInfoSetEvent): void {
  let token = new RoboshareToken(event.params.revenueTokenId.toString())
  token.revenueTokenId = event.params.revenueTokenId
  token.price = event.params.price
  token.supply = event.params.supply
  token.maturityDate = event.params.maturityDate
  token.createdAt = event.block.timestamp
  token.setAtBlock = event.block.number
  token.save()
}

export function handleIdBoundToRegistry(event: IdBoundToRegistryEvent): void {
  let boundId = new BoundId(event.params.id.toString())
  boundId.idValue = event.params.id
  boundId.registry = event.params.registry
  boundId.blockNumber = event.block.number
  boundId.blockTimestamp = event.block.timestamp
  boundId.transactionHash = event.transaction.hash
  boundId.save()

  let contract = RegistryRouterContract.load("1")
  if (!contract) {
    contract = new RegistryRouterContract("1")
    contract.address = event.address
    contract.save()
  }
}

export function handleAssetRegistered(event: AssetRegisteredEvent): void {
  let id = event.params.assetId.toString()
  let vehicle = getOrCreateVehicle(id, event)

  vehicle.partner = event.params.owner
  vehicle.assetValue = event.params.assetValue
  vehicle.blockNumber = event.block.number
  vehicle.blockTimestamp = event.block.timestamp
  vehicle.transactionHash = event.transaction.hash
  vehicle.save()
}

export function handleVehicleRegistered(event: VehicleRegisteredEvent): void {
  let id = event.params.vehicleId.toString()
  let vehicle = getOrCreateVehicle(id, event)

  vehicle.partner = event.params.partner
  vehicle.vinHash = event.params.vinHash
  vehicle.blockNumber = event.block.number
  vehicle.blockTimestamp = event.block.timestamp
  vehicle.transactionHash = event.transaction.hash
  vehicle.save()

  let registryContract = VehicleRegistryContract.load("1")
  if (!registryContract) {
    registryContract = new VehicleRegistryContract("1")
    registryContract.address = event.address
    registryContract.save()
  }
}


export function handleCollateralLocked(event: CollateralLockedEvent): void {
  let collateralLock = new CollateralLock(
    event.params.assetId.toString() + "-" + event.transaction.hash.toHex()
  )
  collateralLock.assetId = event.params.assetId
  collateralLock.partner = event.params.partner
  collateralLock.amount = event.params.amount
  collateralLock.blockNumber = event.block.number
  collateralLock.blockTimestamp = event.block.timestamp
  collateralLock.transactionHash = event.transaction.hash
  collateralLock.save()

  let contract = TreasuryContract.load("1")
  if (!contract) {
    contract = new TreasuryContract("1")
    contract.address = event.address
    contract.save()
  }
}

export function handleEarningsDistributed(event: EarningsDistributedEvent): void {
  // Create individual distribution record
  let distribution = new EarningsDistribution(eventEntityId(event))
  distribution.assetId = event.params.assetId
  distribution.partner = event.params.partner
  distribution.totalRevenue = event.params.totalRevenue
  distribution.netEarnings = event.params.investorEarnings
  distribution.period = event.params.period
  distribution.blockNumber = event.block.number
  distribution.blockTimestamp = event.block.timestamp
  distribution.transactionHash = event.transaction.hash
  distribution.save()

  // Update or create aggregate earnings for asset
  let assetEarningsId = event.params.assetId.toString()
  let assetEarnings = AssetEarning.load(assetEarningsId)

  if (!assetEarnings) {
    assetEarnings = new AssetEarning(assetEarningsId)
    assetEarnings.assetId = event.params.assetId
    assetEarnings.totalEarnings = BigInt.fromI32(0)
    assetEarnings.totalRevenue = BigInt.fromI32(0)
    assetEarnings.distributionCount = BigInt.fromI32(0)
    assetEarnings.firstDistributionAt = event.block.timestamp
  }

  assetEarnings.totalEarnings = assetEarnings.totalEarnings.plus(event.params.investorEarnings)
  assetEarnings.totalRevenue = assetEarnings.totalRevenue.plus(event.params.totalRevenue)
  assetEarnings.distributionCount = assetEarnings.distributionCount.plus(BigInt.fromI32(1))
  assetEarnings.lastDistributionAt = event.block.timestamp
  assetEarnings.save()
}

export function handleListingCreated(event: ListingCreatedEvent): void {
  let listing = new Listing(event.params.listingId.toString())
  listing.tokenId = event.params.tokenId
  listing.assetId = event.params.assetId
  listing.seller = event.params.seller
  listing.amount = event.params.amount
  listing.amountSold = BigInt.fromI32(0)
  listing.pricePerToken = event.params.pricePerToken
  listing.expiresAt = event.params.expiresAt
  listing.buyerPaysFee = event.params.buyerPaysFee
  listing.status = "active"
  listing.isEnded = false
  listing.endedAt = null
  listing.createdAt = event.block.timestamp
  listing.blockNumber = event.block.number
  listing.blockTimestamp = event.block.timestamp
  listing.transactionHash = event.transaction.hash
  listing.save()

  let contract = MarketplaceContract.load("1")
  if (!contract) {
    contract = new MarketplaceContract("1")
    contract.address = event.address
    contract.save()
  }
}

export function handleRevenueTokensTraded(event: RevenueTokensTradedEvent): void {
  // Update listing amountSold and remaining amount
  let listing = Listing.load(event.params.listingId.toString())
  if (listing) {
    listing.amountSold = listing.amountSold.plus(event.params.amount)
    listing.amount = listing.amount.minus(event.params.amount)
    if (listing.amount.equals(BigInt.fromI32(0))) {
      listing.status = "sold_out"
      listing.isEnded = true
      listing.endedAt = event.block.timestamp
    }
    listing.save()
  }
}

export function handleListingEnded(event: ListingEndedEvent): void {
  let listing = Listing.load(event.params.listingId.toString())
  if (listing) {
    listing.status = "ended"
    listing.isEnded = true
    listing.endedAt = event.block.timestamp
    listing.save()
  }
}

export function handleListingExtended(event: ListingExtendedEvent): void {
  let listing = Listing.load(event.params.listingId.toString())
  if (listing) {
    listing.expiresAt = event.params.newExpiresAt
    listing.save()
  }
}

export function handlePrimaryPoolCreated(event: PrimaryPoolCreatedEvent): void {
  let pool = new PrimaryPool(event.params.tokenId.toString())
  pool.tokenId = event.params.tokenId
  pool.assetId = assetIdFromTokenId(event.params.tokenId)
  pool.partner = event.params.partner
  pool.pricePerToken = event.params.pricePerToken
  pool.maxSupply = event.params.maxSupply
  pool.immediateProceeds = event.params.immediateProceeds
  pool.protectionEnabled = event.params.protectionEnabled
  pool.isPaused = false
  pool.isClosed = false
  pool.createdAt = event.block.timestamp
  pool.pausedAt = null
  pool.closedAt = null
  pool.totalPurchased = BigInt.fromI32(0)
  pool.totalRedeemed = BigInt.fromI32(0)
  pool.totalPartnerProceedsReleased = BigInt.fromI32(0)
  pool.save()
}

export function handlePrimaryPoolPaused(event: PrimaryPoolPausedEvent): void {
  let pool = PrimaryPool.load(event.params.tokenId.toString())
  if (!pool) return
  pool.isPaused = true
  pool.pausedAt = event.block.timestamp
  pool.save()
}

export function handlePrimaryPoolUnpaused(event: PrimaryPoolUnpausedEvent): void {
  let pool = PrimaryPool.load(event.params.tokenId.toString())
  if (!pool) return
  pool.isPaused = false
  pool.save()
}

export function handlePrimaryPoolClosed(event: PrimaryPoolClosedEvent): void {
  let pool = PrimaryPool.load(event.params.tokenId.toString())
  if (!pool) return
  pool.isClosed = true
  pool.closedAt = event.block.timestamp
  pool.save()
}

export function handlePrimaryPoolPurchased(event: PrimaryPoolPurchasedEvent): void {
  let purchase = new PrimaryPoolPurchase(eventEntityId(event))
  purchase.tokenId = event.params.tokenId
  purchase.buyer = event.params.buyer
  purchase.amount = event.params.amount
  purchase.totalCost = event.params.totalCost
  purchase.protocolFee = event.params.protocolFee
  purchase.partnerProceeds = event.params.partnerProceeds
  purchase.blockNumber = event.block.number
  purchase.blockTimestamp = event.block.timestamp
  purchase.transactionHash = event.transaction.hash
  purchase.save()

  let pool = PrimaryPool.load(event.params.tokenId.toString())
  if (!pool) return
  pool.totalPurchased = pool.totalPurchased.plus(event.params.amount)
  pool.totalPartnerProceedsReleased = pool.totalPartnerProceedsReleased.plus(event.params.partnerProceeds)
  pool.save()
}

export function handlePrimaryPoolRedeemed(event: PrimaryPoolRedeemedEvent): void {
  let redemption = new PrimaryPoolRedemption(eventEntityId(event))
  redemption.tokenId = event.params.tokenId
  redemption.holder = event.params.holder
  redemption.amountBurned = event.params.amountBurned
  redemption.payout = event.params.payout
  redemption.investorLiquidityAfter = event.params.investorLiquidityAfter
  redemption.blockNumber = event.block.number
  redemption.blockTimestamp = event.block.timestamp
  redemption.transactionHash = event.transaction.hash
  redemption.save()

  let pool = PrimaryPool.load(event.params.tokenId.toString())
  if (!pool) return
  pool.totalRedeemed = pool.totalRedeemed.plus(event.params.amountBurned)
  pool.save()
}
