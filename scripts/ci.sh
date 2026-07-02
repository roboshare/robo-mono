#!/usr/bin/env bash
set -e

# Pass any flags like -f down to the signoff wrapper
SIGNOFF_ARGS=("$@")

# ci.sh writes the marker after all checks pass, so its own signoff calls
# must bypass both the marker check (doesn't exist yet) and gh-signoff's
# dirty-tree check (untracked files are expected).
CI_SIGNOFF_ARGS=("--ci" "-f")
for arg in "${SIGNOFF_ARGS[@]}"; do
  CI_SIGNOFF_ARGS+=("$arg")
done

SIGNOFF_SCRIPT="$(dirname "$0")/signoff.sh"

echo "Running local CI checks and conditional signoffs..."

BASE_BRANCH="origin/dev"
if ! git rev-parse --verify "$BASE_BRANCH" >/dev/null 2>&1; then
  BASE_BRANCH="origin/main"
fi

MERGE_BASE=$(git merge-base "$BASE_BRANCH" HEAD || git rev-parse HEAD)
CHANGED_FILES=$(git diff --name-only "$MERGE_BASE" HEAD)

check_path() {
  local pattern=$1
  echo "$CHANGED_FILES" | grep -qE "$pattern"
}

# 1. EVM
if check_path "^(\.github/workflows/|package\.json|yarn\.lock|\.yarnrc\.yml|\.yarn/|protocols/evm/)"; then
  echo "======================"
  echo "EVM: Linting, Compiling, Testing"
  echo "======================"
  yarn evm:lint
  yarn evm:storage-layout:check
  yarn compile
  yarn test
  bash "$SIGNOFF_SCRIPT" evm "${CI_SIGNOFF_ARGS[@]}"
else
  echo "======================"
  echo "EVM: No changes detected. Skipping tests and signing off."
  echo "======================"
  bash "$SIGNOFF_SCRIPT" evm "${CI_SIGNOFF_ARGS[@]}"
fi

# 2. Web
if check_path "^(\.github/workflows/|package\.json|yarn\.lock|\.yarnrc\.yml|\.yarn/|web/|protocols/evm/subgraph/)"; then
  echo "======================"
  echo "Web: Linting, Types, Building"
  echo "======================"
  yarn web:lint --max-warnings=0
  yarn web:check-types
  export NODE_OPTIONS="--max-old-space-size=4096"
  yarn web:build
  bash "$SIGNOFF_SCRIPT" web "${CI_SIGNOFF_ARGS[@]}"
else
  echo "======================"
  echo "Web: No changes detected. Skipping tests and signing off."
  echo "======================"
  bash "$SIGNOFF_SCRIPT" web "${CI_SIGNOFF_ARGS[@]}"
fi

# 3. Sui
if check_path "^(\.github/workflows/|protocols/sui/)"; then
  if [ -f "protocols/sui/Move.toml" ]; then
    echo "======================"
    echo "Sui: Linting, Building, Testing"
    echo "======================"
    if command -v sui &> /dev/null; then
      sui move build --path protocols/sui --lint --warnings-are-errors
      sui move test --path protocols/sui --warnings-are-errors
      bash "$SIGNOFF_SCRIPT" sui "${CI_SIGNOFF_ARGS[@]}"
    else
      echo "Warning: 'sui' command not found, failing."
      exit 1
    fi
  else
    echo "======================"
    echo "Sui package not found. Skipping tests and signing off."
    echo "======================"
    bash "$SIGNOFF_SCRIPT" sui "${CI_SIGNOFF_ARGS[@]}"
  fi
else
  echo "======================"
  echo "Sui: No changes detected. Skipping tests and signing off."
  echo "======================"
  bash "$SIGNOFF_SCRIPT" sui "${CI_SIGNOFF_ARGS[@]}"
fi

# Write CI marker after all checks pass so signoff.sh can verify CI was run
git rev-parse HEAD > .git/ci-run

echo "======================"
echo "All local CI checks completed successfully! ✅"
echo "======================"
