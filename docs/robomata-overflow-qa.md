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
8. verify `/robomata` renders publicly as product marketing without loading
   private submissions

This runbook should be executed after the implementation PR stack lands on a
green `dev` commit and before cutting the next Robomata Overflow release
branch, currently `release/robomata-overflow-v0.1.7`.

## Branch And Release Gate

Current release path for this tranche:

- short-lived child branches are cut from `dev`
- stacked PRs are used only when a slice depends on another open child PR
- child PRs merge back into `dev` in dependency order
- release branch is cut as the next patch in the active Robomata Overflow
  release line, currently `release/robomata-overflow-v0.1.7`
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
- `yarn robomata:tokenization-api-test`, for local API-level validation of the
  submission-to-tokenization transition without a live EVM wallet signature

The smoke command starts the local app on an isolated port, creates a temporary
partner API signer, uses an ignored temporary submission file, uploads evidence
through Seal and Walrus, computes a zero-exception borrowing base, and commits
the evidence root to the configured Sui testnet facility. It prints only
non-secret submission, storage, encryption, and transaction metadata.

Required environment:

- `NEXT_PUBLIC_ENABLE_ROBOMATA_WORKFLOW=true`
- `ROBOMATA_WORKFLOW_ENABLED=true`
- `ROBOMATA_WORKFLOW_MUTATIONS_ENABLED=true`
- `ROBOMATA_TOKENIZATION_ENABLED=true`, when exercising the
  borrowing-base-to-tokenization path
- `NEXT_PUBLIC_ROBOMATA_TOKENIZATION_ENABLED=true`, when validating the
  tokenization controls or tokenized facility dashboard assets
- `ROBOMATA_TOKENIZATION_MOCK_METADATA_ENABLED=true`, only for local API smoke
  tests that should avoid live IPFS/Pinata uploads while still producing stable
  metadata URIs
- `ROBOMATA_TOKENIZATION_MOCK_REGISTRY_ADDRESS` and
  `ROBOMATA_TOKENIZATION_MOCK_COMPLETION_VERIFICATION_ENABLED=true`, only for
  local API smoke tests that need to simulate a FacilityRegistry transaction
  without a deployed local EVM registry. Do not use these in shared preview,
  release candidate, or production environments.
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
  and a Sui wallet for the persisted facility operator address. Product-path QA
  is native sponsored and requires `ROBOMATA_SUI_SPONSORSHIP_ENABLED=true`,
  `ROBOMATA_SUI_PRIVATE_KEY`, funded sponsor SUI coins, and a wallet exposing
  `sui:signTransaction`.
- Submission creation or compute assigns the Sui facility automatically when the
  Privy Sui wallet binding and Sui package/signing runtime are configured. QA
  should confirm `facilityObjectId` and `facilityOperatorAddress` are persisted
  in Postgres on the submission payload.
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
- deterministic LLM diligence memo output is optional and subordinate to
  rules-based credit logic
- supervised agent actions are separate policy/run/action records; they can
  propose operator work but do not replace rules-based credit calculation

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

### 8a. Live Facility Monitoring Preview

Status: preview behind `ROBOMATA_FACILITY_MONITORING_ENABLED` and
`NEXT_PUBLIC_ROBOMATA_FACILITY_MONITORING_ENABLED`.

Verify:

- flag-off local smoke keeps current submission, packet sharing, and public
  `/robomata` behavior unchanged
- server monitoring API returns `404` unless both the Robomata workflow server
  flag and monitoring server flag are enabled
- authorized partner can load a facility monitoring projection for their own
  submission
- unauthorized partner cannot load another partner's monitoring projection
- projection summarizes facility identity, Sui facility assignment, latest run,
  run history, packet manifest history, packet freshness, observation
  freshness, exceptions, and warnings without exposing raw evidence contents
- with monitoring enabled, local smoke persists facility, receivables
  observation, evidence observation, borrowing-base run, and packet manifest in
  `ROBOMATA_FACILITY_MONITORING_FILE`
- durable local monitoring projection reports two observation inputs for the
  monitored smoke run: one CSV receivables observation and one evidence
  observation
- durable local monitoring projection retains a seeded prior immutable run and
  prior packet manifest while keeping the latest run pinned as current
- durable local monitoring projection creates pending Sui root records for the
  locked run and packet manifest, and the authenticated Sui root endpoint
  returns those records
- monitoring-enabled share links pin lender packet access to the latest run and
  packet manifest while legacy share links remain submission-backed
