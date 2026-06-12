# Rental Platform Launch Validation Record

Status: Pending external approvals
Date: June 12, 2026
Owner: Legal + Compliance + Product
Linear: ROB-231

## Summary

This record tracks the human approval gates required before rental platform
features move beyond controlled preview.

The current codebase provides the rental platform implementation, feature gates,
privacy boundaries, and operational checklists. It does not provide legal advice
or human approval of launch terms. Public or production enablement remains
blocked until each required owner records an approval. Open blockers may be
recorded here or in the linked Linear issue for traceability, but recording a
blocker does not satisfy the launch gate.

## Launch Decision

Current decision: do not enable public renter booking, host onboarding, rental
payments, revenue posting, or investor rental reporting outside controlled
preview.

Required decision before launch:

- target environment and launch date
- included jurisdictions
- enabled feature flags
- approved policy versions
- final owner sign-offs
- known limitations
- rollback plan
- linked release PRs, Linear issues, and deployment evidence

## Feature Flags Covered

Server-side launch gates:

- `ROBOMATA_RENTAL_INVENTORY_ENABLED`
- `ROBOMATA_RENTAL_INVENTORY_SCHEDULED_SYNC_ENABLED`
- `ROBOMATA_RENTAL_PAYMENTS_ENABLED`
- `ROBOMATA_RENTER_ACCOUNTS_ENABLED`
- `ROBOMATA_RENTAL_BOOKINGS_ENABLED`
- `ROBOMATA_RENTAL_REVENUE_POSTING_ENABLED`
- `ROBOMATA_RENTAL_INVESTOR_REPORTING_ENABLED`
- `ROBOMATA_WORKFLOW_MUTATIONS_ENABLED`

Client-visible launch gates:

- `NEXT_PUBLIC_ROBOMATA_RENTAL_MARKETPLACE_ENABLED`
- `NEXT_PUBLIC_ROBOMATA_RENTAL_HOST_OPS_ENABLED`
- `NEXT_PUBLIC_ROBOMATA_RENTAL_INVESTOR_REPORTING_ENABLED`

Provider and secret gates:

- `POSTGRES_URL`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `ROBOMATA_RENTAL_PAYMENT_CONFIRMATION_SECRET`
- `ROBOMATA_RENTER_VERIFICATION_SECRET`
- `ROBOMATA_RENTER_IDENTITY_PROVIDER`
- `ROBOMATA_RENTER_DRIVER_LICENSE_PROVIDER`
- `ROBOMATA_RENTER_SANCTIONS_PROVIDER`
- `CRON_SECRET`
- `ROBOMATA_RENTAL_INVENTORY_SYNC_SECRET`
- `ROBOMATA_RENTAL_INVENTORY_METADATA_ALLOWED_ORIGINS`
- `ROBOMATA_RENTAL_INVENTORY_FACILITY_OWNERS_JSON`
- `ROBOMATA_FACILITY_REGISTRY_ADDRESSES_JSON` or target-chain `ROBOMATA_FACILITY_REGISTRY_ADDRESS_<chainId>`
- `NEXT_PUBLIC_PRIVY_APP_ID`
- `PRIVY_APP_SECRET`
- `ROBOMATA_RENTAL_STRIPE_MOCK` must be unset or `false` for public paid-rental launch

## Required Sign-Off Matrix

| Area | Required owner | Required evidence | Current status |
| --- | --- | --- | --- |
| Legal terms | Legal | Approval of renter terms, host terms, cancellation/refund policy, claims policy, protection-plan wording, deposit language, payment authorization/capture timing, refund/chargeback language, tax collection/remittance/invoice language, host payout timing, securities-adjacent disclosure overlap, partner classification and payout structure, investment-disclosure separation, and utilization/yield/revenue claim language for each launch jurisdiction | Pending |
| Privacy and retention | Privacy | Approval of renter verification notices, trip data handling, support/claims retention, deletion/access/correction handling, and raw-PII provider boundary | Pending |
| Payments and deposits | Payments | Stripe authorization, capture, cancellation, refund, dispute, chargeback, tax, invoice, deposit-hold validation, and confirmation that `ROBOMATA_RENTAL_STRIPE_MOCK` is unset or `false` in each launch environment | Pending |
| Trust and safety | Trust | Approval of manual verification override, sanctions review, safety takedown, fraud review, claims evidence, and payout-hold workflows | Pending |
| Revenue operations | Revenue Operations | Approval of recognized revenue policy, posting-batch caps, pass-through exclusions, retry behavior, and protocol transaction reconciliation | Pending |
| Investor communications | Investor Relations | Approval that investor reporting and copy exclude renter identity, claim narratives, support-sensitive data, and guaranteed yield language | Pending |
| Operations readiness | Product Operations + Engineering | Escalation paths for failed verification, failed authorization, incidents, disputes, safety takedowns, payout holds, rollback, Postgres schema bootstrap, backup/restore readiness, inventory metadata origin allowlist, facility ownership/source-attribution configuration, target-chain FacilityRegistry addresses, and Privy partner-auth configuration | Pending |
| Product launch scope | Product | Final launch environment, jurisdictions, enabled flags, known limitations, support model, and rollback plan | Pending |

## Evidence Sources

Implementation and product scope:

