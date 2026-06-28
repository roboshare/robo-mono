# VehicleRegistry Metadata Ownership Verification

Status: Verified
Date: June 27, 2026
Owner: Product + Protocol

## Summary

The current `VehicleRegistry.updateVehicleMetadata` implementation already enforces owner-only metadata updates for registered vehicle assets.

This means the rental platform does not need a protocol change before using optional `vehicleAssetId` links for individually registered cars.

## Current Contract Behavior

`VehicleRegistry.updateVehicleMetadata` checks that:

- the vehicle exists
- `msg.sender` is an authorized partner
- `msg.sender` holds the asset token for the target `vehicleId`

The owner check is implemented through `_requireAuthorizedAssetOwner(msg.sender, vehicleId)`, which reverts with `IAssetRegistry.NotAssetOwner` when an authorized partner does not hold the asset token.

## Verification

Source evidence:

- `protocols/evm/contracts/VehicleRegistry.sol`
- `protocols/evm/test/integration/VehicleRegistry.Integration.t.sol`

Executable verification:

```bash
forge test --offline --match-path test/integration/VehicleRegistry.Integration.t.sol --match-test testUpdateVehicleMetadataAuthorizedPartnerNotAssetOwner
```

Result:

```text
[PASS] testUpdateVehicleMetadataAuthorizedPartnerNotAssetOwner()
1 tests passed; 0 failed; 0 skipped
```

## Rental Platform Implication

For facility-backed rental inventory:

- `facilityAssetId` remains the default financing and reporting target.
- `vehicleAssetId` is optional and only applies when a car is individually registered in `VehicleRegistry`.
- Offchain host setup and rental inventory updates must not require per-car protocol registration.
- If a car has a `vehicleAssetId`, protocol metadata updates must be performed by the owning authorized partner, not by any authorized partner.

No contract change is required for this issue based on the current target branch behavior.
