# Rental Platform Earnings Posting

Status: Draft
Date: June 11, 2026
Owner: Revenue Operations + Protocol

## Summary

Earnings posting turns immutable rental revenue ledger entries into protocol distribution requests. The platform remains the source of truth for booking, payment, refund, dispute, and adjustment records. Protocol contracts receive only reconciled posting amounts and provenance.

Shared posting helpers live in `web/lib/robomata/rentalRevenue.ts`. Persistence lives in `web/lib/robomata/server/rentalRevenueStore.ts`. Attestation metadata and rollout sequencing are defined in [Rental Platform Revenue Attestation](./rental-platform-revenue-attestation.md).

## API

Initial posting APIs:

- `POST /api/robomata/rental-revenue/posting-batches`
- `GET /api/robomata/rental-revenue/posting-batches/:batchId`
- `POST /api/robomata/rental-revenue/posting-batches/:batchId/mark-posted`

These APIs require `ROBOMATA_RENTAL_REVENUE_POSTING_ENABLED=true`. Writes also require `ROBOMATA_WORKFLOW_MUTATIONS_ENABLED=true`.

Local development may use `ROBOMATA_RENTAL_REVENUE_FILE` when `POSTGRES_URL` is absent.

## Batch Guardrails

The posting service enforces:

- at least one ledger entry per batch
- all ledger entries must match the posting target
- total recognized revenue must be non-negative
- deterministic batch ID by posting asset and period
- idempotency key by batch ID and sorted ledger entry IDs

Duplicate posting creation returns the existing batch for the same idempotency key.

## Protocol Distribution Request

The service emits a `distributeEarnings` request shape with:

- batch ID
- posting asset ID
- posting asset kind: facility or vehicle
- amount in cents
- currency
- idempotency key
- ledger entry IDs
- period start/end
- audit event ID when available
- attestation metadata

The request is the handoff to the protocol execution layer. `mark-posted` records the protocol transaction hash after execution.

## Posting Target

Rental revenue posts to `facilityAssetId` by default. It posts to `vehicleAssetId` only when a vehicle is intentionally financed and reconciled separately.

Disputed bookings, unresolved chargebacks, payout holds, and open claims must not feed ready posting batches until their outcome has produced final ledger entries.
