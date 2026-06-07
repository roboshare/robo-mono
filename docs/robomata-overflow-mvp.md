# Robomata Working Submission Flow Product Spec

## Summary

Robomata turns a mid-market fleet operator's receivables book into a lender-ready
borrowing base through a real partner-owned submission workflow. This document
defines the target working-submission tranche, not a claim that every route and
protocol hook already exists on `dev`.

The planned working submission flow lives inside `/partner`, where an operator
creates a persisted `FacilitySubmission`, uploads receivables and evidence,
computes eligibility and availability, resolves exceptions, generates a lender
packet, and optionally commits the evidence root through the Sui path.

`/robomata` remains in the product as a secondary projection surface. In the
working tranche it must become read-only and submission-backed; until the web
implementation PR lands, the current `dev` route remains demo-backed.

## First Customer

The first customer is a mid-market fleet rental or leasing operator with 50-500
vehicles, fragmented operating data, and a receivables book that is financeable
in theory but painful to present to a lender in practice.

The operator wants more borrowing capacity and faster lender response without
rebuilding its entire operating system or replacing its existing finance
partners.

## Job To Be Done

When the operator needs working-capital financing against fleet receivables, it
needs to prove the book is eligible, monitored, and enforceable enough for a
lender to underwrite.

The current workflow is manual and brittle:

- export receivables aging from accounting systems
- gather title, lien, insurance, utilization, servicing, and bank evidence
- normalize exceptions into lender templates
- answer diligence questions by email and spreadsheet
- repeat the same evidence collection for each facility or renewal

Robomata's first promise is:

> Turn your fleet receivables book into a lender-ready borrowing base.

## Working Submission Scenario

The first working tranche starts with MetroFleet Logistics, a mid-market fleet
operator that submits a $1.24M receivables book backed by 92 revenue-generating
vehicles. Robomata accepts a real receivables CSV and evidence files, applies a
lender-style eligibility policy, produces a borrowing-base certificate, flags
exceptions, and creates a controlled evidence bundle tied to the submission.

The lender-facing output includes:

- gross receivables
- eligible receivables
- ineligible receivables with reasons
- advance rate
- concentration reserve
- borrowing-base availability
- agent diligence memo
- evidence commitment references

## Product Flow

1. Operator creates a `FacilitySubmission` with operator, facility, and as-of date.
2. Operator uploads a receivables CSV and supporting evidence files with source
   metadata.
3. Robomata persists the submission server-side and normalizes the imported rows.
4. In real testnet mode, evidence bytes are encrypted with Seal before the
   encrypted object is published to Walrus. Local development may use a mock
   storage fallback unless fail-closed real-evidence mode is enabled.
5. Borrowing-base logic computes eligibility, concentration reserve, and
   availability from the persisted submission.
6. Rules-based exceptions are generated for receivables and evidence records.
7. The review layer explains exceptions and next actions, but does not override
   credit logic.
8. Robomata generates a lender packet and evidence-root preview from the current
   submission state.
9. If runtime configuration is present, Robomata commits the evidence root
   through the Sui facility path and persists the commit result on the
   submission.

## Product Surfaces

### `/partner` Submission Area

The existing `/partner` surface is the operator entrypoint. The implementation
target for this tranche adds a borrowing-base submissions area under that
surface, with `/partner/submissions` and `/partner/submissions/[id]` introduced
by the web implementation PR.

This operator workspace owns:

- submission list
- new submission creation
- receivables import
- evidence upload
- exception handling
- recomputation
- lender packet generation
- evidence commit initiation

### `/robomata`

This is the projection surface for an existing submission. The target behavior
for the working tranche is:

- render real submission state, not demo-only placeholders
- explain lender readiness in plain operational terms
- hide raw technical metadata behind `Advanced details`
- link the user back to the corresponding `/partner` submission workspace for
  edits

Until the implementation PR that rewires `/robomata` lands, the existing route
still renders the fixed demo portfolio and must not be used as proof that real
submissions are projected.

## Core Product Object

The authoritative product object is `FacilitySubmission`.

Each submission contains:

- operator and facility identity
- receivables imported from CSV
- evidence records uploaded through the evidence adapter, including operator
  metadata, plaintext audit digest, ciphertext digest, Walrus object reference,
  and Seal policy metadata when real testnet infrastructure is configured
- computed borrowing-base output
- open and resolved exceptions
- lender-facing packet artifacts
- evidence commit state
- audit history

