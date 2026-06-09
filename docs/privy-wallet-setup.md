# Privy Wallet Setup

This project now supports a `Privy in code + AA endpoints in the Privy dashboard` wallet setup for embedded wallets, social login, and smart-wallet-ready transaction flows.

At runtime:

- if `NEXT_PUBLIC_PRIVY_APP_ID` is set, the web app uses Privy for login and wallet connection
- if it is not set, the app falls back to the existing RainbowKit-only path

## Environment

Add the following client-side variables in `web/.env.local` or your deployment environment:

```sh
NEXT_PUBLIC_PRIVY_APP_ID=your-privy-app-id
NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID=your-walletconnect-project-id
```

`NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` is still used because Privy can expose external wallet connection flows that rely on WalletConnect.

Robomata server APIs also require the Privy app secret in deployed environments
where the workflow is enabled:

```sh
PRIVY_APP_SECRET=your-privy-app-secret
```

Keep `PRIVY_APP_SECRET` server-only. It is used to verify the current user's
Privy access token and confirm that the partner smart wallet and signing wallet
belong to the same Privy user before Robomata accepts API requests.

No additional bundler or paymaster environment variables are required in this repo. Those values are configured in the Privy dashboard.

## Robomata Sui Operator Wallets

Robomata can automatically provision and bind a Privy-managed Sui wallet for an
authorized partner operator. Enable this only after the Robomata workflow and
partner authorization path are working:

```bash
ROBOMATA_PRIVY_SUI_WALLET_BINDING_ENABLED=true
NEXT_PUBLIC_ROBOMATA_PRIVY_SUI_WALLET_BINDING_ENABLED=true
```

The binding API verifies the signed Robomata partner request, verifies the Privy
access token, finds an existing Sui wallet for the Privy user, or creates one
with `chain_type=sui` and `owner.user_id=<Privy user id>`. It persists the
resulting `walletId` and Sui address in the Robomata persistence backend.

Optional:

```bash
ROBOMATA_PRIVY_SUI_WALLET_POLICY_ID=your-privy-sui-policy-id
ROBOMATA_OPERATOR_SUI_WALLETS_FILE=/tmp/robomata-operator-sui-wallets.json
```

`ROBOMATA_PRIVY_SUI_WALLET_POLICY_ID` attaches a Privy Sui policy to newly
created wallets. `ROBOMATA_OPERATOR_SUI_WALLETS_FILE` is local-development only;
deployed environments should use the existing `POSTGRES_URL` persistence path.

The current Sui evidence commit UI supports wallet-standard Sui extensions for
operator execution. Bound Privy Sui wallets become the default operator identity
and facility-operator mapping target; raw-sign execution from those wallets
should require a user authorization signature and an allowlisted Sui policy
before it is enabled for production.

Native Sui gas sponsorship is handled by Robomata, not by Privy/Pimlico. When
`ROBOMATA_SUI_SPONSORSHIP_ENABLED=true`, the Robomata server prepares the
allowlisted `commit_evidence` transaction, attaches sponsor-owned SUI gas,
sponsor-signs the transaction bytes, asks the operator wallet to
`sui:signTransaction`, then submits the dual-signed transaction server-side.
This requires `ROBOMATA_SUI_PRIVATE_KEY` and funded sponsor SUI coins in the
target Sui network. In this mode the key signs only as gas sponsor. The same
variable is reused as a legacy/test-only server signer only when operator-owned
commits are disabled and the server itself is the mapped facility operator.

When `ROBOMATA_SUI_COMMIT_ENABLED=true`, `ROBOMATA_SUI_PACKAGE_ID`, and
`ROBOMATA_SUI_PRIVATE_KEY` are configured with Sui wallet binding enabled,
Robomata creates a Sui facility during submission creation or compute and
persists `facilityObjectId` plus `facilityOperatorAddress` on the submission.
The facility operator is the bound Privy Sui wallet address; per-submission Sui
facility env maps are no longer used.

## Recommended Production Topology

For Roboshare, the recommended setup is:

- app code: `Privy`
- smart-wallet infrastructure configured inside Privy: `Pimlico`
- bundler URL: `Pimlico`
- paymaster URL: `Pimlico`

This keeps wallet and auth logic in one SDK while avoiding a second AA integration inside the frontend codebase.

## Dashboard Checklist

Configure the following in the Privy Dashboard before testing embedded smart-wallet flows:

1. Enable your desired login methods.
2. Enable embedded Ethereum wallets.
3. Enable smart wallets and select the smart wallet type for the app.
4. Configure the supported networks used by Roboshare:
   - `Sepolia`
   - `Polygon Amoy`
   - `Arbitrum Sepolia`
   - optionally `Base Sepolia`
5. For each smart-wallet network, provide:
   - a bundler URL
   - a paymaster URL if you want sponsored gas
6. Prefer dedicated Pimlico endpoints over the default Privy-offered rate-limited bundler for any serious testing or production traffic.

For local QA accounts that already have an external wallet linked to Privy, set
`NEXT_PUBLIC_PRIVY_EMBEDDED_WALLET_CREATE_ON_LOGIN=all-users` in the local or
Vercel Development environment. The app defaults to `users-without-wallets`, so
production behavior only changes when the override is explicitly set.

## Important Distinction

Privy exposes two different gas-related setup models:

1. Smart wallets:
   - used by this app's batched `wallet_sendCalls` path
   - require smart wallets to be enabled in the dashboard
   - require dashboard-configured bundler URLs
   - use dashboard-configured paymaster URLs for sponsored gas
2. Native gas sponsorship:
   - uses Privy's `useSendTransaction(..., { sponsor: true })` flow
   - is a separate execution path from the app's current wagmi-based contract writes

Roboshare currently uses the smart-wallet wagmi path with dashboard-configured bundler and paymaster support, not the separate `useSendTransaction(..., { sponsor: true })` sponsorship path.

## Current App Behavior

The current integration includes:

- embedded wallet login via Privy
- external wallet connection via Privy
- automatic embedded Ethereum wallet creation for users without wallets
- Privy `SmartWalletsProvider` mounted in the app shell
- batched `approve + buy` when the connected wallet exposes atomic call support
- dynamic payment-token handling instead of hard-coded `MockUSDC`

## Current Sponsorship Model

The current setup assumes:

1. Pimlico bundler and paymaster endpoints are configured in the Privy dashboard for each target chain.
2. Roboshare uses the smart-wallet execution path, so sponsored gas is surfaced through the connected smart wallet instead of a separate frontend transaction hook.
3. Sponsorship can be limited by chain, transaction surface, and paymaster policy without changing the app-level integration model.
4. The remaining production work is operational: funding rails, sponsorship budgets, abuse controls, and monitoring for subsidized investor flows.
