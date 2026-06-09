# Robomata Overflow v0.1.7

## Scope

Patch release for the Robomata Overflow testnet line. This cut ships the
public Robomata product surface and controlled lender packet sharing work that
landed after `robomata-overflow-v0.1.6`.

## Included Work

- Reframes `/robomata` as a public marketing and product-positioning route
  with no partner authentication, no submission loading, and no
  `/robomata?submission=...` projection path.
- Keeps `/partner/submissions` and `/partner/submissions/[submissionId]` as
  the authenticated operator workflow for borrowing-base submissions.
- Adds the protected lender packet sharing model, share-link APIs, and
  operator UI for creating, listing, revoking, and inspecting access metadata.
- Adds `/lender/packet/[token]` as the protected lender-ready packet view for a
  single submission.
- Keeps Walrus, Seal, Sui, digest, and transaction details behind advanced
  packet/evidence disclosures instead of exposing them on the public surface.
- Adds `yarn robomata:local-smoke` for public-route, partner-route,
  submission-flow, and protected share-link lifecycle QA.

## Included PRs

- `#173` `feat(robomata): split public surface from partner workflow`
- `#174` `docs(robomata): define protected lender sharing model`
- `#175` `feat(robomata): add protected packet share APIs`
- `#176` `feat(robomata): add protected packet share UI`
- `#177` `chore(robomata): add controlled sharing QA smoke`

## Deployment Notes

- This is a web/server release only.
- No Sui package republish is required because no Move code or onchain function
  signatures changed.
- Share links remain feature-flagged. Set both server and client flags before
  exposing the operator UI:
  - `ROBOMATA_SHARE_LINKS_ENABLED=true`
  - `NEXT_PUBLIC_ROBOMATA_SHARE_LINKS_ENABLED=true`
- Protected share links require durable storage outside local development:
  - `POSTGRES_URL`
  - `ROBOMATA_SHARE_LINK_TOKEN_SECRET`
- Existing Robomata workflow flags remain required for the authenticated
  operator flow:
  - `ROBOMATA_WORKFLOW_ENABLED=true`
  - `ROBOMATA_WORKFLOW_MUTATIONS_ENABLED=true`
  - `NEXT_PUBLIC_ENABLE_ROBOMATA_WORKFLOW=true`

## Verification

Local verification on the final implementation stack:

- `yarn web:check-types`
- `yarn web:lint`
- `yarn web:build`
- `yarn robomata:local-smoke`
- `git diff --check`

PR #177 CI verification:

- `Web lint and types (ubuntu-latest, 24.x)` passed.
- `Web build (ubuntu-latest, 24.x)` passed.
- `EVM lint (ubuntu-latest, 24.x)` passed.
- `EVM compile and tests (ubuntu-latest, 24.x)` passed.
- `Sui lint` skipped because no Sui files changed.
- `Sui compile and tests` skipped because no Sui files changed.
- Vercel preview deployment passed.

Live testnet smoke note:

- `yarn robomata:testnet-smoke` was not rerun successfully in the ROB-148 QA
  branch because local CLI env injection did not expose `ROBOMATA_SUI_NETWORK`
  to the smoke process.
- The release does not change Sui, Walrus, Seal, or evidence commit code.
  Existing live testnet evidence remains the ROB-134 result recorded in
  `docs/robomata-overflow-qa.md`.

## Known Limitations

- `/robomata` is not a public facility browser.
- Protected packet links are bearer-style links with expiry and revocation; do
  not treat them as recipient-authenticated lender portals yet.
- No production public-record, carrier, bank, insurance, title, lien, or
  telematics API integrations are claimed.
- Legal enforceability, lien perfection, custody, transfer agency, and
  regulated distribution remain out of scope for this release.