The workflow is intentionally centered on the submission, not on an individual
vehicle registration or tokenization object.

## Release Flags

The working submission workflow is feature-flagged because `dev` is the branch
used to cut release candidates. Default release behavior must keep the workflow
dark unless a controlled preview is explicitly configured.

Use the flags as a matrix:

- `NEXT_PUBLIC_ENABLE_ROBOMATA_WORKFLOW=true` exposes the `/partner` borrowing
  base entry point and lets `/robomata` attempt the real read-only submission
  projection.
- `ROBOMATA_WORKFLOW_ENABLED=true` enables the server-side submission APIs.
  Without this flag, the APIs fail closed with `404`.
- `ROBOMATA_WORKFLOW_MUTATIONS_ENABLED=true` enables write actions such as
  creating submissions, importing receivables, uploading evidence, computing the
  borrowing base, and committing evidence. Without this flag, writes fail closed
  with `403`.
- `POSTGRES_URL` is required when the server workflow is enabled outside local
  development. `ROBOMATA_SUBMISSIONS_FILE=/local/path/submissions.json` is only
  a local-development fallback and must not be used for shared previews or
  release candidates.
- `ROBOMATA_WALRUS_UPLOADS_ENABLED=true` enables real Walrus publisher uploads
  when `WALRUS_PUBLISHER_URL` and the Seal package, facility identity, and
  key-server configuration are available. Without this flag, evidence uploads
  keep using deterministic mock Walrus references even if a publisher URL
  exists. With this flag, uploads fail closed unless evidence can be encrypted
  before publishing.
- `ROBOMATA_SUI_COMMIT_ENABLED=true` enables real Sui evidence commit
  transactions. Without this flag, evidence roots remain prepared but cannot be
  committed onchain.
- `ROBOMATA_SUI_OPERATOR_COMMIT_ENABLED=true` enables the operator-owned wallet
  path. In this mode the server prepares the exact
  `robomata_overflow::facility::commit_evidence` transaction for the mapped
  facility, the browser asks a Sui wallet to sign or execute it, and the server
  marks the submission committed only after reconciling the matching Sui
  `EvidenceCommitted` event. Unsponsored operator commits require
  `sui:signAndExecuteTransaction`. Native sponsored commits require
  `sui:signTransaction` so the server can execute the transaction with both the
  operator signature and sponsor signature. This path still requires
  `ROBOMATA_SUI_PACKAGE_ID`, per-submission facility mapping, and per-submission
  operator mapping, but it does not require `ROBOMATA_SUI_PRIVATE_KEY` or
  `ROBOMATA_SUI_SIGNER_ADDRESS`.
- `ROBOMATA_SUI_SPONSORSHIP_ENABLED=true` enables native Sui gas sponsorship for
  operator-owned commits. The server builds transaction-kind bytes for the
  allowlisted `commit_evidence` call, sets the mapped facility operator as the
  sender, sets the sponsor as gas owner, selects a sponsor-owned SUI gas coin,
  signs the final transaction bytes with the sponsor key, and asks the operator
  wallet to sign the same bytes. The server executes only after both signatures
  are available and still reconciles the `EvidenceCommitted` event before
  persisting `committed`.
- `ROBOMATA_SUI_SPONSOR_PRIVATE_KEY=suiprivkey...` is the sensitive native Sui
  gas-sponsor key. It funds gas only; it must not be the mapped facility
  operator and must never be exposed to the browser.
- `ROBOMATA_SUI_SPONSOR_ADDRESS=0x...` optionally hardens runtime startup by
  requiring the sponsor private key to derive to the expected address.
- `ROBOMATA_SUI_SPONSOR_GAS_BUDGET` and
  `ROBOMATA_SUI_SPONSOR_MIN_COIN_BALANCE` optionally tune native sponsorship
  budgets in MIST. The first tranche selects one sponsor SUI coin whose balance
  is at least the configured minimum.
- `ROBOMATA_SUI_FACILITY_IDS_JSON={"sub_...":"0x..."}` maps each submission id
  to its own Sui facility object. Do not use facility names as keys; names are
  mutable operator input and are not safe authorization boundaries.
- `ROBOMATA_SUI_FACILITY_OPERATORS_JSON={"sub_...":"0x..."}` maps each
  submission id to the Sui address that created and controls the mapped facility
  object.
