# Roboshare

Agent-supervised programmable credit rails for asset-backed finance, lender review, and downstream distribution.

This repository contains the smart contracts, subgraph, and web application for the Roboshare platform.
It is a production application running on testnet.
It was originally bootstrapped on top of Scaffold-ETH 2 and still builds on that foundation.

Core stack:

- `Next.js`
- `RainbowKit`
- `Foundry`
- `Wagmi`
- `Viem`
- `The Graph`
- `TypeScript`

## Products

Roboshare is organized around a layered product model:

- **Robomata** (live on testnet)
  The operator workspace. Helps operators turn receivables, asset evidence, policy exceptions, and monitoring signals into lender-ready borrowing-base packets with verifiable evidence rails. Also provides the protected lender packet review surface via share links.
- **Markets** (live on testnet)
  Primary and secondary market browsing for tokenized revenue-stream positions. Includes on-chain acquisition, earnings claims, liquidity redemption, and secondary listing management.
- **Rental Platform** (in development)
  A vehicle rental marketplace built on top of Robomata. Covers bookings, trips, payments, claims, host tooling, investor reporting, and renter verification. Currently behind feature flags.
- **Robolend** (planned)
  The capital-provider workspace for packet review, monitoring, and credit decisions. Not yet started.

## Protocol Overview

Roboshare is structured around a set of core protocol components:

- `RoboshareTokens`
  - manages asset and revenue-token positions (ERC-1155)
- `PartnerManager`
  - manages partner authorization
- `RegistryRouter`
  - routes protocol actions to the correct asset registry and coordinates with Treasury and Marketplace
- `Treasury`
  - handles collateral, settlements, earnings, and payout flows
- `Marketplace`
  - manages primary and secondary market flows
- `EarningsManager`
  - manages earnings distribution and claiming
- `PositionManager`
  - manages token position accounting
- `VehicleRegistry`
  - defines how vehicle assets are registered and managed
- `FacilityRegistry`
  - defines how facility assets are registered and managed
- `Libraries`
  - shared library code

Interfaces:

- `IAssetRegistry`
- `IEarningsManager`
- `IMarketplace`
- `IPositionManager`
- `ITreasury`

The repository is organized as a monorepo. The active EVM protocol implementation lives under `protocols/evm`. A Sui Move package for the Overflow MVP lives under `protocols/sui`. The `protocols/*` structure supports additional protocol backends in the future.

## Extending the Protocol

The main protocol extension point is `IAssetRegistry`.

That interface is designed so Roboshare can support multiple asset-specific registries, not only vehicles.
The current `VehicleRegistry` and `FacilityRegistry` are concrete implementations, but the same protocol shape can support additional registry types such as equipment, real estate, or other asset categories.

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

- [Node (>= 24)](https://nodejs.org/en/download/)
- [Yarn (v3+)](https://yarnpkg.com/getting-started/install)
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

### Deployment Targets

Contracts are deployed on the following networks:

- `Sepolia` (primary testnet)
- `Arbitrum Sepolia`
- `Polygon Amoy`
- `Monad Testnet`
- `Anvil` (local development)

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

| Command | Description |
|---------|-------------|
| `yarn dev` | Start the web app in development mode |
| `yarn chain` | Start a local Foundry network |
| `yarn deploy` | Deploy contracts locally |
| `yarn start` | Start the web app |
| `yarn test` | Run EVM contract tests |
| `yarn evm:test` | Run EVM contract tests |
| `yarn evm:compile` | Compile contracts |
| `yarn evm:lint` | Lint Solidity contracts |
| `yarn evm:verify <network>` | Verify contracts on a block explorer |
| `yarn evm:coverage` | Run contract test coverage |
| `yarn web:check-types` | Run TypeScript type checking |
| `yarn web:build` | Build the web app |
| `yarn web:lint` | Lint the web app |
| `yarn format` | Format code (web + EVM) |
| `yarn lint` | Lint all packages |
| `yarn subgraph:run-node` | Start local graph node |
| `yarn subgraph:local-ship` | Build and deploy local subgraph |
| `yarn subgraph:test` | Run subgraph tests |
| `yarn robomata:local-smoke` | Run Robomata local smoke tests |
| `yarn ci` | Run CI checks locally |

## Key Paths

- EVM contracts: `protocols/evm/contracts`
- EVM deploy scripts: `protocols/evm/script`
- Sui package: `protocols/sui`
- Subgraph: `protocols/evm/subgraph`
- Web app: `web`

## Further Reading

- [Testnet Release Strategy](docs/testnet-release-strategy.md) — branching, versioning, and launch sequencing
- [Testnet Technical Checklist](docs/testnet-technical-checklist.md) — deploy, verify, and readiness checklist
- [Privy Wallet Setup](docs/privy-wallet-setup.md) — embedded wallet and smart-wallet configuration
- [Marketing and App IA](docs/roboshare-marketing-app-ia.md) — route ownership, persona language, and host routing
- [Rental Platform PRD](docs/rental-platform-prd.md) — rental platform product spec
- [EVM Token Metadata Boundary](docs/evm-token-metadata-boundary.md) — token metadata model

## Contributing

Contributions are welcome.
See [CONTRIBUTING.md](CONTRIBUTING.md) for project-specific contribution guidance.
