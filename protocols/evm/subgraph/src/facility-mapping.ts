import {
  AssetRegistered as AssetRegisteredEvent,
  FacilityMetadataUpdated as FacilityMetadataUpdatedEvent,
  FacilityRegistered as FacilityRegisteredEvent
} from "../generated/FacilityRegistry/FacilityRegistry"

import { Facility } from "../generated/schema"

export function handleFacilityAssetRegistered(event: AssetRegisteredEvent): void {
  let id = event.params.assetId.toString()
  let facility = Facility.load(id)
  if (!facility) {
    facility = new Facility(id)
  }

  facility.partner = event.params.owner
  facility.assetValue = event.params.assetValue
  facility.blockNumber = event.block.number
  facility.blockTimestamp = event.block.timestamp
  facility.transactionHash = event.transaction.hash
  facility.save()
}

export function handleFacilityRegistered(event: FacilityRegisteredEvent): void {
  let facility = Facility.load(event.params.facilityId.toString())
  if (!facility) return

  facility.partner = event.params.partner
  facility.facilityCommitment = event.params.facilityCommitment
  facility.blockNumber = event.block.number
  facility.blockTimestamp = event.block.timestamp
  facility.transactionHash = event.transaction.hash
  facility.save()
}

export function handleFacilityMetadataUpdated(event: FacilityMetadataUpdatedEvent): void {
  let facility = Facility.load(event.params.facilityId.toString())
  if (!facility) return

  facility.facilityCommitment = event.params.facilityCommitment
  facility.assetMetadataURI = event.params.assetMetadataURI
  facility.revenueTokenMetadataURI = event.params.revenueTokenMetadataURI
  facility.blockNumber = event.block.number
  facility.blockTimestamp = event.block.timestamp
  facility.transactionHash = event.transaction.hash
  facility.save()
}
