"use client";

import { useCallback, useEffect, useState } from "react";
import { isRobomataPrivySuiWalletBindingClientEnabled } from "~~/lib/featureFlags";

export type PrivySuiWalletBinding = {
  id: string;
  partnerAddress: string;
  privyUserId: string;
  walletId: string;
  suiAddress: string;
  source: "privy_embedded";
  createdAt: string;
  updatedAt: string;
  lastEnsuredAt: string;
};

type GetAuthHeaders = (input?: {
  chainId?: number;
  method?: string;
  path?: string;
  signerAddress?: string;
}) => Promise<Record<string, string>>;

type UsePrivySuiWalletBindingInput = {
  chainId?: number;
  enabled?: boolean;
  getAuthHeaders: GetAuthHeaders;
  partnerAddress?: string;
  signerAddress?: string;
};

export function usePrivySuiWalletBinding({
  chainId,
  enabled: enabledOverride,
  getAuthHeaders,
  partnerAddress,
  signerAddress,
}: UsePrivySuiWalletBindingInput) {
  const [binding, setBinding] = useState<PrivySuiWalletBinding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isEnsuring, setIsEnsuring] = useState(false);
  const featureEnabled = isRobomataPrivySuiWalletBindingClientEnabled();
  const enabled = Boolean(featureEnabled && enabledOverride !== false && partnerAddress);

  const ensureBinding = useCallback(async () => {
    if (!enabled) return null;

    const path = "/api/robomata/operator-wallets/sui";
    setIsEnsuring(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: await getAuthHeaders({ chainId, method: "POST", path, signerAddress }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        binding?: PrivySuiWalletBinding | null;
        error?: string;
      };
      if (!response.ok || !payload.binding) throw new Error(payload.error ?? "Failed to ensure Privy Sui wallet.");
      setBinding(payload.binding);
      return payload.binding;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Failed to ensure Privy Sui wallet.";
      setError(message);
      return null;
    } finally {
      setIsEnsuring(false);
    }
  }, [chainId, enabled, getAuthHeaders, signerAddress]);

  useEffect(() => {
    if (!enabled) {
      setBinding(null);
      setError(null);
      return;
    }

    void ensureBinding();
  }, [enabled, ensureBinding]);

  return {
    binding,
    error,
    featureEnabled,
    isEnsuring,
    ensureBinding,
  };
}
