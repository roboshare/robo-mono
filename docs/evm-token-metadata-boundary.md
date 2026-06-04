# EVM token/registry metadata boundary (ROB-96)

This document defines the metadata model between `VehicleRegistry` and `RoboshareTokens`.

## Canonical model

- **Registry-owned protocol state (trusted on-chain):**
  - `assetId` lifecycle + settlement state
  - `vinHash` as optional uniqueness anchor (`bytes32`)
  - asset NFT metadata URI pointer (`ipfs://...`)
  - paired revenue-token metadata URI pointer (`ipfs://...`)
- **Transitional legacy state:**
  - `assetValue` still exists in registry asset info for legacy accounting/display compatibility.
  - Pool sizing no longer derives issuance from `assetValue`; explicit pool-size terms such as `maxSupply` are authoritative.
  - The target boundary does not treat appraisal/display value as registry business metadata or as the source of pool sizing.
- **Protocol/economic terms (trusted on-chain when contracts use them):**
  - token price or current price/NAV, depending on the final pricing model
  - maturity date
  - revenue share basis points
  - target yield basis points
  - max supply
  - immediate proceeds flag
  - protection flag
- **Presentation-only metadata (untrusted JSON at URI):**
  - make/model/year
  - images/media
  - odometer/condition/history
  - display copies of protocol/economic terms
  - any UI decoration labels

## URI behavior

- `VehicleRegistry` now decodes registration payload as:
  - `abi.encode(string vin, string assetMetadataURI, string revenueTokenMetadataURI)`
- During registration, it stores `vinHash` plus separate asset NFT and revenue-token metadata pointers, then sets each token URI in `RoboshareTokens`:
  - asset NFT ID URI = `assetMetadataURI`
  - paired revenue-token ID URI = `revenueTokenMetadataURI`
- `updateVehicleMetadata(assetId, assetMetadataURI, revenueTokenMetadataURI)` updates both pointers explicitly and may only be called by the authorized partner that owns the asset NFT.
- `RoboshareTokens.uri(id)` returns per-token canonical URI if explicitly set; otherwise it falls back to ERC1155 base URI behavior.

## Metadata JSON shapes

Asset NFT metadata describes the underlying asset for wallets, web, marketplaces, and indexers:

- `name`, `description`, `image`
- optional gallery, video, or media fields
- make/model/year and other display attributes
- VIN only if product and privacy needs allow it; otherwise keep only `vinHash` on-chain
- odometer, condition, inspection summaries, history, and other presentation/business fields
- optional `external_url` only when a stable app route exists

Revenue token metadata describes the revenue/claim-unit token:

- `name`, `description`, `image`
- linkage to the underlying `assetId` / asset NFT
- display copies of authoritative on-chain pool/product terms
- optional `external_url` only when a stable app route exists

The same JSON document should not be reused for both token IDs by default. A shared document is acceptable only when it is intentionally designed as a typed multi-view document and consumers can reliably distinguish the asset view from the revenue-token view.

## Transitional dependencies

- ROB-84 owns updating web registration payloads and reads to the new metadata-pointer shape. Until ROB-84 lands, web incompatibility on this integration branch is expected.
- ROB-85 owns updating subgraph ABI/event handling for the slimmed registry metadata model. Until ROB-85 lands, subgraph incompatibility on this integration branch is expected.

## Why this split

The split makes token metadata a token-layer concern while keeping registries thin and protocol-focused. Consumers should resolve rich display content from token metadata URIs rather than treating registry structs as a required display API.

Token URI JSON is presentation data only. Protocol behavior must use authoritative on-chain state or an explicitly trusted oracle/accounting/governance path.
