# Rental Platform Investor KPI Model

Status: Draft
Date: June 27, 2026
Owner: Product + Protocol

## Summary

Investor reporting aggregates rental operating data to the protocol financing asset. The default reporting grain is `facilityAssetId`; optional `vehicleAssetId` reporting is only used for cars that are individually registered and intentionally financed per car.

Shared KPI contracts and helpers live in `web/lib/robomata/rentalInvestorKpis.ts`.

## API

Initial investor reporting API:

- `POST /api/robomata/rental-investor/dashboard`

The route requires `ROBOMATA_RENTAL_INVESTOR_REPORTING_ENABLED=true`. The investor UI entrypoint under
`/markets/rental-performance` requires `NEXT_PUBLIC_ROBOMATA_RENTAL_INVESTOR_REPORTING_ENABLED=true`.

It accepts attribution, period metrics, revenue ledger entries, and posting batches, then returns:

- KPI snapshot
- investor dashboard summary
- revenue variance report
- per-vehicle drilldowns where permitted
- posting batch attestation summaries
- investor disclosure boundary

## KPI Definitions

| KPI | Definition | Primary source |
| --- | --- | --- |
| utilization rate | booked days divided by available vehicle days, expressed in basis points | trip operations |
| booked days | total renter-booked days for completed, active, or confirmed bookings in the period | booking ledger |
| gross booking value | renter-facing gross booking amount before exclusions | booking ledger |
| recognized revenue | completed-trip rental revenue less refunds, chargebacks, taxes, pass-through insurance, and waived fees | revenue ledger |
| cancellations | count of cancelled bookings in the period | booking ledger |
| downtime | days vehicles are unavailable due to maintenance, turnaround, suspension, or delisting | trip operations |
| disputes | count of open or resolved disputes/claims tied to bookings or trips | trip operations |
| time to distribution | hours between revenue recognition and protocol earnings distribution | revenue ledger plus protocol subgraph |

## Join Model

All KPI rows must preserve:

- `facilityAssetId`
- one or more `platformVehicleId` values
- optional `vehicleAssetId`
- period start and end
- computation timestamp
- source system
- freshness status
- data gap notes when source data is partial or missing

Facility-backed aggregation joins platform vehicles to `facilityAssetId` through the rental inventory manifest and current/historical rental vehicle records.

Optional per-car reporting uses `vehicleAssetId` only when a vehicle has its own protocol identity. It must not force every facility-backed car into `VehicleRegistry`.

## Data Sources

Protocol data:

- `FacilityRegistry` or indexed facility-registration events
- optional `VehicleRegistry` events for individually tokenized cars
- token pool and marketplace state
- `Treasury.distributeEarnings` events
- settlement/retirement events

Platform data:

- rental inventory manifests
- rental vehicle records
- host setup and listing state
- booking ledger
- trip operations state
- revenue ledger and posting batches
- claims, disputes, and support overrides

## Freshness and Attribution

Each KPI snapshot should expose a freshness value:

- `fresh`: source data is current for the period
- `partial`: one or more non-critical sources are missing or delayed
- `stale`: data is older than the reporting freshness SLA
- `missing`: required data is unavailable

Attribution must be period-aware. If a vehicle moved between manifests, reporting should use the manifest relationship that was effective during the KPI period.

## Data Gaps and Manual Interpretation

Known gaps for early implementation:

- live protocol event indexing may lag or be absent in local development
- payment/refund provider data may arrive after trip completion
- disputes can change recognized revenue after an initial trip completion
- downtime may require manual classification until telematics or maintenance integrations exist
- time-to-distribution is unavailable until an earnings batch is posted and indexed

Manual interpretations must be captured with notes and an attributable audit event before they are shown in investor-facing reporting.

## Dashboard Summary

The dashboard summary exposes:

- utilization rate
- booked days
- recognized revenue
- posted revenue
- posting variance
- distribution frequency
- downtime
- claims impact
- dispute count
- settlement status

Settlement status values:

- `not_started`
- `partially_posted`
- `posted`
- `variance`
- `stale_or_incomplete`

## Variance And Attestation View

The variance report compares platform recognized revenue to protocol-posted revenue by financing asset:

- `recognizedRevenueCents`
- `postedRevenueCents`
- `varianceCents`
- stale or incomplete data reasons
- `platformVehicleId` drilldowns
- batch attestation IDs
- ledger entry digests
- protocol transaction hashes when posted

If the dashboard has no matching ledger entries, no posting batches, or legacy batches without attestation metadata, it must surface `stale_or_incomplete` instead of forcing a clean investor-facing interpretation.

## Investor Disclosure Boundary

Investor reporting may show:

- facility-level operational KPIs
- per-vehicle aggregates when permitted by the financing structure
- recognized revenue and posted earnings
- posting batch attestation references

Investor reporting must not show:

- renter identity
- driver-license or sanctions verification results
- raw support narratives
- unresolved claim details
- projected or guaranteed investment returns
