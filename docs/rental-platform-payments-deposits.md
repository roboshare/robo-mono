# Rental Platform Payments And Deposits

Status: Draft
Date: June 11, 2026
Owner: Product + Revenue Operations

## Summary

MVP renter checkout uses an offchain card payment processor. The selected provider is Stripe, with manual authorization and capture for trip charges plus card authorization for security deposit holds.

Renter checkout must not require an onchain wallet. Protocol contracts receive only reconciled earnings later through the revenue posting flow.

Shared TypeScript payment contracts live in `web/lib/robomata/rentalPayments.ts`.

## Processor Choice

Stripe is the MVP processor because it supports:

- card checkout without a crypto wallet
- manual authorization and later capture
- refund and dispute workflows
- provider webhooks for reconciliation
- Vercel Marketplace provisioning for sandbox keys and webhook secrets

The implementation exposes a quote-only payment-plan route:

- `POST /api/robomata/rental-marketplace/payment-plan`

The route requires:

- `ROBOMATA_RENTAL_INVENTORY_ENABLED=true`
- `ROBOMATA_RENTAL_PAYMENTS_ENABLED=true`

It returns a deterministic payment plan and a Stripe-shaped manual-capture authorization request.

Provider write routes:

- `POST /api/robomata/rental-payments/payment-intents`
- `POST /api/robomata/rental-payments/stripe/webhook`
- `POST /api/robomata/rental-payments/reconcile`

`payment-intents` creates a live Stripe `PaymentIntent` with `capture_method=manual` when `STRIPE_SECRET_KEY` is configured. Local and CI smoke tests can set `ROBOMATA_RENTAL_STRIPE_MOCK=true` to exercise the same platform persistence path without calling Stripe.

Public paid-rental launch must leave `ROBOMATA_RENTAL_STRIPE_MOCK` unset or `false` in the target environment so checkout creates live Stripe PaymentIntents instead of `pi_mock_*` records.

`stripe/webhook` verifies `STRIPE_WEBHOOK_SECRET` outside local development and stores selected provider IDs, statuses, amounts, timestamps, and event references only. It handles authorization, capture, payment failure, refund, dispute, and chargeback event shapes.

`reconcile` re-fetches Stripe state by `paymentIntentId` and requires `x-robomata-payment-confirmation` with `ROBOMATA_RENTAL_PAYMENT_CONFIRMATION_SECRET` outside local development.

## Checkout Flow

1. Renter selects a listed `platformVehicleId` and trip date range.
2. Platform builds a marketplace listing and trip estimate from host controls.
3. Payment plan computes trip charge, platform fees, protection-plan amount, taxes, and deposit hold.
4. Provider authorization request is prepared with manual capture semantics.
5. Provider-write route creates a Stripe payment intent and records provider IDs.
6. Booking can move from `pending_payment_authorization` to host review or confirmation after authorization succeeds.
7. At trip completion, the platform captures the final authorized charge, releases or captures the deposit outcome, and creates immutable revenue ledger entries.

## Deposit Model

The MVP deposit is a card authorization hold, not protocol escrow.

Default policy:

- enabled
- 50% of trip subtotal
- minimum hold: 25,000 cents
- maximum hold: 150,000 cents

The deposit may be released after clean checkout, partially captured for approved claims, or fully captured for severe damage/loss outcomes. Deposit captures require attributable support, claims, or dispute references before revenue recognition.

## Refunds, Disputes, And Chargebacks

Provider events must map to immutable platform records before they affect recognized revenue:

- refunds create `renter_refund` ledger entries
- chargebacks create `chargeback` ledger entries
- taxes and pass-through protection-plan costs are excluded from recognized revenue
- disputed bookings must not enter protocol posting batches until the outcome is final

Provider IDs belong in offchain records and ledger source references. They must not be written into facility commitments or token metadata.

Failed payment, failed refund, dispute, and chargeback states set `postingBlocked=true` on the payment record. Revenue posting batch creation rejects ledger entries that reference blocked `paymentIntentId` values until a webhook or reconciliation run records a non-blocking final state.

## Compliance And Legal Constraints

- Sensitive payment method data stays with Stripe.
- The platform stores provider IDs, statuses, amounts, timestamps, and audit references only.
- Deposit language, authorization duration, capture reasons, cancellation policies, and tax handling require legal review before launch.
- Authorization windows vary by card network and payment method, so capture/release jobs must monitor expiration.
- Stablecoin escrow, programmable refunds, and onchain renter deposits are future optional rails, not MVP dependencies.

## Failure And Outage Assumptions

- If authorization fails, booking remains in `pending_payment_authorization` or is cancelled with `payment_failure`.
- If authorization expires before capture, the booking requires reauthorization before host handoff or trip start.
- If webhook delivery is delayed, provider reconciliation jobs must be able to re-fetch provider state by provider ID.
- If provider capture/refund fails, the platform records a failed payment event and blocks protocol revenue posting until reconciliation succeeds.
