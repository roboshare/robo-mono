"use client";

import { useState } from "react";
import type { ExtractAbiFunctionNames } from "abitype";
import { encodeFunctionData, erc20Abi } from "viem";
import { useAccount, useWriteContract } from "wagmi";
import { useSelectedNetwork, useTransactor } from "~~/hooks/scaffold-eth";
import { usePaymentToken } from "~~/hooks/usePaymentToken";
import { sendSmartWalletCalls } from "~~/hooks/useSmartWalletTransaction";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import { notification } from "~~/utils/scaffold-eth";
import { TransactorFuncOptions } from "~~/utils/scaffold-eth/contract";

type PaymentTokenWriteFunctionName = ExtractAbiFunctionNames<typeof erc20Abi, "nonpayable" | "payable">;

type PaymentTokenWriteVariables<TFunctionName extends PaymentTokenWriteFunctionName> = {
  functionName: TFunctionName;
  args?: readonly unknown[];
  value?: bigint;
};

export const usePaymentTokenWriteContract = () => {
  const { address: paymentTokenAddress } = usePaymentToken();
  const selectedNetwork = useSelectedNetwork();
  const { chain: accountChain } = useAccount();
  const { chainId: transactingChainId, getSmartWalletClientForChain, isSmartWallet } = useTransactingAccount();
  const writeTx = useTransactor();
  const wagmiWrite = useWriteContract();
  const [isMining, setIsMining] = useState(false);

  const writeContractAsync = async <TFunctionName extends PaymentTokenWriteFunctionName>(
    variables: PaymentTokenWriteVariables<TFunctionName>,
    options?: TransactorFuncOptions,
  ) => {
    if (!paymentTokenAddress) {
      notification.error("Payment token is not configured");
      return;
    }

    if (!accountChain?.id) {
      notification.error("Please connect your wallet");
      return;
    }

    const activeChainId = transactingChainId ?? accountChain.id;

    if (activeChainId !== selectedNetwork.id) {
      notification.error(`Wallet is connected to the wrong network. Please switch to ${selectedNetwork.name}`);
      return;
    }

    try {
      setIsMining(true);
      return await writeTx(() => {
        if (isSmartWallet && getSmartWalletClientForChain) {
          return sendSmartWalletCalls(getSmartWalletClientForChain, activeChainId, [
            {
              to: paymentTokenAddress,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: variables.functionName as never,
                args: variables.args as never,
              } as never),
              value: variables.value,
            },
          ]);
        }

        return wagmiWrite.writeContractAsync({
          abi: erc20Abi,
          address: paymentTokenAddress,
          ...variables,
        } as never);
      }, options);
    } finally {
      setIsMining(false);
    }
  };

  return {
    isMining,
    isPending: wagmiWrite.isPending,
    writeContractAsync,
  };
};