- local seeded monitoring cases cover stale observation, expired observation,
  superseded observation, stale packet, superseded packet, and refresh-available
  packet states through the same authenticated monitoring API
- seeded cases verify packet freshness outcomes: `fresh`, `stale`, and
  `invalid`, `superseded`, and `refresh_available`, plus facility statuses
  `packet_fresh`, `packet_stale`, and `needs_review`

### 8b. Supervised Agent Lifecycle Preview

Status: preview behind `ROBOMATA_AGENTS_ENABLED`,
`NEXT_PUBLIC_ROBOMATA_AGENTS_ENABLED`, and
`ROBOMATA_AGENT_MUTATIONS_ENABLED`.

Tracking issue: `ROB-220`.

Verify:

- flag-off local smoke confirms agent policy, run, and action routes return
  `404`
- flag-off local smoke confirms the operator workspace does not render the
  `Agent supervision` panel
- default policies start paused, and manual run attempts fail with `409` until
  the operator activates the policy
- activating a policy allows a manual run against
  `sub_seed_expired_observation`
- the seeded expired-observation case proposes `evidence_review`,
  `packet_refresh`, and `sui_root_review`
- wrong-partner access is hidden for policy, run, and action decision routes
- `approved`, `rejected`, `completed`, and `skipped` decisions persist in the
  local agent store after reloading the run list
- pausing the policy returns the submission to the expected `409` run-conflict
  state
- local smoke uses `ROBOMATA_AGENTS_FILE` as the ignored JSON fallback; shared
  preview, release candidate, and production environments must use Postgres
  when the agent flags are enabled

### 8c. Scheduled Agent Tick Preview

Status: preview behind `ROBOMATA_AGENTS_ENABLED` and
`ROBOMATA_AGENT_REFRESH_ENABLED`.

Tracking issue: `ROB-221`.

Verify:

- `POST /api/robomata/agents/tick` requires
  `x-robomata-agent-tick-secret`
- disabled agent flag, disabled refresh flag, missing configured secret,
  missing header secret, and wrong header secret return distinct failures
- zero active policies returns `{ count: 0, results: [] }`
- a mixed batch with one valid active policy and one dangling active policy
  returns per-policy `completed` and `failed` results without failing the route
- repeated ticks leave `ROBOMATA_SUBMISSIONS_FILE` byte-for-byte unchanged
- local smoke keeps Sui commit execution disabled while scheduled ticks run
- scheduled tick actions remain `proposed` even when the policy has
  `autoApproveActionTypes` configured
- deployment scheduling remains caller-owned until a durable worker or
  control-plane service is justified

### 8d. Lender Agent Appointment Preview

Status: preview behind `ROBOMATA_SHARE_LINKS_ENABLED`,
`ROBOMATA_AGENTS_ENABLED`, `ROBOMATA_AGENT_MUTATIONS_ENABLED`, and
`ROBOMATA_LENDER_AGENT_APPOINTMENT_ENABLED`.

Tracking issue: `ROB-244`.

Verify:

- protected lender packet pages show current lender appointment flag state
- disabled appointment flag keeps the lender appointment card read-only
- `PATCH /api/robomata/share/:token/agent-policy` fails closed when share
  links, agents, agent mutations, or lender appointment are disabled
- active protected share links can record `appointedBy: lender` with
  `appointmentAuthorizationSurface: protected_lender_share_link`
- the operator-only agent policy endpoint cannot rename an existing
  lender-appointed policy through operator submission access
- the lender appointment path does not execute actions, approve actions, or
  mutate Sui/EVM state
- revoked policies remain retained in history but cannot run, approve actions,
  complete actions, or be picked up by scheduled ticks
- operator and lender packet surfaces show revocation state, reason, and
  authorization surface

### 8e. Agent-First Trust Boundary

Status: documented for the current supervised tranche.

Tracking issue: `ROB-222`.

Verify:

- current agents are described as monitors, evaluators, action proposers, and
  audit trail producers
- deterministic LLM diligence memo output remains separate from supervised
  policy/run/action state
- operators still approve, reject, complete, or skip proposed actions
- scheduled ticks do not approve their own work, mutate submissions, or execute
  Sui/EVM writes
- Sui commits remain operator-owned sponsored browser flow when configured, with
  the direct server-signed path treated as legacy/test-only
- EVM tokenization remains an explicit operator-signed `FacilityRegistry`
  transaction
