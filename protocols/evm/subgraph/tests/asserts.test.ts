import { assert, beforeAll, describe, test } from "matchstick-as";
import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import { Listing, PrimaryPool, Vehicle } from "../generated/schema";

describe("Asserts", () => {
  beforeAll(() => {
    let vehicle = new Vehicle("1");
    vehicle.partner = Bytes.fromHexString("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    vehicle.metadataURI = "ipfs://QmTest";
    vehicle.assetValue = BigInt.fromI32(100000);
    vehicle.blockNumber = BigInt.fromI32(12345);
    vehicle.blockTimestamp = BigInt.fromI32(1709849870);
    vehicle.transactionHash = Bytes.fromHexString(
      "0x1909fcb0b41989e28308afcb0cf55adb6faba28e14fcbf66c489c69b8fe95dd6",
    );
    vehicle.save();

    let listing = new Listing("1");
    listing.tokenId = BigInt.fromI32(2);
    listing.assetId = BigInt.fromI32(1);
    listing.seller = Bytes.fromHexString("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    listing.amount = BigInt.fromI32(1000);
    listing.amountSold = BigInt.fromI32(0);
    listing.pricePerToken = BigInt.fromI32(100);
    listing.expiresAt = BigInt.fromI32(1709949870);
    listing.buyerPaysFee = true;
    listing.status = "active";
    listing.isEnded = false;
    listing.createdAt = BigInt.fromI32(1709849870);
    listing.blockNumber = BigInt.fromI32(12345);
    listing.blockTimestamp = BigInt.fromI32(1709849870);
    listing.transactionHash = Bytes.fromHexString(
      "0x2909fcb0b41989e28308afcb0cf55adb6faba28e14fcbf66c489c69b8fe95dd7",
    );
    listing.save();

    let pool = new PrimaryPool("2");
    pool.tokenId = BigInt.fromI32(2);
    pool.assetId = BigInt.fromI32(1);
    pool.partner = Bytes.fromHexString("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    pool.pricePerToken = BigInt.fromI32(100);
    pool.maxSupply = BigInt.fromI32(500);
    pool.immediateProceeds = false;
    pool.protectionEnabled = false;
    pool.isPaused = false;
    pool.isClosed = false;
    pool.createdAt = BigInt.fromI32(1709849870);
    pool.save();
  });

  test("Vehicle entity fields", () => {
    assert.fieldEquals("Vehicle", "1", "metadataURI", "ipfs://QmTest");
    assert.fieldEquals("Vehicle", "1", "assetValue", "100000");
    assert.entityCount("Vehicle", 1);
  });

  test("Listing entity fields", () => {
    assert.fieldEquals("Listing", "1", "tokenId", "2");
    assert.fieldEquals("Listing", "1", "amount", "1000");
    assert.fieldEquals("Listing", "1", "buyerPaysFee", "true");
    assert.entityCount("Listing", 1);
  });

  test("PrimaryPool entity fields", () => {
    assert.fieldEquals("PrimaryPool", "2", "assetId", "1");
    assert.fieldEquals("PrimaryPool", "2", "maxSupply", "500");
    assert.fieldEquals("PrimaryPool", "2", "isClosed", "false");
    assert.entityCount("PrimaryPool", 1);
  });
});
