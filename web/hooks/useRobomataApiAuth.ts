"use client";

import { useCallback, useRef } from "react";
import { getAccessToken } from "@privy-io/react-auth";
import { useSignMessage } from "wagmi";
import { ROBOMATA_AUTH_HEADERS, ROBOMATA_AUTH_MAX_AGE_MS, buildRobomataAuthMessage } from "~~/lib/robomata/auth";

type CachedAuthHeaders = {
  chainId?: number;
  expiresAt: number;
  headers: Record<string, string>;
  method: string;
  partnerAddress: string;
  path: string;
  signerAddress: string;
};

type RobomataAuthRequest = {
  chainId?: number;
  method?: string;
  path?: string;
  signerAddress?: string;
};

const CLIENT_AUTH_CACHE_MS = ROBOMATA_AUTH_MAX_AGE_MS - 30_000;

async function getPrivyAuthorizationHeader(): Promise<Record<string, string>> {
  const privyAccessToken = await getAccessToken();
  return privyAccessToken ? { authorization: `Bearer ${privyAccessToken}` } : {};
}

export function useRobomataApiAuth(partnerAddress?: string) {
  const { signMessageAsync } = useSignMessage();
  const cacheRef = useRef<CachedAuthHeaders | null>(null);

  return useCallback(
    async (input: RobomataAuthRequest = {}) => {
      if (!partnerAddress) throw new Error("Connect a partner wallet before accessing Robomata submissions.");
      const signerAddress = input.signerAddress ?? partnerAddress;
      if (!signerAddress) throw new Error("Connect a signing wallet before accessing Robomata submissions.");
      const chainId = input.chainId;
      const method = (input.method ?? "GET").toUpperCase();
      const path = input.path ?? "/api/robomata/submissions";

      const cached = cacheRef.current;
      const normalizedPartnerAddress = partnerAddress.toLowerCase();
      const normalizedSignerAddress = signerAddress.toLowerCase();

      if (
        cached &&
        cached.partnerAddress.toLowerCase() === normalizedPartnerAddress &&
        cached.signerAddress.toLowerCase() === normalizedSignerAddress &&
        cached.chainId === chainId &&
        cached.method === method &&
        cached.path === path &&
        cached.expiresAt > Date.now()
      ) {
        return { ...cached.headers, ...(await getPrivyAuthorizationHeader()) };
      }

      const timestamp = Date.now().toString();
      const signature = await signMessageAsync({
        message: buildRobomataAuthMessage({ chainId, method, partnerAddress, path, signerAddress, timestamp }),
      });
      const headers = {
        ...(chainId ? { [ROBOMATA_AUTH_HEADERS.chainId]: chainId.toString() } : {}),
        [ROBOMATA_AUTH_HEADERS.method]: method,
        [ROBOMATA_AUTH_HEADERS.path]: path,
        [ROBOMATA_AUTH_HEADERS.partnerAddress]: partnerAddress,
        [ROBOMATA_AUTH_HEADERS.signerAddress]: signerAddress,
        [ROBOMATA_AUTH_HEADERS.signature]: signature,
        [ROBOMATA_AUTH_HEADERS.timestamp]: timestamp,
      };

      cacheRef.current = {
        chainId,
        expiresAt: Date.now() + CLIENT_AUTH_CACHE_MS,
        headers,
        method,
        partnerAddress,
        path,
        signerAddress,
      };

      return { ...headers, ...(await getPrivyAuthorizationHeader()) };
    },
    [partnerAddress, signMessageAsync],
  );
}
