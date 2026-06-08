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

- short-lived child branches are cut from `dev`
- stacked PRs are used only when a slice depends on another open child PR
- child PRs merge back into `dev` in dependency order
- release branch is cut as `release/robomata-overflow-v0.1.0`
- validated release merges into `main`

Do not recommend a release cut until all required gates below have a concrete
pass/fail result.

## Required Automated Verification

Run from the repo root unless otherwise noted.

### Web

Status: passed on `dev` commit `4399bc9` before this documentation update.

Commands:

- `yarn web:check-types`
- `yarn web:lint`
- `yarn web:build`

Result:

- `yarn web:check-types` passed.
- `yarn web:lint` passed with no ESLint warnings or errors.
- `yarn web:build` passed and built `/markets`, `/partner`,
  `/partner/submissions`, `/partner/submissions/[submissionId]`, Robomata API
  routes, and `/robomata`.

### Sui

Status: passed on `dev` commit `4399bc9` before this documentation update.

Commands:

- `sui move build --path protocols/sui --warnings-are-errors`
- `sui move build --path protocols/sui --lint --warnings-are-errors`
- `sui move test --path protocols/sui --warnings-are-errors`

Result:

- `sui move build --path protocols/sui --warnings-are-errors` passed.
- `sui move build --path protocols/sui --lint --warnings-are-errors` passed.
- `sui move test --path protocols/sui --warnings-are-errors` passed.
- Test output included:
  - `robomata_overflow::facility::authorized_operator_passes`
  - `robomata_overflow::facility::unauthorized_operator_fails`
  - `robomata_overflow::facility::seal_identity_matches_facility_id`
  - `robomata_overflow::facility::seal_identity_mismatch_fails`

### Evidence Storage And Commit Configuration

Status: passed on `dev` commit `4399bc9` before this documentation update.

Tracking issue: `ROB-134`.

Command:

- `yarn robomata:testnet-smoke`

The smoke command starts the local app on an isolated port, creates a temporary
partner API signer, uses an ignored temporary submission file, uploads evidence
through Seal and Walrus, computes a zero-exception borrowing base, and commits
the evidence root to the configured Sui testnet facility. It prints only
non-secret submission, storage, encryption, and transaction metadata.

Required environment:

- `NEXT_PUBLIC_ENABLE_ROBOMATA_WORKFLOW=true`
- `ROBOMATA_WORKFLOW_ENABLED=true`
- `ROBOMATA_WORKFLOW_MUTATIONS_ENABLED=true`
- `ROBOMATA_AUTHORIZED_PARTNER_ADDRESSES`, set by the smoke script to the
  temporary randomly generated local partner signer because this command runs
  `next dev` and intentionally exercises the development-only API allowlist
  fallback instead of deployed `PartnerManager` authorization
- `POSTGRES_URL`, except for single-developer local QA where
  `ROBOMATA_SUBMISSIONS_FILE` may point at an ignored temp file
- `WALRUS_PUBLISHER_URL`, for example the current Walrus testnet publisher
  endpoint `https://publisher.walrus-testnet.walrus.space`
- `WALRUS_AGGREGATOR_URL`, for example the current Walrus testnet aggregator
  endpoint `https://aggregator.walrus-testnet.walrus.space`
- `ROBOMATA_WALRUS_UPLOADS_ENABLED=true`
- `ROBOMATA_REQUIRE_REAL_EVIDENCE_STORAGE=true`
- `ROBOMATA_SUI_COMMIT_ENABLED=true`
- `ROBOMATA_SUI_PACKAGE_ID`
- For legacy server-signed smoke only: `ROBOMATA_SUI_PRIVATE_KEY` and
  `ROBOMATA_SUI_SIGNER_ADDRESS`. Do not use this as the normal production
  fallback once operator-owned native sponsorship is enabled.
- For operator-signed browser QA: `ROBOMATA_SUI_OPERATOR_COMMIT_ENABLED=true`
  and a Sui wallet for the mapped facility operator address. Product-path QA is
  native sponsored and requires `ROBOMATA_SUI_SPONSORSHIP_ENABLED=true`,
  `ROBOMATA_SUI_PRIVATE_KEY`, funded sponsor SUI coins, and a wallet exposing
  `sui:signTransaction`.
