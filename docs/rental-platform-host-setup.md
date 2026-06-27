# Rental Platform Host Setup Flow

Status: Draft
Date: June 27, 2026
Owner: Product + Protocol

## Summary

Host setup turns a facility-backed inventory vehicle into a rentable platform vehicle. It is an offchain workflow keyed by `platformVehicleId`; it does not require a protocol transaction and does not require a `VehicleRegistry` record.

Every setup record preserves:

- `platformVehicleId`
- `facilityAssetId`
- optional `vehicleAssetId`

The shared TypeScript setup contract lives in `web/lib/robomata/rentalInventory.ts`. The persistence boundary is `web/lib/robomata/server/rentalInventoryStore.ts`.

## Required Setup Sections

The MVP checklist is:

- `photos`: at least one public photo URI
- `description`: renter-facing vehicle description
- `pickup_dropoff`: pickup/dropoff location and instructions
- `pricing`: positive daily rate and optional discounts
- `availability`: timezone and booking lead-time controls
- `rules`: mileage, smoking, pets, and additional renter rules

## Setup States

- `not_started`: no meaningful setup data is present
- `incomplete`: setup has validation errors or missing required sections
- `complete`: all required sections validate and the vehicle can move from `setup` to `ready`
- `blocked`: reserved for future ops/compliance holds that block setup completion

When setup becomes `complete`, the platform may move `operationalStatus` from `setup` to `ready`. Listing publication is still a separate marketplace action.

Post-setup pricing, blackout dates, maintenance holds, booking review, and manual listing status controls are defined in [Rental Platform Host Controls](./rental-platform-host-controls.md).

## API

Initial host setup APIs:

- `GET /api/robomata/rental-inventory/vehicles/:platformVehicleId/setup`
- `PATCH /api/robomata/rental-inventory/vehicles/:platformVehicleId/setup`

These APIs require `ROBOMATA_RENTAL_INVENTORY_ENABLED=true`. Writes also require `ROBOMATA_WORKFLOW_MUTATIONS_ENABLED=true`.

`PATCH` accepts:

- `photoUris`
- `publicDescription`
- `pickupDropoff`
- `pricing`
- `availability`
- `rules`
- optional checklist overrides

The API returns the updated vehicle and computed setup status with validation errors.

## Protocol Boundary

Host setup must not ask the host to manually register a vehicle onchain. The default financing link remains `facilityAssetId`. `vehicleAssetId` is optional metadata for individually registered cars and should not block normal facility-backed setup.