- autonomous execution is deferred to the follow-on Linear project
  `Robomata Agent-First Operating System`
- default-off flags and known limitations remain explicit before release

### 9. Public `/robomata` Product Surface

Status: passed.

Verify:

- `/robomata` renders without connected wallet, Privy auth, or partner
  privileges
- `/robomata` does not call private submission APIs or accept
  `?submission=<id>` as an access mechanism
- primary CTA sends operators to `/robomata/submissions`
- page presents product positioning, workflow steps, and evidence rails in
  customer-facing terms
- page does not present demo-only controls such as `Keep Markets Live`,
  `Keep Partner Flows Live`, or `First Customer`
- protected lender packet sharing remains separate from `/robomata` and uses
  controlled `/lender/packet/[token]` links instead of public facility discovery

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
- no automatic token creation is triggered from uploaded evidence or computed
  borrowing-base output
- committed submissions tokenize as facility-level assets, not synthetic vehicle
  registrations
- legal enforceability, lien perfection, custody, transfer agency, and regulated
  distribution remain out of scope
- lender approval remains subject to lender diligence and exception cure

## Submission-To-Tokenization QA Addendum

Use this addendum when validating the merged origination path after the facility
registry and partner UI are enabled.

Expected gate:

- a submission with uncomputed borrowing base must not expose tokenization
- a computed submission with open exceptions must not expose tokenization
- a clean submission must still require Sui evidence commit before tokenization
- a committed submission exposes Robolend handoff/tokenization status, with
  tokenization controls framed as an internal preview path when enabled

Expected tokenization behavior:

- starting a draft persists tokenization state on the submission
- the default offering limit equals the committed available borrowing base
- increasing the offering limit above committed availability is capped or
  rejected by the API
- prepared public metadata includes summary economics plus root/Sui anchors
- prepared public metadata excludes raw receivables, evidence file contents, and
  lender packet contents
- the operator signs an EVM `FacilityRegistry` transaction explicitly
- completion persists registry address, asset id, revenue token id, EVM tx hash,
  and metadata URIs back to the submission

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
- Historical note: the original Overflow MVP used
  `/robomata?submission=sub_9ead6912-257e-4858-b632-efa4e0d84658` as an
  authenticated read-only lender-ready projection. That behavior has been
  superseded by the public `/robomata` product surface. Future lender packet
  sharing should use protected share links, not `/robomata` query params.

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
- `/robomata` is a public marketing/product surface. It is not a private
  submission projection and not a public lender-share link.

## ROB-148 Public Surface And Controlled Sharing QA Evidence

Status: passed local API/browser-route smoke on 2026-06-09 against the current
QA branch after PRs #173 through #176 were merged to `dev`.

Commands:

- `yarn web:check-types`
- `yarn web:lint`
- `yarn web:build`
- `yarn robomata:local-smoke`

Result:

- `yarn web:check-types` passed.
- `yarn web:lint` passed with no ESLint warnings or errors.
- `yarn web:build` passed and built `/robomata`,
  `/partner/submissions`, `/partner/submissions/[submissionId]`,
  `/lender/packet/[token]`, and the protected share-link API routes.
- `yarn robomata:local-smoke` passed using an isolated local Next runtime,
  temporary file-backed submission store, temporary file-backed share-link
  store, temporary file-backed monitoring and agent stores, mock Walrus
  evidence, and disabled Sui commit.

Non-secret local smoke result:

