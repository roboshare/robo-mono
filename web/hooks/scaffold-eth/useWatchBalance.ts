import { useEffect } from "react";
import { useTargetNetwork } from "./useTargetNetwork";
import { useQueryClient } from "@tanstack/react-query";
import { UseBalanceParameters, useBalance, useBlockNumber } from "wagmi";

type UseWatchBalanceParameters = UseBalanceParameters & {
  watch?: boolean;
};

/**
 * Wrapper around wagmi's useBalance hook. Set watch=true only for flows that need live balance refreshes.
 */
export const useWatchBalance = ({ watch = false, ...useBalanceParameters }: UseWatchBalanceParameters) => {
  const { targetNetwork } = useTargetNetwork();
  const queryClient = useQueryClient();
  const { data: blockNumber } = useBlockNumber({
    watch,
    chainId: targetNetwork.id,
    query: {
      enabled: watch,
    },
  });
  const { queryKey, ...restUseBalanceReturn } = useBalance(useBalanceParameters);

  useEffect(() => {
    if (!watch) {
      return;
    }

    queryClient.invalidateQueries({ queryKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockNumber]);

  return restUseBalanceReturn;
};
