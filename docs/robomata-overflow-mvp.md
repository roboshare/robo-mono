# Robomata Overflow MVP Product Spec

## Summary

Robomata turns a mid-market fleet operator's receivables book into a lender-ready
borrowing base. The Overflow MVP demonstrates one concrete workflow: ingest a
sample fleet receivables portfolio, calculate eligibility and availability,
route exceptions to an agent review, and anchor evidence commitments through a
Sui/Walrus/Seal/Nautilus-oriented evidence rail.

The MVP starts with financeability software for operators and uses Sui
infrastructure where it improves auditability, controlled evidence access,
verifiable offchain processing, and programmable monitoring.

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

* export receivables aging from accounting systems
* gather title, lien, insurance, utilization, servicing, and bank evidence
* normalize exceptions into lender templates
* answer diligence questions by email and spreadsheet
* repeat the same evidence collection for each facility or renewal

Robomata's first promise is:

> Turn your fleet receivables book into a lender-ready borrowing base.

## MVP Scenario

The demo operator, MetroFleet Logistics, submits a $1.24M receivables book backed
by 92 revenue-generating vehicles. Robomata applies a lender-style eligibility
policy, produces a borrowing-base certificate, flags exceptions, and creates a
controlled evidence bundle.

The lender-facing output includes:

* gross receivables
* eligible receivables
* ineligible receivables with reasons
* advance rate
* concentration reserve
* borrowing-base availability
* agent diligence memo
* evidence commitment references

## Product Flow

1. Operator enters or uploads fleet receivables and operating evidence.
2. Borrowing-base engine applies eligibility rules and reserves.
3. Agent reviews exceptions and writes a diligence memo.
4. Evidence bundle references are prepared for UCC/title/lien, insurance,
   receivables aging, telematics, servicing, and lockbox extracts.
5. Sui records the facility state and evidence commitment references.
6. Walrus stores encrypted evidence objects in the demo model.
7. Seal represents controlled-access policy for lender and auditor review.

## Release Flags

The working submission workflow is feature-flagged because `dev` is the branch
used to cut release candidates. Default release behavior must keep the workflow
dark unless a controlled preview is explicitly configured.

Use the flags as a matrix:

* `NEXT_PUBLIC_ENABLE_ROBOMATA_WORKFLOW=true` exposes the `/partner` borrowing
  base entry point and lets `/robomata` attempt the real read-only submission
  projection.
* `ROBOMATA_WORKFLOW_ENABLED=true` enables the server-side submission APIs.
  Without this flag, the APIs fail closed with `404`.
* `ROBOMATA_WORKFLOW_MUTATIONS_ENABLED=true` enables write actions such as
  creating submissions, importing receivables, uploading evidence, computing the
  borrowing base, and committing evidence. Without this flag, writes fail closed
  with `403`.

Recommended environments:

* production and release-candidate branches: leave all three flags unset unless
  the Robomata QA gate has explicitly passed for that release
* controlled preview and local QA: set all three flags when testing the full
  operator workflow
* public demo mode: leave the server flags unset so `/robomata` remains a
  read-only demo narrative and `/partner/submissions` stays hidden

## Sui, Walrus, Seal, And Nautilus Role

Sui is not the reason the operator buys the first product. The operator buys
financeability. Sui becomes useful because the borrowing base is a monitored,
stateful financial object with evidence commitments and repeatable update logic.

Walrus and Seal are scoped as demo infrastructure for evidence packaging and
controlled access. Nautilus can be used to run authorized offchain data pulls,
normalization, and eligibility checks inside a verifiable execution environment.
That improves proof of processing, but it does not remove the need for
commercial providers, customer authorization, and legal/compliance review for
UCC, title, lien, insurance, telematics, or bank data.

## Non-Goals

* Do not lead the MVP with a marketplace or tokenization story.
* Do not sell directly to Apollo, KKR, or other mega-managers as the first path.
* Do not claim legal perfection of liens, collateral control, or custody.
* Do not replace Alfa, Solifi, Vero, or lender system-of-record tools in v1.
* Do not require the operator to understand tokenization to benefit.

## Success Criteria

The MVP is successful when a user can understand the wedge in one pass:

* The first customer is clear.
* The borrowing-base output is credible enough for a lender conversation.
* The agent activity appears in a concrete credit-ops workflow.
* Sui/Walrus/Seal/Nautilus are tied to evidence and monitoring, not decorative crypto.
* Existing EVM marketplace infrastructure remains secondary to the Robomata
  financeability workflow.

## Overflow Narrative

Robomata is building agent-assisted credit infrastructure for real-world
productive assets. The first wedge is fleet receivables: make operators more
financeable, accumulate monitoring and servicing infrastructure, become useful
to capital providers, and eventually become programmable market infrastructure.

The Overflow demo shows the first two steps with a credible path to the next two.
