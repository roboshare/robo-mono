# Robomata Overflow v0.1.13

## Scope

Release cut from the current `dev` head after `robomata-overflow-v0.1.12`.
This release packages the Robomata workspace, rental platform, wallet, evidence,
and supervised-agent work accumulated since the last production release.

## Included Work

- Adds the rental marketplace, host operations, investor reporting, booking,
  renter verification, payments, Bridge transfer, and revenue posting surfaces.
- Splits Roboshare marketing and app navigation, adds app product spaces, and
  keeps marketing pages free of wallet network and balance chrome.
- Expands the Robomata facility workspace with monitoring, packet freshness,
  evidence status derivation, lender packet next actions, and more resilient CSV
  import and draft flows.
- Adds supervised-agent policy artifacts, lender appointments, bounded action
  permissions, OpenAI and Gemini review/planner adapters, planner provenance,
  and MemWal-backed agent memory.
- Hardens Privy Sui evidence anchoring, Sui raw signing, Walrus evidence upload
  bounds, production host navigation, app-host routing, and browser RPC usage.

## Deployment Notes

- Deploy the web app from `main` after the release branch merges.
- Verify the configured production and preview app hosts before enabling the
  new app navigation paths externally.
- Keep Robomata rental payment, Bridge, Gemini, OpenAI, MemWal, Sui, Walrus, and
  Postgres variables scoped to environments where those flows are enabled.
- The release carries the dev-side workflow token-permission fix alongside the
  matching main-side CI hardening commit.

## Verification

- `yarn web:check-types`
- `yarn web:lint`
- `yarn web:build`
- `yarn robomata:local-smoke`
- `yarn robomata:agent-memory-smoke`
