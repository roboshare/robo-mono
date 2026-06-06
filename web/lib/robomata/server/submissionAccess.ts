import { NextRequest, NextResponse } from "next/server";
import { PrivyClient } from "@privy-io/server-auth";
import {
  type Address,
  type Chain,
  createPublicClient,
  fallback,
  http,
  isAddress,
  verifyMessage as verifyEoaMessage,
} from "viem";
import { ROBOMATA_AUTH_HEADERS, ROBOMATA_AUTH_MAX_AGE_MS, buildRobomataAuthMessage } from "~~/lib/robomata/auth";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";
import scaffoldConfig, { type ScaffoldConfig } from "~~/scaffold.config";
import { getDeployedContract } from "~~/utils/contracts";
import { getAlchemyHttpUrl, getInfuraHttpUrl } from "~~/utils/scaffold-eth";

const PARTNER_AUTH_CACHE_MS = 60_000;
const partnerAuthorizationCache = new Map<string, { authorized: boolean; expiresAt: number }>();
let privyClient: PrivyClient | null | undefined;

function getAuthorizedPartnerAddresses(): Set<string> {
  return new Set(
    (process.env.ROBOMATA_AUTHORIZED_PARTNER_ADDRESSES ?? "")
      .split(",")
      .map(address => address.trim().toLowerCase())
      .filter(Boolean),
  );
}

function getConfiguredChain(chainId: string | null) {
  if (!chainId) return null;
  const parsedChainId = Number.parseInt(chainId, 10);
  if (!Number.isInteger(parsedChainId)) return null;

  const chain = scaffoldConfig.targetNetworks.find(targetNetwork => targetNetwork.id === parsedChainId) as
    | Chain
    | undefined;
  return chain ?? null;
}

function getVerificationClient(chainId: string | null) {
  const chain = getConfiguredChain(chainId);
  if (!chain) return undefined;

  const rpcFallbacks = [];
  const infuraHttpUrl = getInfuraHttpUrl(chain.id);
  const alchemyHttpUrl = getAlchemyHttpUrl(chain.id);
  const rpcOverrideUrl = (scaffoldConfig.rpcOverrides as ScaffoldConfig["rpcOverrides"])?.[chain.id];
  if (infuraHttpUrl) {
    rpcFallbacks.push(http(infuraHttpUrl));
  }
  if (alchemyHttpUrl) {
    rpcFallbacks.push(http(alchemyHttpUrl));
  }
  if (rpcOverrideUrl) {
    rpcFallbacks.push(http(rpcOverrideUrl));
  }
  rpcFallbacks.push(http());

  return createPublicClient({
    chain,
    transport: fallback(rpcFallbacks),
  });
}

function canUseLocalPartnerAllowlist() {
  return process.env.NODE_ENV === "development";
}

function getPrivyAppId() {
  return process.env.PRIVY_APP_ID ?? process.env.NEXT_PUBLIC_PRIVY_APP_ID;
}

function getPrivyClient() {
  if (privyClient !== undefined) return privyClient;

  const appId = getPrivyAppId();
  const appSecret = process.env.PRIVY_APP_SECRET;
  privyClient = appId && appSecret ? new PrivyClient(appId, appSecret) : null;
  return privyClient;
}

function getPrivyAccessToken(request: NextRequest): string | null {
  const authorizationHeader = request.headers.get("authorization")?.trim();
  if (authorizationHeader?.toLowerCase().startsWith("bearer ")) {
    return authorizationHeader.slice("bearer ".length).trim() || null;
  }

  return request.cookies.get("privy-token")?.value?.trim() || null;
}

type PrivyUser = Awaited<ReturnType<PrivyClient["getUser"]>>;

function accountAddress(account: unknown): string | null {
  if (!account || typeof account !== "object") return null;
  const address = (account as { address?: unknown }).address;
  return typeof address === "string" && isAddress(address) ? address.toLowerCase() : null;
}

function userHasAddress(user: PrivyUser, type: "smart_wallet" | "wallet", address: string): boolean {
  const normalizedAddress = address.toLowerCase();
  const directAccount = type === "smart_wallet" ? accountAddress(user.smartWallet) : accountAddress(user.wallet);
  if (directAccount === normalizedAddress) return true;

  return user.linkedAccounts.some(account => {
    const linkedType = (account as { type?: unknown }).type;
    if (linkedType !== type) return false;
    return accountAddress(account) === normalizedAddress;
  });
}

async function verifyPrivyWalletOwnership({
  partnerAddress,
  request,
  signerAddress,
}: {
  partnerAddress: string;
  request: NextRequest;
  signerAddress: string;
}): Promise<boolean> {
  if (canUseLocalPartnerAllowlist() && partnerAddress.toLowerCase() === signerAddress.toLowerCase()) return true;

  const client = getPrivyClient();
  const accessToken = getPrivyAccessToken(request);
  if (!client || !accessToken) return false;

  try {
    const claims = await client.verifyAuthToken(accessToken);
    const user = await client.getUser(claims.userId);
    if (user.id !== claims.userId) return false;

    const signerIsLinkedAccount =
      userHasAddress(user, "wallet", signerAddress) || userHasAddress(user, "smart_wallet", signerAddress);
    const partnerIsLinkedAccount =
      userHasAddress(user, "smart_wallet", partnerAddress) || userHasAddress(user, "wallet", partnerAddress);

    return signerIsLinkedAccount && partnerIsLinkedAccount;
  } catch {
    return false;
  }
}

