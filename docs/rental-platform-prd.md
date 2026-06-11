# Roboshare Rental Platform PRD

Status: Draft
Date: June 11, 2026
Owner: Product + Protocol

## 1. Summary

This document defines the product requirements for a Turo-like vehicle rental platform built on top of the Roboshare Protocol.

The core idea is:

- rental vehicles are operational inventory records managed by the offchain rental platform
- the default financing asset is a `FacilityRegistry` asset with a protocol `assetId`
- each facility may contain one or many rentable vehicles through a committed inventory manifest
- `VehicleRegistry` remains optional for cases that need per-car protocol identity, VIN-hash uniqueness, or per-car tokenization
- the rental platform operates the consumer marketplace, booking engine, trip lifecycle, claims, and host tooling
- Roboshare remains the onchain source of truth for asset registration, partner authorization, tokenization, investor ownership, earnings distribution, and settlement

This is explicitly a two-layer product:

- offchain rental operations layer
- onchain asset and investor layer

That split matches the current codebase. The existing protocol supports facility registration, optional vehicle registration, token pool creation, investor purchases, earnings distribution, and settlement. It does not currently support booking, trip management, renter identity, claims, live rental inventory, or rental escrow.

## 2. Problem

Today, Roboshare can register financing assets and monetize them as tokenized assets, but it does not yet provide the operating product that actually generates rental demand and trip revenue.

Without a rental marketplace:

- partners can tokenize fleet facilities or selected vehicles, but cannot rent the underlying cars through the product
- investors can buy revenue exposure, but cannot see a native operational funnel that drives earnings
- the protocol relies on partner-submitted revenue instead of platform-recorded bookings and completed trips

The missing product is a rental marketplace that turns offchain vehicle inventory into active commercial assets while posting reconciled earnings back to the relevant protocol financing asset.

## 3. Goals

### Primary goals

- Enable every eligible vehicle in a facility inventory manifest to be listed for rent in a consumer marketplace.
- Create a clean operating model where booking and trip events ultimately translate into protocol earnings for the corresponding `facilityAssetId`, or optional `vehicleAssetId` when a car is individually tokenized.
- Give partners a host-grade fleet operations tool for pricing, availability, booking management, check-in/out, maintenance, and claims.
- Give renters a full booking and trip experience comparable to a mainstream car-sharing marketplace.
- Give investors transparent visibility into rental performance, utilization, revenue, and earnings distribution by financing asset.

### Secondary goals

- Use `platformVehicleId` as the canonical rental-inventory key and protocol asset IDs as financing links.
- Keep rental operations flexible enough to evolve without forcing all booking logic onchain.
- Make revenue posted to `Treasury.distributeEarnings` auditable against platform accounting.

## 4. Non-goals

- Fully onchain bookings in the MVP
- Fully onchain trip-state management in the MVP
- Replacing mainstream KYC, driver verification, payment processing, or insurance systems with protocol contracts
- Building a general-purpose property management system for all future asset classes in the first release
- Trustless telematics enforcement in the MVP

## 5. Product principles

- `platformVehicleId` is the canonical identifier for rental operations.
- `facilityAssetId` is the default protocol financing identifier for fleet-backed rental revenue.
- `vehicleAssetId` is optional and only used when an individual car is registered in `VehicleRegistry`.
- Operational workflows remain offchain unless onchain execution materially improves trust, settlement, or portability.
- Revenue posted into the protocol must be derived from reconciled platform accounting, not loose manual inputs.
- Hosts, renters, and investors each need first-class product surfaces.
- Protocol state and rental state are related but not identical.

## 6. Current protocol baseline

The current codebase already provides:

- partner authorization through `PartnerManager`
- facility-level registration through `FacilityRegistry`
- optional vehicle registration through `VehicleRegistry`
- one asset token plus one revenue token per financing asset through `RoboshareTokens`
- primary and secondary revenue-token market flows through `Marketplace`
- collateral, earnings, and settlement flows through `Treasury`
- indexed views of facilities, vehicles, pools, listings, trades, and earnings through the subgraph

The current codebase does not provide:

- rental listings
- live facility inventory manifests for rental use
- availability calendars
- booking requests and confirmations
- renter accounts and driver verification
- trip check-in or check-out
- cancellation policies and refund execution
- security deposit management for renters
- damage claims and dispute resolution
- platform-level revenue reconciliation by trip

## 7. Product scope

The rental platform will include four major product surfaces:

1. Consumer renter app
2. Host and fleet operations app
3. Investor analytics and protocol insights app
4. Internal operations and risk tooling

## 8. Users and roles

### Partner / Host

