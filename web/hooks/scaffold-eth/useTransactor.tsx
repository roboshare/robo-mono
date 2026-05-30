import { useQueryClient } from "@tanstack/react-query";
import { Hash, SendTransactionParameters, TransactionReceipt, WalletClient } from "viem";
import { Config, useWalletClient } from "wagmi";
import { getPublicClient } from "wagmi/actions";
import { SendTransactionMutate } from "wagmi/query";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import { getWagmiConfig } from "~~/services/web3/wagmiConfig";
import { getBlockExplorerTxLink, getParsedError, notification } from "~~/utils/scaffold-eth";
import { TransactorFuncOptions } from "~~/utils/scaffold-eth/contract";

type TransactionFunc = (
  tx: (() => Promise<Hash>) | Parameters<SendTransactionMutate<Config, undefined>>[0],
  options?: TransactorFuncOptions,
) => Promise<Hash | undefined>;

/**
 * Custom notification content for TXs.
 */
const TxnNotification = ({ message, blockExplorerLink }: { message: string; blockExplorerLink?: string }) => {
  return (
    <div className={`flex flex-col ml-1 cursor-default`}>
      <p className="my-0">{message}</p>
      {blockExplorerLink && blockExplorerLink.length > 0 ? (
        <a href={blockExplorerLink} target="_blank" rel="noreferrer" className="block link text-md">
          check out transaction
        </a>
      ) : null}
    </div>
  );
};

/**
 * Runs Transaction passed in to returned function showing UI feedback.
 * @param _walletClient - Optional wallet client to use. If not provided, will use the one from useWalletClient.
 * @returns function that takes in transaction function as callback, shows UI feedback for transaction and returns a promise of the transaction hash
 */
export const useTransactor = (_walletClient?: WalletClient): TransactionFunc => {
  let walletClient = _walletClient;
  const { data } = useWalletClient();
  const { isSmartWallet, chainId: transactingChainId } = useTransactingAccount();
  const queryClient = useQueryClient();
  if (walletClient === undefined && data) {
    walletClient = data;
  }

  const result: TransactionFunc = async (tx, options) => {
    if (!walletClient && !isSmartWallet) {
      notification.error("Cannot access account");
      console.error("⚡️ ~ file: useTransactor.tsx ~ error");
      return;
    }

    let notificationId = null;
    let transactionHash: Hash | undefined = undefined;
    let transactionReceipt: TransactionReceipt | undefined;
    let blockExplorerTxURL = "";
    try {
      const network = walletClient ? await walletClient.getChainId() : transactingChainId;
      if (!network) {
        throw new Error("No active network configured for the transacting account");
      }
      // Get full transaction from public client
      const publicClient = getPublicClient(getWagmiConfig());
      if (!publicClient) {
        throw new Error("No public client configured for the active network");
      }

      notificationId = notification.loading(<TxnNotification message="Submitting transaction..." />);
      if (typeof tx === "function") {
        // Tx is already prepared by the caller
        const result = await tx();
        transactionHash = result;
      } else if (tx != null) {
        if (!walletClient) {
          throw new Error("Cannot send a direct transaction without a connected wallet client");
        }
        transactionHash = await walletClient.sendTransaction(tx as SendTransactionParameters);
      } else {
        throw new Error("Incorrect transaction passed to transactor");
      }
      notification.remove(notificationId);

      blockExplorerTxURL = network ? getBlockExplorerTxLink(network, transactionHash) : "";

      if (isSmartWallet) {
        // Privy smart-wallet sendTransaction already waits for bundler inclusion and returns
        // the mined transaction hash. Waiting again on the public RPC often times out when
        // the returned hash is still a user-operation hash or the bundler path differs.
        notification.success(
          <TxnNotification message="Transaction completed successfully!" blockExplorerLink={blockExplorerTxURL} />,
          {
            icon: "🎉",
          },
        );

        queryClient.invalidateQueries();

        if (options?.onBlockConfirmation && transactionHash) {
          try {
            transactionReceipt = await publicClient.getTransactionReceipt({ hash: transactionHash });
            options.onBlockConfirmation(transactionReceipt);
          } catch {
            // Receipt may lag slightly behind the smart-wallet client resolution.
          }
        }

        return transactionHash;
      }

      notificationId = notification.loading(
        <TxnNotification message="Waiting for transaction to complete." blockExplorerLink={blockExplorerTxURL} />,
      );

      transactionReceipt = await publicClient.waitForTransactionReceipt({
        hash: transactionHash,
        confirmations: options?.blockConfirmations,
      });
      notification.remove(notificationId);

      if (transactionReceipt.status === "reverted") throw new Error("Transaction reverted");

      notification.success(
        <TxnNotification message="Transaction completed successfully!" blockExplorerLink={blockExplorerTxURL} />,
        {
          icon: "🎉",
        },
      );

      queryClient.invalidateQueries();

      if (options?.onBlockConfirmation) options.onBlockConfirmation(transactionReceipt);
    } catch (error: any) {
      if (notificationId) {
        notification.remove(notificationId);
      }
      console.error("⚡️ ~ file: useTransactor.ts ~ error", error);
      const message = getParsedError(error);

      // if receipt was reverted, show notification with block explorer link and return error
      if (transactionReceipt?.status === "reverted") {
        notification.error(<TxnNotification message={message} blockExplorerLink={blockExplorerTxURL} />);
        throw error;
      }

      notification.error(message);
      throw error;
    }

    return transactionHash;
  };

  return result;
};
