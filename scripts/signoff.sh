#!/usr/bin/env bash
set -e

# Gated signoff wrapper. Requires `yarn ci` to have been run first.
# Usage: scripts/signoff.sh [signoff-name] [-f]
#
# The CI script writes .git/ci-run with the current commit SHA after all checks
# pass. This wrapper refuses to sign off unless that marker exists and matches
# the current HEAD, preventing `gh signoff` from being called directly without
# running the full CI suite first.
#
# Pass -f to bypass the CI marker check (use sparingly).

CI_MARKER=".git/ci-run"
SIGNOFF_ARGS=()

FORCE=false
SIGNOFF_NAME=""

for arg in "$@"; do
  case "$arg" in
    -f) FORCE=true; SIGNOFF_ARGS+=("$arg") ;;
    *)  SIGNOFF_NAME="$arg"; SIGNOFF_ARGS+=("$arg") ;;
  esac
done

if [ "$FORCE" = false ]; then
  if [ ! -f "$CI_MARKER" ]; then
    echo "Error: CI marker not found at $CI_MARKER"
    echo "Run 'yarn ci' before signing off."
    exit 1
  fi

  MARKER_SHA=$(cat "$CI_MARKER")
  CURRENT_SHA=$(git rev-parse HEAD)

  if [ "$MARKER_SHA" != "$CURRENT_SHA" ]; then
    echo "Error: CI marker SHA ($MARKER_SHA) does not match current HEAD ($CURRENT_SHA)."
    echo "Run 'yarn ci' again on the current commit."
    exit 1
  fi
fi

gh signoff $SIGNOFF_NAME "${SIGNOFF_ARGS[@]}"