- `ROBOMATA_SUI_PRIVATE_KEY=suiprivkey...` is the sensitive server-side Sui
  testnet signer used by Vercel to submit evidence commit transactions when the
  operator-owned wallet path is disabled or unavailable. It must belong to the
  mapped facility operator and must never be exposed to the browser.
- `ROBOMATA_SUI_SIGNER_ADDRESS=0x...` must match both the server signer's
  derived Sui address and the mapped facility operator before the runtime
  exposes the server-side Sui commit path.
- `ROBOMATA_PRIVY_SUI_WALLET_BINDING_ENABLED=true` and
  `NEXT_PUBLIC_ROBOMATA_PRIVY_SUI_WALLET_BINDING_ENABLED=true` let Robomata
  automatically provision and bind a Privy-managed Sui wallet for an authorized
  signed-in partner. The wallet is created with `chain_type=sui` and owned by
  the verified Privy user. The current execution path still keeps
  wallet-standard Sui extensions available as the transaction-signing fallback
  until Privy raw-sign execution is enabled with user authorization signatures
  and a suitable Sui policy.
- `ROBOMATA_SUI_COMMIT_STALE_MS` optionally overrides the default ten-minute
  stale threshold for in-progress Sui commits. Stale attempts are reconciled
  against Sui `EvidenceCommitted` events before the app permits another commit
  attempt.
- `ROBOMATA_SUI_EVENT_QUERY_LIMIT` optionally controls how many recent
  `EvidenceCommitted` events the reconciliation path requests per page.
- `ROBOMATA_SUI_EVENT_QUERY_MAX_PAGES` optionally controls how many Sui event
  pages stale-commit reconciliation scans before releasing the attempt.
- `ROBOMATA_SUI_TIMEOUT_MS` optionally controls Sui SDK request timeout for
  commit transactions. The legacy `ROBOMATA_SUI_CLI_TIMEOUT_MS` name remains a
  fallback for local smoke environments.
- Robomata server APIs verify a fresh wallet signature and then read
  `PartnerManager.isAuthorizedPartner(partnerAddress)` on the signed request's
  configured EVM chain before listing, creating, or mutating submissions.
- Deployed Robomata server APIs also require Privy server authentication:
  `NEXT_PUBLIC_PRIVY_APP_ID` and `PRIVY_APP_SECRET` must be configured so the
  server can verify the current user's access token and confirm that the partner
  smart wallet plus signing wallet are linked to the same Privy user.
- `ROBOMATA_AUTHORIZED_PARTNER_ADDRESSES=0x...,0x...` is a local-development
  fallback for isolated smoke tests when `PartnerManager` cannot be read. It is
  not the deployed authorization source of truth.

Recommended environments:

- production and release-candidate branches: leave workflow, mutation, Walrus,
  and Sui side-effect flags unset unless the Robomata QA gate has explicitly
  passed for that release
- controlled preview: set the workflow and mutation flags, configure
  `POSTGRES_URL`, ensure the tester wallet is authorized in the deployed EVM
  `PartnerManager`, configure Privy server auth with `NEXT_PUBLIC_PRIVY_APP_ID`
  and `PRIVY_APP_SECRET`, and enable Walrus/Sui side-effect flags only for
  testnet runs that should write to external infrastructure
- local QA: use `ROBOMATA_SUBMISSIONS_FILE` only for single-developer local
  runs when Postgres is not configured
- public demo mode: leave the server flags unset so `/robomata` remains a
  read-only demo narrative and `/partner/submissions` stays hidden

## Sui, Walrus, Seal, And Nautilus Role

Sui is not the initial buying reason. The operator buys financeability. Sui is
useful because the borrowing base is a monitored, stateful financial object with
repeatable evidence commitments and a commit history that matters to lenders and
capital providers.

Walrus and Seal are infrastructure layers for evidence storage and controlled
access. In this tranche:

- Walrus is the storage adapter for encrypted evidence objects. When
  `WALRUS_PUBLISHER_URL` is configured, uploaded evidence is published through
  the Walrus publisher path and the Walrus blob/object references are persisted
  on the submission.
- Seal is the encryption and access-control layer for uploaded evidence. The app
  encrypts evidence bytes before Walrus upload when `ROBOMATA_SEAL_*` or
  generated Sui testnet values are configured.
- The Sui evidence rails expose `robomata_overflow::facility::seal_approve`,
  using the facility object ID as the Seal identity and approving access only
  for the facility operator. `commit_evidence` is the Sui entry point for
  anchoring the computed evidence root after submission exceptions are resolved.
