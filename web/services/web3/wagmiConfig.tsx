import { getWagmiConnectors } from "./wagmiConnectors";
import { createConfig as createPrivyWagmiConfig } from "@privy-io/wagmi";
import { Chain, createClient, fallback, http } from "viem";
import { foundry, mainnet } from "viem/chains";
import { Config, createConfig } from "wagmi";
import scaffoldConfig, { ScaffoldConfig } from "~~/scaffold.config";
import { isPrivyEnabled } from "~~/services/web3/privyConfig";
import { getRuntimeLocalChain } from "~~/utils/localServiceUrls";
import { getAlchemyHttpUrl } from "~~/utils/scaffold-eth";

const { targetNetworks } = scaffoldConfig;

// We always want to have mainnet enabled (ENS resolution, ETH price, etc). But only once.
export const enabledChains = targetNetworks.find((network: Chain) => network.id === 1)
  ? targetNetworks
  : [...targetNetworks, mainnet];

let wagmiConfigSingleton: Config | undefined;

export const getWagmiConfig = () => {
  if (wagmiConfigSingleton) {
    return wagmiConfigSingleton;
  }

  const connectors = typeof window === "undefined" ? [] : getWagmiConnectors();

  const runtimeEnabledChains = enabledChains.map(chain =>
    chain.id === foundry.id ? getRuntimeLocalChain() : chain,
  ) as [Chain, ...Chain[]];
  const createRuntimeConfig = isPrivyEnabled() ? createPrivyWagmiConfig : createConfig;

  wagmiConfigSingleton = createRuntimeConfig({
    chains: runtimeEnabledChains,
    connectors,
    ssr: true,
    client({ chain }) {
      const rpcFallbacks = [];
      const alchemyHttpUrl = getAlchemyHttpUrl(chain.id);
      const rpcOverrideUrl = (scaffoldConfig.rpcOverrides as ScaffoldConfig["rpcOverrides"])?.[chain.id];
      if (alchemyHttpUrl) {
        rpcFallbacks.push(http(alchemyHttpUrl));
      }
      if (rpcOverrideUrl) {
        rpcFallbacks.push(http(rpcOverrideUrl));
      }
      rpcFallbacks.push(http());

      return createClient({
        chain,
        transport: fallback(rpcFallbacks),
        ...(chain.id !== (foundry as Chain).id
          ? {
              pollingInterval: scaffoldConfig.pollingInterval,
            }
          : {}),
      });
    },
  });

  return wagmiConfigSingleton;
};
