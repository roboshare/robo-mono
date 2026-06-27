# Rental Platform Payments And Deposits

Status: Draft
Date: June 27, 2026
Owner: Product + Revenue Operations

## Summary

MVP renter checkout uses an offchain card payment processor. The selected primary provider is Stripe, with manual authorization and capture for trip charges plus card authorization for security deposit holds.

Bridge can be enabled as an optional stablecoin transfer rail for crypto-native renters or operator-controlled preview flows. Bridge is not a card authorization-hold equivalent: it behaves as stablecoin prepayment and only confirms the booking after the transfer reaches a settled provider state.

Renter checkout must not require an onchain wallet. Protocol contracts receive only reconciled earnings later through the revenue posting flow.

Shared TypeScript payment contracts live in `web/lib/robomata/rentalPayments.ts`.

## Processor Choice

Stripe is the MVP processor because it supports:

- card checkout without a crypto wallet
- manual authorization and later capture
- refund and dispute workflows
- provider webhooks for reconciliation
- Vercel Marketplace provisioning for sandbox keys and webhook secrets

Bridge is a secondary processor because it supports:

- USDC/stablecoin payment routes for crypto-native renters
- Bridge-hosted orchestration for source and destination rails
- provider deposit instructions for awaiting-funds transfers
- webhook-based transfer reconciliation
- clean lockbox-style evidence for stablecoin receipts

Bridge must stay optional until customer onboarding, supported routes, refunds/returns, sanctions/travel-rule handling, and stablecoin deposit terms are approved for the launch environment.

The implementation exposes a quote-only payment-plan route:

- `POST /api/robomata/rental-marketplace/payment-plan`

The route requires:

- `ROBOMATA_RENTAL_INVENTORY_ENABLED=true`
- `ROBOMATA_RENTAL_PAYMENTS_ENABLED=true`

It returns a deterministic payment plan and a Stripe-shaped manual-capture authorization request.

Provider write routes:

- `POST /api/robomata/rental-payments/payment-intents`
- `POST /api/robomata/rental-payments/stripe/webhook`
- `POST /api/robomata/rental-payments/bridge/transfers`
- `POST /api/robomata/rental-payments/bridge/webhook`
- `POST /api/robomata/rental-payments/reconcile`

`payment-intents` creates a live Stripe `PaymentIntent` with `capture_method=manual` when `STRIPE_SECRET_KEY` is configured. Local and CI smoke tests can set `ROBOMATA_RENTAL_STRIPE_MOCK=true` to exercise the same platform persistence path without calling Stripe.

Public paid-rental launch must leave `ROBOMATA_RENTAL_STRIPE_MOCK` unset or `false` in the target environment so checkout creates live Stripe PaymentIntents instead of `pi_mock_*` records.

`stripe/webhook` verifies `STRIPE_WEBHOOK_SECRET` outside local development and stores selected provider IDs, statuses, amounts, timestamps, and event references only. It handles authorization, capture, payment failure, refund, dispute, and chargeback event shapes.

`bridge/transfers` requires `ROBOMATA_RENTAL_BRIDGE_ENABLED=true` and creates a Bridge transfer using:

- `BRIDGE_API_KEY`
- `ROBOMATA_RENTAL_BRIDGE_CUSTOMER_ID`
- `ROBOMATA_RENTAL_BRIDGE_SOURCE_RAIL`
- `ROBOMATA_RENTAL_BRIDGE_SOURCE_CURRENCY`
- `ROBOMATA_RENTAL_BRIDGE_ALLOW_ANY_FROM_ADDRESS` when source deposits may come from any sender address
- `ROBOMATA_RENTAL_BRIDGE_DESTINATION_RAIL`
- `ROBOMATA_RENTAL_BRIDGE_DESTINATION_CURRENCY`
- `ROBOMATA_RENTAL_BRIDGE_DESTINATION_ADDRESS`

Local and CI smoke tests can set `ROBOMATA_RENTAL_BRIDGE_MOCK=true` to exercise the same payment persistence path without calling Bridge. When mock mode is enabled, `retrieveBridgeRentalTransfer` returns a full mock snapshot that derives transfer state from existing payment records instead of calling the Bridge API.

`bridge/webhook` verifies Bridge's `X-Webhook-Signature` using `BRIDGE_WEBHOOK_PUBLIC_KEY` or `ROBOMATA_RENTAL_BRIDGE_WEBHOOK_PUBLIC_KEY` outside local development. It stores selected transfer IDs, states, amounts, timestamps, event references, and transaction hashes only. It handles awaiting-funds, in-review, funds-received, submitted, processed, cancelled, returned, refunded, and failed transfer states.

