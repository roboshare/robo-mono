# Robomata Overflow v0.1.5

## Scope

Patch release for the Robomata Overflow testnet line. This cut ships the current
`dev` stabilization work after `robomata-overflow-v0.1.4`, including the market
earnings event fix that removes browser-side RPC log scans from `/markets`.

## Included Work

- Sources market earnings timestamps from indexed subgraph events instead of
  polling `EarningsDistributed` logs in the browser.
- Adds `EarningsDistribution` subgraph indexing for `EarningsManager`.
- Uses deployed contract ABIs when building deployed-network subgraphs so
  historical event signatures stay aligned with live deployments.
- Hardens browser RPC fallback behavior for public testnet providers.
- Includes the guarded Robomata submission, Sui sponsorship, and operator
  facility-assignment fixes already merged to `dev`.

## Deployment Notes

- Redeploy the active public testnet subgraphs so `lastDistributionAt` is backed
  by indexed `EarningsDistribution` entities:
  - `sepolia`
  - `polygon-amoy`
  - `arbitrum-sepolia`
  - `monad-testnet`
- `localhost` does not need a hosted subgraph deployment.
- Until a network subgraph is redeployed, the UI will still render but may not
  show indexed latest distribution timestamps for that network.

## Verification

- `yarn subgraph:build --network monad-testnet`
- `yarn web:check-types`
- `yarn web:lint`
- `yarn web:build`