- The committed evidence digest is the ciphertext digest. The plaintext digest
  remains an internal audit field on the evidence record.
- If `ROBOMATA_REQUIRE_REAL_EVIDENCE_STORAGE=true`, upload fails closed unless
  both Seal encryption and Walrus publishing are configured.
- Nautilus remains a future execution path for authorized offchain pulls and
  verifiable processing, not a prerequisite for the submission workflow.

This tranche does not claim live public-record, telematics, insurance, bank, or
carrier integrations.

Decryption UX is intentionally not part of this spec tranche. A future lender or
operator decrypt flow should be built only after the Sui evidence-rails PR lands;
that later flow must create a Seal session key, build transaction bytes that call
the implemented approval hook, and request keys from the configured Seal key
servers.

## Persistence Model

Submission state is persisted server-side through Next route handlers and a
Postgres-backed store when runtime database configuration is available. Local
development may fall back to a server-side file-backed store, but browser-only
draft state is not the source of truth.

## Branch And Release Alignment

This work follows the current repo policy:

- `dev` is the only long-lived day-to-day integration branch.
- Robomata work ships through short-lived `feat/*`, `fix/*`, or `docs/*`
  branches cut from `dev`.
- Each Linear child issue should map to a scoped branch and PR targeting `dev`.
  A child PR may be stacked on another child branch when it depends on the
  earlier branch's code, then merged back down into `dev` in dependency order.
- `release/robomata-overflow-v0.1.0` should be cut only after the QA and
  submission-readiness pass is green on `dev`.
- Validated release fixes must be merged back into `dev` before the release is
  merged to `main`.

## Non-Goals

- Do not lead with a marketplace or tokenization story.
- Do not auto-create tokenized vehicle registrations from uploaded evidence in
  this tranche.
- Do not sell directly to Apollo, KKR, or other mega-managers as the first path.
- Do not claim legal perfection of liens, collateral control, or custody.
- Do not replace Alfa, Solifi, Vero, or lender system-of-record tools in v1.
- Do not make LLM output the source of credit truth.
- Do not expose raw Walrus, Seal, or Sui identifiers as the primary operator
  workflow. Technical identifiers belong behind `Advanced details`.
- Do not treat Seal decryption UX, lender allowlists, or multi-party access
  delegation as complete in this tranche.
- Do not require the operator to understand tokenization or onchain internals to
  benefit.

## Success Criteria

The working submission flow is successful when:

- An authorized partner can create and reopen a submission in `/partner`.
- A receivables CSV can be imported into persisted submission state.
- Evidence files can be uploaded and tracked with operator-facing status.
- In real testnet mode, evidence upload produces Seal-encrypted ciphertext,
  stores that ciphertext in Walrus, and records both plaintext and ciphertext
  digests.
- Borrowing-base output is computed from submission data, not page-local demo
  fixtures.
- Exceptions are actionable and tied to receivables or evidence records.
- The lender packet is generated from persisted submission state.
- Evidence-root commit state is visible and can be persisted after a Sui call
  when configured.
- `/robomata` reads from a real submission after the web implementation PR lands
  and does not act as a narrative-only mock surface in the final tranche.

## Current Verification Snapshot

As of June 5, 2026, the dependent Sui evidence-rails branch has verified this
path on Sui and Walrus testnet:

- Sui package with `seal_approve`:
  `0xe55d4263d3966a58bfa7a1ebea2cd21b6eccea9104b7deebe3dfbcbe1abd2a16`
- Facility object used as Seal identity:
  `0xb5907dc938474c19cc3b797baeec2ae1f15e59f9159e0df6001086c3a3fd62c1`
- Walrus blob created from Seal ciphertext:
  `R5HoBirREdeobsUgCfMwJviJpm4SpzZh0qcm8Ldl3ig`
- Evidence commit transaction:
  `4o9kaiW3tknMKTDcTTLFJRaegLofW6paQdJYh3jqTW6Q`

The fetched Walrus blob hash matched the recorded ciphertext digest, and the
plaintext fixture was not present in the fetched blob bytes.

## Wedge Narrative

Robomata starts as financeability software for operators. The wedge is still
fleet receivables, but the product now moves beyond demo framing into a working
submission loop:

1. make operators more financeable
2. accumulate structured servicing and evidence data
3. become underwriting and monitoring infrastructure for capital providers
4. eventually become programmable market infrastructure

This tranche is aimed at making step one real in product terms while preserving
the path to steps two through four.
