# Rental Platform Persistence And Retention

Status: Draft
Date: June 11, 2026
Owner: Product + Engineering

## Purpose

Rental platform runtime state is offchain and must be persisted in Postgres for shared preview, release-candidate, and production environments. Local JSON files are single-developer fallbacks only.

This document covers the production persistence boundary for:

- facility inventory manifests, vehicles, ingestion runs, and sync checkpoints
- renter profiles and verification audit events
- bookings and booking lifecycle events
- trip check-in/check-out records
- support incidents and cancellation audit events
- claims, evidence references, and payout holds
- revenue ledger entries and posting batches

## Bootstrap

Run the idempotent schema bootstrap before enabling rental feature flags outside local development:

```sh
POSTGRES_URL="$POSTGRES_URL" yarn robomata:rental-persistence:bootstrap
```

The script executes `web/scripts/sql/robomata-rental-persistence.sql` and creates every table/index used by the existing rental stores. Store code still lazily creates tables as a safety net, but production readiness should not rely on first user traffic to initialize the schema.

## Environment Rules

- `POSTGRES_URL` is required outside local development when any rental store is enabled.
- `ROBOMATA_RENTAL_INVENTORY_FILE`, `ROBOMATA_RENTER_ACCOUNTS_FILE`, `ROBOMATA_RENTAL_BOOKINGS_FILE`, `ROBOMATA_RENTAL_TRIPS_FILE`, `ROBOMATA_RENTAL_SUPPORT_FILE`, `ROBOMATA_RENTAL_CLAIMS_FILE`, and `ROBOMATA_RENTAL_REVENUE_FILE` are local-development fallbacks only.
- Preview and production environments should run the bootstrap after database provisioning and before turning on rental feature flags.

## Privacy And Retention Boundaries

Roboshare stores provider references, statuses, digests, timestamps, actor attribution, and audit facts. It must not persist raw renter identity documents, full SSNs, full dates of birth, raw sanctions payloads, biometric artifacts, card data, payment method payloads, Stripe client secrets, or raw claim documents.

The shared write-boundary guard in `web/lib/robomata/rentalPersistencePolicy.ts` rejects prohibited raw PII, payment, and provider-payload keys across rental inventory, renter verification, booking, support, claim, and revenue stores.

Retention expectations:

- Renter verification: retain provider references, status history, expiry, policy version, and audit attribution; source documents remain with the verification vendor.
- Payments: retain provider IDs, amounts, statuses, and timestamps; raw payment methods and client secrets remain with Stripe.
- Claims: retain evidence references, digests, notes, and adjudication state; raw evidence blobs remain in controlled object/provider storage.
- Audit events: retain operational facts for the legal/compliance window, without raw PII or provider payloads.
- Revenue ledger and posting batches: retain immutable accounting payloads needed to reconcile protocol postings.

## Backup, Restore, And Replay

Back up the rental tables together with the rest of the Robomata Postgres database before enabling live provider integrations. Restore should preserve:

- `robomata_rental_inventory_sync_checkpoints` so FacilityRegistry sync resumes from the correct block.
- `robomata_rental_inventory_ingestion_runs` so failed and replayed manifests remain auditable.
- `robomata_rental_revenue_posting_batches.idempotency_key` so earnings posting remains duplicate-safe.

If inventory sync checkpoints are lost, restore from backup first. If no backup is available, restart sync from a conservative `ROBOMATA_RENTAL_INVENTORY_SYNC_FROM_BLOCK` and replay manifests; duplicate manifests and vehicles are upserted by stable IDs/digests.
