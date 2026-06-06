import type { Address, Hash, Hex } from "viem";

export type SmartWalletCall = {
  data?: Hex;
  to?: Address;
  value?: bigint;
};

export type SmartWalletTransactClient = {
  chain?: { id: number };
  switchChain?: (args: { id: number }) => Promise<void>;
  sendTransaction: (params: { calls: readonly SmartWalletCall[] }) => Promise<Hash>;
};

export type GetSmartWalletClientForChain = (chainId: number) => Promise<SmartWalletTransactClient | undefined>;

export async function resolveSmartWalletClientForChain(
  getClientForChain: GetSmartWalletClientForChain,
  chainId: number,
): Promise<SmartWalletTransactClient> {
  const client = await getClientForChain(chainId);
  if (!client) {
    throw new Error(`Smart wallet is not configured for chain ${chainId}`);
  }

  if (client.chain?.id !== chainId) {
    await client.switchChain?.({ id: chainId });
  }

  return client;
}

export async function sendSmartWalletCalls(
  getClientForChain: GetSmartWalletClientForChain,
  chainId: number,
  calls: readonly SmartWalletCall[],
): Promise<Hash> {
  const client = await resolveSmartWalletClientForChain(getClientForChain, chainId);
  return client.sendTransaction({ calls });
}
