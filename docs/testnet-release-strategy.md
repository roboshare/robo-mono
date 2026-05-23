# Testnet Release Strategy

## Summary

This document captures the non-sensitive release strategy for Roboshare's first public testnet cycle.
It covers phase ordering, release gates, branching, versioning, and launch messaging at a level that should stay versioned with the codebase.

Current release defaults:

- Default chain: `Sepolia`
- Historical first release line: `release/testnet-v0.2.0`
- Current status: `release/testnet-v0.2.0` has been merged into `main`
- Follow-on deployment added in this release line: `Monad Testnet`
- Earlier planned follow-on deployments in this release line: `Polygon Amoy`, `Arbitrum Sepolia`
- Deferred to a later release line: `Base Sepolia`
- Repo posture: private-source, all rights reserved
- Launch sequence: `internal hardening -> quiet beta -> public testnet launch`
- Indexing: managed The Graph deployment path
- Incentives: none in the first public testnet cycle

## Release Principles

- Ship a working product before broad promotion.
- Use `Sepolia` as the primary reference network in docs, QA, and support.
- Keep every public release traceable to a release branch and Git tag.
- Announce only from a tagged, reproducible build.
- Keep public-facing surfaces clearly branded as Roboshare while preserving Scaffold-ETH attribution.
- Defer non-critical features if they threaten launch reliability.

## Phase Ordering

### Phase 1: Release Foundations

- Keep day-to-day development on `dev`.
- Create short-lived feature or fix branches from `dev`.
- Prepare the active release branch:
  - `release/testnet-v0.2.0`
- Use pre-release tags for launch stages on that same release line:
  - `v0.2.0-internal.1`
  - `v0.2.0-beta.1`
  - `v0.2.0-testnet.1`
- Define the release-note format before beta begins.

### Phase 2: Technical Readiness

- Complete deploy and verify flow for `Sepolia`.
- Prepare `Polygon Amoy` and `Arbitrum Sepolia` as follow-on deployments once `Sepolia` quiet beta is stable.
- Make `Sepolia` the default chain in the product and docs.
- Replace public-facing localhost assumptions with chain-aware configuration.
- Publish the managed The Graph deployment for the currently active quiet-beta chain.
- Seed realistic demo state on `Sepolia`.
- Finish the public-facing README and CONTRIBUTING cleanup before beta.

### Phase 3: Quiet Beta

- Cut `release/testnet-v0.2.0` only from a green `dev` commit.
- Tag the first beta build as `v0.2.0-beta.1`.
- Deploy quiet beta only from the tagged release branch.
- Start with partners and trusted users through direct outreach.
- Treat `Sepolia` as the only active beta path until quiet-beta exit criteria are met.
- Treat `Polygon Amoy` and `Arbitrum Sepolia` as expansion targets after `Sepolia` stabilizes.
- Fix launch blockers on the release branch and merge them back into `dev`.

### Phase 4: Public Testnet Launch

- Tag the public launch commit as `v0.2.0-testnet.1`.
- Publish the matching GitHub release from that exact tag.
- Announce only after quiet beta exit criteria are met.
- Sequence launch channels:
  - partners/direct outreach first
  - then `X`, `Telegram`, and `Farcaster`
- Use a short post-launch stabilization window before any broader campaign.

## Quiet Beta And Public Launch Gates

Quiet beta is ready only when:

- core `Sepolia` flows work end to end
- no blocker-level issues remain in wallet connection, chain switching, listings, purchases, withdrawals, or indexed data freshness
- public-facing docs are accurate enough for external testers

Public launch is ready only when:

- quiet beta passed
- the app is deployed from a tagged release-branch commit
- release notes are prepared
- support instructions and bug-report instructions are ready
- all public-facing product surfaces are aligned with the current launch scope

## Branching And Versioning

### Branching Model

- `dev` is the integration branch.
- Feature work happens on short-lived feature and fix branches.
- The active launch line is isolated on `release/testnet-v0.2.0`.
- Launch blockers and hotfixes are fixed on the release branch first.
- Every release-branch fix shipped externally must be merged back into `dev`.

### Deployment Model

- Vercel production stays pinned to the stable long-lived branch: `main`.
- `dev` and `release/*` branches are used for preview and release-stabilization deployments, not as the long-term production branch setting.
- The release branch is the place to stabilize a version line and verify internal and beta environments.
- The final ship step is:
  - merge the approved `release/*` branch into `main`
  - let Vercel deploy `main` automatically as production
  - tag the shipped commit on the release line with the appropriate channel tag
- Avoid changing the Vercel production-branch setting for every release line.
- Avoid relying on manual deployment promotion as the default release mechanism.

### Versioning Model

- Use pre-release SemVer tags for the testnet lifecycle.
- Promote the active release line through the launch stages:
  - `v0.2.0-internal.1`
  - `v0.2.0-beta.1`
  - `v0.2.0-testnet.1`
- Use patch bumps for launch fixes.
- Use minor bumps for meaningful user-facing capability changes before mainnet.
- Treat `release/robomata-overflow-v0.1.0` as a separate Robomata MVP line, not
  a continuation of the historical Roboshare testnet `v0.2.0` line.

### Release Truth

Every public-facing release should be traceable through:

- Git tag
- GitHub release entry
- commit SHA
- deployed addresses
- subgraph endpoints
- known limitations

Do not treat monorepo `package.json` versions as the public release truth.

In practice for hosted environments, this means:

- release-candidate validation happens from `release/*` preview deployments
- the externally served production deployment comes from `main`
- the release tag identifies the exact approved code state for that release stage

## Announcement Plan

### Quiet Beta Messaging

- keep outreach direct and narrow
- include the app URL, supported chains, what to test, and how to report issues
- ask testers to start on `Sepolia`

### Public Launch Messaging

Primary framing:

- Roboshare public testnet is live
- `Sepolia` is the default chain
- the first public release line rolls out `Sepolia` first, with additional testnets enabled in follow-on phases
- feedback is wanted on real usage, not on speculative hype

Required assets:

- one X thread
- one Telegram launch post
- one Farcaster post
- one partner outreach message
- one tester instruction message

Messaging priorities:

- be explicit about current scope and known limits
- keep the first public cycle focused on feedback quality
- avoid incentives in the first cycle

## Public And Private Docs Split

Keep these materials in the repo:

- public architecture and developer documentation
- release strategy
- non-sensitive technical checklists

Keep these materials in a private ops system, such as a Linear doc:

- launch-day owner assignments
- exact support channels
- partner lists
- rollback decision process
- secret-adjacent operational details

## Assumptions

- `Sepolia` remains the primary/default launch network.
- `Base Sepolia` is out of scope for the first public launch.
- The repo remains private-source for this cycle; third-party dependencies keep
  their own license terms.
- Managed The Graph indexing is available for the supported first-launch testnets.
- Smart-wallet work is not on the critical path unless the base wallet UX proves inadequate.
- There is only one active public testnet release line at a time.
