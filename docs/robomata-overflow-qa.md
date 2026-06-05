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

Tracking issue: `ROB-134`.

Required environment:

* `NEXT_PUBLIC_ENABLE_ROBOMATA_WORKFLOW=true`
* `ROBOMATA_WORKFLOW_ENABLED=true`
* `ROBOMATA_WORKFLOW_MUTATIONS_ENABLED=true`
* `ROBOMATA_AUTHORIZED_PARTNER_ADDRESSES`
* `POSTGRES_URL`
* `WALRUS_PUBLISHER_URL`
* `WALRUS_AGGREGATOR_URL`
* `ROBOMATA_WALRUS_UPLOADS_ENABLED=true`
* `ROBOMATA_REQUIRE_REAL_EVIDENCE_STORAGE=true`
* `ROBOMATA_SUI_COMMIT_ENABLED=true`
* `ROBOMATA_SUI_PACKAGE_ID`
* `ROBOMATA_SUI_CLIENT_CONFIG`
* `ROBOMATA_SUI_SIGNER_ADDRESS`
* `ROBOMATA_SUI_FACILITY_IDS_JSON`
* `ROBOMATA_SUI_FACILITY_OPERATORS_JSON`
* Seal package, identity, threshold, and key-server configuration from `ROB-129`
  and the Sui testnet deployment helper

Required evidence:

* evidence upload stores encrypted bytes after `ROB-129` Seal/Walrus support is
  on the verified `dev` commit
* uploaded evidence records persist Walrus object/blob references
* plaintext digest and ciphertext digest are both retained for audit by the
  `ROB-129` evidence record fields
* commitment root is computed from persisted submission evidence records
* Sui commit status and reference metadata are persisted back to the submission
* generated Sui deployment fixtures, local client config paths, recovery
  phrases, and secrets are not committed

## Browser QA Scenario

Use the repo-standard local entrypoint:

* `yarn start`

Before starting the browser scenario, load the workflow/testnet environment
listed in the evidence-storage gate above. Without those flags, the submission
UI is intentionally hidden and the mutation APIs intentionally return
configuration errors.

If the user already has the local server running, reuse it rather than starting
a second process.

### 1. Partner Submission List

Status: pending.

Verify:

* `/partner` renders the existing partner surface and links to the borrowing
  base submissions area without breaking legacy vehicle
  registration/tokenization entrypoints
* `/partner/submissions` renders the `Borrowing Base Submissions` list
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
* `ROB-134` real Sui/Walrus/Seal testnet evidence verification has not yet
  passed

Update this section only after `ROB-132` and `ROB-134` have concrete automated,
browser, Sui/Walrus/Seal, and submission-packaging results.