An authorized protocol partner that owns or operates vehicles and wants to rent them out and optionally tokenize their future cash flow.

### Renter

A consumer who discovers, books, and uses a vehicle for a trip.

### Investor

A protocol user who buys or trades revenue tokens and expects transparent operating performance and earnings distributions.

### Platform Ops / Admin

An internal operator responsible for risk controls, support, claims, moderation, payout reconciliation, and exceptions handling.

## 9. Product architecture

### 9.1 Protocol-owned responsibilities

The Roboshare Protocol remains the source of truth for:

- facility and optional vehicle asset registration
- partner authorization
- asset lifecycle at the protocol level
- revenue-token economics
- investor ownership and transfers
- earnings distribution
- settlement and liquidation

### 9.2 Platform-owned responsibilities

The rental platform owns:

- vehicle merchandising and search
- booking and availability logic
- pricing and promotions
- renter onboarding and verification
- payment authorization and capture
- security deposit handling
- check-in and check-out workflows
- mileage, fuel, damage, and incident records
- cancellations, refunds, and disputes
- accounting and reconciliation
- revenue batching into the protocol

### 9.3 Integration model

The platform will ingest onchain events for:

- partner authorization
- facility registration
- optional vehicle registration
- metadata updates
- revenue pool creation
- earnings distributions
- settlement and retirement

The platform will maintain offchain rental inventory and operating ledgers keyed by `platformVehicleId`, with every revenue ledger entry linked to the protocol financing asset that should receive earnings.

Default linkage:

- `platformVehicleId`: required rental inventory identifier
- `facilityAssetId`: required when the vehicle belongs to a `FacilityRegistry`-backed financing pool
- `vehicleAssetId`: optional link to a `VehicleRegistry` asset when a car has its own protocol identity

Revenue posts to `facilityAssetId` by default. It posts to `vehicleAssetId` only when the product intentionally finances that individual car outside a facility pool.

## 10. Core domain model

New offchain entities required:

- `FacilityInventoryManifest`
- `RentalVehicle`
- `RentalListing`
- `VehicleOperationalStatus`
- `AvailabilityCalendar`
- `PricingRule`
- `Booking`
- `BookingCharge`
- `SecurityDeposit`
- `Trip`
- `PickupReport`
- `ReturnReport`
- `MileageRecord`
- `DamageClaim`
- `Refund`
- `PayoutBatch`
- `RenterProfile`
- `HostProfile`
- `RevenueLedgerEntry`

Each rental entity must include `platformVehicleId` where it refers to a car. Each accounting entity must include the protocol financing target: `facilityAssetId` by default or `vehicleAssetId` for explicit per-car tokenization.

`FacilityInventoryManifest` is a versioned, auditable snapshot of the vehicles inside a facility. It should include stable vehicle identifiers, public descriptive fields, privacy-safe VIN hashes where needed, evidence digests, and the facility asset relationship. It is not the live rental database.

The manifest and data-placement boundary is defined in [Rental Platform Facility Inventory Boundary](./rental-platform-facility-inventory.md). Host setup is defined in [Rental Platform Host Setup Flow](./rental-platform-host-setup.md). Host operating controls are defined in [Rental Platform Host Controls](./rental-platform-host-controls.md). Renter-facing listing/search projections are defined in [Rental Platform Marketplace Listing Model](./rental-platform-marketplace-listings.md). Payment and deposit policy is defined in [Rental Platform Payments And Deposits](./rental-platform-payments-deposits.md). Renter account, verification control-plane, and privacy boundaries are defined in [Rental Platform Renter Accounts And Verification](./rental-platform-renter-verification.md). Booking checkout is defined in [Rental Platform Booking Checkout](./rental-platform-booking-checkout.md). Trip check-in/check-out is defined in [Rental Platform Trip Check-In And Check-Out](./rental-platform-trip-check-in-out.md). Cancellations and support flows are defined in [Rental Platform Cancellations And Support](./rental-platform-cancellations-support.md). Claims and safety workflows are defined in [Rental Platform Claims And Safety](./rental-platform-claims-safety.md). Compliance launch gates are defined in [Rental Platform Compliance Launch Checklist](./rental-platform-compliance-launch-checklist.md). Earnings posting is defined in [Rental Platform Earnings Posting](./rental-platform-earnings-posting.md). Revenue attestation metadata is defined in [Rental Platform Revenue Attestation](./rental-platform-revenue-attestation.md). Shared TypeScript inventory types live in `web/lib/robomata/rentalInventory.ts`.
Production persistence, schema bootstrap, retention, and replay expectations are defined in [Rental Platform Persistence And Retention](./rental-platform-persistence.md).