async function isPartnerAuthorizedOnchain(chainId: string | null, partnerAddress: string): Promise<boolean | null> {
  if (!isAddress(partnerAddress)) return false;

  const chain = getConfiguredChain(chainId);
  if (!chain) return null;

  const partnerManager = getDeployedContract(chain.id, "PartnerManager");
  if (!partnerManager) return null;

  const normalizedPartnerAddress = partnerAddress.toLowerCase();
  const cacheKey = `${chain.id}:${partnerManager.address.toLowerCase()}:${normalizedPartnerAddress}`;
  const cached = partnerAuthorizationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.authorized;

  const client = getVerificationClient(chainId);
  if (!client) return null;

  try {
    const authorized = Boolean(
      await client.readContract({
        address: partnerManager.address,
        abi: partnerManager.abi,
        functionName: "isAuthorizedPartner",
        args: [partnerAddress as Address],
      }),
    );
    partnerAuthorizationCache.set(cacheKey, { authorized, expiresAt: Date.now() + PARTNER_AUTH_CACHE_MS });
    return authorized;
  } catch {
    return null;
  }
}

function isPartnerAuthorizedByLocalAllowlist(partnerAddress: string): boolean {
  if (!canUseLocalPartnerAllowlist()) return false;
  const authorizedPartners = getAuthorizedPartnerAddresses();
  return authorizedPartners.has(partnerAddress.toLowerCase());
}

async function verifyPartnerSignature({
  chainId,
  message,
  signature,
  signerAddress,
}: {
  chainId: string | null;
  message: string;
  signature: `0x${string}`;
  signerAddress: `0x${string}`;
}) {
  try {
    if (await verifyEoaMessage({ address: signerAddress, message, signature })) {
      return true;
    }
  } catch {
    // Smart-wallet signatures may not be recoverable as EOA signatures.
  }

  const verificationClient = getVerificationClient(chainId);
  if (!verificationClient) return false;

  try {
    return await verificationClient.verifyMessage({
      address: signerAddress,
      message,
      signature,
    });
  } catch {
    return false;
  }
}

async function getVerifiedPartnerAddress(request: NextRequest): Promise<string | null> {
  const chainId = request.headers.get(ROBOMATA_AUTH_HEADERS.chainId)?.trim() ?? null;
  const method = request.headers.get(ROBOMATA_AUTH_HEADERS.method)?.trim().toUpperCase();
  const path = request.headers.get(ROBOMATA_AUTH_HEADERS.path)?.trim();
  const partnerAddress = request.headers.get(ROBOMATA_AUTH_HEADERS.partnerAddress)?.trim();
  const signerAddress = request.headers.get(ROBOMATA_AUTH_HEADERS.signerAddress)?.trim() ?? partnerAddress;
  const signature = request.headers.get(ROBOMATA_AUTH_HEADERS.signature)?.trim();
  const timestamp = request.headers.get(ROBOMATA_AUTH_HEADERS.timestamp)?.trim();

  if (!method || !path || !partnerAddress || !signerAddress || !signature || !timestamp || !isAddress(partnerAddress)) {
    return null;
  }
  if (method !== request.method.toUpperCase()) return null;
  if (path !== request.nextUrl.pathname) return null;
  if (!isAddress(signerAddress)) return null;

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > ROBOMATA_AUTH_MAX_AGE_MS) return null;

  const hasPrivyOwnership = await verifyPrivyWalletOwnership({ partnerAddress, request, signerAddress });
  if (!hasPrivyOwnership) return null;

  let valid = false;
  try {
    valid = await verifyPartnerSignature({
      chainId,
      message: buildRobomataAuthMessage({
        chainId: chainId ?? undefined,
        method,
        partnerAddress,
        path,
        signerAddress,
        timestamp,
      }),
      signature: signature as `0x${string}`,
      signerAddress: signerAddress as `0x${string}`,
    });
  } catch {
    return null;
  }

  return valid ? partnerAddress : null;
}

export async function requirePartnerAddress(request: NextRequest): Promise<string | NextResponse> {
  const partnerAddress = await getVerifiedPartnerAddress(request);

  if (!partnerAddress) {
    return NextResponse.json({ error: "Missing or invalid partner authorization." }, { status: 401 });
  }

  const chainId = request.headers.get(ROBOMATA_AUTH_HEADERS.chainId)?.trim() ?? null;
  const isAuthorizedPartner = await isPartnerAuthorizedOnchain(chainId, partnerAddress);

  if (isAuthorizedPartner === true) return partnerAddress;

  if (isAuthorizedPartner === null) {
    if (isPartnerAuthorizedByLocalAllowlist(partnerAddress)) return partnerAddress;

    return NextResponse.json(
      { error: "Unable to verify partner authorization against PartnerManager." },
      { status: 403 },
    );
  }

  return NextResponse.json({ error: "Wallet is not authorized for Robomata submissions." }, { status: 403 });
}

export function requireSubmissionAccess(submission: FacilitySubmission, partnerAddress: string): NextResponse | null {
  if (submission.partnerAddress.toLowerCase() !== partnerAddress.toLowerCase()) {
    return NextResponse.json({ error: "Submission not found." }, { status: 404 });
  }

  return null;
}

export function requireSubmissionMutable(submission: FacilitySubmission): NextResponse | null {
  if (submission.evidenceCommit.status === "committed") {
    return NextResponse.json(
      { error: "Evidence is already committed for this submission. Create a new submission for further changes." },
      { status: 409 },
    );
  }

  if (submission.evidenceCommit.status === "committing") {
    return NextResponse.json(
      { error: "Evidence commit is in progress for this submission. Try again after it completes." },
      { status: 409 },
    );
  }

  return null;
}
