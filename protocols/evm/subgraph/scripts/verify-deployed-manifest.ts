/**
 * Verify the manifest Studio is serving for a version label.
 * Usage: ts-node-esm scripts/verify-deployed-manifest.ts --version-label v0.3.0-arbitrum-sepolia.11
 */
import {
  readSchemaEntities,
  readNetworks,
  checkManifestEntities,
  checkManifestNetworks,
} from "./manifest-utils.ts";

type MetaResponse = {
  data?: { _meta?: { deployment?: string; hasIndexingErrors?: boolean; block?: { number?: number } } };
  errors?: Array<{ message?: string }>;
};

const args = process.argv.slice(2);
let versionLabel = process.env.GRAPH_SUBGRAPH_VERSION_LABEL;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--version-label" && args[i + 1]) {
    versionLabel = args[i + 1];
    i++;
  }
}

if (!versionLabel) {
  console.error("Missing --version-label");
  process.exit(1);
}

const slug = process.env.GRAPH_SUBGRAPH_SLUG || "roboshare-protocol";
const studioId = process.env.GRAPH_STUDIO_ID || "1745285";
const queryUrl = `https://api.studio.thegraph.com/query/${studioId}/${slug}/${versionLabel}`;

// Freshly deployed subgraphs need a few seconds to start ingesting blocks before
// _meta is queryable. The Graph reports "has not started syncing yet" until then,
// so poll instead of treating that startup race as a deploy failure.
const MAX_ATTEMPTS = Number(process.env.GRAPH_VERIFY_MAX_ATTEMPTS || 30);
const RETRY_DELAY_MS = Number(process.env.GRAPH_VERIFY_RETRY_MS || 10000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const notSyncingYet = (json: MetaResponse): boolean =>
  Array.isArray(json.errors) && json.errors.some((e) => /has not started syncing yet/i.test(e?.message ?? ""));

async function main(): Promise<void> {
  let deployment: string | undefined;
  let hasIndexingErrors: boolean | undefined;
  let blockNumber: number | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const metaResponse = await fetch(queryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ _meta { deployment hasIndexingErrors block { number } } }" }),
    });

    if (!metaResponse.ok) {
      console.error(`Failed to query ${queryUrl}: HTTP ${metaResponse.status}`);
      process.exit(1);
    }

    const metaJson = (await metaResponse.json()) as MetaResponse;
    deployment = metaJson.data?._meta?.deployment;
    hasIndexingErrors = metaJson.data?._meta?.hasIndexingErrors;
    blockNumber = metaJson.data?._meta?.block?.number;

    if (deployment) break;

    if (notSyncingYet(metaJson) && attempt < MAX_ATTEMPTS) {
      console.log(
        `Subgraph not started syncing yet (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${RETRY_DELAY_MS / 1000}s...`
      );
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    console.error(`No deployment hash returned from ${queryUrl}`);
    console.error(JSON.stringify(metaJson, null, 2));
    process.exit(1);
  }

  if (!deployment) {
    console.error(`No deployment hash returned from ${queryUrl}`);
    process.exit(1);
  }

  const ipfsResponse = await fetch(`https://ipfs.network.thegraph.com/ipfs/${deployment}`);
  if (!ipfsResponse.ok) {
    console.error(`Failed to fetch IPFS manifest ${deployment}: HTTP ${ipfsResponse.status}`);
    process.exit(1);
  }

  const manifest = await ipfsResponse.text();

  // Entity correctness is a hard failure: a deployment that serves legacy or
  // unknown entity names is the bug that breaks indexing.
  const entityErrors = checkManifestEntities(manifest, readSchemaEntities());
  if (entityErrors.length > 0) {
    console.error(`IPFS ${deployment} failed entity verification:`);
    for (const error of entityErrors) console.error(`  - ${error}`);
    process.exit(1);
  }

  // Start-block / address drift vs networks.json is surfaced as a warning: a
  // historical version legitimately differs from the current config, but flagging
  // it catches stale deployments (e.g. an old start block causing a slow backfill).
  const { network, errors: networkErrors } = checkManifestNetworks(manifest, readNetworks());
  if (networkErrors.length > 0) {
    console.warn(`WARNING: ${versionLabel} (${network}) does not match current networks.json:`);
    for (const error of networkErrors) console.warn(`  - ${error}`);
  }

  console.log(`OK: ${versionLabel} serves deployment ${deployment}`);
  console.log(`Query URL: ${queryUrl}`);
  console.log(`Indexed block: ${blockNumber ?? "unknown"}; hasIndexingErrors: ${hasIndexingErrors ?? "unknown"}`);
}

await main();