`reconcile` re-fetches Stripe state by `paymentIntentId` and requires `x-robomata-payment-confirmation` with `ROBOMATA_RENTAL_PAYMENT_CONFIRMATION_SECRET` outside local development. When mock mode is enabled (`ROBOMATA_RENTAL_STRIPE_MOCK=true`), the secret check is skipped when the env var is absent.

## Mock And Testing Overrides

Local and CI environments can control mock behavior with these additional variables:

- `ROBOMATA_RENTAL_STRIPE_MOCK_RECONCILE_STATUS` — override the status returned by mock `retrieveStripeRentalPaymentIntent`. Defaults to `requires_capture`. Useful for testing expired-authorisation or canceled-payment flows without calling Stripe.
- `ROBOMATA_RENTAL_STRIPE_MOCK_RECONCILE_STATUS_FILE` — JSON file mapping `paymentIntentId` to status override. Per-intent overrides take priority over the env var default.
- `ROBOMATA_RENTAL_BRIDGE_MOCK_RECONCILE_STATE` — override the state returned by mock `retrieveBridgeRentalTransfer`. Defaults to deriving state from existing payment status.
- `ROBOMATA_RENTAL_BRIDGE_MOCK_RECONCILE_STATE_FILE` — JSON file mapping `transferId` to state override. Per-transfer overrides take priority over the env var default.

Smoke tests exercise the full payment lifecycle by setting `ROBOMATA_RENTAL_STRIPE_MOCK=true` and `ROBOMATA_RENTAL_BRIDGE_MOCK=true` together with the above overrides.

## Approval Payment Validation

The `POST /api/robomata/rental-bookings/:bookingId/approve` route validates payment state before allowing host approval:

1. Booking must be in `host_review` state.
2. Booking must have a `paymentProviderReference`.
3. Vehicle must be `listed` (when inventory is enabled).
4. `confirmBooking` enforces `paymentAuthorized=true` as a hard assertion.

For Stripe, the stored payment must be in `requires_capture` or `captured` status. For Bridge, the stored payment must be in `captured` status. Approvals on bookings with expired, canceled, or failed payment records are rejected with HTTP 409.

## Checkout Flow

1. Renter selects a listed `platformVehicleId` and trip date range.
2. Platform builds a marketplace listing and trip estimate from host controls.
3. Payment plan computes trip charge, platform fees, protection-plan amount, taxes, and deposit hold.
4. Provider authorization request is prepared with manual capture semantics.
5. Provider-write route creates a Stripe payment intent or Bridge transfer and records provider IDs.
6. Stripe bookings can move from `pending_payment_authorization` to host review or confirmation after authorization succeeds.
7. Bridge bookings can move from `pending_payment_authorization` to host review or confirmation only after the transfer is processed.
8. At trip completion, the platform captures the final authorized charge, releases or captures the deposit outcome, and creates immutable revenue ledger entries. For Bridge, deposit handling is prepayment/refund/capture policy rather than card authorization release.

## Deposit Model

The MVP deposit is a card authorization hold, not protocol escrow.

Default policy:

- enabled
- 50% of trip subtotal
- minimum hold: 25,000 cents
- maximum hold: 150,000 cents

The deposit may be released after clean checkout, partially captured for approved claims, or fully captured for severe damage/loss outcomes. Deposit captures require attributable support, claims, or dispute references before revenue recognition.

Bridge deposit handling is a stablecoin prepayment model. It requires explicit legal copy and operational policy for refund timing, returned funds, disputed claims, and partial retention. Until those approvals are recorded, Bridge should be limited to controlled preview or zero-deposit stablecoin payment experiments.

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
- Sensitive stablecoin orchestration, KYC/KYB, and travel-rule payloads stay with Bridge.
- The platform stores provider IDs, statuses, amounts, timestamps, transaction hashes, and audit references only.
- Deposit language, authorization duration, capture reasons, cancellation policies, and tax handling require legal review before launch.
- Authorization windows vary by card network and payment method, so capture/release jobs must monitor expiration.
- Stablecoin escrow, programmable refunds, and onchain renter deposits remain optional rails; Bridge transfer support is the first offchain stablecoin orchestration rail.

## Failure And Outage Assumptions

- If authorization fails, booking remains in `pending_payment_authorization` or is cancelled with `payment_failure`.
- If authorization expires before capture, the booking requires reauthorization before host handoff or trip start.
- If webhook delivery is delayed, provider reconciliation jobs must be able to re-fetch provider state by provider ID.
- If provider capture/refund fails, the platform records a failed payment event and blocks protocol revenue posting until reconciliation succeeds.
