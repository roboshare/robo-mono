# Rental Platform State Models

Status: Draft
Date: June 11, 2026
Owner: Product + Protocol

## Summary

Rental platform state is separate from protocol asset state. Protocol state determines whether a financing asset can receive tokenization, earnings, settlement, or retirement actions. Platform state determines whether an offchain vehicle can be set up, listed, reserved, used in a trip, suspended, reconciled, or reported.

The canonical rental key is `platformVehicleId`. Every booking, trip, support case, and accounting record must preserve the financing link:

- `facilityAssetId` by default
- optional `vehicleAssetId` only when a car is individually registered through `VehicleRegistry`

The shared TypeScript state model lives in `web/lib/robomata/rentalOperations.ts`.

## Vehicle Operational States

| State | Meaning |
| --- | --- |
| `setup` | Vehicle exists in facility inventory but host setup is incomplete. |
| `ready` | Setup is complete but the vehicle is not renter-visible. |
| `listed` | Vehicle is renter-visible and can receive booking demand. |
| `reserved` | Vehicle is held for a confirmed or near-confirmed booking. |
| `in_trip` | Renter has checked in or trip is active. |
| `turnaround` | Trip is complete and vehicle awaits return inspection, cleaning, or release. |
| `maintenance` | Vehicle is temporarily unavailable for service or inspection. |
| `suspended` | Ops has blocked vehicle availability for safety, fraud, compliance, or data quality reasons. |
| `delisted` | Host or ops removed the vehicle from marketplace visibility without retiring the inventory record. |
| `retired` | Vehicle should no longer be used for rental operations. |

## Vehicle Transitions

Default allowed transitions:

- `setup` -> `ready`, `suspended`, `retired`
- `ready` -> `listed`, `maintenance`, `suspended`, `retired`
- `listed` -> `reserved`, `maintenance`, `suspended`, `delisted`
- `reserved` -> `listed`, `in_trip`
- `in_trip` -> `turnaround`, `maintenance`, `suspended`
- `turnaround` -> `listed`, `maintenance`, `suspended`, `retired`
- `maintenance` -> `ready`, `listed`, `suspended`, `retired`
- `suspended` -> `ready`, `listed`, `maintenance`, `delisted`, `retired`
- `delisted` -> `ready`, `listed`, `retired`
- `retired` has no forward transition

Override-required transitions:

- marketplace removal while listed: `listed` -> `maintenance`, `listed` -> `suspended`
- booking exception release: `reserved` -> `listed`
- active-trip safety or service exception: `in_trip` -> `maintenance`, `in_trip` -> `suspended`
- ops reinstatement: `suspended` -> `listed`, `delisted` -> `listed`

Overrides must include actor, reason, audit event ID, and optional support case ID.

## Booking Lifecycle States

| State | Meaning |
| --- | --- |
| `draft_quote` | Search or PDP quote exists but renter has not begun checkout. |
| `pending_renter_verification` | Checkout requires identity, license, sanctions, or manual review. |
| `pending_payment_authorization` | Payment/deposit authorization is required before confirmation. |
| `host_review` | Host approval is required before confirmation. |
| `confirmed` | Booking is accepted and the vehicle should be held. |
| `cancelled` | Booking ended before trip completion. |
| `check_in_open` | Pickup/check-in window is open. |
| `in_trip` | Renter has checked in and the trip is active. |
| `return_pending` | Trip is ending or vehicle return is awaiting check-out. |
| `completed` | Trip is complete and can feed revenue recognition after adjustments. |
| `disputed` | Claim, dispute, fraud review, or support exception is open. |
| `closed` | Booking has no remaining operational or accounting action. |

## Booking Transitions

Default allowed transitions:

- `draft_quote` -> `pending_renter_verification`, `pending_payment_authorization`, `cancelled`
- `pending_renter_verification` -> `pending_payment_authorization`, `cancelled`
- `pending_payment_authorization` -> `host_review`, `confirmed`, `cancelled`
- `host_review` -> `confirmed`, `cancelled`
- `confirmed` -> `check_in_open`, `cancelled`, `disputed`
- `cancelled` -> `closed`, `disputed`
- `check_in_open` -> `in_trip`, `cancelled`, `disputed`
- `in_trip` -> `return_pending`, `disputed`
- `return_pending` -> `completed`, `disputed`
- `completed` -> `closed`, `disputed`
- `disputed` -> `closed`
- `closed` has no forward transition

Dispute, cancellation-after-check-in, and completed-trip reopening transitions require an attributable override.

## Protocol State Relationship

Platform state does not mutate protocol `AssetStatus`. The rental platform must read protocol state as an eligibility input:

- A vehicle can be `maintenance` while its `facilityAssetId` remains protocol-operational.
- A facility can be protocol `Earning` while some underlying vehicles are `listed`, `reserved`, `in_trip`, or `maintenance`.
- A vehicle should not become `listed` if its financing asset is retired, settled, frozen, or otherwise not operational.
- Optional `vehicleAssetId` state is informative for per-car financing paths, but facility-backed MVP revenue posts to `facilityAssetId` unless explicitly configured otherwise.

## Reconciliation and Reporting Requirements

Booking records that reach `completed` are eligible for recognized revenue calculation after refunds, chargebacks, taxes, pass-through costs, and dispute adjustments. `disputed` bookings must not be posted to protocol earnings until their revenue outcome is resolved.

Every state transition that affects availability, support, or accounting must be attributable. Manual overrides should create an audit event and preserve:

- actor
- previous state
- next state
- reason
- support case or incident reference when applicable
- timestamp
- `platformVehicleId`
- `facilityAssetId`
- optional `vehicleAssetId`
