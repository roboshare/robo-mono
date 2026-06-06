"use client";

import { type ReactNode, createContext, useCallback, useContext } from "react";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import type { Address } from "viem";
import { useAccount } from "wagmi";
import type { GetSmartWalletClientForChain, SmartWalletTransactClient } from "~~/hooks/useSmartWalletTransaction";

type TransactingAccountState = {
  address?: Address;
  chainId?: number;
  connectedAddress?: Address;
  connectedChainId?: number;
  isSmartWallet: boolean;
  smartWalletClient?: SmartWalletTransactClient;
  getSmartWalletClientForChain?: GetSmartWalletClientForChain;
};

const TransactingAccountContext = createContext<TransactingAccountState>({
  address: undefined,
  chainId: undefined,
  connectedAddress: undefined,
  connectedChainId: undefined,
  isSmartWallet: false,
});

const DefaultTransactingAccountProvider = ({ children }: { children: ReactNode }) => {
  const { address, chainId } = useAccount();

  return (
    <TransactingAccountContext.Provider
      value={{
        address,
        chainId,
        connectedAddress: address,
        connectedChainId: chainId,
        isSmartWallet: false,
        smartWalletClient: undefined,
      }}
    >
      {children}
    </TransactingAccountContext.Provider>
  );
};

const PrivyTransactingAccountProvider = ({ children }: { children: ReactNode }) => {
  const { address: connectedAddress, chainId: connectedChainId } = useAccount();
  const { client: smartWalletClient, getClientForChain } = useSmartWallets();
  const address =
    ((smartWalletClient as SmartWalletTransactClient & { account?: { address?: Address } })?.account?.address as
      | Address
      | undefined) ?? connectedAddress;
  const chainId = connectedChainId ?? smartWalletClient?.chain?.id;

  const getSmartWalletClientForChain = useCallback<GetSmartWalletClientForChain>(
    async (targetChainId: number) => {
      const client = await getClientForChain({ id: targetChainId });
      return client as SmartWalletTransactClient | undefined;
    },
    [getClientForChain],
  );

  return (
    <TransactingAccountContext.Provider
      value={{
        address,
        chainId,
        connectedAddress,
        connectedChainId,
        isSmartWallet: Boolean(smartWalletClient),
        smartWalletClient: smartWalletClient as SmartWalletTransactClient | undefined,
        getSmartWalletClientForChain,
      }}
    >
      {children}
    </TransactingAccountContext.Provider>
  );
};

export const TransactingAccountProvider = ({
  children,
  privyEnabled,
}: {
  children: ReactNode;
  privyEnabled: boolean;
}) => {
  if (privyEnabled) {
    return <PrivyTransactingAccountProvider>{children}</PrivyTransactingAccountProvider>;
  }

  return <DefaultTransactingAccountProvider>{children}</DefaultTransactingAccountProvider>;
};

export const useTransactingAccount = () => useContext(TransactingAccountContext);
