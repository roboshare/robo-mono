# AGENTS.md

Agent-facing operating notes for `robo-mono`.

This file is for repository-specific workflow, validation, and tooling conventions
that agents should follow by default. It complements human-facing docs such as
`README.md` and `CONTRIBUTING.md`.

## Read First

Before making non-trivial changes, review:

- `README.md` for product and workspace structure
- `CONTRIBUTING.md` for contributor expectations
- `docs/testnet-release-strategy.md` for the current branch and release model

## Current Branch Model

Use the current repo policy, not historical project branch patterns.

- `dev` is the only long-lived integration branch for day-to-day work.
- Cut short-lived `feat/*`, `fix/*`, `docs/*`, `chore/*`, or similar branches from `dev`.
- Cut `release/*` branches only from a green `dev` commit when a version line is ready to stabilize.
- Merge approved `release/*` branches into `main` when stable enough to ship.
- Merge every fix made on a `release/*` branch back into `dev` immediately.
- Do not create new long-lived `integration/*` branches.

Historical note:

- Older Linear projects and merged PRs may still reference `integration/*`
  branch families such as `integration/position-manager-split` or
  `integration/robomata-overflow-demo-flow`.
- Treat those as historical context for old work, not as the default workflow
  for new work.

## Branching And PR Defaults

- Even repo-policy changes should go on a short-lived branch, not directly on `dev`.
- Keep each branch scoped to one concern.
- Prefer squash merges unless the user asks otherwise.
- PR titles should follow the repo's conventional-commit style:
  - `feat: ...`
  - `fix(web): ...`
  - `docs(repo): ...`
  - `chore(repo): ...`
- Do not use ad hoc prefixes like `[codex]` in PR titles.
- PR bodies should clearly include:
  - `Summary`
  - `Verification`

## GitHub And Linear Guidance

- Prefer local `git` for branch creation, staging, commit, and push.
- Prefer the GitHub connector for PR creation and metadata updates when it is available.
- If `gh` reports invalid auth inside the sandbox, verify the same command outside
  the sandbox before assuming the local token is actually invalid.
- Use Linear for project or issue context when it helps clarify current scope, but
  do not let old Linear branch-policy text override the current repo policy above.

## Validation Defaults

Run the narrowest checks that match the change.

Common root-level commands:

- `yarn evm:test`
- `yarn web:check-types`
- `yarn web:build`
- `yarn evm:lint`
- `yarn start`

Repo-specific guidance:

- `yarn start` from the repo root is the canonical local web entrypoint.
- If the user says a local server is already running, reuse it instead of starting a second guessed environment.
- For raw Foundry commands or direct EVM debugging, prefer running from `protocols/evm`.
- If `/markets` locally shows `No subgraph endpoint configured for chain 11155111.`, treat that as expected warning state unless the page is actually broken.

## Scope Discipline

- Keep issue boundaries strict.
- Do not mix unrelated refactors into launch-critical work.
- If behavior changes, update docs that describe the affected flow.
- If a change belongs to later migration or hardening work, note it and keep it out of the current branch unless the user explicitly expands scope.

## Release And Deployment Notes

- `main` is the stable production branch.
- `dev` and `release/*` support preview and release-stabilization work.
- Public release truth is the tagged release branch commit plus its GitHub release and deployed artifacts, not just a package version bump.

## When In Doubt

- Prefer the current repo docs over stale branch names in old project artifacts.
- Prefer smaller branches and earlier merges.
- Ask once when scope is genuinely ambiguous, otherwise make the smallest reasonable assumption and proceed.
