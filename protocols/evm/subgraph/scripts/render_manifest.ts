import * as fs from "fs";
import yaml from "js-yaml";

const DEFAULT_NETWORK = "localhost";
const MANIFEST_TEMPLATE_FILE = "./subgraph.yaml";
const NETWORKS_FILE = "./networks.json";
const RENDERED_MANIFEST_FILE = "./subgraph.rendered.yaml";
const OPTIONAL_DATA_SOURCES = new Set(["FacilityRegistry"]);

function parseCliArgs() {
  const args = process.argv.slice(2);
  let networkArg: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if ((arg === "--network" || arg === "-n") && args[i + 1]) {
      networkArg = args[i + 1];
      i++;
    }
  }

  return {
    networkName: networkArg ?? process.env.SUBGRAPH_NETWORK ?? DEFAULT_NETWORK,
  };
}

function substituteTemplatePlaceholders(
  manifestTemplate: string,
  networkName: string,
  networkConfig: Record<string, { address?: string; startBlock?: number }>
): string {
  let renderedManifest = manifestTemplate.replace(/{{\s*network\s*}}/g, networkName);

  for (const [contractName, contractConfig] of Object.entries(networkConfig)) {
    if (!contractConfig.address) {
      throw new Error(`Missing address for ${contractName} on network '${networkName}'.`);
    }

    if (!Number.isInteger(contractConfig.startBlock)) {
      throw new Error(`Missing startBlock for ${contractName} on network '${networkName}'.`);
    }

    renderedManifest = renderedManifest.replace(
      new RegExp(`{{\\s*${contractName}\\.address\\s*}}`, "g"),
      contractConfig.address
    );
    renderedManifest = renderedManifest.replace(
      new RegExp(`{{\\s*${contractName}\\.startBlock\\s*}}`, "g"),
      String(contractConfig.startBlock)
    );
  }

  return renderedManifest;
}

function main() {
  const { networkName } = parseCliArgs();
  const manifestTemplate = fs.readFileSync(MANIFEST_TEMPLATE_FILE, "utf8");
  const networks = JSON.parse(fs.readFileSync(NETWORKS_FILE, "utf8")) as Record<
    string,
    Record<string, { address?: string; startBlock?: number }>
  >;

  const networkConfig = networks[networkName];
  if (!networkConfig) {
    throw new Error(`No subgraph network config found for '${networkName}'.`);
  }

  const substitutedManifest = substituteTemplatePlaceholders(
    manifestTemplate,
    networkName,
    networkConfig
  );

  // Expand YAML anchors so Studio receives a fully inlined manifest.
  const manifestDocument = yaml.load(substitutedManifest) as Record<string, unknown>;
  const dataSources = Array.isArray(manifestDocument.dataSources)
    ? (manifestDocument.dataSources as Array<{
        name?: string;
        source?: { address?: unknown; startBlock?: unknown };
      }>)
    : [];

  manifestDocument.dataSources = dataSources
    .filter(dataSource => {
      const address = String(dataSource.source?.address ?? "");
      const startBlock = String(dataSource.source?.startBlock ?? "");
      const hasUnresolvedPlaceholder = address.includes("{{") || startBlock.includes("{{");
      return !(dataSource.name && OPTIONAL_DATA_SOURCES.has(dataSource.name) && hasUnresolvedPlaceholder);
    })
    .map(dataSource => {
      const startBlock = dataSource.source?.startBlock;
      if (typeof startBlock === "string" && /^\d+$/.test(startBlock)) {
        dataSource.source!.startBlock = Number.parseInt(startBlock, 10);
      }
      return dataSource;
    });

  const unresolvedManifest = JSON.stringify(manifestDocument);
  if (unresolvedManifest.includes("{{")) {
    throw new Error(`Rendered manifest for '${networkName}' still contains unresolved placeholders.`);
  }

  const renderedManifest = yaml.dump(manifestDocument, {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  });

  fs.writeFileSync(RENDERED_MANIFEST_FILE, renderedManifest);
  console.log(`✅  Rendered subgraph manifest for ${networkName} at ${RENDERED_MANIFEST_FILE}.`);
}

main();