- [Roboshare Rental Platform PRD](./rental-platform-prd.md)
- [Rental Platform Facility Inventory Boundary](./rental-platform-facility-inventory.md)
- [Rental Platform Host Setup Flow](./rental-platform-host-setup.md)
- [Rental Platform Host Controls](./rental-platform-host-controls.md)
- [Rental Platform Marketplace Listing Model](./rental-platform-marketplace-listings.md)
- [Rental Platform Booking Checkout](./rental-platform-booking-checkout.md)
- [Rental Platform Trip Check-In And Check-Out](./rental-platform-trip-check-in-out.md)
- [Rental Platform Cancellations And Support](./rental-platform-cancellations-support.md)
- [Rental Platform Claims And Safety](./rental-platform-claims-safety.md)

Compliance, privacy, and finance scope:

- [Rental Platform Compliance Launch Checklist](./rental-platform-compliance-launch-checklist.md)
- [Rental Platform Renter Accounts And Verification](./rental-platform-renter-verification.md)
- [Rental Platform Payments And Deposits](./rental-platform-payments-deposits.md)
- [Rental Platform Persistence And Retention](./rental-platform-persistence.md)
- [Rental Platform Revenue Ledger](./rental-platform-revenue-ledger.md)
- [Rental Platform Earnings Posting](./rental-platform-earnings-posting.md)
- [Rental Platform Revenue Attestation](./rental-platform-revenue-attestation.md)
- [Rental Platform Investor KPI Model](./rental-platform-investor-kpis.md)

Code and configuration evidence:

- `web/lib/featureFlags.ts`
- `web/.env.example`
- `web/lib/robomata/rentalPersistencePolicy.ts`
- `web/lib/robomata/rentalPayments.ts`
- `web/lib/robomata/rentalRenters.ts`
- `web/lib/robomata/rentalRevenue.ts`
- `web/lib/robomata/server/rentalStripe.ts`
- `web/scripts/sql/robomata-rental-persistence.sql`
- `web/scripts/robomata-rental-stripe-payments-smoke.mjs`

## Approval Record

Add approvals here only when the responsible owner has reviewed the linked
evidence and approved launch for the named environment and jurisdictions.

| Date | Owner | Area | Environment | Jurisdictions | Decision | Evidence link | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TBD | TBD | TBD | TBD | TBD | Pending | TBD | TBD |

## Open Blockers

- No legal approval has been recorded for renter terms, host terms,
  cancellation/refund policy, claims policy, protection-plan wording, privacy
  policy, retention policy, deposit language, payment authorization/capture
  timing, refund/chargeback language, tax collection/remittance/invoice
  language, host payout timing, securities-adjacent disclosure overlap, partner
  classification and payout structure, investment-disclosure separation, or
  utilization/yield/revenue claim language.
- No privacy approval has been recorded for renter verification notices, trip
  data handling, support/claims retention, deletion/access/correction handling,
  or the raw-PII provider boundary.
- No payment owner approval has been recorded for live Stripe manual-capture,
  refund, dispute, chargeback, tax, invoice, or deposit-hold behavior in target
  launch jurisdictions.
- No payment owner approval has been recorded that
  `ROBOMATA_RENTAL_STRIPE_MOCK` is unset or `false` in every public paid-rental
  launch environment.
- No trust/safety approval has been recorded for manual verification overrides,
  sanctions review, safety takedowns, claim evidence, or payout holds.
- No Revenue Operations approval has been recorded for recognized revenue
  policy, posting-batch caps, pass-through exclusions, retry behavior, or
  protocol transaction reconciliation.
- No investor-relations approval has been recorded for the separation between
  investor reporting and renter/host marketplace communications.
- No Product Operations readiness approval has been recorded for failed
  verification, failed authorization, incidents, disputes, safety takedowns,
  payout holds, escalation paths, or rollback operations.
- No Engineering/Product Operations approval has been recorded that
  `POSTGRES_URL` is provisioned, `yarn robomata:rental-persistence:bootstrap`
  has run successfully in the target environment, and rental table
  backup/restore/replay readiness has been validated.
- No inventory metadata origin allowlist has been recorded for HTTPS
  `assetMetadataURI` or `rentalInventoryManifestUri` values used by scheduled
  FacilityRegistry sync.
- No facility ownership plan has been recorded for production inventory access:
  each launch facility must either have `ROBOMATA_RENTAL_INVENTORY_FACILITY_OWNERS_JSON`
  configured for the authorized partner or ingest manifests whose `sourceId`
  matches that partner.
- No target-chain FacilityRegistry address plan has been recorded: every launch
  chain used by scheduled inventory sync must resolve a generated deployment or
  configure `ROBOMATA_FACILITY_REGISTRY_ADDRESSES_JSON` or the matching
  `ROBOMATA_FACILITY_REGISTRY_ADDRESS_<chainId>`.
- No partner-auth readiness approval has been recorded: deployed rental
  inventory, host, and revenue operations require `NEXT_PUBLIC_PRIVY_APP_ID` and
  `PRIVY_APP_SECRET` so protected routes can verify wallet ownership before
  PartnerManager authorization.
- No final launch environment, launch date, jurisdiction list, enabled-flag set,
  approved policy versions, known limitations, support model, or rollback plan
  has been recorded.

## Completion Rule

`ROB-231` can move to `Done` only when every required sign-off has an approval
record or an explicit product decision narrowing the launch scope so the
unapproved area is not enabled.

The Rental Platform project can be treated as implementation-complete but not
launch-complete while this record contains pending blockers.
