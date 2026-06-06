# Robomata Overflow Sui Package

This is a minimal Sui scaffold for the Overflow MVP. It models a borrowing-base
facility and evidence commitment references at demo fidelity.

Walrus, Seal, and Nautilus are represented at the workflow boundary:

* Walrus stores encrypted or redacted evidence objects.
* Seal governs controlled access to sensitive evidence.
* Nautilus can run authorized offchain evidence pulls and eligibility checks in
  a verifiable execution environment before committing results to Sui.

The package is not a production credit agreement, regulated instrument, transfer
agent, custody layer, lien-perfection system, or lender system of record.

Run from this directory when the Sui CLI is installed:

```sh
sui move build
```

## Localnet Demo Path

`ROB-117` uses an isolated localnet flow rather than the default `~/.sui`
client state or a public faucet dependency.

Run the end-to-end demo path from the repo root:

```sh
./protocols/sui/scripts/run_localnet_demo.sh
```

The script will:

* create a disposable Sui config directory under `/tmp`
* bootstrap a local network with `sui genesis` and `sui start`
* test-publish `protocols/sui`
* execute `create_facility`, `update_borrowing_base`, and `commit_evidence`
* write a JSON fixture with the resulting package ID, facility ID, and
  transaction digests

A committed sample fixture from a real localnet execution lives at:

```text
protocols/sui/fixtures/localnet-demo-run.json
```

## Testnet Deployment Path

The working submission flow can commit evidence roots to a real Sui testnet
facility when the app runtime has package, facility, and client config values.
The helper script publishes this package, creates the first shared facility
object, and writes generated environment exports for local app verification.
It also emits the Seal policy package and identity values used to encrypt
evidence before the encrypted object is stored in Walrus.

Prerequisites:

* Sui CLI installed.
* Active Sui client environment set to `testnet`.
* Active testnet address funded with gas.

Check the active environment and address:

```sh
sui client envs
sui client active-address
sui client gas
```

If the active address needs testnet gas, use the faucet URL returned by:

```sh
sui client faucet --json
```

Deploy the package and create the initial facility:

```sh
./protocols/sui/scripts/deploy_testnet.sh
```

The script writes generated, uncommitted outputs:

```text
protocols/sui/fixtures/testnet-deploy.generated.json
protocols/sui/fixtures/testnet-env.generated.sh
```

For local app verification, load the generated values before starting the web
server:

```sh
source protocols/sui/fixtures/testnet-env.generated.sh
yarn start
```

Those values configure:

```text
ROBOMATA_SUI_PACKAGE_ID
ROBOMATA_SUI_FACILITY_ID
ROBOMATA_SUI_GAS_BUDGET
ROBOMATA_SUI_NETWORK
ROBOMATA_SEAL_PACKAGE_ID
ROBOMATA_SEAL_IDENTITY
ROBOMATA_SEAL_KEY_SERVER_OBJECT_ID
ROBOMATA_SEAL_KEY_SERVER_AGGREGATOR_URL
ROBOMATA_SEAL_THRESHOLD
```

For hosted app commits, also configure the sensitive server-side signer key:

```text
ROBOMATA_SUI_PRIVATE_KEY=suiprivkey...
ROBOMATA_SUI_SIGNER_ADDRESS=0x...
```

`ROBOMATA_SUI_SIGNER_ADDRESS` must be the address derived from
`ROBOMATA_SUI_PRIVATE_KEY` and must match the facility operator address stored
in `ROBOMATA_SUI_FACILITY_OPERATORS_JSON`. Do not commit the private key or add
it to any `NEXT_PUBLIC_` variable.

For real evidence upload, also configure a Walrus publisher endpoint in the app
runtime:

```sh
export WALRUS_PUBLISHER_URL="https://publisher.walrus-testnet.walrus.space"
export WALRUS_AGGREGATOR_URL="https://aggregator.walrus-testnet.walrus.space"
export ROBOMATA_REQUIRE_REAL_EVIDENCE_STORAGE="true"
export ROBOMATA_WALRUS_UPLOADS_ENABLED="true"
```

With `ROBOMATA_REQUIRE_REAL_EVIDENCE_STORAGE=true`, evidence upload fails closed
unless real Walrus uploads are enabled. With
`ROBOMATA_WALRUS_UPLOADS_ENABLED=true`, upload also fails closed unless both
Seal encryption and the Walrus publisher are configured. Without those flags,
local development can still fall back to mock storage.

The current Seal policy binds decryption access to
`robomata_overflow::facility::seal_approve`. The Seal identity is the facility
object ID, and the Move policy approves only the facility operator. The default
testnet key-server configuration uses the verified decentralized testnet
committee object and aggregator.

Do not commit generated testnet deployment fixtures or client config files. The
deployment fixture contains public object IDs and transaction digests, but the
client config path points at local signing state.
