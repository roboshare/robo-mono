import { assert, clearStore, describe, newMockEvent, test } from "matchstick-as/assembly/index"
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import {
  AssetRegistered,
  VehicleRegistered,
  VehicleMetadataUpdated
} from "../generated/VehicleRegistry/VehicleRegistry"
import {
  RevenueTokenInfoSet,
  TokenMetadataURISet,
  TransferSingle
} from "../generated/RoboshareTokens/RoboshareTokens"
import { IdBoundToRegistry } from "../generated/RegistryRouter/RegistryRouter"
import { PrimaryPoolCreated } from "../generated/Marketplace/Marketplace"
import {
  handleAssetRegistered,
  handleIdBoundToRegistry,
  handlePrimaryPoolCreated,
  handleRevenueTokenInfoSet,
  handleRoboshareTokensTransferSingle,
  handleTokenMetadataURISet,
  handleVehicleMetadataUpdated,
  handleVehicleRegistered
} from "../src/mapping"
import { BoundId, PrimaryPool, RoboshareToken, Vehicle } from "../generated/schema"

const PARTNER = Address.fromString("0x8166E0fd513B1231DC77D98380F4a22024342347")
const ROUTER = Address.fromString("0x058996C4588E0e74a41929B1d9d1002a29DB880B")
const REGISTRY = Address.fromString("0xB41bBD6F6dEb64E3A2C19e5Ee0d1e71427d43903")
const TOKENS = Address.fromString("0x10d06b778b036F57ef927E1eE9DAEc9B0F50489D")
const MARKETPLACE = Address.fromString("0x8f6453B2E6b1aCB9EAD2185D6cF1B264350bf819")
const TX = Bytes.fromHexString("0x9178d980b4c2d49c7cd9e068dd8d240f67e25c989fa0d12025e0ad3d4d97a416")

function entityId(logIndex: i32): string {
  return TX.concatI32(logIndex).toHexString()
}

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
  test("indexes vehicle, token, and primary pool entities", () => {
    clearStore()

    let boundAsset = changetype<IdBoundToRegistry>(mockEvent<IdBoundToRegistry>(ROUTER, 5))
    boundAsset.parameters = new Array()
    let boundAssetId = new ethereum.EventParam("id", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1)))
    let boundAssetRegistry = new ethereum.EventParam(
      "registry",
      ethereum.Value.fromAddress(REGISTRY)
    )
    boundAsset.parameters.push(boundAssetId)
    boundAsset.parameters.push(boundAssetRegistry)
    handleIdBoundToRegistry(boundAsset)

    let boundRevenue = changetype<IdBoundToRegistry>(mockEvent<IdBoundToRegistry>(ROUTER, 6))
    boundRevenue.parameters = new Array()
    let boundRevenueId = new ethereum.EventParam("id", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(2)))
    let boundRevenueRegistry = new ethereum.EventParam(
      "registry",
      ethereum.Value.fromAddress(REGISTRY)
    )
    boundRevenue.parameters.push(boundRevenueId)
    boundRevenue.parameters.push(boundRevenueRegistry)
    handleIdBoundToRegistry(boundRevenue)

    let metadata = changetype<TokenMetadataURISet>(mockEvent<TokenMetadataURISet>(TOKENS, 7))
    metadata.parameters = new Array()
    metadata.parameters.push(
      new ethereum.EventParam("tokenId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1)))
    )
    metadata.parameters.push(
      new ethereum.EventParam("metadataURI", ethereum.Value.fromString("ipfs://asset-metadata"))
    )
    handleTokenMetadataURISet(metadata)

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

    let vehicleRegistered = changetype<VehicleRegistered>(mockEvent<VehicleRegistered>(REGISTRY, 10))
    vehicleRegistered.parameters = new Array()
    vehicleRegistered.parameters.push(
      new ethereum.EventParam("vehicleId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1)))
    )
    vehicleRegistered.parameters.push(
      new ethereum.EventParam("partner", ethereum.Value.fromAddress(PARTNER))
    )
    vehicleRegistered.parameters.push(
      new ethereum.EventParam(
        "vinHash",
        ethereum.Value.fromFixedBytes(Bytes.fromHexString("0x1c88866c00dc50d846f65ff40f18eb0c2e986f4182649027b5b064679a5cadcd") as Bytes)
      )
    )
    handleVehicleRegistered(vehicleRegistered)

    let transfer = changetype<TransferSingle>(mockEvent<TransferSingle>(TOKENS, 11))
    transfer.parameters = new Array()
    transfer.parameters.push(
      new ethereum.EventParam("operator", ethereum.Value.fromAddress(REGISTRY))
    )
    transfer.parameters.push(
      new ethereum.EventParam("from", ethereum.Value.fromAddress(Address.zero()))
    )
    transfer.parameters.push(new ethereum.EventParam("to", ethereum.Value.fromAddress(PARTNER)))
    transfer.parameters.push(
      new ethereum.EventParam("id", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1)))
    )
    transfer.parameters.push(
      new ethereum.EventParam("value", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1)))
    )
    handleRoboshareTokensTransferSingle(transfer)

    let tokenInfo = changetype<RevenueTokenInfoSet>(mockEvent<RevenueTokenInfoSet>(TOKENS, 12))
    tokenInfo.parameters = new Array()
    tokenInfo.parameters.push(
      new ethereum.EventParam("revenueTokenId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(2)))
    )
    tokenInfo.parameters.push(
      new ethereum.EventParam("price", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(500)))
    )
    tokenInfo.parameters.push(
      new ethereum.EventParam("supply", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(100000000)))
    )
    tokenInfo.parameters.push(
      new ethereum.EventParam("maxSupply", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(500)))
    )
    tokenInfo.parameters.push(
      new ethereum.EventParam("maturityDate", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1870000000)))
    )
    tokenInfo.parameters.push(
      new ethereum.EventParam("immediateProceeds", ethereum.Value.fromBoolean(false))
    )
    tokenInfo.parameters.push(
      new ethereum.EventParam("protectionEnabled", ethereum.Value.fromBoolean(false))
    )
    handleRevenueTokenInfoSet(tokenInfo)

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

    assert.entityCount("BoundId", 2)
    assert.entityCount("Vehicle", 1)
    assert.entityCount("RoboshareToken", 1)
    assert.entityCount("PrimaryPool", 1)

    assert.fieldEquals("Vehicle", "1", "partner", PARTNER.toHexString())
    assert.fieldEquals("Vehicle", "1", "metadataURI", "ipfs://asset-metadata")
    assert.fieldEquals("RoboshareToken", "2", "maxSupply", "500")
    assert.fieldEquals("PrimaryPool", "2", "assetId", "1")
  })

  test("skips duplicate immutable entities safely", () => {
    clearStore()

    let bound = changetype<IdBoundToRegistry>(mockEvent<IdBoundToRegistry>(ROUTER, 1))
    bound.parameters = new Array()
    bound.parameters.push(
      new ethereum.EventParam("id", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1)))
    )
    bound.parameters.push(
      new ethereum.EventParam("registry", ethereum.Value.fromAddress(REGISTRY))
    )

    handleIdBoundToRegistry(bound)
    handleIdBoundToRegistry(bound)

    assert.entityCount("BoundId", 1)
    assert.assertNotNull(BoundId.load(entityId(1)))
  })

  test("updates vehicle metadata from VehicleMetadataUpdated", () => {
    clearStore()

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
