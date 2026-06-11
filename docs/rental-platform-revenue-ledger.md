# Rental Platform Revenue Ledger

Status: Draft
Date: June 11, 2026
Owner: Product + Protocol

## Summary

The rental platform must maintain an immutable accounting ledger before any earnings are posted to protocol contracts. The ledger is keyed by `platformVehicleId` for rental operations and by financing target for protocol posting.

Default posting target is `facilityAssetId`. Optional `vehicleAssetId` is used only when an individually registered car is intentionally financed and posted separately.

Shared TypeScript types and helpers live in `web/lib/robomata/rentalRevenue.ts`.

## Recognized Revenue Policy

MVP recognized revenue is:

`recognized_revenue = completed_trip_rental_revenue - refunds - chargebacks - taxes - pass_through_insurance_costs - waived_fees`

Inputs:

- completed trip rental revenue: renter-paid rental amount after trip completion
- refunds: renter refunds or credits
- chargebacks: payment reversals
- taxes: sales, rental, tourism, or similar taxes collected for remittance
- pass-through insurance costs: protection-plan amounts owed to carriers or vendors
- waived fees: fees the platform chooses not to collect

Recognized revenue must not be posted while a booking is `disputed`. Disputed bookings can only enter a posting batch after the dispute outcome creates a final adjustment entry.

## Immutable Ledger Entry

Every ledger entry must include:

- immutable `id`
- `platformVehicleId`
- `facilityAssetId`
- optional `vehicleAssetId`
- `postingAssetId`
- `postingAssetKind`
- `kind`
- `bookingId`
- optional `tripId`
- optional adjustment, dispute, payment, refund, and audit references
- signed amount in cents
- currency
- occurrence timestamp
- creation timestamp
- optional `postingBatchId`
- optional `supersedesEntryId`

Ledger entries are append-only. Corrections must create a new adjustment or superseding entry; existing entries should not be mutated after creation.

## Posting Batch Contract

A posting batch groups recognized revenue ledger entries for one financing target and one period. It must include:

- deterministic batch ID
- period start and end
- `postingAssetId`
- `postingAssetKind`
- entry IDs
- total recognized revenue
- idempotency key
- status
- audit event ID
- protocol transaction hash once posted

The idempotency key must be derived from the batch ID and sorted ledger entry IDs so retries cannot double-post the same revenue set.

The posting service and protocol distribution request shape are defined in [Rental Platform Earnings Posting](./rental-platform-earnings-posting.md).

## Audit Requirements

Every posting batch must be traceable back to:

- booking records
- trip completion records
- payment and refund provider references
- manual adjustments
- dispute outcomes
- protocol transaction hash when posted

Manual adjustments require an attributable audit event and should include actor, reason, timestamp, and support case or dispute reference when applicable.

## Protocol Boundary

This ledger is the platform source of truth for rental revenue. Protocol contracts receive only reconciled posting amounts and provenance metadata. The ledger does not require booking, renter, payment, or dispute data to be stored onchain.
