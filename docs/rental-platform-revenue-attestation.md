# Rental Platform Revenue Attestation

Status: Draft
Date: June 27, 2026
Owner: Revenue Operations + Protocol

## Summary

Revenue attestation gives each earnings posting batch a stable provenance envelope before any protocol schema change is required.

The platform still owns booking, payment, refund, dispute, and recognized-revenue ledger evidence. The protocol receives the finalized distribution amount for `Treasury.distributeEarnings`, the posting asset, transaction hash, and attestation reference.

Shared attestation types and helpers live in `web/lib/robomata/rentalRevenue.ts`.

## Metadata Format

Each `RentalRevenuePostingBatch` includes `attestation`:

- `schema`: `robomata.rental_revenue_attestation`
- `version`: `v1`
- `attestationId`
- `batchId`
- `postingAssetId`
- `postingAssetKind`
- `periodStart`
- `periodEnd`
- `ledgerEntryIds`
- `ledgerEntryCount`
- `totalRecognizedRevenueCents`
- `currency`
- `sourceSystem`
- `createdBy`
- `createdAt`
- `ledgerEntriesDigest`
- `platformBoundary`
- `protocolBoundary`
- `rolloutMode`

`ledgerEntriesDigest` is a SHA-256 digest over sorted ledger-entry inputs that materially affect recognized revenue and provenance. It intentionally excludes raw payment-provider payloads and renter identity data.

## Integration Hooks

Posting creation returns:

- `batch.attestation`
- `protocolRequest.provenance.attestation`

Execution tooling should persist the full batch and pass the attestation reference alongside the protocol transaction record. `mark-posted` records the protocol transaction hash after execution; it does not rewrite attestation metadata.

## Ownership Boundaries

Platform-owned evidence:

- booking records
- trip completion records
- payment authorization/capture records
- refund, chargeback, and dispute outcomes
- recognized revenue ledger entries
- posting batch and attestation metadata

Protocol-owned evidence:

- financing asset identity
- distribution execution transaction
- investor token and treasury accounting state
- transaction hash for `distributeEarnings`

The attestation object bridges those systems; it does not move platform operating records onchain.

## Rollout Sequence

1. Store attestation metadata on every new posting batch as `rolloutMode=metadata_only`.
2. Add variance and investor reporting views that drill from protocol transaction hash to attestation metadata and ledger entries.
3. Add an optional offchain attestation publication step if external auditors or investors require immutable evidence packages.
4. Add protocol-level attestation references only after the metadata-only format is stable and backwards-compatible.

Existing posting batches without `attestation` should be treated as legacy batches and backfilled only when their source ledger entries are still available.
