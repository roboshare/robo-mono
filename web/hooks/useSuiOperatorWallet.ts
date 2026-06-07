import { useCallback, useEffect, useState } from "react";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { getWallets } from "@wallet-standard/app";

const STANDARD_CONNECT = "standard:connect";
const SUI_SIGN_TRANSACTION = "sui:signTransaction";
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
  }) => Promise<{
    digest?: string;
    effects?: string | { status?: { status?: string; error?: string } };
    bytes?: string;
    signature?: string;
  }>;
};

type SuiSignTransactionFeature = {
  signTransaction: (input: { account: SuiWalletAccount; chain: string; transaction: Transaction }) => Promise<{
    bytes?: string;
    signature?: string;
  }>;
};

export type OperatorSuiCommitRequest = {
  chain: string;
  sponsorship?: {
    gasBudget: number;
    gasObjectId: string;
    sponsorAddress: string;
    sponsorSignature: string;
    transactionBytes: string;
  };
  transactionJson: string;
  facilityOperatorAddress: string;
  rootDigest: string;
};

export class OperatorSuiWalletError extends Error {
  constructor(
    message: string,
    readonly releaseReservation: boolean,
  ) {
    super(message);
    this.name = "OperatorSuiWalletError";
  }
}

export function shouldReleaseOperatorCommitReservation(error: unknown): boolean {
  return error instanceof OperatorSuiWalletError && error.releaseReservation;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isUserRejectedWalletError(error: unknown): boolean {
  if (typeof error === "object" && error && "code" in error && (error as { code?: unknown }).code === 4001) {
    return true;
  }
  return /\b(cancelled|canceled|denied|rejected)\b/i.test(errorMessage(error, ""));
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function asSuiWallet(wallet: unknown): SuiWallet | null {
  if (!wallet || typeof wallet !== "object") return null;
  const candidate = wallet as Partial<SuiWallet>;
  if (typeof candidate.name !== "string") return null;
  if (!candidate.features || typeof candidate.features !== "object") return null;
  if (!(SUI_SIGN_AND_EXECUTE_TRANSACTION in candidate.features) && !(SUI_SIGN_TRANSACTION in candidate.features)) {
    return null;
  }
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

function getSignTransactionFeature(wallet: SuiWallet): SuiSignTransactionFeature | null {
  const feature = wallet.features[SUI_SIGN_TRANSACTION];
  if (!feature || typeof feature !== "object") return null;
  const signTransaction = (feature as Partial<SuiSignTransactionFeature>).signTransaction;
  return typeof signTransaction === "function" ? { signTransaction } : null;
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
  throw new OperatorSuiWalletError("Sui wallet did not return a transaction digest.", false);
}

function assertWalletExecutionSucceeded(response: {
  effects?: string | { status?: { status?: string; error?: string } };
}) {
  if (!response.effects || typeof response.effects === "string") return;
  const status = response.effects.status;
  if (status?.status === "failure") {
    throw new OperatorSuiWalletError(
      status.error
        ? `Sui wallet executed a failed transaction: ${status.error}`
        : "Sui wallet executed a failed transaction.",
      true,
    );
  }
}

async function executeWithWallet(input: {
  wallet: SuiWallet;
  account: SuiWalletAccount;
  request: OperatorSuiCommitRequest;
  signFeature: SuiSignAndExecuteFeature;
}) {
  const transaction = Transaction.from(input.request.transactionJson);
  let response: Awaited<ReturnType<SuiSignAndExecuteFeature["signAndExecuteTransaction"]>>;
  try {
    response = await input.signFeature.signAndExecuteTransaction({
      account: input.account,
      chain: input.request.chain,
      transaction,
    });
  } catch (error) {
    throw new OperatorSuiWalletError(
      errorMessage(error, "Sui wallet did not return a transaction execution response."),
      isUserRejectedWalletError(error),
    );
  }
  assertWalletExecutionSucceeded(response);

  return {
    txDigest: responseDigest(response),
    walletAddress: input.account.address,
    walletName: input.wallet.name,
  };
}

async function signSponsoredWithWallet(input: {
  wallet: SuiWallet;
  account: SuiWalletAccount;
  request: OperatorSuiCommitRequest;
  signFeature: SuiSignTransactionFeature;
}) {
  if (!input.request.sponsorship) {
    throw new OperatorSuiWalletError("Sponsored Sui transaction payload is missing.", true);
  }

  const transaction = Transaction.from(fromBase64(input.request.sponsorship.transactionBytes));
  let response: Awaited<ReturnType<SuiSignTransactionFeature["signTransaction"]>>;
  try {
    response = await input.signFeature.signTransaction({
      account: input.account,
      chain: input.request.chain,
      transaction,
    });
  } catch (error) {
    throw new OperatorSuiWalletError(
      errorMessage(error, "Sui wallet did not return a transaction signature."),
      isUserRejectedWalletError(error),
    );
  }

  if (!response.signature) {
    throw new OperatorSuiWalletError("Sui wallet did not return an operator signature.", false);
  }

  return {
    operatorSignature: response.signature,
    sponsorSignature: input.request.sponsorship.sponsorSignature,
    transactionBytes: response.bytes ?? input.request.sponsorship.transactionBytes,
    walletAddress: input.account.address,
    walletName: input.wallet.name,
  };
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
    ): Promise<{
      operatorSignature?: string;
      sponsorSignature?: string;
      transactionBytes?: string;
      txDigest?: string;
      walletAddress: string;
      walletName: string;
    }> => {
      if (!wallets.length) {
        throw new OperatorSuiWalletError(
          "No Sui wallet with transaction-signing support is available in this browser.",
          true,
        );
      }

      const candidates = wallets
        .map(wallet => ({
          wallet,
          connectFeature: getConnectFeature(wallet),
          signAndExecuteFeature: getSignAndExecuteFeature(wallet),
          signTransactionFeature: getSignTransactionFeature(wallet),
        }))
        .filter(
          (
            candidate,
          ): candidate is {
            wallet: SuiWallet;
            connectFeature: StandardConnectFeature;
            signAndExecuteFeature: SuiSignAndExecuteFeature | null;
            signTransactionFeature: SuiSignTransactionFeature | null;
          } => Boolean(candidate.connectFeature),
        );

      if (!candidates.length) {
        throw new OperatorSuiWalletError(
          "No Sui wallet exposes the required wallet-standard connection feature.",
          true,
        );
      }

      for (const candidate of candidates) {
        const silent = await candidate.connectFeature.connect({ silent: true }).catch(() => ({ accounts: [] }));
        const account = findOperatorAccount(
          silent.accounts ?? candidate.wallet.accounts,
          request.chain,
          request.facilityOperatorAddress,
        );
        if (account) {
          if (request.sponsorship) {
            if (!candidate.signTransactionFeature) continue;
            return signSponsoredWithWallet({
              wallet: candidate.wallet,
              account,
              request,
              signFeature: candidate.signTransactionFeature,
            });
          }
          if (!candidate.signAndExecuteFeature) continue;
          return executeWithWallet({
            wallet: candidate.wallet,
            account,
            request,
            signFeature: candidate.signAndExecuteFeature,
          });
        }
      }

      const connectionErrors: string[] = [];
      for (const candidate of candidates) {
        try {
          const connected = await candidate.connectFeature.connect({ silent: false });
          const account = findOperatorAccount(
            connected.accounts ?? candidate.wallet.accounts,
            request.chain,
            request.facilityOperatorAddress,
          );
          if (account) {
            if (request.sponsorship) {
              if (!candidate.signTransactionFeature) continue;
              return signSponsoredWithWallet({
                wallet: candidate.wallet,
                account,
                request,
                signFeature: candidate.signTransactionFeature,
              });
            }
            if (!candidate.signAndExecuteFeature) continue;
            return executeWithWallet({
              wallet: candidate.wallet,
              account,
              request,
              signFeature: candidate.signAndExecuteFeature,
            });
          }
        } catch (error) {
          connectionErrors.push(
            error instanceof Error
              ? `${candidate.wallet.name}: ${error.message}`
              : `${candidate.wallet.name}: connection failed`,
          );
        }
      }

      throw new OperatorSuiWalletError(
        [
          `No connected Sui wallet exposes the configured facility operator address ${request.facilityOperatorAddress}.`,
          connectionErrors.length ? `Wallet errors: ${connectionErrors.join("; ")}` : undefined,
        ]
          .filter(Boolean)
          .join(" "),
        true,
      );
    },
    [wallets],
  );

  return {
    hasSuiWallet: wallets.length > 0,
    suiWalletNames: wallets.map(wallet => wallet.name),
    signAndExecuteOperatorCommit,
  };
}
