# Contributing to Roboshare

Thank you for contributing to Roboshare.

This repository contains the smart contracts, subgraph, and web application for the Roboshare platform.
Read [README.md](README.md) first for product context and supported networks.

## Project Status

The project is in active development with products at different stages:

- **Robomata** — live on testnet. Operator workflow and lender packet review surface.
- **Markets** — live on testnet. Primary and secondary market browsing.
- **Rental Platform** — in development. Vehicle rental marketplace built on Robomata.
- **Robolend** — planned. Capital-provider workspace. Not yet started.

## How to Contribute

Contributions are welcome in these areas:

- bug fixes
- test coverage
- docs improvements
- launch-readiness improvements
- UX and reliability issues

Before opening new work:

- search existing issues and PRs first
- keep changes scoped to one concern
- if behavior changes, update docs where appropriate

## Reporting Issues

When reporting a bug, include:

- the target chain
- the wallet used
- the transaction hash, if any
- expected behavior
- actual behavior
- reproduction steps
- screenshots or short recordings when useful

## Pull Requests

We follow a fork-and-pull workflow.

Recommended process:

1. branch from the current target branch (`dev`)
2. use a descriptive branch name: `feat/...`, `fix/...`, `docs/...`, `chore/...`
3. keep the PR focused on a single concern
4. include validation steps in the PR description
5. update docs if the user-facing behavior changed
6. respond to review comments and resolve conversations clearly

PR guidance:

- use clear commit messages
- include screenshots for UI changes when relevant
- avoid mixing unrelated refactors into launch-critical work

Merge policy:

- PRs are generally squash-merged
- launch-critical fixes should remain easy to trace in the PR description

## Validation Expectations

At minimum, contributors should run the checks relevant to their change:

- `yarn evm:test`
- `yarn evm:lint`
- `yarn web:check-types`
- `yarn web:build`
- `yarn lint`
- `yarn format`

For Robomata-related changes, also consider running:

- `yarn robomata:local-smoke`

If a change affects deploy, verify, or release behavior, mention that explicitly in the PR.

See [AGENTS.md](AGENTS.md) for detailed branch policy, PR conventions, and agent workflow guidance.
