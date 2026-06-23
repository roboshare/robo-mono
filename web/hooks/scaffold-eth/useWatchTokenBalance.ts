import { useEffect } from "react";
import { useTargetNetwork } from "./useTargetNetwork";
import { useQueryClient } from "@tanstack/react-query";
import { Address, erc20Abi } from "viem";
import { useBlockNumber, useReadContract } from "wagmi";

type UseWatchTokenBalanceProps = {
  tokenAddress?: Address;
  ownerAddress?: Address;
  watch?: boolean;
};

export const useWatchTokenBalance = ({ tokenAddress, ownerAddress, watch = true }: UseWatchTokenBalanceProps) => {
  const { targetNetwork } = useTargetNetwork();
  const queryClient = useQueryClient();

  const readContractHookRes = useReadContract({
    chainId: targetNetwork.id,
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: ownerAddress ? [ownerAddress] : undefined,
    query: {
      enabled: !!tokenAddress && !!ownerAddress,
    },
  });

  const { data: blockNumber } = useBlockNumber({
    watch,
    chainId: targetNetwork.id,
    query: {
      enabled: watch,
    },
  });

  useEffect(() => {
    if (watch) {
      queryClient.invalidateQueries({ queryKey: readContractHookRes.queryKey });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockNumber]);

  return readContractHookRes;
};
