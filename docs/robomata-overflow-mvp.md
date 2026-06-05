# Robomata Working Submission Flow Product Spec

## Summary

Robomata turns a mid-market fleet operator's receivables book into a lender-ready
borrowing base through a real partner-owned submission workflow. The working
submission flow lives inside `/partner`, where an operator creates a persisted
`FacilitySubmission`, uploads receivables and evidence, computes eligibility and
availability, resolves exceptions, generates a lender packet, and optionally
commits the evidence root through the Sui path.

`/robomata` remains in the product as a secondary, read-only projection of a
real submission. It is no longer the editable operating surface.

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

### `/partner/submissions`

This is the operator workspace. It owns:

- submission list
- new submission creation
- receivables import
- evidence upload
- exception handling
- recomputation
- lender packet generation
- evidence commit initiation

### `/robomata`

This is the read-only presentation surface for an existing submission. It should:

- render real submission state, not demo-only placeholders
- explain lender readiness in plain operational terms
- hide raw technical metadata behind `Advanced details`
- link the user back to `/partner/submissions/[id]` for edits

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
- The current Sui package exposes
  `robomata_overflow::facility::seal_approve`, using the facility object ID as
  the Seal identity and approving access only for the facility operator.
- The committed evidence digest is the ciphertext digest. The plaintext digest
  remains an internal audit field on the evidence record.
- If `ROBOMATA_REQUIRE_REAL_EVIDENCE_STORAGE=true`, upload fails closed unless
  both Seal encryption and Walrus publishing are configured.
- Nautilus remains a future execution path for authorized offchain pulls and
  verifiable processing, not a prerequisite for the submission workflow.

This tranche does not claim live public-record, telematics, insurance, bank, or
carrier integrations.

Decryption UX is intentionally not part of this spec tranche. A future lender or
operator decrypt flow must create a Seal session key, build transaction bytes
that call `seal_approve`, and request keys from the configured Seal key servers.

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
- `/robomata` reads from a real submission and does not act as a narrative-only
  mock surface.

## Current Verification Snapshot

As of June 5, 2026, the working branch has verified this path on Sui and Walrus
testnet:

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
