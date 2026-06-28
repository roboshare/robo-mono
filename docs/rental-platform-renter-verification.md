# Rental Platform Renter Accounts And Verification

Status: Draft
Date: June 27, 2026
Owner: Product + Trust

## Summary

Renter accounts are platform accounts, not protocol wallets. A renter can create a profile with email or phone and begin booking flows without connecting an onchain wallet.

Shared TypeScript contracts live in `web/lib/robomata/rentalRenters.ts`. Server persistence lives in `web/lib/robomata/server/rentalRenterStore.ts`.

## Verification Model

The MVP checkout gate is policy-driven by `RENTER_VERIFICATION_POLICY_V1`. It requires three checks:

- identity
- driver license
- sanctions

Each check supports these statuses:

- `not_started`
- `pending`
- `approved`
- `manual_review`
- `failed`
- `expired`

`renterCheckoutEligibility` returns `eligible=false` and the blocking checks until all required checks are approved and unexpired.

The policy version is returned with checkout eligibility so booking, support, and compliance tooling can explain which rules were applied.

## Control Plane

Verification writes are decision records, not raw vendor payload storage. Each decision records:

- check kind
- status
- decision source: `provider`, `admin_override`, or `system`
- policy version
- provider and provider reference, when applicable
- actor attribution
- reason
- expiry

Every decision appends a `verificationAuditLog` entry to the renter profile. Manual administrative overrides use the `manual_override_applied` action and must include actor attribution plus a reason.

## API

Initial renter APIs:

- `POST /api/robomata/rental-renters`
- `GET /api/robomata/rental-renters/:renterId`
- `PATCH /api/robomata/rental-renters/:renterId/verification`
- `POST /api/robomata/rental-renters/:renterId/verification/override`
- `GET /api/robomata/rental-renters/verification-policy`

These APIs require `ROBOMATA_RENTER_ACCOUNTS_ENABLED=true`.

Verification updates also require `ROBOMATA_WORKFLOW_MUTATIONS_ENABLED=true`. Outside local development, verification updates require `ROBOMATA_RENTER_VERIFICATION_SECRET` and `Authorization: Bearer <secret>` so only an ops tool or verification-provider callback can mutate status.

Provider callbacks should use `PATCH /verification` with provider attribution. Operations tooling should use `POST /verification/override`; override requests are stored as `decisionSource=admin_override`, require a reason, and are audit logged separately from provider decisions.

Production and preview environments must configure one accepted provider identifier per required check:

- `ROBOMATA_RENTER_IDENTITY_PROVIDER`
- `ROBOMATA_RENTER_DRIVER_LICENSE_PROVIDER`
- `ROBOMATA_RENTER_SANCTIONS_PROVIDER`

The provider callback route rejects non-local updates when the relevant provider identifier is missing. It also rejects callbacks whose `provider` does not match the configured provider for the check kind, callbacks without `providerReferenceId`, and callbacks with non-provider actor attribution. Local development can force the same validation by setting `ROBOMATA_RENTER_VERIFICATION_REQUIRE_PROVIDER_CONFIG=true`.

`GET /api/robomata/rental-renters/verification-policy` returns the active policy and non-secret provider configuration metadata so operators can verify that each required check is wired before launch.

Local development may use `ROBOMATA_RENTER_ACCOUNTS_FILE` when `POSTGRES_URL` is absent. Shared preview and production environments should use `POSTGRES_URL`.

## Privacy Boundary

The platform stores contact fields, provider references, statuses, reasons, review attribution, and expiration timestamps. It should not store raw identity documents, driver-license images, full SSNs, payment method data, or sanctions result payloads in the rental platform database.

Provider IDs and review audit references are sufficient for support and compliance traceability.

Verification vendors should retain sensitive source documents under their own retention controls. Roboshare should fetch or deep-link to vendor records for authorized review instead of copying sensitive artifacts into `robomata_rental_renters`.

## Booking Boundary

Booking checkout can begin before verification is complete, but confirmation must be gated when policy requires verification. A failed, expired, or manual-review check should keep the booking in verification or cancellation paths rather than moving directly to confirmed.

Manual overrides can approve a check, but the approval should remain tied to the current policy version and should expire when the underlying provider or legal policy requires re-verification.

## Verification

Run the provider/control-plane smoke before enabling live provider callbacks:

```bash
yarn robomata:rental-verification-providers-smoke
```

The smoke starts a local app with configured identity, driver-license, and sanctions providers, then verifies invalid-provider rejection, raw provider payload rejection, manual-review blocking, failed-license blocking, expired-check blocking, admin override attribution, and final booking confirmation after all required checks are approved and unexpired.
