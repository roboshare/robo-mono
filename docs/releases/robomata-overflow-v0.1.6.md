# Robomata Overflow v0.1.6

## Scope

Patch release for the Robomata Overflow testnet line. This cut ships the
server-side Sui facility-assignment persistence fix merged after
`robomata-overflow-v0.1.5`.

## Included Work

- Persists a newly created Sui facility without replacing the full stale
  submission payload when assignment recovery races with unrelated row updates.
- Keeps the live evidence root guard in the file and Postgres submission stores
  before attaching a created facility to a submission.
- Clears transient facility-assignment fields when the assignment succeeds so
  later evidence commits are not blocked by a stale assignment token.

## Deployment Notes

- This is a web/server release only.
- No Sui package republish is required because no Move code or onchain function
  signatures changed.
- No database migration or environment variable change is expected.

## Verification

- `yarn web:check-types`
- `yarn web:lint`
- `yarn web:build`
