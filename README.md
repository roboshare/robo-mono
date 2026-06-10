# Roboshare

Roboshare is a marketplace for tokenized revenue streams built as an EVM dApp.
This repository contains the smart contracts, subgraph, and web application used for Roboshare's public testnet release.
It was originally bootstrapped on top of Scaffold-ETH 2 and still builds on that foundation heavily.

Core stack:

- `Next.js`
- `RainbowKit`
- `Foundry`
- `Wagmi`
- `Viem`
- `The Graph`
- `TypeScript`

## Protocol Overview

Roboshare is structured around a small set of core protocol components:

- `RoboshareTokens`
  - manages asset and revenue-token positions
- `PartnerManager`
  - manages partner authorization
- `RegistryRouter`
  - routes protocol actions to the correct asset registry and coordinates with Treasury and Marketplace
- `Treasury`
  - handles collateral, settlements, earnings, and payout flows
- `Marketplace`
  - manages primary and secondary market flows
- asset registries such as `VehicleRegistry`
  - define how specific asset classes are registered and managed

The repository is also organized as a monorepo so the project can evolve beyond the current EVM implementation.
Today, the active protocol implementation lives under `protocols/evm`, but the top-level `protocols/*` structure leaves room for additional protocol backends or chain families in the future without forcing the whole project into a single implementation boundary.

## Extending the Protocol

The main protocol extension point is `IAssetRegistry`.

That interface is designed so Roboshare can support multiple asset-specific registries, not only vehicles.
The current `VehicleRegistry` is one concrete implementation, but the same protocol shape can support additional registry types such as equipment, real estate, or other asset categories.

If you want to add a new registry type, the relevant pieces are:

- `protocols/evm/contracts/interfaces/IAssetRegistry.sol`
  - the common asset-registry interface
- `protocols/evm/contracts/RegistryRouter.sol`
  - the central router that binds asset IDs to registries and forwards lifecycle calls
- `protocols/evm/contracts/VehicleRegistry.sol`
  - the reference implementation for a typed registry

At a high level, a new registry implementation should:

1. implement `IAssetRegistry`
2. coordinate asset/revenue-token lifecycle through `RegistryRouter`
3. use the router and core contracts instead of bypassing protocol orchestration
4. be granted `AUTHORIZED_REGISTRY_ROLE` so the router can recognize it as an approved registry

## Requirements

Before you begin, you need to install the following tools:

- [Node (>= v20.18.3)](https://nodejs.org/en/download/)
- Yarn ([v1](https://classic.yarnpkg.com/en/docs/install/) or [v2+](https://yarnpkg.com/getting-started/install))
- [Git](https://git-scm.com/downloads)

## Local Development

To work on the repo locally:

1. Install dependencies:

```
yarn install
```

2. Run a local network in the first terminal:

```
yarn chain
```

This starts a local Foundry network for development and contract testing.

3. Deploy the contracts:

```
yarn deploy
```

This deploys the Roboshare contracts locally and updates generated frontend contract metadata.

4. Start the web app:

```
yarn start
```

Visit `http://localhost:3000`.

### Vercel Environment Variables

If you do not want Vercel development environment variables written to disk,
use the injected-at-runtime flow instead:

```sh
yarn vercel:link
yarn vercel:start
```

Notes:

- `yarn vercel:link` links the `web` app directory to the correct Vercel
  project and creates `web/.vercel/project.json`
- `yarn vercel:start` runs the web app through `vercel env run -- yarn dev`, so
  Vercel development variables are injected into the process without being
  written to `web/.env.local`
- use plain `yarn start` when you want the repo's normal local web flow without
  Vercel-managed environment injection
- if `/markets` shows `No subgraph endpoint configured...`, the matching
  subgraph env vars are still missing from the injected environment and should
  be added in Vercel

Useful commands:

- `yarn evm:test`
- `yarn web:check-types`
- `yarn web:build`
- `yarn evm:verify <network>`

Key paths:

- contracts: `protocols/evm/contracts`
- deploy scripts: `protocols/evm/script`
- subgraph: `protocols/evm/subgraph`
- web app: `web`

Launch sequencing and release-management policy are tracked in [docs/testnet-release-strategy.md](docs/testnet-release-strategy.md).
Embedded-wallet setup notes are tracked in [docs/privy-wallet-setup.md](docs/privy-wallet-setup.md).
Marketing/app route ownership and persona language are tracked in [docs/roboshare-marketing-app-ia.md](docs/roboshare-marketing-app-ia.md).

## Indexing and Subgraph Development

Roboshare uses The Graph for indexed reads. The current subgraph implementation lives in `protocols/evm/subgraph`.

For local indexing work:

1. Start the local graph node stack:

```sh
yarn subgraph:run-node
```

2. Create the local subgraph once:

```sh
yarn subgraph:create-local
```

3. Build and deploy the local subgraph:

```sh
yarn subgraph:local-ship
```

Useful indexing commands:

- `yarn subgraph:clean-node`
- `yarn subgraph:stop-node`
- `yarn subgraph:abi-copy`
- `yarn subgraph:codegen`
- `yarn subgraph:build`
- `yarn subgraph:test`

For public testnet environments, Roboshare uses managed The Graph deployments rather than the local graph-node stack. The release-specific indexing flow and technical readiness checklist are tracked in [docs/testnet-technical-checklist.md](docs/testnet-technical-checklist.md).

## Command Reference

Useful root-level commands:

- `yarn chain`
- `yarn deploy`
- `yarn start`
- `yarn evm:test`
- `yarn evm:compile`
- `yarn evm:verify <network>`
- `yarn web:check-types`
- `yarn web:build`
- `yarn subgraph:run-node`
- `yarn subgraph:local-ship`
- `yarn subgraph:test`

## Contributing

Contributions are welcome.
See [CONTRIBUTING.md](CONTRIBUTING.md) for project-specific contribution guidance.
