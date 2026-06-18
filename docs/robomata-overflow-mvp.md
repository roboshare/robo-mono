# Robomata Working Submission Flow Product Spec

## Summary

Robomata turns a mid-market fleet operator's receivables book into a lender-ready
borrowing base through a real partner-owned submission workflow. This document
defines the target working-submission tranche, not a claim that every route and
protocol hook already exists on `dev`.

The planned working submission flow lives inside `/partner`, where an operator
creates a persisted `FacilitySubmission`, uploads receivables and evidence,
computes eligibility and availability, resolves exceptions, generates a lender
packet, optionally commits the evidence root through the Sui path, and then uses
that committed borrowing-base state as the origination step for facility-level
tokenization.

`/robomata` is now the public Robomata marketing and product-positioning
surface. It must not load private submissions or act as a public facility
browser. The editable operator workflow remains under `/partner/submissions`,
and protected lender packet sharing is a separate future controlled-sharing
surface.

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
- deterministic LLM diligence memo
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
10. Once the submission is committed with no open exceptions, the operator can
    draft a facility-level tokenization package from the committed borrowing
    base.
11. Robomata prepares public asset and revenue-token metadata with summary
    economics plus evidence anchors, excluding raw receivables, private
    evidence, and lender packet contents.
12. The operator explicitly signs the EVM transaction that registers the
    facility asset and creates the paired revenue-token offering.

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

This is the public Robomata product surface. The target behavior is:

- explain the fleet receivables financeability wedge
- show the operator workflow at a high level
- describe Sui, Walrus, and Seal as evidence rails without exposing raw
  technical identifiers as the product UI
- send operators to `/partner/submissions` to start or continue private
  submissions

`/robomata` must not fetch submission APIs, render private submission state, or
accept a submission query parameter as an access mechanism. Future lender packet
sharing should use a protected share-link route with opaque tokens, expiry,
revocation, and audit state. The detailed controlled-sharing design is captured
in [Robomata Protected Lender Packet Sharing](./robomata-protected-lender-sharing.md).

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
- tokenization state, including committed Sui anchors, facility commitment,
  offering terms, public metadata URIs, and completed EVM asset/token results
- audit history

The workflow is intentionally centered on the submission. In the merged
origination model, tokenization is not a separate first step and is not forced
through individual vehicle registration. A committed `FacilitySubmission` can
become one facility-level asset with one paired revenue-token offering.

## Submission-To-Tokenization Model

The tokenization path starts only after:

- the borrowing base has been computed from persisted submission data
- open receivable and evidence exceptions are resolved or removed from lender
  output
- the evidence root is committed through the Sui facility path

For v1, one committed submission maps to one facility-level EVM asset. The
facility registry uses a `facilityCommitment` derived from submission identity,
partner address, committed root digest, and as-of date. That commitment is the
onchain uniqueness anchor; raw receivable rows and private evidence remain in
Robomata controlled storage and lender-sharing flows.

Public token metadata may include:

- facility name, operator display name, and as-of date
- available borrowing base and selected offering limit
- root digest, evidence root, and Sui transaction digest
- revenue-token economics such as token price, maturity, revenue share cap,
  target yield, proceeds profile, and protection flag

Public token metadata must not include raw receivable rows, private evidence
file contents, lender packet contents, plaintext evidence, or borrower-sensitive
row-level diligence data.

The next Robomata monitoring tranche keeps this submission object as the
compatibility surface, but introduces a long-lived facility layer underneath it.
In that model, a facility is the live workspace, evidence and receivable changes
become observations, borrowing-base calculations become immutable runs, and
lender packets become run-pinned artifacts that can be fresh or stale relative
to newer observations. The detailed contract is tracked in
[Robomata Live Facility Monitoring](./robomata-live-facility-monitoring.md).

## Release Flags

The working submission workflow is feature-flagged because `dev` is the branch
used to cut release candidates. Default release behavior must keep the workflow
dark unless a controlled preview is explicitly configured.

Use the flags as a matrix:

- `NEXT_PUBLIC_ENABLE_ROBOMATA_WORKFLOW=true` exposes the `/partner` borrowing
  base entry point. `/robomata` remains a public product page and does not
  become a private submission projection when workflow flags are enabled.
- `ROBOMATA_WORKFLOW_ENABLED=true` enables the server-side submission APIs.
  Without this flag, the APIs fail closed with `404`.
- `ROBOMATA_WORKFLOW_MUTATIONS_ENABLED=true` enables write actions such as
  creating submissions, importing receivables, uploading evidence, computing the
  borrowing base, and committing evidence. Without this flag, writes fail closed
  with `403`.
