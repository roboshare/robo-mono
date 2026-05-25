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