- `ROBOMATA_SUI_FACILITY_IDS_JSON`
- `ROBOMATA_SUI_FACILITY_OPERATORS_JSON`
- `ROBOMATA_SEAL_PACKAGE_ID`, `ROBOMATA_SEAL_IDENTITY`,
  `ROBOMATA_SEAL_KEY_SERVER_OBJECT_ID`,
  `ROBOMATA_SEAL_KEY_SERVER_AGGREGATOR_URL`, and `ROBOMATA_SEAL_THRESHOLD`
  from the Sui testnet deployment helper, or equivalent
  `ROBOMATA_SEAL_KEY_SERVERS_JSON` configuration

Deployed Preview or Production QA is separate from this local smoke command and
must use a wallet authorized in the deployed EVM `PartnerManager`; deployed
environments should not rely on `ROBOMATA_AUTHORIZED_PARTNER_ADDRESSES`.
Deployed Robomata API requests must also include a Privy access token from the
current user session, and the server environment must set
`NEXT_PUBLIC_PRIVY_APP_ID` plus `PRIVY_APP_SECRET` so the API can verify that
the partner smart wallet and signing wallet belong to the same Privy user.

Result:

- `yarn robomata:testnet-smoke` passed against Sui/Walrus/Seal testnet.
- Evidence upload stored Seal ciphertext in Walrus and persisted blob metadata.
- The smoke fetched the Walrus blob back from the aggregator.
- The fetched blob SHA-256 matched the persisted ciphertext digest.
- The fetched blob did not expose the plaintext fixture.
- Plaintext and ciphertext digests were both retained in the evidence record.
- Commitment root was computed from persisted evidence records.
- Sui commit status and reference metadata were persisted back to the submission.
- Generated Sui deployment fixtures, local client config paths, recovery
  phrases, and secrets were not committed.

Non-secret smoke result from current `dev`:

```json
{
  "submissionId": "sub_b761060a-8523-474b-94d8-abce8e2eeb52",
  "storageBackend": "walrus",
  "encryptionBackend": "seal",
  "walrusBlobId": "XGHoBZWLpJb81Bs0KohKGZkJODiyBUa2NCTGogdrjXI",
  "ciphertextDigest": "0xd679f835c9f57fd7f30caca92a19a0ed85e4e5c571e46fc597d685e7e394f6f3",
  "fetchedCiphertextBytes": 483,
  "fetchedCiphertextDigest": "0xd679f835c9f57fd7f30caca92a19a0ed85e4e5c571e46fc597d685e7e394f6f3",
  "plaintextDigest": "0x50733354648c914b5b42d402196da072885231d002b8bc717f689b0b0ca131bd",
  "sealIdentity": "0xb5907dc938474c19cc3b797baeec2ae1f15e59f9159e0df6001086c3a3fd62c1",
  "commitStatus": "committed",
  "txDigest": "2SzHfdayYsjFstd33poMyczmyzm694WZjitGtbY7qhMU"
}
```

## Browser QA Scenario

Use the repo-standard local entrypoint:

- `yarn start`

Before starting the browser scenario, load the workflow/testnet environment
listed in the evidence-storage gate above. Without those flags, the submission
UI is intentionally hidden and the mutation APIs intentionally return
configuration errors.

If the user already has the local server running, reuse it rather than starting
a second process.

### 1. Partner Submission List

Status: passed.

Verify:

- `/partner` renders the existing partner surface and links to the borrowing
  base submissions area without breaking legacy vehicle
  registration/tokenization entrypoints
- `/partner/submissions` renders the `Borrowing Base Submissions` list
- empty state explains what the operator should do next
- existing partner auth/gating behavior still works

### 2. Create Submission

Status: passed in the final browser QA dataset.

Verify:

- operator can create a submission with operator name, facility name, and as-of
  date