## 11. State models

### 11.1 Platform vehicle state

- `onboarding`
- `listed`
- `booked`
- `in_trip`
- `inspection`
- `available`
- `maintenance`
- `delisted`

This state model is offchain and operational.

### 11.2 Booking state

- `draft`
- `payment_authorized`
- `confirmed`
- `cancelled`
- `checked_in`
- `in_trip`
- `completed`
- `no_show`
- `late_return`
- `disputed`
- `refunded`

### 11.3 Protocol state relationship

Protocol `AssetStatus` remains separate:

- `Pending`
- `Active`
- `Earning`
- `Suspended`
- `Expired`
- `Retired`

Example:

- a facility can be protocol `Earning` while one vehicle inside it is platform `maintenance`
- a facility can be protocol `Active` while one vehicle inside it is platform `booked`
- a vehicle should not be renter-visible if its financing asset is not protocol-operational

The detailed platform vehicle and booking state model is defined in [Rental Platform State Models](./rental-platform-state-models.md). Shared TypeScript transition helpers live in `web/lib/robomata/rentalOperations.ts`.

## 12. User journeys

### 12.1 Host onboarding journey

1. Partner is authorized in `PartnerManager`.
2. Partner creates or updates a facility inventory manifest for one or more vehicles.
3. Partner registers or updates a facility asset through `FacilityRegistry`.
4. Platform ingests the facility `assetId` and linked inventory manifest.
5. Host completes rental setup for each `platformVehicleId`:
   - photos
   - description
   - pickup/dropoff settings
   - house rules
   - pricing rules
   - calendar availability
   - delivery options
6. Host optionally links a vehicle to a `VehicleRegistry` `assetId` when per-car protocol identity is required.
7. Host optionally launches tokenization and a revenue pool for the facility or individual vehicle.
8. Vehicle becomes bookable in the consumer marketplace.

### 12.2 Renter booking journey

1. Renter searches by location and dates.
2. Renter views vehicle PDP.
3. Renter completes identity and driver verification.
4. Platform prices the trip and authorizes payment plus deposit.
5. Booking is confirmed.
6. Renter checks in, starts trip, and completes return flow.
7. Final charges and refunds are reconciled.
8. Net recognized revenue is recorded against the `platformVehicleId` and posted to the relevant `facilityAssetId` or optional `vehicleAssetId`.

### 12.3 Investor journey

1. Investor discovers an asset and its rental performance.
2. Investor buys revenue tokens through the existing Roboshare market flow.
3. Investor monitors occupancy, revenue, disputes, downtime, and realized earnings.
4. Investor claims earnings through the existing protocol flow.

## 13. Functional requirements

### 13.1 Consumer marketplace

The renter-facing product must support:

- search by location, date range, price, vehicle type, delivery, instant book, EV, seats, and features
- vehicle detail pages with images, rules, fees, host information, availability, and trip estimate
- account creation and wallet-independent rental flows
- identity verification and driver-license verification
- booking checkout with tax, fees, deposit, and protection-plan pricing
- booking confirmation, trip reminders, and trip management
- cancellation and refund visibility
- support and incident reporting

### 13.2 Host operations

The host app must support:

- import or sync facility-backed vehicle inventory
- rental setup completion for each `platformVehicleId`
- optional linkage between a rental vehicle and a `VehicleRegistry` `vehicleAssetId`
- price/day, discounts, dynamic pricing, minimum trip length, and add-ons
- blackout dates and maintenance holds
- booking review and auto-accept rules
- pickup, handoff, and return workflows with photo capture
- mileage, fuel, charge level, and condition reports
- claims and dispute initiation
- earnings, payout, and utilization reporting
- manual controls to delist or suspend a vehicle from rental availability

### 13.3 Investor experience

The investor app must support:

- current protocol data from pools, listings, earnings, and settlement
- operational KPIs tied to each financing asset and its underlying rental inventory
- utilization rate
- completed trips
- booked days
- gross booking value
- net recognized revenue
- cancellation rate
- maintenance downtime
- dispute rate
- time from trip completion to earnings distribution

KPI definitions, joins, freshness, and attribution requirements are defined in [Rental Platform Investor KPI Model](./rental-platform-investor-kpis.md), with shared TypeScript helpers in `web/lib/robomata/rentalInvestorKpis.ts`.

### 13.4 Internal operations

Ops tooling must support:

- manual booking overrides
- refunds and charge adjustments
- chargeback handling
- dispute workflow management
- fraud and abuse review
- vehicle safety takedown
- claims adjudication
- payout holds
- reconciliation monitoring

