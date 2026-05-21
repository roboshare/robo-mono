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
