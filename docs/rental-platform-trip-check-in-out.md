# Rental Platform Trip Check-In And Check-Out

Status: Draft
Date: June 11, 2026
Owner: Product + Trip Operations

## Summary

Trip check-in and check-out capture the operating facts needed for renter handoff, return inspection, claims, disputes, and revenue reconciliation. Records are keyed by `bookingId` and `platformVehicleId` and preserve:

- `facilityAssetId`
- optional `vehicleAssetId`

Shared trip types live in `web/lib/robomata/rentalTrips.ts`. Persistence lives in `web/lib/robomata/server/rentalTripStore.ts`.

## API

Initial trip APIs:

- `GET /api/robomata/rental-bookings/:bookingId/trip`
- `POST /api/robomata/rental-bookings/:bookingId/check-in`
- `POST /api/robomata/rental-bookings/:bookingId/check-out`

These APIs require `ROBOMATA_RENTAL_BOOKINGS_ENABLED=true`. Writes also require `ROBOMATA_WORKFLOW_MUTATIONS_ENABLED=true`.

Local development may use `ROBOMATA_RENTAL_TRIPS_FILE` when `POSTGRES_URL` is absent.

## Check-In

Check-in accepts:

- photos
- capture timestamp
- condition rating
- odometer miles
- fuel percent or charge percent
- notes
- actor

The booking must be `confirmed` or `check_in_open`. Successful check-in creates a trip record and moves the booking to `in_trip` with a `check_in_completed` event.

## Check-Out

Check-out accepts the same condition report fields and optional exception metadata:

- kind: damage, missing vehicle, late return, safety, or other
- severity
- notes
- claim recommendation
- dispute recommendation

If no exception is present, check-out completes the trip and moves the booking to `completed` with a `trip_completed` event. If an exception is present, the trip moves to `exception` and the booking moves to `disputed` with a `trip_exception_reported` event.

Completed-trip events include `platformVehicleId`, `facilityAssetId`, optional `vehicleAssetId`, and `tripId` so reconciliation can create ledger entries against the correct financing target.

## Claims And Disputes Boundary

Trip exception metadata is the escalation seam. Claims and payout holds are managed by the trust/safety workflow, not by mutating the original trip reports. Check-in and check-out reports remain immutable evidence inputs.

Cancellation outcome, refund adjustments, and support incidents are defined in [Rental Platform Cancellations And Support](./rental-platform-cancellations-support.md).