- `ROBOMATA_TOKENIZATION_ENABLED=true` enables the server-side
  borrowing-base-to-tokenization APIs. Without this flag, tokenization APIs fail
  closed with `404` even when the core submission workflow is enabled.
- `NEXT_PUBLIC_ROBOMATA_TOKENIZATION_ENABLED=true` exposes the partner-facing
  tokenization controls and tokenized facility assets in the dashboard.
- `ROBOMATA_TOKENIZATION_MOCK_METADATA_ENABLED=true` is a local-only test helper
  for deterministic tokenization metadata URIs. It is ignored in production and
  should not be used for shared previews or release candidates.
- `ROBOMATA_TOKENIZATION_MOCK_REGISTRY_ADDRESS` and
  `ROBOMATA_TOKENIZATION_MOCK_COMPLETION_VERIFICATION_ENABLED=true` are
  local-only tokenization API smoke helpers. Shared preview, release candidate,
  and production environments must rely on `deployedContracts.ts` registry
  output and live transaction receipt verification.
- `ROBOMATA_FACILITY_MONITORING_ENABLED=true` enables additive server-side live
  facility monitoring projections and APIs. It does not replace the current
  submission workflow and should stay unset unless the monitoring tranche is
  intentionally enabled.
- `NEXT_PUBLIC_ROBOMATA_FACILITY_MONITORING_ENABLED=true` reveals the operator
  monitoring UI for live facility state, observation freshness, locked runs, and
  Sui root verification. The server flag remains authoritative.
- `ROBOMATA_FACILITY_MONITORING_REFRESH_ENABLED=true` enables side-effectful
  monitoring refresh behavior, such as scheduled or provider reads. Keep it
  unset while the system only records manual uploads and seeded QA observations.
- `ROBOMATA_FACILITY_MONITORING_FILE=/local/path/monitoring.json` is an optional
  local-development JSON fallback for facility monitoring records when
  `POSTGRES_URL` is not configured. Shared previews and release candidates must
  use Postgres for monitoring sidecar state.
- `ROBOMATA_LENDER_MONITORING_SHARE_ENABLED=true` and
  `NEXT_PUBLIC_ROBOMATA_LENDER_MONITORING_SHARE_ENABLED=true` allow protected
  lender views and share controls to include monitoring freshness. Existing
  packet links remain packet-only unless the share capability and server flag
  permit monitoring disclosure.
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
  facility, the browser asks a Sui wallet to sign it, and the server marks the
  submission committed only after reconciling the matching Sui
  `EvidenceCommitted` event. Operator-owned commits are native sponsored
  commits: they require `ROBOMATA_SUI_SPONSORSHIP_ENABLED=true`,
  `ROBOMATA_SUI_PRIVATE_KEY`, and `sui:signTransaction` so the server can
  execute the transaction with both the operator signature and sponsor
  signature. This path requires `ROBOMATA_SUI_PACKAGE_ID` and the Sui facility
  assignment persisted on the submission; it does not require
  `ROBOMATA_SUI_SIGNER_ADDRESS`.
- `ROBOMATA_SUI_SPONSORSHIP_ENABLED=true` enables native Sui gas sponsorship for
  operator-owned commits. The server builds transaction-kind bytes for the
  allowlisted `commit_evidence` call, sets the mapped facility operator as the
  sender, sets the sponsor as gas owner, selects a sponsor-owned SUI gas coin,
  signs the final transaction bytes with `ROBOMATA_SUI_PRIVATE_KEY`, and asks
  the operator wallet to sign the same bytes. The server executes only after
  both signatures are available and still reconciles the `EvidenceCommitted`
  event before persisting `committed`.
- `ROBOMATA_SUI_PRIVATE_KEY=suiprivkey...` is the single sensitive server-held
  Sui key. In the intended operator-owned native sponsorship path it signs only
  as the gas sponsor; it must not be the mapped facility operator and must never
  be exposed to the browser. The same variable is reused as the legacy
  server-side signer only when `ROBOMATA_SUI_OPERATOR_COMMIT_ENABLED` is false,
  `ROBOMATA_SUI_SIGNER_ADDRESS` matches the derived address, and that address is
  the mapped facility operator.
- `ROBOMATA_SUI_SPONSOR_ADDRESS=0x...` optionally hardens runtime startup by
  requiring `ROBOMATA_SUI_PRIVATE_KEY` to derive to the expected gas sponsor
  address when native sponsorship is enabled.
