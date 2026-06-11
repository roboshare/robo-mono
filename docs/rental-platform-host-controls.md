# Rental Platform Host Controls

Status: Draft
Date: June 11, 2026
Owner: Product + Marketplace

## Summary

Host controls are offchain operating controls for facility-backed rental vehicles. They are keyed by `platformVehicleId`, preserve the protocol financing link to `facilityAssetId`, and optionally preserve `vehicleAssetId` for individually registered cars.

Host controls are separate from protocol asset metadata. They can change frequently and should live in platform storage.

## Control Model

The shared TypeScript contract lives in `web/lib/robomata/rentalInventory.ts`.

`RentalVehicleHostControls` includes:

- pricing: daily rate, currency, minimum trip days, weekly discount, monthly discount
- availability: timezone, advance notice, minimum lead time, instant-book flag
- blackout ranges: host-defined unavailable windows
- maintenance holds: operational holds with optional expected return-to-service timestamp
- booking review rules: auto-accept flag, manual approval flag, max trip days, minimum notice hours

The host setup record remains the readiness checklist. Host controls are the mutable operating layer after setup.

## API

Initial host controls API:

- `GET /api/robomata/rental-inventory/vehicles/:platformVehicleId/controls`
- `PATCH /api/robomata/rental-inventory/vehicles/:platformVehicleId/controls`

These APIs require `ROBOMATA_RENTAL_INVENTORY_ENABLED=true`. Writes also require `ROBOMATA_WORKFLOW_MUTATIONS_ENABLED=true`.

`PATCH` accepts:

- `pricing`
- `availability`
- `blackoutRanges`
- `maintenanceHolds`
- `bookingReview`
- `operationalStatus`: `listed`, `maintenance`, `suspended`, or `delisted`

A vehicle cannot move to `listed` until host setup is complete. Blackout and maintenance ranges must have valid ordered `startsAt` and `endsAt` timestamps.

## Marketplace Impact

Marketplace listings use host controls before setup defaults for pricing and availability. General search returns only available listings. A direct `platformVehicleId` lookup can return unavailable listings so PDP, support, and ops views can explain delisting, suspension, maintenance, or blackout status.

Requested date ranges that overlap a blackout range or maintenance hold make the listing unavailable for that search.
