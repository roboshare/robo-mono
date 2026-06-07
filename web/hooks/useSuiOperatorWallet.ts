import { useCallback, useEffect, useState } from "react";
import { Transaction } from "@mysten/sui/transactions";
import { getWallets } from "@wallet-standard/app";

const STANDARD_CONNECT = "standard:connect";
const SUI_SIGN_AND_EXECUTE_TRANSACTION = "sui:signAndExecuteTransaction";

type SuiWalletAccount = {
  address: string;
  chains?: readonly string[];
};

type SuiWallet = {
  name: string;
  accounts: readonly SuiWalletAccount[];
  features: Record<string, unknown>;
};

type StandardConnectFeature = {
  connect: (input?: { silent?: boolean }) => Promise<{ accounts?: readonly SuiWalletAccount[] }>;
};

type SuiSignAndExecuteFeature = {
  signAndExecuteTransaction: (input: {
    account: SuiWalletAccount;
    chain: string;
    transaction: Transaction;
  }) => Promise<{ digest?: string; effects?: string; bytes?: string; signature?: string }>;
};

export type OperatorSuiCommitRequest = {
  chain: string;
  transactionJson: string;
  facilityOperatorAddress: string;
};

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function asSuiWallet(wallet: unknown): SuiWallet | null {
  if (!wallet || typeof wallet !== "object") return null;
  const candidate = wallet as Partial<SuiWallet>;
  if (typeof candidate.name !== "string") return null;
  if (!candidate.features || typeof candidate.features !== "object") return null;
  if (!(SUI_SIGN_AND_EXECUTE_TRANSACTION in candidate.features)) return null;
  return {
    name: candidate.name,
    accounts: Array.isArray(candidate.accounts) ? candidate.accounts : [],
    features: candidate.features,
  };
}

function getConnectFeature(wallet: SuiWallet): StandardConnectFeature | null {
  const feature = wallet.features[STANDARD_CONNECT];
  if (!feature || typeof feature !== "object") return null;
  const connect = (feature as Partial<StandardConnectFeature>).connect;
  return typeof connect === "function" ? { connect } : null;
}

function getSignAndExecuteFeature(wallet: SuiWallet): SuiSignAndExecuteFeature | null {
  const feature = wallet.features[SUI_SIGN_AND_EXECUTE_TRANSACTION];
  if (!feature || typeof feature !== "object") return null;
  const signAndExecuteTransaction = (feature as Partial<SuiSignAndExecuteFeature>).signAndExecuteTransaction;
  return typeof signAndExecuteTransaction === "function" ? { signAndExecuteTransaction } : null;
}

function accountSupportsChain(account: SuiWalletAccount, chain: string): boolean {
  return !account.chains?.length || account.chains.includes(chain);
}

function findOperatorAccount(accounts: readonly SuiWalletAccount[], chain: string, operatorAddress: string) {
  const expectedAddress = normalizeAddress(operatorAddress);
  return accounts.find(
    account => normalizeAddress(account.address) === expectedAddress && accountSupportsChain(account, chain),
  );
}

function responseDigest(response: { digest?: string }): string {
  if (typeof response.digest === "string" && response.digest.trim()) return response.digest.trim();
  throw new Error("Sui wallet did not return a transaction digest.");
}

export function useSuiOperatorWallet() {
  const [wallets, setWallets] = useState<SuiWallet[]>([]);

  const refreshWallets = useCallback(() => {
    setWallets(
      getWallets()
        .get()
        .map(asSuiWallet)
        .filter((wallet): wallet is SuiWallet => Boolean(wallet)),
    );
  }, []);

  useEffect(() => {
    const registry = getWallets();
    refreshWallets();
    const offRegister = registry.on("register", refreshWallets);
    const offUnregister = registry.on("unregister", refreshWallets);
    return () => {
      offRegister();
      offUnregister();
    };
  }, [refreshWallets]);

  const signAndExecuteOperatorCommit = useCallback(
    async (
      request: OperatorSuiCommitRequest,
    ): Promise<{ txDigest: string; walletAddress: string; walletName: string }> => {
      const wallet = wallets[0];
      if (!wallet) {
        throw new Error("No Sui wallet with sign-and-execute support is available in this browser.");
      }

      const connectFeature = getConnectFeature(wallet);
      const signFeature = getSignAndExecuteFeature(wallet);
      if (!connectFeature || !signFeature) {
        throw new Error(`${wallet.name} does not expose the required Sui wallet-standard features.`);
      }

      const silent = await connectFeature.connect({ silent: true }).catch(() => ({ accounts: [] }));
      let account = findOperatorAccount(
        silent.accounts ?? wallet.accounts,
        request.chain,
        request.facilityOperatorAddress,
      );
      if (!account) {
        const connected = await connectFeature.connect({ silent: false });
        account = findOperatorAccount(
          connected.accounts ?? wallet.accounts,
          request.chain,
          request.facilityOperatorAddress,
        );
      }
      if (!account) {
        throw new Error(
          `${wallet.name} is connected, but it does not expose the configured facility operator address ${request.facilityOperatorAddress}.`,
        );
      }

      const transaction = Transaction.from(request.transactionJson);
      const response = await signFeature.signAndExecuteTransaction({
        account,
        chain: request.chain,
        transaction,
      });

      return { txDigest: responseDigest(response), walletAddress: account.address, walletName: wallet.name };
    },
    [wallets],
  );

  return {
    hasSuiWallet: wallets.length > 0,
    suiWalletNames: wallets.map(wallet => wallet.name),
    signAndExecuteOperatorCommit,
  };
}
