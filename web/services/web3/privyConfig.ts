import type { PrivyClientConfig } from "@privy-io/react-auth";
import { mainnet } from "viem/chains";
import scaffoldConfig from "~~/scaffold.config";

const { targetNetworks, walletConnectProjectId } = scaffoldConfig;
const privyEmbeddedWalletCreateOnLoginValues = new Set(["off", "users-without-wallets", "all-users"]);
type PrivyEmbeddedWalletCreateOnLogin = NonNullable<
  NonNullable<PrivyClientConfig["embeddedWallets"]>["ethereum"]
>["createOnLogin"];

export const enabledPrivyChains = targetNetworks.find(network => network.id === mainnet.id)
  ? targetNetworks
  : [...targetNetworks, mainnet];

export const getPrivyAppId = () => process.env.NEXT_PUBLIC_PRIVY_APP_ID;

export const isPrivyEnabled = () => Boolean(getPrivyAppId());

export const getPrivyEmbeddedWalletCreateOnLogin = (): PrivyEmbeddedWalletCreateOnLogin => {
  const configuredValue = process.env.NEXT_PUBLIC_PRIVY_EMBEDDED_WALLET_CREATE_ON_LOGIN?.trim();

  if (configuredValue && privyEmbeddedWalletCreateOnLoginValues.has(configuredValue)) {
    return configuredValue as PrivyEmbeddedWalletCreateOnLogin;
  }

  return "users-without-wallets";
};

export const getPrivyConfig = (theme: "light" | "dark"): PrivyClientConfig => ({
  appearance: {
    theme,
    accentColor: "#2299dd",
    showWalletLoginFirst: false,
    landingHeader: "Roboshare",
    loginMessage: "Access markets for tokenized revenue streams with an embedded wallet or your existing wallet.",
  },
  // Work around a missing-key warning in Privy's default landing screen renderer by
  // using the ordered-login variant instead.
  loginMethodsAndOrder: {
    primary: ["email", "google", "detected_ethereum_wallets"],
    overflow: ["wallet_connect"],
  },
  walletConnectCloudProjectId: walletConnectProjectId,
  supportedChains: [...enabledPrivyChains],
  defaultChain: enabledPrivyChains[0],
  embeddedWallets: {
    ethereum: {
      createOnLogin: getPrivyEmbeddedWalletCreateOnLogin(),
    },
  },
});
