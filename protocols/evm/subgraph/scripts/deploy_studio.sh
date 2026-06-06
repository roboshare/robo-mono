#!/usr/bin/env bash
set -euo pipefail

version_label=""

while [ $# -gt 0 ]; do
  case "$1" in
    --network|-n)
      export SUBGRAPH_NETWORK="$2"
      shift 2
      ;;
    --version-label)
      version_label="$2"
      shift 2
      ;;
    *)
      echo "Unsupported argument for deploy: $1" >&2
      exit 1
      ;;
  esac
done

if [ -z "${SUBGRAPH_NETWORK:-}" ]; then
  echo "SUBGRAPH_NETWORK is required (pass --network or export SUBGRAPH_NETWORK)" >&2
  exit 1
fi

rm -rf build generated
ts-node-esm scripts/render_manifest.ts --network "$SUBGRAPH_NETWORK"
# Regenerate AssemblyScript entity types from the current schema so the compiled
# wasm's store.set/get entity names always match the deployed schema. Skipping
# this lets a stale generated/ bake legacy entity names into the wasm, which
# surfaces at runtime as "unknown name when looking up entity type".
graph codegen subgraph.rendered.yaml
graph build subgraph.rendered.yaml
# Verifies the built manifest against the schema (entity names) and networks.json
# (addresses/start blocks) before publishing.
ts-node-esm scripts/verify-build-manifest.ts

test -n "${GRAPH_DEPLOY_KEY:-}" || { echo "GRAPH_DEPLOY_KEY is required" >&2; exit 1; }
test -n "${GRAPH_SUBGRAPH_SLUG:-}" || { echo "GRAPH_SUBGRAPH_SLUG is required" >&2; exit 1; }

deploy_args=(graph deploy --node https://api.studio.thegraph.com/deploy/ --deploy-key "$GRAPH_DEPLOY_KEY" "$GRAPH_SUBGRAPH_SLUG" subgraph.rendered.yaml)
if [ -n "$version_label" ]; then
  deploy_args+=(--version-label "$version_label")
fi

"${deploy_args[@]}"

if [ -n "$version_label" ]; then
  ts-node-esm scripts/verify-deployed-manifest.ts --version-label "$version_label"
fi
