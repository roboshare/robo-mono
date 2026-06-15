# Roboshare Marketing And App IA Split

## Summary

Roboshare is moving from a single mixed marketing/application surface into a
clear public marketing site plus a canonical authenticated app surface.

The public story is:

1. operators become financeable with Robomata
2. capital providers review, monitor, and underwrite through future Robolend
   workflows
3. markets distribute standardized and tokenized exposure downstream from those
   financeability rails

This document is the source of truth for route ownership, persona language,
host routing, compatibility redirects, and release sequencing for the IA split.

## Personas

### Operators

Operators own or manage productive assets and receivables. In the first
Robomata workflow, the operator is a fleet operator that uploads receivables,
attaches evidence, resolves exceptions, computes a borrowing base, and creates a
lender-ready packet.

Use `Operator` for authenticated workflow labels. Do not use `Partner` for
operator-facing product navigation.

### Capital Providers

Capital providers are lenders, private credit funds, banks, captives, and other
credit allocators. They review lender-ready packets today and may later use
Robolend monitoring or underwriting workflows.

Use `Capital Provider` in public marketing. Keep `Lender` for protected packet
copy and the existing `/lender/packet/[token]` route until a capital-provider
dashboard exists.

### Integration Partners

Integration partners provide the data and service rails that make borrowing
base evidence reliable: telematics, lockbox, insurance, UCC, lien, title,
accounting, servicing, and other provider categories.

Use `Partners` only for this public integration-partner audience.

## Domain Ownership

The initial implementation stays inside one Next app and one Vercel project.
Host-aware routing should create clean public/app behavior without forcing a
repo or deployment split yet.

Public marketing hosts:

- `roboshare.finance`
- `www.roboshare.finance`

Authenticated app host:

- `app.roboshare.finance`

Local development:

- `localhost`, `127.0.0.1`, preview URLs, and branch deployments must remain
  usable without forced domain redirects unless explicit host-routing
  environment variables are configured.

## Public Marketing Routes

The marketing site should be coherent without requiring a wallet connection or
operator authorization.

| Route | Owner | Purpose |
| --- | --- | --- |
| `/` | Marketing | Roboshare homepage. It must not auto-redirect to `/markets`. |
| `/products/robomata` | Marketing | Active operator product page for borrowing-base readiness. |
| `/products/robolend` | Marketing | Capital-provider product page marked `Coming soon`. |
| `/markets` | Marketing | Downstream capital markets and distribution explainer. |
| `/partners` | Marketing | Integration partner page for data, servicing, and infrastructure partners. |
| `/robomata` | Marketing compatibility | Existing public Robomata surface. It should redirect to or render the same product story as `/products/robomata` during migration. |

Public navigation should use:

- `Products`
- `Markets`
- `Partners`
- `Company` or `Docs`
- `Launch App`

The `Products` menu should include:

- `Robomata`
- `Robolend` with `Coming soon`

`Launch App` should send users to the app host and canonical operator entry
point when host routing is enabled.

## Authenticated App Routes

The authenticated app should use operator language and keep private workflow
state out of public marketing routes.

| Route | Owner | Purpose |
| --- | --- | --- |
| `/operator` | App | Canonical operator portal. |
| `/operator/submissions` | App | Borrowing-base submission list. |
| `/operator/submissions/[submissionId]` | App | Borrowing-base workspace for one submission. |
| `/lender/packet/[token]` | Protected packet | Opaque-token packet access. Preserve this route. |
| `/subgraph` | Admin app | Admin-only subgraph diagnostics. |
| `/debug` | Admin app | Admin-only contract debugging. |

On the dedicated app host, primary navigation should stay intentionally narrow:

- `Markets`
- `Dashboard`

Operator submission, monitoring, rental ops, admin diagnostics, and protected
packet surfaces remain available through their direct permissioned routes or
in-workflow links, but they should not appear in the app-host top navigation
until a broader authenticated app navigation model is designed.

Do not create a full lender or capital-provider dashboard in this tranche.
Protected packet links remain the controlled share surface.