## 14. Revenue and accounting specification

### 14.1 Revenue policy

The platform must define a canonical revenue number per asset for protocol posting.

Recommended definition:

`recognized_revenue = completed_trip_rental_revenue - refunds - chargebacks - taxes - pass_through_insurance_costs - waived_fees`

This recognized revenue is the input to protocol earnings distribution. The accounting policy must specify whether revenue posts to a facility-level financing asset or an individually registered vehicle asset. The detailed ledger and posting-batch policy is defined in [Rental Platform Revenue Ledger](./rental-platform-revenue-ledger.md), with shared TypeScript helpers in `web/lib/robomata/rentalRevenue.ts`.

### 14.2 Revenue ledger

The platform must maintain an immutable ledger per `platformVehicleId` with:

- financing target (`facilityAssetId` or optional `vehicleAssetId`)
- booking amount
- discount amount
- taxes
- fees
- protection-plan revenue and cost treatment
- refund amount
- chargeback amount
- final recognized revenue
- booking completion timestamp
- distribution batch ID

### 14.3 Distribution cadence

MVP recommendation:

- daily internal reconciliation
- weekly or monthly batched calls to `Treasury.distributeEarnings`

The cadence should be configurable by partner or platform policy.

### 14.4 Distribution guardrails

Before posting earnings, the platform must verify:

- the financing asset exists and is protocol-operational
- the rental vehicle belongs to the financing asset's current or historical inventory manifest for the posting period
- no duplicate revenue posting for the same ledger entries
- reconciled net revenue is non-negative
- adjustments are captured for cancellations, refunds, and disputes

## 15. Payments and escrow

### 15.1 MVP

Use an offchain payment processor for:

- card authorization
- capture
- refunds
- deposit holds
- dispute workflows

Do not force renter checkout through an onchain wallet in the MVP.

The MVP processor choice, deposit policy, failure assumptions, and payment-plan API are defined in [Rental Platform Payments And Deposits](./rental-platform-payments-deposits.md).

### 15.2 Future optional onchain rails

Phase 2 may introduce a dedicated rental escrow contract for:

- deposit holds in stablecoins
- programmable refunds
- onchain host payouts

This should be treated as an optional extension, not an MVP blocker.

## 16. Metadata strategy

Token metadata and facility metadata URIs should be used for public, non-latency-sensitive financing-asset metadata such as:

- facility or vehicle display summary
- inventory manifest URI or digest
- public performance summary
- evidence root and commitment references
- tokenization terms already safe for public display

The `facilityCommitment` should remain a cryptographic anchor, not a readable vehicle database. It may commit to an inventory manifest digest, evidence root, and facility terms, but the rental platform should read vehicle records from controlled offchain storage.

Token metadata and facility commitments must not be used as the primary operational database for:

- vehicle setup workflow
- live calendar availability
- booking lifecycle state
- payment or dispute state
- renter data
- claims records
- telematics streams

## 17. Trust and safety requirements

The platform must support:

- identity verification
- driver-license verification
- sanctions and fraud screening where required
- safety incident reporting
- claims evidence capture
- host and renter suspension controls
- manual administrative override

## 18. Compliance and legal requirements

The product must be designed to support:

- jurisdiction-aware host and renter terms
- tax handling
- privacy controls for renter identity and trip data
- document retention for claims and disputes
- clear separation between investment disclosures and renter marketplace communications

Legal review is required before launch for:

- securities-adjacent disclosure overlap between investor and rental products
- partner classification and payout structure
- insurance and protection-plan wording
- deposit handling

## 19. Reporting requirements

### 19.1 Host metrics

- active vehicles
- utilization
- completed trips
- gross bookings
- recognized revenue
- cancellation rate
- claims rate
- average trip length
- time to payout

### 19.2 Investor metrics

- asset revenue trend
- distribution frequency
- token yield vs target yield
- occupancy trend
- downtime trend
- claims impact
- settlement status

### 19.3 Platform metrics

- search-to-book conversion
- authorization success rate
- booking completion rate
- refund rate
- dispute rate
- take rate
- time from trip completion to earnings posting

## 20. Technical requirements

### 20.1 Services

MVP services required:

- protocol event ingester
- facility inventory sync service
- booking engine
- pricing and availability service
- renter identity service
- payment orchestration service
- trip operations service
- claims service
- accounting and reconciliation service
- protocol earnings distributor
- investor analytics API

### 20.2 Data requirements

