import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Abi, AbiEvent, ExtractAbiEventNames } from "abitype";
import { BlockNumber, GetLogsParameters } from "viem";
import { Config, UsePublicClientReturnType, useBlockNumber, usePublicClient } from "wagmi";
import { useSelectedNetwork } from "~~/hooks/scaffold-eth";
import { useDeployedContractInfo } from "~~/hooks/scaffold-eth";
import { AllowedChainIds } from "~~/utils/scaffold-eth";
import { replacer } from "~~/utils/scaffold-eth/common";
import {
  ContractAbi,
  ContractName,
  UseScaffoldEventHistoryConfig,
  UseScaffoldEventHistoryData,
} from "~~/utils/scaffold-eth/contract";

const DEFAULT_EVENT_HISTORY_BLOCK_RANGE = 50_000n;
const DEFAULT_EVENT_HISTORY_MAX_BLOCKS = 250_000n;

const parsePositiveBigInt = (value: string | undefined, fallback: bigint) => {
  if (!value) return fallback;
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const eventHistoryBlockRange = parsePositiveBigInt(
  process.env.NEXT_PUBLIC_EVENT_HISTORY_BLOCK_RANGE,
  DEFAULT_EVENT_HISTORY_BLOCK_RANGE,
);
const eventHistoryMaxBlocks = parsePositiveBigInt(
  process.env.NEXT_PUBLIC_EVENT_HISTORY_MAX_BLOCKS,
  DEFAULT_EVENT_HISTORY_MAX_BLOCKS,
);

const maxBigInt = (left: bigint, right: bigint) => (left > right ? left : right);
const minBigInt = (left: bigint, right: bigint) => (left < right ? left : right);

const getEvents = async (
  getLogsParams: GetLogsParameters<AbiEvent | undefined, AbiEvent[] | undefined, boolean, BlockNumber, BlockNumber>,
  publicClient?: UsePublicClientReturnType<Config, number>,
  Options?: {
    blockData?: boolean;
    transactionData?: boolean;
    receiptData?: boolean;
    toBlock?: bigint;
  },
) => {
  if (!publicClient) return undefined;

  const fromBlock = typeof getLogsParams.fromBlock === "bigint" ? getLogsParams.fromBlock : 0n;
  const toBlock = Options?.toBlock;
  const logs = [];
  let cursor = fromBlock;

  do {
    const chunkToBlock = toBlock ? minBigInt(cursor + eventHistoryBlockRange - 1n, toBlock) : undefined;
    const chunkLogs = await publicClient.getLogs({
      address: getLogsParams.address,
      fromBlock: cursor,
      ...(chunkToBlock ? { toBlock: chunkToBlock } : {}),
      args: getLogsParams.args,
      event: getLogsParams.event,
    });
    logs.push(...chunkLogs);

    if (!toBlock || chunkToBlock === undefined || chunkToBlock >= toBlock) break;
    cursor = chunkToBlock + 1n;
  } while (cursor <= toBlock);

  const finalEvents = await Promise.all(
    logs.map(async log => {
      return {
        ...log,
        blockData:
          Options?.blockData && log.blockHash ? await publicClient?.getBlock({ blockHash: log.blockHash }) : null,
        transactionData:
          Options?.transactionData && log.transactionHash
            ? await publicClient?.getTransaction({ hash: log.transactionHash })
            : null,
        receiptData:
          Options?.receiptData && log.transactionHash
            ? await publicClient?.getTransactionReceipt({ hash: log.transactionHash })
            : null,
      };
    }),
  );

  return finalEvents;
};

/**
 * Reads events from a deployed contract
 * @param config - The config settings
 * @param config.contractName - deployed contract name
 * @param config.eventName - name of the event to listen for
 * @param config.fromBlock - the block number to start reading events from
 * @param config.chainId - optional chainId that is configured with the scaffold project to make use for multi-chain interactions.
 * @param config.filters - filters to be applied to the event (parameterName: value)
 * @param config.blockData - if set to true it will return the block data for each event (default: false)
 * @param config.transactionData - if set to true it will return the transaction data for each event (default: false)
 * @param config.receiptData - if set to true it will return the receipt data for each event (default: false)
 * @param config.watch - if set to true, the events will be updated every pollingInterval milliseconds set at scaffoldConfig (default: false)
 * @param config.enabled - set this to false to disable the hook from running (default: true)
 */
export const useScaffoldEventHistory = <
  TContractName extends ContractName,
  TEventName extends ExtractAbiEventNames<ContractAbi<TContractName>>,
  TBlockData extends boolean = false,
  TTransactionData extends boolean = false,
  TReceiptData extends boolean = false,
>({
  contractName,
  eventName,
  fromBlock,
  chainId,
  filters,
  blockData,
  transactionData,
  receiptData,
  watch,
  enabled = true,
}: UseScaffoldEventHistoryConfig<TContractName, TEventName, TBlockData, TTransactionData, TReceiptData>) => {
  const selectedNetwork = useSelectedNetwork(chainId);

  const publicClient = usePublicClient({
    chainId: selectedNetwork.id,
  });
  const [isFirstRender, setIsFirstRender] = useState(true);

  const { data: blockNumber } = useBlockNumber({ watch: watch, chainId: selectedNetwork.id });

  const { data: deployedContractData } = useDeployedContractInfo({
    contractName,
    chainId: selectedNetwork.id as AllowedChainIds,
  });

  const event =
    deployedContractData &&
    ((deployedContractData.abi as Abi).find(part => part.type === "event" && part.name === eventName) as AbiEvent);

  const isContractAddressAndClientReady = Boolean(deployedContractData?.address) && Boolean(publicClient);

  const query = useInfiniteQuery({
    queryKey: [
      "eventHistory",
      {
        contractName,
        address: deployedContractData?.address,
        eventName,
        fromBlock: fromBlock.toString(),
        chainId: selectedNetwork.id,
        filters: JSON.stringify(filters, replacer),
      },
    ],
    queryFn: async ({ pageParam }) => {
      if (!isContractAddressAndClientReady) return [];
      const latestBlock = blockNumber ?? (await publicClient?.getBlockNumber());
      const boundedFromBlock = latestBlock
        ? maxBigInt(
            pageParam,
            latestBlock > eventHistoryMaxBlocks ? latestBlock - eventHistoryMaxBlocks + 1n : pageParam,
          )
        : pageParam;
      const data = await getEvents(
        { address: deployedContractData?.address, event, fromBlock: boundedFromBlock, args: filters },
        publicClient,
        { blockData, transactionData, receiptData, toBlock: latestBlock },
      );

      return data ?? [];
    },
    enabled: enabled && isContractAddressAndClientReady,
    initialPageParam: fromBlock,
    getNextPageParam: (lastPage, allPages, lastPageParam) => {
      if (!blockNumber || fromBlock >= blockNumber) return undefined;

      const lastPageHighestBlock = Math.max(
        Number(fromBlock),
        ...(lastPage || []).map(event => Number(event.blockNumber || 0)),
      );
      const nextBlock = BigInt(Math.max(Number(lastPageParam), lastPageHighestBlock) + 1);

      if (nextBlock > blockNumber) return undefined;

      return nextBlock;
    },
    select: data => {
      const events = data.pages
        .filter((page): page is NonNullable<typeof page> => Array.isArray(page))
        .flat() as unknown as UseScaffoldEventHistoryData<
        TContractName,
        TEventName,
        TBlockData,
        TTransactionData,
        TReceiptData
      >;

      const sanitizedEvents = (events ?? []).filter(event => event != null);

      return {
        pages: [...sanitizedEvents].reverse(),
        pageParams: data.pageParams,
      };
    },
  });

  useEffect(() => {
    const shouldSkipEffect = !blockNumber || !watch || isFirstRender;
    if (shouldSkipEffect) {
      // skipping on first render, since on first render we should call queryFn with
      // fromBlock value, not blockNumber
      if (isFirstRender) setIsFirstRender(false);
      return;
    }

    query.fetchNextPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockNumber, watch]);

  return {
    data: query.data?.pages,
    status: query.status,
    error: query.error,
    isLoading: query.isLoading,
    isFetchingNewEvent: query.isFetchingNextPage,
    refetch: query.refetch,
  };
};
