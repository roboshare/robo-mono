import * as fs from "fs";
import * as path from "path";
import {
  SUBGRAPH_DIR,
  readSchemaEntities,
  readNetworks,
  checkManifestEntities,
  checkManifestNetworks,
} from "./manifest-utils.ts";

const buildManifestPath = path.join(SUBGRAPH_DIR, "build", "subgraph.yaml");

if (!fs.existsSync(buildManifestPath)) {
  console.error(`Missing ${buildManifestPath}. Run graph build first.`);
  process.exit(1);
}

const manifest = fs.readFileSync(buildManifestPath, "utf8");
const errors: string[] = [];

errors.push(...checkManifestEntities(manifest, readSchemaEntities()));

// The build manifest is rendered straight from networks.json, so a mismatch
// here means render/build rewrote the addresses or start blocks.
const { network, errors: networkErrors } = checkManifestNetworks(manifest, readNetworks());
errors.push(...networkErrors);

if (errors.length > 0) {
  console.error("build/subgraph.yaml failed verification:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`OK: build/subgraph.yaml matches schema entities and networks.json (${network}).`);