- all rental operational records must be queryable by `platformVehicleId`
- all rental operational records must be joinable to `facilityAssetId` and optional `vehicleAssetId`
- all revenue postings must be traceable to booking and ledger records
- all manual overrides must be audit logged
- all claims and dispute actions must be time-stamped and attributable

### 20.3 Reliability

The platform must support:

- idempotent protocol posting
- replayable event ingestion
- reconciliation re-runs
- partial outage recovery for payment, booking, and distribution systems

## 21. Contract and protocol change recommendations

These are not all required for MVP, but they should be planned:

### 21.1 Recommended near-term changes

- Verify the deployed `VehicleRegistry.updateVehicleMetadata` permission model and close any remaining gap if older deployments allow non-owner authorized partners to update metadata. Current target-branch verification is documented in [VehicleRegistry Metadata Ownership Verification](./rental-platform-vehicle-registry-metadata-ownership.md).
- Define the facility inventory manifest digest format used by `FacilityRegistry` asset metadata and Robomata evidence roots.
- Add revenue attestation metadata to earnings distributions.
- Add explicit integration hooks for batch revenue posting provenance.

### 21.2 Optional later changes

- `RentalEscrow` contract for stablecoin deposit flows
- `RevenueAttestor` contract or signed attestation registry
- protocol-native booking commitment proofs if strong portability becomes necessary

## 22. Phased delivery plan

### Phase 0: Foundations

- define the facility inventory manifest format and privacy boundary
- ingest facility-backed rental inventory into the platform database
- create host-facing rental setup flow for `platformVehicleId` records
- support optional `VehicleRegistry` linkage for individually tokenized cars
- define accounting policy for recognized revenue
- establish payment processor, KYC, and support tooling

Exit criteria:

- any newly registered or updated facility inventory manifest can be synced into host setup within minutes
- each synced rental vehicle is keyed by `platformVehicleId`
- each synced rental vehicle is linked to a `facilityAssetId` and may optionally reference a `vehicleAssetId`

### Phase 1: MVP rental marketplace

- renter search and PDP
- booking checkout
- verification
- host pricing and availability
- booking confirmation
- trip check-in and check-out
- refunds and cancellations
- weekly or monthly earnings batching into Treasury

Exit criteria:

- vehicle with a valid `platformVehicleId` and financing asset link can be booked end to end
- completed trip revenue can be reconciled and posted into protocol earnings

### Phase 2: Operations and investor transparency

- richer investor dashboards
- host utilization and claims dashboards
- dispute tooling
- telematics and condition-report integrations
- signed revenue batch attestations

Exit criteria:

- investors can map protocol earnings to operating performance with minimal manual interpretation

### Phase 3: Advanced protocol integrations

- optional onchain rental escrow
- optional programmable deposit release
- stronger proof links between offchain ledger and onchain earnings events

Exit criteria:

- selected rental financial flows can settle through dedicated onchain rails without breaking core UX

## 23. Success metrics

### Marketplace metrics

- booking conversion rate
- repeat renter rate
- average booking value
- host activation rate

### Operational metrics

- fleet utilization
- completed-trip rate
- cancellation rate
- claims rate
- mean time to resolution

### Protocol-linked metrics

- percentage of facility-backed inventory vehicles that become rentable
- percentage of rentable vehicles that generate posted earnings
- time from completed trip to `distributeEarnings`
- variance between platform recognized revenue and protocol-posted revenue

## 24. Risks

- misalignment between offchain accounting and protocol earnings
- user confusion between rental ownership and investment ownership
- legal overlap between marketplace operations and investment messaging
- operational complexity around claims, insurance, and chargebacks
- partner misuse of manual revenue posting if reconciliation controls are weak
- stale or misleading investor metrics if platform and protocol data pipelines drift

## 25. Open questions

- Should all vehicles in a facility inventory manifest be eligible for rental by default, or should rental eligibility require an extra host setup approval step?
- Should a facility inventory manifest be refreshed on every vehicle roster change or only at financing/reporting checkpoints?
- Should the platform support instant book only, approval-based booking only, or both?
- How should insurance and protection-plan economics be treated in recognized revenue?
- How frequently should earnings be posted for high-volume assets?
- Which investor metrics belong onchain, if any, versus remaining purely offchain?
- When should a protocol asset be moved from `Active` to `Earning` in relation to real booking activity?

## 26. MVP recommendation

The recommended MVP is:

- offchain booking engine
- offchain payments and deposits
- offchain trip and claims operations
- onchain facility registration and investor markets
- optional onchain vehicle registration for per-car financing paths
- batched protocol earnings posting from reconciled trip revenue

This gives Roboshare a realistic path to market without forcing the rental product to inherit unnecessary onchain complexity too early.
