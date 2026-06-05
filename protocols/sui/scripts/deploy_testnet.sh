#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_PATH="${1:-$ROOT_DIR/fixtures/testnet-deploy.generated.json}"
ENV_PATH="${ROBOMATA_SUI_TESTNET_ENV_PATH:-$ROOT_DIR/fixtures/testnet-env.generated.sh}"
EXPECTED_ENV="${ROBOMATA_SUI_DEPLOY_ENV:-testnet}"
PUBLISH_GAS_BUDGET="${ROBOMATA_SUI_PUBLISH_GAS_BUDGET:-500000000}"
CALL_GAS_BUDGET="${ROBOMATA_SUI_GAS_BUDGET:-100000000}"
CLIENT_CONFIG="${ROBOMATA_SUI_CLIENT_CONFIG:-$HOME/.sui/sui_config/client.yaml}"
SEAL_KEY_SERVER_OBJECT_ID="${ROBOMATA_SEAL_KEY_SERVER_OBJECT_ID:-0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98}"
SEAL_KEY_SERVER_AGGREGATOR_URL="${ROBOMATA_SEAL_KEY_SERVER_AGGREGATOR_URL:-https://seal-aggregator-testnet.mystenlabs.com}"
SEAL_THRESHOLD="${ROBOMATA_SEAL_THRESHOLD:-1}"

GROSS_RECEIVABLES_CENTS="${ROBOMATA_SUI_INITIAL_GROSS_RECEIVABLES_CENTS:-124010000}"
ELIGIBLE_RECEIVABLES_CENTS="${ROBOMATA_SUI_INITIAL_ELIGIBLE_RECEIVABLES_CENTS:-69530000}"
ADVANCE_RATE_BPS="${ROBOMATA_SUI_INITIAL_ADVANCE_RATE_BPS:-8200}"
AVAILABLE_CENTS="${ROBOMATA_SUI_INITIAL_AVAILABLE_CENTS:-36155600}"
EVIDENCE_ROOT_HEX="${ROBOMATA_SUI_INITIAL_EVIDENCE_ROOT_HEX:-0x65766964656e63652d726f6f742d7631}"

mkdir -p "$(dirname "$OUTPUT_PATH")" "$(dirname "$ENV_PATH")"

ACTIVE_ENV="$(sui client --client.config "$CLIENT_CONFIG" active-env)"
ACTIVE_ADDRESS="$(sui client --client.config "$CLIENT_CONFIG" active-address)"

if [[ "$ACTIVE_ENV" != "$EXPECTED_ENV" && "${ROBOMATA_SUI_ALLOW_NON_TESTNET:-0}" != "1" ]]; then
  echo "Refusing to deploy: active Sui env is '$ACTIVE_ENV', expected '$EXPECTED_ENV'." >&2
  echo "Run 'sui client --client.config \"$CLIENT_CONFIG\" switch --env testnet' or set ROBOMATA_SUI_ALLOW_NON_TESTNET=1." >&2
  exit 1
fi

if ! sui client --client.config "$CLIENT_CONFIG" gas --json | node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const coins = Array.isArray(data) ? data : data?.gasCoins ?? [];
process.exit(coins.length > 0 ? 0 : 1);
'; then
  echo "No gas coins found for $ACTIVE_ADDRESS on $ACTIVE_ENV." >&2
  echo "Fund the address, then rerun this script." >&2
  exit 1
fi

rm -f "$ROOT_DIR/Published.toml"
PUBLISH_JSON="$(sui client --client.config "$CLIENT_CONFIG" publish "$ROOT_DIR" --gas-budget "$PUBLISH_GAS_BUDGET" --json)"
PACKAGE_ID="$(printf '%s' "$PUBLISH_JSON" | node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const published = data.objectChanges.find(change => change.type === "published");
if (!published) process.exit(1);
process.stdout.write(published.packageId);
')"
PUBLISH_DIGEST="$(printf '%s' "$PUBLISH_JSON" | node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(data.digest);
')"

CREATE_JSON="$(sui client --client.config "$CLIENT_CONFIG" call --package "$PACKAGE_ID" --module facility --function create_facility --args "$GROSS_RECEIVABLES_CENTS" "$ELIGIBLE_RECEIVABLES_CENTS" "$ADVANCE_RATE_BPS" "$AVAILABLE_CENTS" "$EVIDENCE_ROOT_HEX" 0x6 --gas-budget "$CALL_GAS_BUDGET" --json)"
FACILITY_ID="$(printf '%s' "$CREATE_JSON" | node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const event = data.events.find(item => item.type.endsWith("::FacilityCreated"));
if (!event) process.exit(1);
process.stdout.write(event.parsedJson.facility_id);
')"
CREATE_DIGEST="$(printf '%s' "$CREATE_JSON" | node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(data.digest);
')"