```json
{
  "smokeProfile": "local",
  "publicRoutes": {
    "publicRobomataRoute": "passed",
    "operatorSubmissionsRoute": "passed"
  },
  "agentSupervision": {
    "flagOff": {
      "apiClosed": true,
      "tickClosed": true,
      "uiHidden": true
    },
    "durableLocalStore": {
      "policyDefaultStatus": "paused",
      "policyFinalStatus": "paused",
      "pausedRunConflict": true,
      "actionCount": 3,
      "actionTypes": ["evidence_review", "packet_refresh", "sui_root_review"],
      "persistedActionStatuses": {
        "approvedThenCompleted": "completed",
        "rejected": "rejected",
        "skipped": "skipped",
        "approvedIntermediate": "approved"
      },
      "unauthorizedPartnerHidden": true
    },
    "scheduledTick": {
      "disabledAgentStatus": "Robomata agents are not enabled.",
      "disabledRefreshStatus": "Robomata agent refresh is not enabled.",
      "missingConfiguredSecretStatus": "ROBOMATA_AGENT_TICK_SECRET is not configured.",
      "missingHeaderSecretStatus": "Missing Robomata agent tick secret.",
      "wrongHeaderSecretStatus": "Invalid Robomata agent tick secret.",
      "zeroActivePolicyCount": 0,
      "firstTickCount": 2,
      "firstTickStatuses": ["completed", "failed"],
      "repeatedTickCount": 2,
      "scheduledActionsRemainProposed": true,
      "submissionsUnchangedAfterRepeatedTicks": true,
      "suiCommitExecutionDisabled": true
    }
  },
  "submissionId": "sub_28b0e81f-f592-42bf-b295-bf126cc66bd7",
  "storageBackend": "walrus-mock",
  "encryptionBackend": "none",
  "walrusBlobId": "50733354648c914b5b42d402196da072885231d002b8",
  "plaintextDigest": "0x50733354648c914b5b42d402196da072885231d002b8bc717f689b0b0ca131bd",
  "commitStatus": "skipped",
  "shareLinks": {
    "activeShareLinkId": "share_50e39e3d-decc-4c9e-ad19-bb0fe3104bd9",
    "activeShareLinkStatus": "revoked",
    "activeShareLinkAccessCount": 2,
    "expiredShareLinkId": "share_9990fea3-2d7a-470d-96ae-6a14c8ee8ba4",
    "expiredShareLinkStatus": "expired",
    "lenderPacketPageRendered": true
  }
}
```

Covered behavior:

- `/robomata` renders publicly with the partner submission CTA and without old
  demo/read-only projection copy.
- `/robomata/submissions` returns the Robomata facility package workspace with
  the workflow flags enabled.
- A temporary partner signer can create a submission, import receivables,
  attach evidence, compute a zero-exception borrowing base, and generate a
  lender packet.
- Protected share-link creation returns both the human packet URL and API URL.
- `GET /api/robomata/share/[token]` returns a packet projection and records
  access metadata.
- `/lender/packet/[token]` renders the protected lender packet page.
- Listing share links shows access count and last-access metadata.
- Revocation persists `revoked` status and the API rejects the revoked link
  with `410`.
- Agent routes stay closed and the operator panel stays hidden while agent
  flags are off.
- The local JSON-backed agent store persists policy activation, manual run
  output, action decisions, and the final paused-policy conflict state.
- A short-lived link derives `expired` status and the API rejects the expired
  link with `410`.
- Walrus, Seal, Sui, digest, and transaction metadata remain outside the public
  `/robomata` surface and are scoped to the packet/evidence surfaces.

Live testnet note:

- `yarn robomata:testnet-smoke` was not rerun successfully in this QA branch
  because the local shell did not have the Sui testnet fixture file and
  `vercel env run -e preview|production` did not expose
  `ROBOMATA_SUI_NETWORK` to the local process, even though Vercel lists the
  Robomata/Sui/Walrus/Seal variable names for Preview and Production.
- This branch does not change Sui, Seal encryption, Walrus upload, or Sui
  commit code. The live testnet evidence remains the ROB-134 result above until
  the sensitive Sui variables are made available to the local smoke runner.

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

Current recommendation: clear to cut `release/robomata-overflow-v0.1.7` after
this QA evidence update is merged to a green `dev`.

Reason:

- implementation PRs are merged to `dev`
- automated web checks, production web build, Sui build/lint/test, and
  Robomata testnet smoke passed on the final implementation commit
- browser/API QA covered partner submission list, CSV import, evidence upload,
  compute, exception-free lender packet, protected share-link create/view/list
  metadata/revoke/expiry states, public `/robomata` product surface,
  `/markets`, and existing `/partner` vehicle/offering entrypoints
- release notes for this tranche are captured in
  `docs/releases/robomata-overflow-v0.1.7.md`
- known limitations remain explicit and do not block the Overflow MVP release

Agent-first release readiness notes:

- agent policy, run, action, event, mutation, UI, refresh, and scheduled tick
  paths remain default-off behind explicit environment flags
- local JSON stores are development-only; shared previews, release candidates,
  and production environments should use Postgres when agent flags are enabled
- the current implementation is supervised: agents monitor, evaluate, propose
  actions, and write audit records, while operators approve, reject, complete,
  or skip
- Sui and EVM execution remains outside agent autonomy; those writes are
  operator-signed product paths or explicitly configured legacy/test paths
- broader autonomous execution is a follow-on project, not a release gate for
  the current live monitoring tranche
