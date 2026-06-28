# Rental Platform Claims And Safety

Status: Draft
Date: June 27, 2026
Owner: Trust + Operations

## Summary

Claims and safety workflows manage damage, disputes, fraud review, payout holds, and vehicle takedowns. They are platform workflows keyed by `bookingId` and `platformVehicleId` and preserve:

- `facilityAssetId`
- optional `vehicleAssetId`

Shared claim types live in `web/lib/robomata/rentalClaims.ts`. Persistence lives in `web/lib/robomata/server/rentalClaimStore.ts`.

## API

Initial claims and safety APIs:

- `POST /api/robomata/rental-bookings/:bookingId/claims`
- `GET /api/robomata/rental-claims/:claimId`
- `PATCH /api/robomata/rental-claims/:claimId`
- `POST /api/robomata/rental-inventory/vehicles/:platformVehicleId/safety-takedown`

These APIs require the relevant rental feature gates. Writes require `ROBOMATA_WORKFLOW_MUTATIONS_ENABLED=true`.

Local development may use `ROBOMATA_RENTAL_CLAIMS_FILE` when `POSTGRES_URL` is absent.

## Claim State Model

Claim statuses:

- `open`
- `evidence_collection`
- `adjudicating`
- `approved`
- `denied`
- `settled`
- `closed`

Evidence items can reference photos, condition reports, provider events, support notes, or documents. Evidence records store safe references and optional digests, not raw sensitive payloads.

## Payout Holds

Claims can create payout holds with:

- status
- amount
- reason
- hold timestamp
- release timestamp
- release conditions

Payout hold states:

- `not_held`
- `held`
- `partially_released`
- `released`
- `captured`

Payout holds are operating controls. They do not mutate protocol earnings until reconciliation decides what ledger entries and posting batches are eligible.

## Safety Takedown

Safety takedown immediately moves a vehicle to `suspended` through host controls. This removes it from general renter search because marketplace listings only expose available `listed` vehicles.

Takedown requests should include a reason and support case ID. Follow-up claims, disputes, or maintenance records should explain the final remediation path.
