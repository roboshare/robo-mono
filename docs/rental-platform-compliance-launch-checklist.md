# Rental Platform Compliance Launch Checklist

Status: Draft
Date: June 11, 2026
Owner: Legal + Compliance + Product

## Summary

This checklist defines launch gates for the rental platform before renter-facing booking, host onboarding, revenue posting, or investor reporting is promoted beyond controlled preview.

It is not legal advice. It is the operating checklist for ensuring the right legal, privacy, support, and product owners have reviewed the launch surface.

## Required Legal Reviews

Jurisdictional terms:

- host marketplace terms
- renter rental terms
- cancellation and refund terms
- protection-plan and insurance wording
- deposit authorization and capture language
- incident, claims, and damage liability language

Payments and tax:

- card authorization and capture timing
- security deposit hold duration and capture reasons
- refund, chargeback, and dispute handling
- tax collection, remittance, and invoice language
- host payout timing and payout holds

Investor and protocol adjacency:

- separation between rental marketplace copy and investment disclosures
- revenue posting language for protocol earnings distribution
- statements about expected utilization, yield, or rental revenue
- facility-backed versus per-vehicle financing asset reporting

Data and privacy:

- renter identity verification notices
- driver-license and sanctions screening notices
- trip, telematics, and condition-photo handling
- support, claims, and dispute record retention
- deletion, access, and correction request handling

## Privacy And Retention Map

Rental inventory:

- System: `robomata_rental_inventory_*` storage and facility inventory manifests
- Data: vehicle metadata, availability, host controls, facility/vehicle asset linkage
- Retention owner: Product Operations
- Rule: retain public vehicle and host-control history while the facility is active; archive after host offboarding according to partner agreement

Renter verification:

- System: `robomata_rental_renters`
- Data: contact fields, verification status, provider reference, expiry, actor attribution, audit events
- Retention owner: Trust + Compliance
- Rule: store provider references and decisions only; raw identity documents, driver-license images, full SSNs, sanctions payloads, and biometric artifacts stay with the provider

Bookings and trips:

- System: `robomata_rental_bookings` and trip records
- Data: renter ID, vehicle ID, dates, booking state, check-in/out condition records, event history
- Retention owner: Marketplace Operations
- Rule: retain through support, claim, tax, and revenue recognition windows; condition media should be reference/digest based where possible

Payments and revenue:

- System: payment provider, rental payment plan, revenue ledger, posting batches
- Data: provider IDs, amounts, taxes, refunds, chargebacks, ledger entries, posting attestations
- Retention owner: Revenue Operations
- Rule: payment method data remains with Stripe; platform stores provider references and reconciliation evidence

Claims and support:

- System: rental support and claim stores
- Data: incident reports, claim status, evidence references, payout holds, safety takedowns
- Retention owner: Trust + Operations
- Rule: retain until claims, disputes, insurance, and legal holds are resolved; do not publish claim details to investor reporting

Investor reporting:

- System: investor KPI and variance reporting views
- Data: facility-level or allowed vehicle-level operational metrics, recognized revenue, posting status, attestation references
- Retention owner: Finance + Investor Relations
- Rule: investor reporting must aggregate or permission-filter renter/trip data and must not expose renter identity, claim narratives, or support records

## Communication Separation

Renter marketplace communications may include:

- vehicle availability
- trip price and deposit hold
- cancellation/refund policy
- verification requirements
- support and claim process

Investor disclosures may include:

- financing asset identity
- utilization and revenue metrics
- earnings distribution history
- attestation and protocol transaction references
- risks framed for asset performance and protocol participation

Investor disclosures must not include:

- renter contact details
- identity or driver-license verification results
- raw trip-level support narratives
- unresolved claim details
- language implying guaranteed utilization, revenue, or yield

Renter marketplace communications must not include:

- investment solicitations
- projected investor returns
- token purchase prompts
- securities-adjacent performance claims

## Launch Blockers

Do not launch beyond controlled preview if any item is unresolved:

- Legal has not approved host, renter, cancellation, deposit, protection-plan, and claims wording.
- Privacy owner has not approved renter verification, trip data, payment references, and support retention boundaries.
- Payments owner has not validated Stripe authorization/capture/refund/dispute behavior in the target jurisdiction.
- Trust owner has not validated manual verification override, sanctions review, safety takedown, and claim evidence flows.
- Revenue owner has not validated recognized revenue policy, posting batch guardrails, and protocol transaction reconciliation.
- Investor-relations owner has not validated that investor reporting excludes renter identity and support-sensitive data.
- Operations owner has not documented escalation paths for failed verification, failed authorization, incidents, disputes, and payout holds.

## Decision Owners

- Legal: jurisdictional terms, deposit language, protection-plan wording, investor/renter communication separation
- Privacy: identity, driver-license, sanctions, trip, support, and retention controls
- Trust: verification policy, overrides, fraud review, safety takedown, claims evidence
- Payments: Stripe setup, authorization windows, capture/refund/dispute workflows
- Revenue Operations: recognized revenue ledger, posting batches, attestation metadata, reconciliation
- Investor Relations: KPI disclosure boundaries, variance reporting, asset-performance wording
- Product: launch scope, feature gates, support readiness, host/renter user experience

## Launch Review Record

Before launch, create a release checklist record that includes:

- target environment and launch date
- jurisdictions included
- enabled feature flags
- approved policy versions
- owner sign-offs
- known limitations
- rollback plan
- links to Linear issues and release PRs