## Compatibility Redirects

The old operator route family remains as a temporary compatibility layer for
one or two releases:

| Legacy route | Redirect target |
| --- | --- |
| `/partner` | `/operator` |
| `/partner/submissions` | `/operator/submissions` |
| `/partner/submissions/[submissionId]` | `/operator/submissions/[submissionId]` |

These redirects must not create duplicate editable surfaces. New copy,
navigation, and documentation should use `/operator`.

## Host-Aware Routing Rules

On marketing hosts:

- app-only routes redirect to the equivalent `app.roboshare.finance` URL
- protected packet links may redirect to the app host or remain accessible if
  the release implementation intentionally supports both
- marketing routes stay on the marketing host

On app host:

- marketing-only routes redirect to the equivalent `www.roboshare.finance` URL
- app routes stay on the app host
- `/lender/packet/[token]` stays accessible as protected packet access

On local and preview hosts:

- do not force production host redirects by default
- allow all routes to render so local QA and branch previews remain usable

## Product Positioning

### Robomata

Robomata is the active operator product. It helps operators turn receivables and
asset evidence into lender-ready borrowing-base packets with verifiable evidence
rails.

The product flow is:

1. create an operator submission
2. import receivables
3. attach evidence
4. compute borrowing base
5. resolve exceptions
6. generate packet
7. commit evidence
8. optionally originate tokenized facility exposure downstream

### Robolend

Robolend is the future capital-provider product. It should be marked
`Coming soon` and framed around review, monitoring, and credit allocation
workflows. Do not imply that a full capital-provider dashboard is live.

### Markets

Markets are downstream from financeability. The markets story should describe
standardized and tokenized facility exposure produced from Robomata-ready
operators, not a generic marketplace disconnected from the operator workflow.

### Partners

Partners means integration partners. The page should recruit telematics,
lockbox, insurance, UCC/lien/title, accounting, servicing, and data providers.
It should not be the operator portal.

## Current Product Dependencies

PR #184 added operator facility monitoring foundations and has landed on `dev`.
The IA split must keep monitoring inside the operator portal and avoid treating
monitoring as a public facility browser.

PR #185 adds lender-pinned monitoring packets. Until that work is merged, route
migration should be checked for conflicts against its packet/share surfaces.
The intended outcome is that lender-pinned monitoring remains protected packet
or share-link behavior, not a full capital-provider dashboard.

Completed tokenization origination means marketing should describe Markets as a
downstream path from committed Robomata borrowing-base facilities into
standardized/tokenized exposure.

## Implementation Phases

### Phase 1: IA Spec And Route Ownership

- Add this spec.
- Keep implementation work blocked until the route and persona model is explicit.

### Phase 2: Marketing Site Pages

- Remove the `/` auto-redirect to `/markets`.
- Rebuild `/` as the public homepage.
- Add `/products/robomata`.
- Add `/products/robolend` with `Coming soon`.
- Add `/partners` for integration partners.
- Reframe `/markets` as downstream markets/distribution.
- Add public navigation and product menu.

### Phase 3: App Route Migration

- Add canonical `/operator` routes.
- Add `/partner*` compatibility redirects.
- Update app nav and CTAs from Partner to Operator, with the app-host primary
  nav limited to `Markets` and `Dashboard`.
- Preserve protected packet links.

### Phase 4: Host Routing And QA

- Add host-aware routing guards.
- Verify marketing host, app host, preview, localhost, and packet-link behavior.
- Check compatibility with PR #184 and PR #185.

### Phase 5: Release Readiness

- Run browser QA.
- Prepare release notes.
- Cut a release branch only from a green `dev` commit.
- Merge release fixes back to `dev` immediately.

## Test Plan

- `yarn web:check-types`
- `yarn web:lint`
- `yarn web:build`
- browser QA for `/`, `/products/robomata`, `/products/robolend`, `/partners`,
  `/markets`, `/operator`, `/operator/submissions`, `/partner*` redirects, and
  `/lender/packet/[token]`
- host QA for marketing host, app host, preview host, and localhost
