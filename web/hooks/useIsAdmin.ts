"use client";

import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";

// DEFAULT_ADMIN_ROLE is bytes32(0) in AccessControl
const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

/**
 * Hook to check if the connected wallet has DEFAULT_ADMIN_ROLE in the PartnerManager contract.
 * Returns { isAdmin: boolean, isLoading: boolean, isConnected: boolean }
 */
export function useIsAdmin() {
  const { connectedAddress } = useTransactingAccount();
  const isConnected = !!connectedAddress;

  const {
    data: hasRole,
    isFetched,
    isSuccess,
  } = useScaffoldReadContract({
    contractName: "PartnerManager",
    functionName: "hasRole",
    args: [DEFAULT_ADMIN_ROLE, connectedAddress],
    query: {
      enabled: isConnected && !!connectedAddress,
      staleTime: 30000, // Cache for 30 seconds to prevent refetch flicker
    },
  });

  // Consider loading until we have a successful fetch with defined result
  // This prevents redirect during the brief undefined state
  const isLoading = isConnected && !!connectedAddress && (!isFetched || !isSuccess || hasRole === undefined);

  return {
    isAdmin: hasRole === true,
    isLoading,
    isConnected,
  };
}