node - "$OUTPUT_PATH" "$ENV_PATH" "$ACTIVE_ENV" "$ACTIVE_ADDRESS" "$CLIENT_CONFIG" "$PACKAGE_ID" "$FACILITY_ID" "$PUBLISH_DIGEST" "$CREATE_DIGEST" "$CALL_GAS_BUDGET" "$SEAL_KEY_SERVER_OBJECT_ID" "$SEAL_KEY_SERVER_AGGREGATOR_URL" "$SEAL_THRESHOLD" "$PUBLISH_JSON" "$CREATE_JSON" <<'NODE'
const fs = require("fs");

const [
  ,
  ,
  outputPath,
  envPath,
  activeEnv,
  activeAddress,
  clientConfig,
  packageId,
  facilityId,
  publishDigest,
  createDigest,
  gasBudget,
  sealKeyServerObjectId,
  sealKeyServerAggregatorUrl,
  sealThreshold,
  publishJson,
  createJson,
] = process.argv;

const publish = JSON.parse(publishJson);
const created = JSON.parse(createJson);
const upgradeCap = publish.objectChanges.find(
  change => change.type === "created" && change.objectType === "0x2::package::UpgradeCap",
);
const facilityCreated = created.events.find(event => event.type.endsWith("::FacilityCreated"));

const payload = {
  network: {
    env: activeEnv,
    activeAddress,
    clientConfig,
  },
  package: {
    packageId,
    publishDigest,
    upgradeCapId: upgradeCap?.objectId ?? null,
    moduleNames: ["facility"],
  },
  facility: {
    objectId: facilityId,
    createDigest,
    initialSharedVersion:
      created.objectChanges.find(change => change.type === "created" && change.objectId === facilityId)?.owner?.Shared
        ?.initial_shared_version ?? null,
    createEvent: facilityCreated?.parsedJson ?? null,
  },
  appEnv: {
    ROBOMATA_SUI_PACKAGE_ID: packageId,
    ROBOMATA_SUI_FACILITY_ID: facilityId,
    ROBOMATA_SUI_CLIENT_CONFIG: clientConfig,
    ROBOMATA_SUI_GAS_BUDGET: gasBudget,
    ROBOMATA_SUI_NETWORK: "testnet",
    ROBOMATA_SEAL_PACKAGE_ID: packageId,
    ROBOMATA_SEAL_IDENTITY: facilityId,
    ROBOMATA_SEAL_KEY_SERVER_OBJECT_ID: sealKeyServerObjectId,
    ROBOMATA_SEAL_KEY_SERVER_AGGREGATOR_URL: sealKeyServerAggregatorUrl,
    ROBOMATA_SEAL_THRESHOLD: sealThreshold,
  },
};

fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2) + "\n");
fs.writeFileSync(
  envPath,
  [
    `export ROBOMATA_SUI_PACKAGE_ID="${packageId}"`,
    `export ROBOMATA_SUI_FACILITY_ID="${facilityId}"`,
    `export ROBOMATA_SUI_CLIENT_CONFIG="${clientConfig}"`,
    `export ROBOMATA_SUI_GAS_BUDGET="${gasBudget}"`,
    `export ROBOMATA_SUI_NETWORK="testnet"`,
    `export ROBOMATA_SEAL_PACKAGE_ID="${packageId}"`,
    `export ROBOMATA_SEAL_IDENTITY="${facilityId}"`,
    `export ROBOMATA_SEAL_KEY_SERVER_OBJECT_ID="${sealKeyServerObjectId}"`,
    `export ROBOMATA_SEAL_KEY_SERVER_AGGREGATOR_URL="${sealKeyServerAggregatorUrl}"`,
    `export ROBOMATA_SEAL_THRESHOLD="${sealThreshold}"`,
    "",
  ].join("\n"),
);
NODE

printf 'Published Robomata Sui package on %s\n' "$ACTIVE_ENV"
printf 'Package ID: %s\n' "$PACKAGE_ID"
printf 'Facility ID: %s\n' "$FACILITY_ID"
printf 'Wrote deployment fixture to %s\n' "$OUTPUT_PATH"
printf 'Wrote app env exports to %s\n' "$ENV_PATH"
