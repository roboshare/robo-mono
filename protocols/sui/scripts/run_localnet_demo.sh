#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${ROBOMATA_SUI_DEMO_CONFIG_DIR:-$(mktemp -d /tmp/robomata-sui-demo.XXXXXX)}"
CLIENT_CONFIG="$CONFIG_DIR/client.yaml"
PUBFILE_PATH="$CONFIG_DIR/Published.toml"
OUTPUT_PATH="${1:-$ROOT_DIR/fixtures/localnet-demo-run.generated.json}"
FULLNODE_PORT="${ROBOMATA_SUI_DEMO_FULLNODE_PORT:-9000}"
RPC_URL="http://127.0.0.1:${FULLNODE_PORT}"

PACKAGE_ID=""
FACILITY_ID=""
PUBLISH_DIGEST=""
UPDATE_DIGEST=""
COMMIT_DIGEST=""

cleanup() {
  if [[ -n "${SUI_START_PID:-}" ]] && kill -0 "$SUI_START_PID" >/dev/null 2>&1; then
    kill "$SUI_START_PID" >/dev/null 2>&1 || true
    wait "$SUI_START_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

mkdir -p "$(dirname "$OUTPUT_PATH")"

sui genesis --working-dir "$CONFIG_DIR" --force --with-faucet >/dev/null
python3 - "$CLIENT_CONFIG" "$RPC_URL" <<'PY'
from pathlib import Path
import sys

client_config = Path(sys.argv[1])
rpc_url = sys.argv[2]

lines = client_config.read_text().splitlines()
rewritten = []
in_localnet_env = False

for line in lines:
    stripped = line.strip()

    if stripped.startswith("- alias:"):
        alias = stripped.split(":", 1)[1].strip().strip('"')
        in_localnet_env = alias == "localnet"
        rewritten.append(line)
        continue

    if in_localnet_env and stripped.startswith("rpc:"):
        indent = line[: len(line) - len(line.lstrip())]
        rewritten.append(f'{indent}rpc: "{rpc_url}"')
        in_localnet_env = False
        continue

    rewritten.append(line)

client_config.write_text("\n".join(rewritten) + "\n")
PY
sui start --network.config "$CONFIG_DIR" --fullnode-rpc-port "$FULLNODE_PORT" >/tmp/robomata-sui-demo.log 2>&1 &
SUI_START_PID=$!

for _ in {1..30}; do
  if sui client --client.config "$CLIENT_CONFIG" chain-identifier >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

ACTIVE_ADDRESS="$(sui client --client.config "$CLIENT_CONFIG" active-address)"

PUBLISH_JSON="$(sui client --client.config "$CLIENT_CONFIG" test-publish "$ROOT_DIR" --pubfile-path "$PUBFILE_PATH" --build-env localnet --gas-budget 500000000 --json)"
CREATE_JSON=""
UPDATE_JSON=""
COMMIT_JSON=""

PACKAGE_ID="$(printf '%s' "$PUBLISH_JSON" | node -e 'const fs = require("fs"); const data = JSON.parse(fs.readFileSync(0, "utf8")); const published = data.objectChanges.find(change => change.type === "published"); if (!published) process.exit(1); process.stdout.write(published.packageId);')"
PUBLISH_DIGEST="$(printf '%s' "$PUBLISH_JSON" | node -e 'const fs = require("fs"); const data = JSON.parse(fs.readFileSync(0, "utf8")); process.stdout.write(data.digest);')"

CREATE_JSON="$(sui client --client.config "$CLIENT_CONFIG" call --package "$PACKAGE_ID" --module facility --function create_facility --args 124010000 69530000 8200 36155600 0x65766964656e63652d726f6f742d7631 0x6 --gas-budget 100000000 --json)"
FACILITY_ID="$(printf '%s' "$CREATE_JSON" | node -e 'const fs = require("fs"); const data = JSON.parse(fs.readFileSync(0, "utf8")); const event = data.events.find(item => item.type.endsWith("::FacilityCreated")); if (!event) process.exit(1); process.stdout.write(event.parsedJson.facility_id);')"

UPDATE_JSON="$(sui client --client.config "$CLIENT_CONFIG" call --package "$PACKAGE_ID" --module facility --function update_borrowing_base --args "$FACILITY_ID" 71200000 40200400 0x757064617465642d65766964656e63652d726f6f742d7632 0x6 --gas-budget 100000000 --json)"
UPDATE_DIGEST="$(printf '%s' "$UPDATE_JSON" | node -e 'const fs = require("fs"); const data = JSON.parse(fs.readFileSync(0, "utf8")); process.stdout.write(data.digest);')"

COMMIT_JSON="$(sui client --client.config "$CLIENT_CONFIG" call --package "$PACKAGE_ID" --module facility --function commit_evidence --args "$FACILITY_ID" lockbox_extract 0x6c6f636b626f782d6469676573742d7631 --gas-budget 100000000 --json)"
COMMIT_DIGEST="$(printf '%s' "$COMMIT_JSON" | node -e 'const fs = require("fs"); const data = JSON.parse(fs.readFileSync(0, "utf8")); process.stdout.write(data.digest);')"

node - "$OUTPUT_PATH" "$CONFIG_DIR" "$RPC_URL" "$ACTIVE_ADDRESS" "$PACKAGE_ID" "$FACILITY_ID" "$PUBLISH_DIGEST" "$UPDATE_DIGEST" "$COMMIT_DIGEST" "$PUBLISH_JSON" "$CREATE_JSON" "$UPDATE_JSON" "$COMMIT_JSON" <<'NODE'
const fs = require("fs");

const [
  ,
  ,
  outputPath,
  configDir,
  rpcUrl,
  activeAddress,
  packageId,
  facilityId,
  publishDigest,
  updateDigest,
  commitDigest,
  publishJson,
  createJson,
  updateJson,
  commitJson,
] = process.argv;

const publish = JSON.parse(publishJson);
const created = JSON.parse(createJson);
const updated = JSON.parse(updateJson);
const committed = JSON.parse(commitJson);

const upgradeCap = publish.objectChanges.find(change => change.type === "created" && change.objectType === "0x2::package::UpgradeCap");
const facilityCreated = created.events.find(event => event.type.endsWith("::FacilityCreated"));
const borrowingBaseUpdated = updated.events.find(event => event.type.endsWith("::BorrowingBaseUpdated"));
const evidenceCommitted = committed.events.find(event => event.type.endsWith("::EvidenceCommitted"));

const payload = {
  network: {
    mode: "isolated-localnet",
    rpcUrl,
    configDir,
    clientConfig: `${configDir}/client.yaml`,
    activeAddress,
  },
  package: {
    packageId,
    publishDigest,
    upgradeCapId: upgradeCap?.objectId ?? null,
    moduleNames: ["facility"],
  },
  facility: {
    objectId: facilityId,
    createDigest: created.digest,
    initialSharedVersion:
      created.objectChanges.find(change => change.type === "created" && change.objectId === facilityId)?.owner?.Shared
        ?.initial_shared_version ?? null,
    grossReceivablesCents: 124010000,
    eligibleReceivablesCents: 69530000,
    advanceRateBps: 8200,
    availableCents: 36155600,
    evidenceRootHex: "0x65766964656e63652d726f6f742d7631",
    createEvent: facilityCreated?.parsedJson ?? null,
  },
  update: {
    digest: updateDigest,
    eligibleReceivablesCents: 71200000,
    availableCents: 40200400,
    evidenceRootHex: "0x757064617465642d65766964656e63652d726f6f742d7632",
    updateEvent: borrowingBaseUpdated?.parsedJson ?? null,
  },
  evidenceCommit: {
    digest: commitDigest,
    evidenceKind: "lockbox_extract",
    evidenceDigestHex: "0x6c6f636b626f782d6469676573742d7631",
    evidenceEvent: evidenceCommitted?.parsedJson ?? null,
  },
  notes: [
    "This fixture comes from an isolated localnet run started from a disposable config directory.",
    "No default ~/.sui client state or recovery phrase is required for the scripted demo path.",
  ],
};

fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2) + "\n");
NODE

printf 'Wrote localnet demo fixture to %s\n' "$OUTPUT_PATH"
