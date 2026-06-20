# Robomata Overflow v0.1.9

## Scope

Prerelease cut from the current `dev` head after `robomata-overflow-v0.1.8`.
This release promotes the operator monitoring, lender packet monitoring,
tokenized facility origination, and Roboshare marketing/app IA split work that
landed on `dev`.

## Included Work

- Adds tokenized facility origination from persisted Robomata submissions.
- Adds Robomata facility monitoring foundations and operator monitoring
  surfaces under the canonical operator workflow.
- Adds lender-pinned monitoring packets as protected packet/share flows rather
  than a public lender dashboard.
- Rebuilds `/` as the public Roboshare marketing homepage instead of redirecting
  to `/markets`.
- Adds public product surfaces for Robomata and Robolend:
  `/products/robomata` and `/products/robolend`, with Robolend marked
  `Coming soon`.
- Adds `/partners` as the public integration-partner page for evidence,
  servicing, telematics, lockbox, insurance, and related data providers.
- Reframes `/markets` as the downstream distribution layer while preserving live
  market functionality.
- Moves authenticated operator workflows to canonical `/operator` routes and
  keeps `/partner*` as temporary compatibility redirects.
- Adds host-aware marketing/app routing guards for `roboshare.finance`,
  `www.roboshare.finance`, and `app.roboshare.finance`.

## Deployment Notes

- Deploy the web app from `main` after the release PR merges.
- Configure production DNS so `roboshare.finance` and `www.roboshare.finance`
  serve the public marketing surface, and `app.roboshare.finance` serves the app
  surface.
- Keep `/partner*` compatibility redirects for one or two releases before
  removing legacy operator route aliases.
- Robolend remains a coming-soon product; do not market it as a live capital
  provider dashboard yet.
- Protected lender packet access remains token-gated; this release does not add
  public facility discovery.
- No Sui package republish is required for the marketing/app IA split.

## Verification

- `yarn web:check-types`
- `yarn web:lint`
- `yarn web:build`
- PR #187 CI:
  - Web lint and types: passed
  - Web build: passed
  - Vercel preview: passed
- Local QA on merged `dev` at `365d098`:
  - `/` renders the public marketing homepage and does not redirect.
  - `/products/robomata` presents the active operator product.
  - `/products/robolend` is clearly marked `Coming soon`.
  - `/partners` targets integration partners.
  - `/markets` presents the downstream distribution story.
  - `/partner` redirects to `/operator`.
  - `/partner/submissions` redirects to `/robomata/submissions`.
  - Marketing host redirects app-only routes to `app.roboshare.finance`.
  - App host redirects marketing routes to `www.roboshare.finance`.
  - Protected packet routes remain available on app host.
