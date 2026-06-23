import { BigInt } from "@graphprotocol/graph-ts"
import {
  AssetRegistered as AssetRegisteredEvent,
  VehicleMetadataUpdated as VehicleMetadataUpdatedEvent
} from "../generated/VehicleRegistry/VehicleRegistry"
import {
  ListingCreated as ListingCreatedEvent,
  RevenueTokensTraded as RevenueTokensTradedEvent,
  ListingExtended as ListingExtendedEvent,
  ListingEnded as ListingEndedEvent,
  PrimaryPoolCreated as PrimaryPoolCreatedEvent,
  PrimaryPoolPaused as PrimaryPoolPausedEvent,
  PrimaryPoolUnpaused as PrimaryPoolUnpausedEvent,
  PrimaryPoolClosed as PrimaryPoolClosedEvent
} from "../generated/Marketplace/Marketplace"
import { EarningsDistributed as EarningsDistributedEvent } from "../generated/EarningsManager/EarningsManager"
import {
  PartnerAuthorized as PartnerAuthorizedEvent,
  PartnerNameUpdated as PartnerNameUpdatedEvent,
  PartnerRevoked as PartnerRevokedEvent
} from "../generated/PartnerManager/PartnerManager"

import {
  EarningsDistribution,
  Vehicle,
  Listing,
  PrimaryPool,
  Partner
} from "../generated/schema"

function assetIdFromTokenId(tokenId: BigInt): BigInt {
  const one = BigInt.fromI32(1)
  if (tokenId.le(one)) return BigInt.fromI32(0)
  return tokenId.minus(one)
}

export function handlePartnerAuthorized(event: PartnerAuthorizedEvent): void {
  let id = event.params.partner.toHexString()
  let partner = Partner.load(id)
  if (!partner) {
    partner = new Partner(id)
    partner.address = event.params.partner
  }

  partner.name = event.params.name
  partner.isAuthorized = true
  partner.registeredAt = event.block.timestamp
  partner.revokedAt = null
  partner.blockNumber = event.block.number
  partner.blockTimestamp = event.block.timestamp
  partner.transactionHash = event.transaction.hash
  partner.save()
}

export function handlePartnerRevoked(event: PartnerRevokedEvent): void {
  let id = event.params.partner.toHexString()
  let partner = Partner.load(id)
  if (!partner) {
    partner = new Partner(id)
    partner.address = event.params.partner
    partner.name = null
    partner.registeredAt = null
  }

  partner.isAuthorized = false
  partner.name = null
  partner.registeredAt = null
  partner.revokedAt = event.block.timestamp
  partner.blockNumber = event.block.number
  partner.blockTimestamp = event.block.timestamp
  partner.transactionHash = event.transaction.hash
  partner.save()
}

export function handlePartnerNameUpdated(event: PartnerNameUpdatedEvent): void {
  let id = event.params.partner.toHexString()
  let partner = Partner.load(id)
  if (!partner) {
    partner = new Partner(id)
    partner.address = event.params.partner
    partner.isAuthorized = true
    partner.registeredAt = event.block.timestamp
    partner.revokedAt = null
  }

  partner.name = event.params.newName
  partner.blockNumber = event.block.number
  partner.blockTimestamp = event.block.timestamp
  partner.transactionHash = event.transaction.hash
  partner.save()
}

export function handleVehicleAssetRegistered(event: AssetRegisteredEvent): void {
  let id = event.params.assetId.toString()
  let vehicle = Vehicle.load(id)
  if (!vehicle) {
    vehicle = new Vehicle(id)
  }

  vehicle.partner = event.params.owner
  vehicle.assetValue = event.params.assetValue
  vehicle.blockNumber = event.block.number
  vehicle.blockTimestamp = event.block.timestamp
  vehicle.transactionHash = event.transaction.hash
  vehicle.save()
}

export function handleVehicleMetadataUpdated(event: VehicleMetadataUpdatedEvent): void {
  let vehicle = Vehicle.load(event.params.vehicleId.toString())
  if (!vehicle) return

  vehicle.metadataURI = event.params.assetMetadataURI
  vehicle.blockNumber = event.block.number
  vehicle.blockTimestamp = event.block.timestamp
  vehicle.transactionHash = event.transaction.hash
  vehicle.save()
}

export function handleListingCreated(event: ListingCreatedEvent): void {
  let listingId = event.params.listingId.toString()
  if (Listing.load(listingId) != null) {
    return
  }

  let listing = new Listing(listingId)
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
  let poolId = event.params.tokenId.toString()
  if (PrimaryPool.load(poolId) != null) {
    return
  }

  let pool = new PrimaryPool(poolId)
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
  pool.save()
}

export function handlePrimaryPoolPaused(event: PrimaryPoolPausedEvent): void {
  let pool = PrimaryPool.load(event.params.tokenId.toString())
  if (!pool) return
  pool.isPaused = true
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
  pool.save()
}

export function handleEarningsDistributed(event: EarningsDistributedEvent): void {
  let distribution = new EarningsDistribution(
    event.transaction.hash.toHexString().concat("-").concat(event.logIndex.toString())
  )

  distribution.assetId = event.params.assetId
  distribution.partner = event.params.partner
  distribution.totalRevenue = event.params.totalRevenue
  distribution.investorEarnings = event.params.investorEarnings
  distribution.period = event.params.period
  distribution.blockNumber = event.block.number
  distribution.blockTimestamp = event.block.timestamp
  distribution.transactionHash = event.transaction.hash
  distribution.save()
}
