# Rental Platform Facility Inventory Boundary

Status: Draft
Date: June 11, 2026
Owner: Product + Protocol

## Summary

Rental vehicles are offchain operating records. The default protocol financing asset is a `FacilityRegistry` asset, and the rental platform links each vehicle to that financing asset through `facilityAssetId`.

`VehicleRegistry` remains optional for cars that need per-car protocol identity, VIN-hash uniqueness, per-car reporting, or per-car tokenization. Most rental vehicles should not need a `vehicleAssetId` in the MVP.

## Identifier Model

- `platformVehicleId`: required rental vehicle identifier used by listings, bookings, trips, claims, availability, and pricing.
- `facilityAssetId`: required protocol financing asset for facility-backed inventory.
- `vehicleAssetId`: optional `VehicleRegistry` asset ID used only for explicit per-car financing paths.
- `inventoryManifestDigest`: digest of the committed facility inventory snapshot used for attribution and audit.

## Data Placement

`FacilityRegistry` stores:

- `facilityAssetId`
- `facilityCommitment`
- asset metadata URI
- revenue-token metadata URI

Facility asset metadata may include:

- facility display summary
- public inventory manifest reference or digest
- evidence root and facility commitment references
- public tokenization terms already safe for display

The facility inventory manifest stores:

- version and manifest ID
- facility asset link
- generated/as-of timestamps
- source information
- one or more vehicle snapshots keyed by `platformVehicleId`
- public display fields such as make, model, year, trim, seats, fuel type, and image URIs
- privacy-safe private references such as VIN hash, plate hash, internal fleet ID, and evidence digests

The rental platform database stores:

- live setup status
- listing state
- pricing and availability
- renter identity and verification state
- bookings and trips
- payments, deposits, refunds, and chargebacks
- claims and disputes
- revenue ledger entries and posting batches

## Non-Goals

- Do not store live rental availability in token metadata.
- Do not store bookings, renters, payments, deposits, claims, or disputes in token metadata.
- Do not treat `facilityCommitment` as a readable vehicle database. It is an anchor that can commit to manifest and evidence digests.
- Do not require every rental vehicle to be registered through `VehicleRegistry`.

## Implementation Anchor

Shared TypeScript types live in `web/lib/robomata/rentalInventory.ts`.

The canonical server-side digest helper lives in `web/lib/robomata/server/rentalInventoryRoots.ts`.

The server-side persistence boundary lives in `web/lib/robomata/server/rentalInventoryStore.ts`.

The FacilityRegistry event-sync boundary lives in `web/lib/robomata/server/rentalInventoryFacilityRegistrySync.ts`.

The initial ingestion APIs are:

- `GET /api/robomata/rental-inventory/manifests`
- `POST /api/robomata/rental-inventory/manifests`
- `POST /api/robomata/rental-inventory/manifests/:manifestId/replay`
- `POST /api/robomata/rental-inventory/facility-registry-sync`
- `GET /api/robomata/rental-inventory/ingestion-runs`
- `GET /api/robomata/rental-inventory/vehicles`

These APIs require `ROBOMATA_RENTAL_INVENTORY_ENABLED=true`. Writes also require the existing Robomata mutation gate.

Every manifest ingest creates a durable ingestion run with trigger, source event metadata, actor, status, vehicle counts, manifest digest, and error message when validation fails. Manual replay reprocesses the stored manifest without creating a new protocol dependency.

`facility-registry-sync` scans `FacilityMetadataUpdated` events, resolves the event `assetMetadataURI`, extracts either an embedded `rentalInventoryManifest` object or a `rentalInventoryManifestUri` reference, and upserts the resulting manifest through the same validation and storage path as direct API uploads. The sync stores a checkpoint keyed by chain ID and registry address so cron jobs or agents can safely rerun it. Failed metadata fetches or invalid manifests are recorded as failed ingestion runs rather than stopping audit visibility.

The same route also exposes a scheduled `GET` path. `web/vercel.json` calls it every five minutes in production deployments. The scheduled path is protected by `ROBOMATA_RENTAL_INVENTORY_SCHEDULED_SYNC_ENABLED=true` and accepts Vercel Cron requests signed with `Authorization: Bearer <CRON_SECRET>`. `ROBOMATA_RENTAL_INVENTORY_SYNC_SECRET` remains a fallback for manual non-Vercel callers.

Operational environment:

- `ROBOMATA_RENTAL_INVENTORY_ENABLED=true` enables protected read APIs and store access.
- `ROBOMATA_RENTAL_INVENTORY_SCHEDULED_SYNC_ENABLED=true` enables scheduled FacilityRegistry sync side effects.
- `CRON_SECRET` is the Vercel Cron bearer secret for scheduled sync requests.
- `ROBOMATA_RENTAL_INVENTORY_SYNC_SECRET` optionally protects manual non-Vercel sync callers with a bearer token.
- `ROBOMATA_WORKFLOW_MUTATIONS_ENABLED=true` enables manifest writes, replay, and registry sync.
- `ROBOMATA_RENTAL_INVENTORY_FILE` enables a local JSON fallback when `POSTGRES_URL` is absent in development.
- `ROBOMATA_RENTAL_INVENTORY_SYNC_FROM_BLOCK` sets the first registry-sync block when no checkpoint exists.
- `ROBOMATA_RENTAL_INVENTORY_SYNC_MAX_BLOCK_RANGE` caps one sync call's block range. The default is 5,000 blocks.
- `ROBOMATA_RENTAL_INVENTORY_IPFS_GATEWAY` resolves `ipfs://` metadata URIs. The default is `https://ipfs.io/ipfs`.
- `ROBOMATA_RENTAL_INVENTORY_METADATA_ALLOWED_ORIGINS` is a comma-separated allowlist for direct HTTPS `assetMetadataURI` and `rentalInventoryManifestUri` fetches.
- `ROBOMATA_RENTAL_INVENTORY_FACILITY_OWNERS_JSON` maps facility asset IDs to partner addresses when production manifests are not source-attributed to the partner.

The first implementation dependency is `ROB-217`: define facility inventory manifest and rental inventory data placement.
