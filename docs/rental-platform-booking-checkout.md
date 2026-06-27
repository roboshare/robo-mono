# Rental Platform Booking Checkout

Status: Draft
Date: June 27, 2026
Owner: Product + Marketplace

## Summary

Booking checkout creates a platform booking keyed by `platformVehicleId` and preserves the protocol financing target for later reconciliation:

- `facilityAssetId` by default
- optional `vehicleAssetId` only for explicit per-car financing paths

Shared booking types live in `web/lib/robomata/rentalBookings.ts`. Persistence lives in `web/lib/robomata/server/rentalBookingStore.ts`.

## API

Booking read APIs:

- `POST /api/robomata/rental-bookings/checkout` — create a new booking
- `GET /api/robomata/rental-bookings/:bookingId` — read booking state
- `GET /api/robomata/rental-bookings/:bookingId/trip` — read trip state for a booking

Booking write APIs (all require `ROBOMATA_WORKFLOW_MUTATIONS_ENABLED=true`):

- `POST /api/robomata/rental-bookings/:bookingId/confirm` — confirm a booking (moves to `confirmed` or `host_review`)
- `POST /api/robomata/rental-bookings/:bookingId/approve` — host approval (moves `host_review` → `confirmed`)
- `POST /api/robomata/rental-bookings/:bookingId/cancel` — cancel a booking
- `POST /api/robomata/rental-bookings/:bookingId/check-in` — renter check-in (moves `confirmed` or `check_in_open` → `in_trip`)
- `POST /api/robomata/rental-bookings/:bookingId/check-out` — trip check-out (moves `in_trip` or `return_pending` → `completed`/`disputed`)
- `POST /api/robomata/rental-bookings/:bookingId/claims` — create a damage claim on a booking
- `POST /api/robomata/rental-bookings/:bookingId/incidents` — record a support incident on a booking

All booking routes require `ROBOMATA_RENTAL_BOOKINGS_ENABLED=true`. Write routes also require `ROBOMATA_WORKFLOW_MUTATIONS_ENABLED=true`. Local development may use `ROBOMATA_RENTAL_BOOKINGS_FILE` when `POSTGRES_URL` is absent.

### Approve

Host approval is available when a booking is in `host_review` state. The route validates:

1. Booking is in `host_review`.
2. A `paymentProviderReference` exists.
3. The vehicle is `listed` (when inventory is enabled).

`confirmBooking` enforces `paymentAuthorized=true` as a hard assertion. The booking moves to `confirmed` on success.

See [Rental Platform Payments And Deposits](./rental-platform-payments-deposits.md) for payment validation details.

### Cancel

Cancellation is available from most non-terminal booking states. The route:

1. Computes cancellation outcome using policy terms (trip charge, refundable amount, cancellation fee).
2. Cancels open Stripe payment intents where possible (`requires_payment_method`, `requires_confirmation`, `requires_capture`).
3. Blocks cancellation when Bridge payments are in `processing` or `captured` state.
4. Records the cancellation event on the booking and creates an audit entry.
5. Moves the booking to `cancelled`.

See [Rental Platform Cancellations And Support](./rental-platform-cancellations-support.md) for cancellation policy details.

### Check-in

Moves a booking to `in_trip`. Available when the booking is in `confirmed` or `check_in_open` state. Records trip check-in timestamp and odometer reading when provided. Updates vehicle operational status to `in_trip`.

### Check-out

Moves a booking to `completed` (or `disputed` if a trip exception is reported). Available when the booking is in `in_trip` or `return_pending` state. Records trip check-out timestamp and odometer reading when provided. Updates vehicle operational status to `turnaround` on clean completion or `suspended` on exception.

### Claims

Creates a damage claim on a booking. Can be created from any booking state — the booking moves to `disputed` when the current state is `check_in_open`, `confirmed`, `in_trip`, `return_pending`, or `completed`; otherwise the booking state is preserved. See [Rental Platform Claims And Safety](./rental-platform-claims-safety.md) for claim workflow details.

### Incidents

Records a support incident on a booking without changing its lifecycle state. Incidents include actor attribution, kind, status, notes, optional refund adjustment amount, and support case reference. See [Rental Platform Cancellations And Support](./rental-platform-cancellations-support.md) for incident details.

## Checkout Flow

1. Renter submits `renterId`, `platformVehicleId`, `dateFrom`, and `dateTo`.
2. Platform loads renter verification state and vehicle inventory/listing state.
3. Marketplace projection verifies listing availability for the requested dates.
4. Payment plan computes trip price, fees, taxes, protection-plan amount, and deposit hold.
5. Booking is created in `pending_renter_verification` if renter checks block checkout, otherwise `pending_payment_authorization`.
6. Booking stores cancellation and refund terms before confirmation.
7. Confirmation requires `paymentAuthorized=true`.
8. Confirmation moves booking to `confirmed` or `host_review`, depending on confirmation input.

## Events

Booking records carry event entries for downstream trip operations:

- `checkout_started`
- `verification_required`
- `payment_authorization_required`
- `host_review_required`
- `booking_confirmed`
- `booking_reminder_scheduled`

The event list is a platform integration seam. It is not a message bus yet, but it provides the canonical event shape for later notification, reminder, check-in, and revenue workflows.

Check-in, check-out, condition capture, and completed-trip events are defined in [Rental Platform Trip Check-In And Check-Out](./rental-platform-trip-check-in-out.md).

## Cancellation And Refund Terms

MVP checkout attaches `standard_flexible_v1` terms:

- free cancellation until 24 hours before pickup when trip start is parseable
- late cancellation may be partially refundable

Later cancellation/refund work should preserve these terms on the booking record and create immutable refund ledger entries rather than mutating prior payment records.

Cancellation outcome, refund visibility, and support incident audit events are defined in [Rental Platform Cancellations And Support](./rental-platform-cancellations-support.md).
