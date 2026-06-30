# Testnet Technical Checklist

## Summary

This document is the non-sensitive operator checklist for Roboshare's public testnet releases.
It focuses on deploy, verify, indexing, frontend wiring, seeded data, and smoke-test readiness for the supported launch networks.

Status:

- `release/testnet-v0.2.0` has been shipped and merged into `main`
- Active release line: `v0.3.x`
- Monad Testnet was added in the `v0.2.x` line; see `docs/releases/v0.2.4-internal.5.md`

Rollout networks:

- `Sepolia` (default)
- `Polygon Amoy`
- `Arbitrum Sepolia`
- `Monad Testnet`

Deferred:

- `Base Sepolia`

## Release Foundations Checklist

- [ ] Confirm the release branch name:
  - `release/testnet-<version>`
- [ ] Confirm the launch-stage tags:
  - `<version>-internal.1`
  - `<version>-beta.1`
  - `<version>-testnet.1`
- [ ] Confirm the release-note template includes:
  - commit SHA
  - default chain
  - supported chains
  - deployed addresses
  - subgraph endpoints
  - known limitations

## Contracts And Deployment Checklist

- [ ] Deploy contracts to `Sepolia`
- [ ] Preserve `Sepolia` deploy artifacts
- [ ] Regenerate frontend contract metadata after the `Sepolia` deploy
- [ ] Confirm the generated frontend contract map contains the currently active rollout chain(s)

Follow-on chain expansion:

- [ ] Deploy contracts to `Polygon Amoy`
- [ ] Deploy contracts to `Arbitrum Sepolia`
- [ ] Preserve deploy artifacts for each added chain
- [ ] Regenerate frontend contract metadata after each added-chain deploy
- [ ] Confirm the generated frontend contract map contains every activated chain in the release line

Verification:

- [ ] Verify `Sepolia` contracts where explorer access is available
- [ ] Record any verification exception explicitly in the release notes

Follow-on chain expansion:

- [ ] Verify `Polygon Amoy` contracts where explorer access is available
- [ ] Verify `Arbitrum Sepolia` contracts where explorer access is available

Upgrade hardening:

- [ ] Run `yarn evm:storage-layout:check`
- [ ] Confirm implementation contracts disable direct initialization
- [ ] Confirm any upgrade that adds state also defines the required migration or reinitializer path

## Managed Subgraph Deployment Checklist

For each activated launch chain, record:

- [ ] Graph network name
- [ ] deployed contract address
- [ ] start block
- [ ] resulting Graph endpoint

Build and publish flow:

- [ ] Run `yarn subgraph:abi-copy`
- [ ] Run `yarn subgraph:codegen`
- [ ] Run `yarn subgraph:build`
- [ ] Authenticate Graph CLI with `yarn subgraph:auth`
- [ ] Create the target Studio subgraph first and set `GRAPH_SUBGRAPH_SLUG` to the exact Studio slug
- [ ] Deploy with `yarn subgraph:deploy --network sepolia --version-label <label>`
- [ ] Capture the resulting Studio endpoint
- [ ] Wire the endpoint into the frontend's chain-aware configuration
- [ ] Confirm the deployed endpoint reflects fresh writes from the contracts

Follow-on chain expansion:

- [ ] Confirm official managed-subgraph support for each added chain before planning the Studio publish step
- [ ] Repeat the same subgraph publish flow for `Polygon Amoy`
- [ ] Repeat the same subgraph publish flow for `Arbitrum Sepolia`

Local graph-node is for development only and should not be treated as the public testnet release path.

## Frontend Checklist

- [ ] Make `Sepolia` the default selected chain
- [ ] Confirm supported chain list matches the release scope
- [ ] Remove or guard localhost and local-chain assumptions from public flows
- [ ] Hide or clearly scope local-only debug or faucet features
- [ ] Confirm public-facing branding is Roboshare-specific and not starter-template boilerplate

## Demo Data Checklist

For the active quiet-beta chain:

- [ ] authorize at least one partner
- [ ] register at least one asset
- [ ] create at least one primary pool
- [ ] create at least one listing

Follow-on chain expansion:

- [ ] repeat the same seeded-demo-state baseline on `Polygon Amoy`
- [ ] repeat the same seeded-demo-state baseline on `Arbitrum Sepolia`

## Smoke Tests

Per activated launch chain:

- [ ] wallet connects successfully
- [ ] chain switching works
- [ ] partner flow works end to end
- [ ] listing flow works end to end
- [ ] purchase flow works end to end
- [ ] withdrawal flow works end to end
- [ ] indexed data appears correctly
- [ ] explorer verification links resolve correctly where verification is available

Cross-chain:

- [ ] switching chains updates addresses, reads, and indexed data without stale cache bleed once more than one release chain is active

## Quiet Beta Readiness

- [ ] deploy the beta app from a tagged release-branch commit
- [ ] publish supported-chain guidance for testers
- [ ] publish bug-report instructions for testers
- [ ] confirm known limitations are documented
- [ ] confirm no blocker-level issue remains in the Sepolia-first user path

## Public Launch Readiness

- [ ] tag `<version>-testnet.1`
- [ ] publish the GitHub release from that tag
- [ ] confirm the public app deploy maps to the tagged commit
- [ ] confirm the public docs match the actual activated launch scope
- [ ] confirm support instructions are ready

## Per-Chain Release Record Template

Record one entry per activated launch chain in the release notes:

- chain
- chain id
- deployed contract addresses
- verification status
- subgraph endpoint
- start block
- seeded demo state status
- known chain-specific limitations
