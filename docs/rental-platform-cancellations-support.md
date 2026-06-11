# Rental Platform Cancellations And Support

Status: Draft
Date: June 11, 2026
Owner: Product + Support

## Summary

Cancellations, refund visibility, and support incidents are platform workflows. They preserve booking and financing target links while keeping provider payments, support decisions, and audit events offchain.

Shared support types live in `web/lib/robomata/rentalSupport.ts`. Persistence lives in `web/lib/robomata/server/rentalSupportStore.ts`.

## API

Initial support APIs:

- `POST /api/robomata/rental-bookings/:bookingId/cancel`
- `POST /api/robomata/rental-bookings/:bookingId/incidents`

These APIs require `ROBOMATA_RENTAL_BOOKINGS_ENABLED=true`. Writes also require `ROBOMATA_WORKFLOW_MUTATIONS_ENABLED=true`.

Local development may use `ROBOMATA_RENTAL_SUPPORT_FILE` when `POSTGRES_URL` is absent.

## Cancellation Outcome

Cancellation computes:

- policy ID
- cancellation reason
- cancellation timestamp
- trip charge
- refundable amount
- cancellation fee
- refund basis points
- audit event ID
- support case ID when provided

The outcome is returned to users and ops. It is also persisted as an audit event and appended to the booking event stream with `booking_cancelled`.

## Incidents And Manual Interventions

Support can record incidents with:

- actor and role
- kind
- status
- notes
- support case ID
- optional refund adjustment amount
- audit event ID

Incidents do not mutate previous payment, trip, or ledger records. Refund-related adjustments become accounting inputs for later immutable ledger entries.

## Booking Boundary

Cancellation moves a booking to `cancelled` unless the booking is already `completed` or `closed`. Incident records preserve the current booking state and append `incident_recorded` to the booking event stream.

Manual interventions must always include an actor and should include a support case reference when they affect refund, dispute, or safety outcomes.

Damage claims, payout holds, adjudication states, and safety takedowns are defined in [Rental Platform Claims And Safety](./rental-platform-claims-safety.md).
