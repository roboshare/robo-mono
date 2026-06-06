import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

const utilsDir = path.dirname(fileURLToPath(import.meta.url));
export const SUBGRAPH_DIR = path.resolve(utilsDir, "..");
const SCHEMA_FILE = path.join(SUBGRAPH_DIR, "src/schema.graphql");
const NETWORKS_FILE = path.join(SUBGRAPH_DIR, "networks.json");

export type ContractConfig = { address?: string; startBlock?: number };
export type NetworksConfig = Record<string, Record<string, ContractConfig>>;

type RenderedDataSource = {
  name?: string;
  network?: string;
  source?: { address?: string; startBlock?: number };
  mapping?: { entities?: string[] };
};
type RenderedManifest = { dataSources?: RenderedDataSource[] };

/** Entity type names declared in the GraphQL schema (`type Foo @entity`). */
export function readSchemaEntities(): string[] {
  const schema = fs.readFileSync(SCHEMA_FILE, "utf8");
  return [...schema.matchAll(/^type\s+(\w+)\s+@entity/gm)].map((m) => m[1]!).sort();
}

export function readNetworks(): NetworksConfig {
  return JSON.parse(fs.readFileSync(NETWORKS_FILE, "utf8")) as NetworksConfig;
}

export function parseManifest(manifestText: string): RenderedManifest {
  return (yaml.load(manifestText) ?? {}) as RenderedManifest;
}

/**
 * Validate a fully rendered manifest (build output or deployed IPFS manifest)
 * against the schema. Because every data source shares one compiled mapping,
 * each must declare every schema entity, and no entity may be unknown to the
 * schema. This is derived from the schema, so it catches any legacy/renamed
 * entity name without a hardcoded deny-list.
 */
export function checkManifestEntities(manifestText: string, schemaEntities: string[]): string[] {
  const errors: string[] = [];

  if (/&entities|\*entities/.test(manifestText)) {
    errors.push("manifest still contains unexpanded YAML anchors (&entities/*entities)");
  }

  const dataSources = parseManifest(manifestText).dataSources ?? [];
  if (dataSources.length === 0) {
    errors.push("manifest has no dataSources");
    return errors;
  }

  const schemaSet = new Set(schemaEntities);
  for (const ds of dataSources) {
    const name = ds.name ?? "<unnamed>";
    const declared = ds.mapping?.entities ?? [];
    const declaredSet = new Set(declared);

    const unknown = declared.filter((entity) => !schemaSet.has(entity));
    if (unknown.length > 0) {
      errors.push(`${name}: entities not in schema: ${unknown.join(", ")}`);
    }

    const missing = schemaEntities.filter((entity) => !declaredSet.has(entity));
    if (missing.length > 0) {
      errors.push(`${name}: missing schema entities: ${missing.join(", ")}`);
    }
  }

  return errors;
}

/**
 * Compare a rendered manifest's per-data-source address/startBlock against
 * networks.json. Catches a stale deployment whose start blocks no longer match
 * the current network config (the class of bug behind the slow Monad backfill).
 */
export function checkManifestNetworks(
  manifestText: string,
  networks: NetworksConfig
): { network: string | null; errors: string[] } {
  const dataSources = parseManifest(manifestText).dataSources ?? [];
  const errors: string[] = [];

  const networkNames = [...new Set(dataSources.map((ds) => ds.network).filter((n): n is string => Boolean(n)))];
  if (networkNames.length === 0) {
    return { network: null, errors: ["manifest data sources declare no network"] };
  }
  if (networkNames.length > 1) {
    errors.push(`manifest mixes networks: ${networkNames.join(", ")}`);
  }

  const network = networkNames[0]!;
  const config = networks[network];
  if (!config) {
    errors.push(`networks.json has no config for '${network}'`);
    return { network, errors };
  }

  for (const ds of dataSources) {
    if (!ds.name) continue;
    const expected = config[ds.name];
    if (!expected) {
      errors.push(`${ds.name}: not present in networks.json['${network}']`);
      continue;
    }

    const actualAddress = (ds.source?.address ?? "").toLowerCase();
    const expectedAddress = (expected.address ?? "").toLowerCase();
    if (expectedAddress && actualAddress !== expectedAddress) {
      errors.push(`${ds.name}: address ${actualAddress || "(none)"} != networks.json ${expectedAddress}`);
    }

    const actualStart = ds.source?.startBlock;
    if (expected.startBlock !== undefined && Number(actualStart) !== Number(expected.startBlock)) {
      errors.push(`${ds.name}: startBlock ${actualStart ?? "(none)"} != networks.json ${expected.startBlock}`);
    }
  }

  return { network, errors };
}