- created submission appears in the submission list
- reopening the submission preserves server-persisted state
- audit event records creation metadata

### 3. Import Receivables CSV

Status: passed.

Verify:

- receivables CSV import accepts the documented sample format
- validation errors are operator-readable
- imported receivables persist against the submission
- allowed editable fields can be updated without silently changing immutable
  imported facts

### 4. Upload Evidence

Status: passed.

Verify:

- operator can upload evidence files with document name, source, scope, status,
  and linked receivable ids
- evidence cards show operator-facing fields first:
  - document name
  - source
  - scope
  - upload date
  - status
  - linked exception
- Walrus refs, Seal metadata, digests, and Sui commit details are hidden behind
  `Advanced details`

### 5. Compute Borrowing Base

Status: passed.

Verify:

- borrowing-base calculation uses persisted receivables and evidence records,
  not `demoPortfolio`
- output includes gross receivables, eligible receivables, advance rate,
  reserves, and availability
- exception records are persisted and tied back to receivables or evidence
- recompute updates results after allowed edits, receivable exclusion, or
  evidence replacement

### 6. Review Exceptions

Status: passed.

Verify:

- exceptions have concrete operator actions:
  - exclude receivable
  - replace or add evidence
  - edit allowed imported row fields
  - recompute submission
- deterministic review output explains next steps
- LLM/agent output is optional and subordinate to rules-based credit logic

### 7. Generate Lender Packet

Status: passed.

Verify:

- lender packet is generated from persisted submission state
- packet summarizes eligibility, availability, evidence status, and unresolved
  exceptions
- packet copy does not claim final lender approval, legal lien perfection, or
  production public-record/carrier/bank/telematics API coverage

### 8. Commit Evidence Root

Status: passed.

Verify:

- canonical evidence set is built from persisted evidence records
- commitment root is deterministic for the same evidence set
- Sui commit action succeeds in the configured testnet path or fails with an
  operator-readable configuration error
- commit status and reference metadata persist on the submission

### 9. Read-Only `/robomata` Projection

Status: passed.

Verify:

- `/robomata` loads a real submission projection
- no editable submission actions are exposed on `/robomata`
- CTA sends the operator back to `/partner` for actions
- page no longer presents demo-only controls such as `Keep Markets Live`,
  `Keep Partner Flows Live`, or `First Customer`
- technical evidence and commit details remain secondary to lender/operator
  summary information

### 10. Legacy Surface Regression Check

Status: passed.

Verify:

- `/markets` still renders
- `/partner` legacy vehicle registration/tokenization path still renders
- missing local subgraph endpoint warnings remain non-blocking unless a route is
  actually broken

## Overflow Submission Materials

Status: ready to assemble from this runbook and the current product/spec docs.

The final submission package should include:

- one-sentence product wedge
- first-customer workflow summary
- demo script for the operator submission path
- Sui/Walrus/Seal explanation tied to evidence, encryption/access, and
  commitment roots
- testnet package/facility/transaction references
- known limitations and out-of-scope claims
- release branch and commit used for the submitted build

## Known Limitations To Reconfirm

These limitations should remain explicit unless the implementation actually
changes them:

- no production public UCC, title, lien, insurance, telematics, or bank API
  integrations are claimed
- no automatic tokenized vehicle registration is created from uploaded evidence
- legal enforceability, lien perfection, custody, transfer agency, and regulated
  distribution remain out of scope
- lender approval remains subject to lender diligence and exception cure

## ROB-132 Final Browser QA Evidence

Status: passed on 2026-06-06 against local `dev` runtime with Vercel
Development env, Robomata workflow flags, real Sui testnet, Seal encryption,
and Walrus testnet upload enabled.

Primary UI-created submission:

```json
{
  "submissionId": "sub_9ead6912-257e-4858-b632-efa4e0d84658",
  "status": "committed",
  "grossReceivables": "$217,500.00",
  "eligibleReceivables": "$217,500.00",
  "availableBorrowingBase": "$113,100.00",
  "openExceptions": 0,
  "storageBackend": "walrus",
  "encryptionBackend": "seal",
  "walrusBlobId": "TGD6Urb6tgXnuhzRYDow4WVNDSjfXwIviWjLC9zeFYg",
  "ciphertextDigest": "0x82222b9f84d3f5e5374b0e6e8dc1b24509c11e1922f8c88e43c3a2387aef319e",
  "sealIdentity": "0xb5907dc938474c19cc3b797baeec2ae1f15e59f9159e0df6001086c3a3fd62c1",
  "rootDigest": "0x127e0b1cb6f42a6950bfdd0d90d3ef83320c19179eef37ed4334ea67bf4d90b3",
  "txDigest": "5yfDhMswWBoZATPqSbkxn4cqA2MAJ2fZb4BGWrEDVjqh"
}
```

Browser QA result:

- `/partner` rendered the existing Partner Dashboard, vehicle/offering entry
  points, and `Borrowing Base Submissions` link after Privy auth hydration.
- `/partner/submissions` rendered the creation form and persisted submission
  list.
- Pasted CSV import through the UI created two persisted receivables:
  `QA-2001` and `QA-2002`.
- Pasted evidence upload through the UI created a verified evidence card with
  operator-facing fields first and `Walrus stored` / `Seal encrypted` badges.
- Borrowing-base compute produced zero exceptions and lender-packet output.
- UI commit submitted the evidence root to Sui testnet and persisted committed
  status plus tx metadata.
- After commit, mutation controls were hidden in the operator workspace.
- `/robomata?submission=sub_9ead6912-257e-4858-b632-efa4e0d84658` rendered the
  real committed submission as a read-only lender-ready projection.
- The read-only projection did not expose demo-only controls such as
  `Keep Markets Live`, `Keep Partner Flows Live`, or `First Customer`.

Additional committed browser QA submission:

```json
{
  "submissionId": "sub_943240d7-9360-4721-8ac4-3fa2d3f0b860",
  "status": "committed",
  "availableBorrowingBase": "$361,556.00",
  "openExceptions": 0,
  "txDigest": "GbkBuUQDLNGmr1K5qcpnkRQp9zTEL5ahQBayZyUfpZCq"
}
```

Known browser QA observation:

- On cold route loads, Privy wallet/auth hydration can briefly show a no-wallet
  or unauthorized fallback before the authorized smart-wallet state loads. The
  route recovers to the authorized state without user action after hydration.
- `/robomata` is still an authenticated partner-owned read-only projection in
  this MVP. It is not yet a public lender-share link.

## ROB-134 Testnet Evidence Verification

Status: passed API-level smoke on 2026-06-05 and again on 2026-06-06 against
the local app runtime with real Sui testnet, Seal encryption, and Walrus
testnet upload enabled.

Non-secret result:

```json
{
  "submissionId": "sub_00ce663e-272c-439f-84ce-1f84acb6f127",
  "storageBackend": "walrus",
  "encryptionBackend": "seal",
  "hasWalrusBlobId": true,
  "hasCiphertextDigest": true,
  "sealIdentity": "0xb5907dc938474c19cc3b797baeec2ae1f15e59f9159e0df6001086c3a3fd62c1",
  "commitStatus": "committed",
  "txDigest": "7kkY3j6SnGWVg1gVcCdqUcieh2MBnuJonu6MYZpQKhZb"
}
```

The smoke used a temporary local submission file and temporary EVM signing key
for Robomata API authentication. No generated Sui fixtures, client config,
recovery phrase, private key, or local store artifact was committed.

## Release Recommendation

Current recommendation: clear to cut `release/robomata-overflow-v0.1.0` after
this QA evidence update is merged to a green `dev`.

Reason:

- implementation PRs are merged to `dev`
- automated web checks, production web build, Sui build/lint/test, and
  Robomata testnet smoke passed on the final implementation commit
- browser QA covered partner submission list, CSV import, evidence upload,
  compute, exception-free lender packet, Sui commit, read-only `/robomata`
  projection, `/markets`, and existing `/partner` vehicle/offering entrypoints
- known limitations remain explicit and do not block the Overflow MVP release
