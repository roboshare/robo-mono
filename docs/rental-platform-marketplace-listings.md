# Rental Platform Marketplace Listing Model

Status: Draft
Date: June 11, 2026
Owner: Product + Marketplace

## Summary

Marketplace listings are renter-facing projections of facility-backed rental inventory. They are keyed by `platformVehicleId` and remain joinable to `facilityAssetId` by default, with optional `vehicleAssetId` only when a car also has per-car protocol identity.

Listings are not token metadata and are not onchain state. The platform derives them from:

- facility inventory manifests for public vehicle display fields
- host setup records for photos, description, pickup/dropoff, pricing, availability, and rules
- platform booking/availability systems for future live calendar exclusions

## Public Listing Shape

The first TypeScript projection lives in `web/lib/robomata/rentalMarketplace.ts`.

A listing exposes:

- `platformVehicleId`
- `facilityAssetId`
- optional `vehicleAssetId`
- `inventoryManifestDigest`
- status: `available` or `unavailable`
- title and public description
- public image URIs
- host display name and optional facility name
- pickup/dropoff location and delivery flag
- public vehicle attributes: make, model, year, trim, body type, seats, fuel type, and transmission
- pricing: daily rate, currency, minimum trip days, weekly discount, monthly discount
- availability controls: timezone, lead-time settings, instant-book flag
- rules: mileage limit, smoking, pets, and additional rules
- trip estimate for a requested date range

Private references such as VIN hash, plate hash, internal fleet ID, evidence digests, renter identity, payment state, and claims state are excluded.

## Search Filters

The initial search contract supports:

- `platformVehicleId`
- `facilityAssetId`
- `city`
- `region`
- `country`
- `dateFrom`
- `dateTo`
- `minDailyRateCents`
- `maxDailyRateCents`
- `vehicleType`
- `deliveryAvailable`
- `instantBookEnabled`
- `evOnly`
- `minSeats`

The current implementation uses static host setup fields for availability and trip estimates. Future booking-calendar work should keep the search contract stable while adding blackout dates, reservations, maintenance holds, and trip conflicts to the availability predicate.

## API

Initial renter-safe read API:

- `GET /api/robomata/rental-marketplace/listings`

The API requires `ROBOMATA_RENTAL_INVENTORY_ENABLED=true` and returns only public marketplace listing data. It does not require partner auth because it excludes private facility references and operating records.

## Ownership Boundary

Facility manifests own the initial vehicle display snapshot. Host setup owns listing readiness and renter-facing listing controls. The marketplace projection owns public search and PDP shape. Token metadata and `facilityCommitment` should only anchor safe references; they must not become the live listing database.
