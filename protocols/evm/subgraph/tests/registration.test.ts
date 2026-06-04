import { assert, clearStore, describe, newMockEvent, test } from "matchstick-as/assembly/index"
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import {
  AssetRegistered,
  VehicleMetadataUpdated
} from "../generated/VehicleRegistry/VehicleRegistry"
import { PrimaryPoolCreated } from "../generated/Marketplace/Marketplace"
import {
  handleAssetRegistered,
  handlePrimaryPoolCreated,
  handleVehicleMetadataUpdated
} from "../src/mapping"
import { PrimaryPool, Vehicle } from "../generated/schema"

const PARTNER = Address.fromString("0x8166E0fd513B1231DC77D98380F4a22024342347")
const REGISTRY = Address.fromString("0xB41bBD6F6dEb64E3A2C19e5Ee0d1e71427d43903")
const MARKETPLACE = Address.fromString("0x8f6453B2E6b1aCB9EAD2185D6cF1B264350bf819")
const TX = Bytes.fromHexString("0x9178d980b4c2d49c7cd9e068dd8d240f67e25c989fa0d12025e0ad3d4d97a416")

function mockEvent<T extends ethereum.Event>(address: Address, logIndex: i32): T {
  let event = changetype<T>(newMockEvent())
  event.address = address
  event.transaction.hash = TX
  event.logIndex = BigInt.fromI32(logIndex)
  event.block.number = BigInt.fromI32(272120450)
  event.block.timestamp = BigInt.fromI32(1710000000)
  return event
}

describe("Launch offering registration flow", () => {
  test("indexes vehicle and primary pool entities", () => {
    clearStore()

    let assetRegistered = changetype<AssetRegistered>(mockEvent<AssetRegistered>(REGISTRY, 9))
    assetRegistered.parameters = new Array()
    assetRegistered.parameters.push(
      new ethereum.EventParam("assetId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1)))
    )
    assetRegistered.parameters.push(new ethereum.EventParam("owner", ethereum.Value.fromAddress(PARTNER)))
    assetRegistered.parameters.push(
      new ethereum.EventParam("assetValue", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(50000)))
    )
    assetRegistered.parameters.push(
      new ethereum.EventParam("status", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(0)))
    )
    handleAssetRegistered(assetRegistered)

    let poolCreated = changetype<PrimaryPoolCreated>(mockEvent<PrimaryPoolCreated>(MARKETPLACE, 15))
    poolCreated.parameters = new Array()
    poolCreated.parameters.push(
      new ethereum.EventParam("tokenId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(2)))
    )
    poolCreated.parameters.push(
      new ethereum.EventParam("partner", ethereum.Value.fromAddress(PARTNER))
    )
    poolCreated.parameters.push(
      new ethereum.EventParam("pricePerToken", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(500)))
    )
    poolCreated.parameters.push(
      new ethereum.EventParam("maxSupply", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(500)))
    )
    poolCreated.parameters.push(
      new ethereum.EventParam("immediateProceeds", ethereum.Value.fromBoolean(false))
    )
    poolCreated.parameters.push(
      new ethereum.EventParam("protectionEnabled", ethereum.Value.fromBoolean(false))
    )
    handlePrimaryPoolCreated(poolCreated)

    assert.entityCount("Vehicle", 1)
    assert.entityCount("PrimaryPool", 1)

    assert.fieldEquals("Vehicle", "1", "partner", PARTNER.toHexString())
    assert.fieldEquals("PrimaryPool", "2", "assetId", "1")
  })

  test("updates vehicle metadata from VehicleMetadataUpdated", () => {
    clearStore()

    let assetRegistered = changetype<AssetRegistered>(mockEvent<AssetRegistered>(REGISTRY, 1))
    assetRegistered.parameters = new Array()
    assetRegistered.parameters.push(
      new ethereum.EventParam("assetId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1)))
    )
    assetRegistered.parameters.push(new ethereum.EventParam("owner", ethereum.Value.fromAddress(PARTNER)))
    assetRegistered.parameters.push(
      new ethereum.EventParam("assetValue", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(50000)))
    )
    assetRegistered.parameters.push(
      new ethereum.EventParam("status", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(0)))
    )
    handleAssetRegistered(assetRegistered)

    let metadataUpdated = changetype<VehicleMetadataUpdated>(
      mockEvent<VehicleMetadataUpdated>(REGISTRY, 3)
    )
    metadataUpdated.parameters = new Array()
    metadataUpdated.parameters.push(
      new ethereum.EventParam("vehicleId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1)))
    )
    metadataUpdated.parameters.push(
      new ethereum.EventParam("assetMetadataURI", ethereum.Value.fromString("ipfs://updated-asset"))
    )
    metadataUpdated.parameters.push(
      new ethereum.EventParam(
        "revenueTokenMetadataURI",
        ethereum.Value.fromString("ipfs://updated-revenue")
      )
    )
    handleVehicleMetadataUpdated(metadataUpdated)

    assert.entityCount("Vehicle", 1)
    assert.fieldEquals("Vehicle", "1", "metadataURI", "ipfs://updated-asset")
    assert.assertNotNull(Vehicle.load("1"))
  })
})