- `ROBOMATA_SUI_SPONSOR_GAS_BUDGET` and
  `ROBOMATA_SUI_SPONSOR_MIN_COIN_BALANCE` optionally tune native sponsorship
  budgets in MIST. The sponsor selector scans paginated SUI coins, reserves the
  selected gas object id before sponsor-signing, and releases the reservation if
  the operator cancels before a digest is returned. Reservation release is
  scoped to the submission id, evidence root, and sponsor address so a caller
  cannot release another submission's in-flight sponsor coin by passing a public
  gas object id.
- `ROBOMATA_SUI_SPONSOR_COIN_QUERY_MAX_PAGES` optionally controls how many pages
  of sponsor SUI coins are scanned before reporting no available unreserved gas
  coin.
- `ROBOMATA_SUI_SPONSOR_RESERVATION_TTL_MS` optionally controls how long a
  prepared sponsor gas reservation can remain idle before the next prepare
  attempt expires it. It defaults to the commit stale window so abandoned tabs or
  interrupted network requests cannot permanently strand sponsor gas coins.
- When `ROBOMATA_SUI_COMMIT_ENABLED=true`,
  `ROBOMATA_PRIVY_SUI_WALLET_BINDING_ENABLED=true`, `ROBOMATA_SUI_PACKAGE_ID`,
  and `ROBOMATA_SUI_PRIVATE_KEY` are configured, submission creation or compute
  creates a Sui facility and persists `facilityObjectId` plus
  `facilityOperatorAddress` on the submission. The facility operator is the
  bound Privy Sui wallet address; no per-submission env maps are required.
- `ROBOMATA_SUI_SIGNER_ADDRESS=0x...` must match both the server signer's
  derived Sui address and the persisted facility operator before the runtime
  exposes the legacy server-side Sui commit path.
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
- protected lender sharing preview: set `ROBOMATA_SHARE_LINKS_ENABLED=true`,
  `NEXT_PUBLIC_ROBOMATA_SHARE_LINKS_ENABLED=true`, and
  `ROBOMATA_SHARE_LINK_TOKEN_SECRET` after the share-link QA gate passes; share
  APIs remain server-gated even if the client-visible flag is set
- local QA: use `ROBOMATA_SUBMISSIONS_FILE` only for single-developer local
  runs when Postgres is not configured
- public marketing mode: `/robomata` remains visible as a public product page;
  leave the server flags unset when `/partner/submissions` should stay hidden
  or non-operational in a release environment

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
- Do not auto-create tokens from uploaded evidence or computed borrowing-base
  output. Tokenization requires a committed submission and an explicit EVM
  wallet signature from the operator.
- Do not force committed facility submissions through vehicle-specific VIN
  semantics. Facility-level tokenization uses a facility registry.
- Do not sell directly to Apollo, KKR, or other mega-managers as the first path.
- Do not claim legal perfection of liens, collateral control, or custody.
- Do not replace Alfa, Solifi, Vero, or lender system-of-record tools in v1.
- Do not make LLM output the source of credit truth.
- Do not conflate the deterministic LLM diligence memo with supervised agent
  policies, runs, actions, or events. Current agents monitor, evaluate, propose
  actions, and produce audit records; they do not execute Sui/EVM writes.
- Do not claim lender-appointed agents are active through the operator policy
  endpoint. Current supervision policies are operator-appointed; lender
  appointment requires a lender-authorized policy endpoint.
- Do not claim non-rules agent planners generate action proposals yet.
  `ROBOMATA_AGENT_PLANNER_PROVIDER` records the planner boundary, but current
  action proposals remain deterministic until live planner controls are built.
- Do not treat `ROBOMATA_AGENT_PROVIDER` or provider API keys as sufficient to
  activate live LLM credit review. Live review also requires
  `ROBOMATA_LLM_REVIEW_ENABLED=true`; OpenAI review also requires
  `ROBOMATA_AGENT_REVIEW_MODEL`. LLM memo output remains advisory, uses capped
  exception-only inputs with `store: false`, and must fall back to deterministic
  review output on provider errors or timeouts.
- Do not present the current platform-default policy rules as lender-authored
  artifacts. The visible `submission-v1` rules are a transparency baseline until
  lender policy artifacts are implemented.
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
- `/robomata` renders as a public marketing/product page without requiring
  partner auth or reading private submission APIs.
- Protected lender packet sharing, when implemented, uses controlled share links
  instead of making `/robomata` a facility projection route.

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
