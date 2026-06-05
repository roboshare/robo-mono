"use client";

import { useCallback, useRef } from "react";
import { useSignMessage } from "wagmi";
import { ROBOMATA_AUTH_HEADERS, ROBOMATA_AUTH_MAX_AGE_MS, buildRobomataAuthMessage } from "~~/lib/robomata/auth";

type CachedAuthHeaders = {
  expiresAt: number;
  headers: Record<string, string>;
  partnerAddress: string;
  signerAddress: string;
};

const CLIENT_AUTH_CACHE_MS = ROBOMATA_AUTH_MAX_AGE_MS - 30_000;

export function useRobomataApiAuth(partnerAddress?: string) {
  const { signMessageAsync } = useSignMessage();
  const cacheRef = useRef<CachedAuthHeaders | null>(null);

  return useCallback(
    async (signerAddress = partnerAddress) => {
      if (!partnerAddress) throw new Error("Connect a partner wallet before accessing Robomata submissions.");
      if (!signerAddress) throw new Error("Connect a signing wallet before accessing Robomata submissions.");

      const cached = cacheRef.current;
      const normalizedPartnerAddress = partnerAddress.toLowerCase();
      const normalizedSignerAddress = signerAddress.toLowerCase();

      if (
        cached &&
        cached.partnerAddress.toLowerCase() === normalizedPartnerAddress &&
        cached.signerAddress.toLowerCase() === normalizedSignerAddress &&
        cached.expiresAt > Date.now()
      ) {
        return cached.headers;
      }

      const timestamp = Date.now().toString();
      const signature = await signMessageAsync({
        message: buildRobomataAuthMessage({ partnerAddress, signerAddress, timestamp }),
      });
      const headers = {
        [ROBOMATA_AUTH_HEADERS.partnerAddress]: partnerAddress,
        [ROBOMATA_AUTH_HEADERS.signerAddress]: signerAddress,
        [ROBOMATA_AUTH_HEADERS.signature]: signature,
        [ROBOMATA_AUTH_HEADERS.timestamp]: timestamp,
      };

      cacheRef.current = {
        expiresAt: Date.now() + CLIENT_AUTH_CACHE_MS,
        headers,
        partnerAddress,
        signerAddress,
      };

      return headers;
    },
    [partnerAddress, signMessageAsync],
  );
}
