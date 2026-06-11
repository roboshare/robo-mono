# Rental Platform Booking Checkout

Status: Draft
Date: June 11, 2026
Owner: Product + Marketplace

## Summary

Booking checkout creates a platform booking keyed by `platformVehicleId` and preserves the protocol financing target for later reconciliation:

- `facilityAssetId` by default
- optional `vehicleAssetId` only for explicit per-car financing paths

Shared booking types live in `web/lib/robomata/rentalBookings.ts`. Persistence lives in `web/lib/robomata/server/rentalBookingStore.ts`.

## API

Initial booking APIs:

- `POST /api/robomata/rental-bookings/checkout`
- `GET /api/robomata/rental-bookings/:bookingId`
- `POST /api/robomata/rental-bookings/:bookingId/confirm`

Checkout requires these gates:

- `ROBOMATA_RENTAL_BOOKINGS_ENABLED=true`
- `ROBOMATA_RENTAL_INVENTORY_ENABLED=true`
- `ROBOMATA_RENTAL_PAYMENTS_ENABLED=true`
- `ROBOMATA_RENTER_ACCOUNTS_ENABLED=true`

Local development may use `ROBOMATA_RENTAL_BOOKINGS_FILE` when `POSTGRES_URL` is absent.

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
