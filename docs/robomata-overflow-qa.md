# Robomata Overflow Working Submission QA Gate

## Scope

This document is the release-readiness runbook for the working-submission
tranche of the Robomata Overflow MVP.

The old demo-only `/robomata` QA record has been superseded. The authoritative
flow is now a partner-owned `FacilitySubmission` workflow:

1. create a borrowing-base submission in `/partner`
2. import receivables from CSV
3. upload evidence files and metadata
4. compute borrowing-base eligibility and availability
5. review and act on exceptions
6. generate a lender packet
7. commit the evidence root through the Sui path
8. verify `/robomata` renders the resulting submission read-only

This runbook should be executed after the implementation PR stack lands on a
green `dev` commit and before cutting `release/robomata-overflow-v0.1.0`.

## Branch And Release Gate

Current release path for this tranche:

* short-lived child branches are cut from `dev`
* stacked PRs are used only when a slice depends on another open child PR
* child PRs merge back into `dev` in dependency order
* release branch is cut as `release/robomata-overflow-v0.1.0`
* validated release merges into `main`

Do not recommend a release cut until all required gates below have a concrete
pass/fail result.

## Required Automated Verification

Run from the repo root unless otherwise noted.

### Web

Status: pending final implementation merge.

Commands:

* `yarn web:check-types`
* `yarn web:lint`
* `yarn web:build`

Required evidence:

* command output or CI checks are green on the relevant `dev` commit
* no build-time route errors for `/partner` or `/robomata`

### Sui

Status: pending final implementation merge.

Commands:

* `sui move build --path protocols/sui --warnings-are-errors`
* `sui move build --path protocols/sui --lint --warnings-are-errors`
* `sui move test --path protocols/sui --warnings-are-errors`

Required evidence:

* Move build, lint, and tests are green
* test output includes the facility authorization and Seal identity checks

### Evidence Storage And Commit Configuration

Status: pending final implementation merge.

Required environment:

* `WALRUS_PUBLISHER_URL`
* `ROBOMATA_SUI_PACKAGE_ID`
* `ROBOMATA_SUI_FACILITY_ID`
* Seal key-server configuration or documented testnet defaults

Required evidence:

* evidence upload stores encrypted bytes when Seal config is present
* uploaded evidence records persist Walrus object/blob references
* plaintext digest and ciphertext digest are both retained for audit
* commitment root is computed from persisted submission evidence records
* Sui commit status and reference metadata are persisted back to the submission

## Browser QA Scenario

Use the repo-standard local entrypoint:

* `yarn start`

If the user already has the local server running, reuse it rather than starting
a second process.

### 1. Partner Submission List

Status: pending.

Verify:

* `/partner` renders the existing partner surface without breaking legacy
  vehicle registration/tokenization entrypoints
* a `Borrowing Base Submissions` area is visible
* empty state explains what the operator should do next
* existing partner auth/gating behavior still works

### 2. Create Submission

Status: pending.

Verify:

* operator can create a submission with operator name, facility name, and as-of
  date
* created submission appears in the submission list
* reopening the submission preserves server-persisted state
* audit event records creation metadata

### 3. Import Receivables CSV

Status: pending.

Verify:

* receivables CSV import accepts the documented sample format
* validation errors are operator-readable
* imported receivables persist against the submission
* allowed editable fields can be updated without silently changing immutable
  imported facts

### 4. Upload Evidence

Status: pending.

Verify:

* operator can upload evidence files with document name, source, scope, status,
  and linked receivable ids
* evidence cards show operator-facing fields first:
  * document name
  * source
  * scope
  * upload date
  * status
  * linked exception
* Walrus refs, Seal metadata, digests, and Sui commit details are hidden behind
  `Advanced details`

### 5. Compute Borrowing Base

Status: pending.

Verify:

* borrowing-base calculation uses persisted receivables and evidence records,
  not `demoPortfolio`
* output includes gross receivables, eligible receivables, advance rate,
  reserves, and availability
* exception records are persisted and tied back to receivables or evidence
* recompute updates results after allowed edits, receivable exclusion, or
  evidence replacement

### 6. Review Exceptions

Status: pending.

Verify:

* exceptions have concrete operator actions:
  * exclude receivable
  * replace or add evidence
  * edit allowed imported row fields
  * recompute submission
* deterministic review output explains next steps
* LLM/agent output is optional and subordinate to rules-based credit logic

### 7. Generate Lender Packet

Status: pending.

Verify:

* lender packet is generated from persisted submission state
* packet summarizes eligibility, availability, evidence status, and unresolved
  exceptions
* packet copy does not claim final lender approval, legal lien perfection, or
  production public-record/carrier/bank/telematics API coverage

### 8. Commit Evidence Root

Status: pending.

Verify:

* canonical evidence set is built from persisted evidence records
* commitment root is deterministic for the same evidence set
* Sui commit action succeeds in the configured testnet path or fails with an
  operator-readable configuration error
* commit status and reference metadata persist on the submission

### 9. Read-Only `/robomata` Projection

Status: pending.

Verify:

* `/robomata` loads a real submission projection
* no editable submission actions are exposed on `/robomata`
* CTA sends the operator back to `/partner` for actions
* page no longer presents demo-only controls such as `Keep Markets Live`,
  `Keep Partner Flows Live`, or `First Customer`
* technical evidence and commit details remain secondary to lender/operator
  summary information

### 10. Legacy Surface Regression Check

Status: pending.

Verify:

* `/markets` still renders
* `/partner` legacy vehicle registration/tokenization path still renders
* missing local subgraph endpoint warnings remain non-blocking unless a route is
  actually broken

## Overflow Submission Materials

Status: pending.

The final submission package should include:

* one-sentence product wedge
* first-customer workflow summary
* demo script for the operator submission path
* Sui/Walrus/Seal explanation tied to evidence, encryption/access, and
  commitment roots
* testnet package/facility/transaction references
* known limitations and out-of-scope claims
* release branch and commit used for the submitted build

## Known Limitations To Reconfirm

These limitations should remain explicit unless the implementation actually
changes them:

* no production public UCC, title, lien, insurance, telematics, or bank API
  integrations are claimed
* no automatic tokenized vehicle registration is created from uploaded evidence
* legal enforceability, lien perfection, custody, transfer agency, and regulated
  distribution remain out of scope
* lender approval remains subject to lender diligence and exception cure

## Release Recommendation

Current recommendation: not yet clear to cut
`release/robomata-overflow-v0.1.0`.

Reason:

* implementation PRs are still under review/merge sequencing
* end-to-end browser QA has not yet been executed on the final `dev` commit
* release evidence has not yet been captured against the final build

Update this section only after `ROB-132` has concrete automated, browser, Sui,
and submission-packaging results.
