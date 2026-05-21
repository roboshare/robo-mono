# Robomata Overflow MVP QA And Submission Notes

## Verification Gates

Run the checks that match the surface you touched before marking a child PR
ready:

* `git status --short --branch`
* `rg -n "MIT|public|v0\\.1\\.0|v0\\.2\\.0|Repo posture" LICENCE docs`
* `yarn web:check-types`, `yarn web:lint`, and `yarn web:build` when the PR
  touches `web`

Run `yarn evm:test` only if the work touches EVM contracts, EVM scripts, or
shared workspace wiring that could affect `protocols/evm`.

Before merging the integration PR into `dev`, and again before release
submission from a branch that includes `protocols/sui`, also run:

* `sui move build --path protocols/sui --warnings-are-errors`
* `sui move build --path protocols/sui --lint --warnings-are-errors`
* `sui move test --path protocols/sui --warnings-are-errors`

## Manual Scenario

When the `/robomata` route is present on the integration branch or release
candidate, verify it from a browser and confirm the page tells one complete
first-customer story:

* MetroFleet Logistics appears as the operator.
* The page shows receivables, eligibility, advance rate, reserves, and borrowing
  availability.
* Exceptions are visible and tied to financeability, not generic risk language.
* Agent review produces a concrete diligence memo.
* Evidence commitments mention Sui, Walrus, and Seal as controlled evidence
  infrastructure.

Until `/robomata` lands, keep `/markets` and `/partner` reachable as legacy EVM
app surfaces and treat the Robomata scenario as a release-candidate gate rather
than a child-PR-ready browser check.

## Release Path

Use the repo's integration-first release path:

* feature branches target `integration/robomata-overflow-mvp`
* `integration/robomata-overflow-mvp` targets `dev`
* release branch is `release/robomata-overflow-v0.1.0`
* validated release merges into `main`

## Known Limitations

* Evidence references are demo commitments, not production integrations.
* Agent review defaults to deterministic mock output unless a live provider is
  explicitly configured.
* The Sui package is a minimal facility/evidence scaffold, not a production
  credit agreement or regulated instrument.
* Legal enforceability, lien perfection, custody, transfer agency, and regulated
  distribution are out of scope for the Overflow MVP.

## Submission Framing

Robomata should be submitted as a financeability and monitoring wedge for
productive real-world assets. The demo starts with fleet receivables because the
workflow is concrete: borrowing-base reporting, eligibility checks, evidence
control, and repeated lender diligence.

Sui/Walrus/Seal/Nautilus matter because private credit workflows need stateful
monitored objects, tamper-evident evidence commitments, controlled access to
sensitive operator data, and verifiable offchain processing for authorized data
feeds.
