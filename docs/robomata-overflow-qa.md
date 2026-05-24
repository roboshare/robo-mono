# Robomata Overflow Demo Flow QA And Submission Gate

## Scope

This document records the end-to-end QA pass for the demo-flow tranche on
`integration/robomata-overflow-demo-flow` and the child branch
`feat/robomata-overflow/rob-121-demo-qa-submission`.

Release path for this tranche:

* child branches target `integration/robomata-overflow-demo-flow`
* `integration/robomata-overflow-demo-flow` targets `dev`
* release branch remains `release/robomata-overflow-v0.1.0`
* validated release merges into `main`

## Verification Results

Recorded on `2026-05-23` and refreshed on `2026-05-24`.

### Repo State

* `git status --short --branch`
  * current branch: `feat/robomata-overflow/rob-121-demo-qa-submission`
  * unrelated pre-existing local changes remain outside this issue:
    * `protocols/evm/scripts-js/checkAccountBalance.js`
    * `.antigravitycli/`
    * `docs/canva-pitch-deck-handoff.md`

### Web

* `yarn web:lint`: pass
* `yarn web:check-types`: pass
* `yarn web:build`: pass
  * `/robomata` builds as a dynamic route (`ƒ /robomata`)

### Sui

* `sui move build --path protocols/sui --warnings-are-errors`: pass
* `sui move build --path protocols/sui --lint --warnings-are-errors`: pass
* `sui move test --path protocols/sui --warnings-are-errors`: pass
  * `authorized_operator_passes`
  * `unauthorized_operator_fails`

## Browser QA

### `/robomata`

Verified in a real browser pass at both a narrow viewport (`599x779`) and a
desktop viewport (`1440x1024`).

Confirmed on-page:

* hero renders with the lender-facing thesis:
  * `Turn fleet receivables into a lender-ready borrowing base.`
* first-customer operator is `MetroFleet Logistics`
* facility card renders:
  * `MetroFleet 2026 Fleet Receivables Facility`
  * `82.0%` advance rate
  * `35%` concentration limit
  * `5` open exceptions
* deterministic portfolio table renders the sample receivables set
* lender-ready certificate renders with availability and certificate statement
* exception workflow renders as a lender follow-up packet and exception memo
* evidence anchor trail renders:
  * commitment root
  * Sui commit path
  * Walrus object references
  * Seal policy references
* evidence library renders grouped controlled evidence references
* demo-only disclosures remain explicit and do not imply production public API
  access

No browser console errors were captured during the `/robomata` pass.

### Legacy Surfaces

Rechecked on `2026-05-24` against the already running local app at
`http://localhost:3001`, using the repo's standard `yarn start` flow outcome.

Observed:

* `/markets` renders normally with the expected local warning:
  * `No subgraph endpoint configured for chain 11155111.`
* `/partner` renders the gated unauthorized state rather than a blank page:
  * `Partner Access Required`
* both routes report the expected `Roboshare` document title in-browser

Conclusion:

* the earlier blank-page finding did not reproduce on the live local server
* treat that earlier observation as an environment-specific false alarm, not an
  integration blocker for this tranche

## Overflow Demo Script

Use the `/robomata` route as the primary demo surface.

1. Start at the hero and frame Robomata as borrowing-base and diligence
   infrastructure for a fleet operator, not a generic tokenization surface.
2. Show the MetroFleet operator card and the current workflow pain.
3. Walk the receivables table and highlight eligibility, concentration, and
   borrowing-base availability.
4. Show the lender-ready certificate statement and explain what a credit team
   can forward internally.
5. Show the exception memo and lender follow-up packet as the operational output
   of the agent/diligence layer.
6. End on the evidence anchor trail and grouped evidence library to explain the
   Sui/Walrus/Seal path for controlled commitments and auditability.

For the Overflow demo, keep `/robomata` as the primary route. `/markets` can be
used only if you want to show the broader app shell, but the local missing
subgraph warning is expected unless matching `.env` endpoints are configured.

## Known Limitations

* operator inputs are still a deterministic sample scenario, not a live upload
  flow
* agent review is rendered through deterministic product outputs and provider
  plumbing, not live underwriting automation
* evidence references are demo commitments, not production integrations
* the Sui package remains a minimal facility/evidence scaffold, not a
  production credit agreement or regulated instrument
* legal enforceability, lien perfection, custody, transfer agency, and
  regulated distribution remain out of scope for the Overflow MVP

## Recommendation

Current recommendation: clear to merge the demo-flow integration branch into
`dev`.

Follow-up notes:

* the local `/markets` warning about missing subgraph endpoints is expected when
  the relevant `.env` values are not configured
* release-candidate QA should still be run again after cutting
  `release/robomata-overflow-v0.1.0`
