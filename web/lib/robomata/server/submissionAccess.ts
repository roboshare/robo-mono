import { NextRequest, NextResponse } from "next/server";
import { type Chain, createPublicClient, fallback, http, isAddress, verifyMessage as verifyEoaMessage } from "viem";
import { ROBOMATA_AUTH_HEADERS, ROBOMATA_AUTH_MAX_AGE_MS, buildRobomataAuthMessage } from "~~/lib/robomata/auth";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";
import scaffoldConfig, { type ScaffoldConfig } from "~~/scaffold.config";
import { getAlchemyHttpUrl } from "~~/utils/scaffold-eth";

function getAuthorizedPartnerAddresses(): Set<string> {
  return new Set(
    (process.env.ROBOMATA_AUTHORIZED_PARTNER_ADDRESSES ?? "")
      .split(",")
      .map(address => address.trim().toLowerCase())
      .filter(Boolean),
  );
}

function getAuthorizedSignerAddress(partnerAddress: string): string {
  const rawSignerMap = process.env.ROBOMATA_AUTHORIZED_PARTNER_SIGNERS_JSON;
  if (!rawSignerMap) return partnerAddress;

  try {
    const signerMap = JSON.parse(rawSignerMap) as Record<string, string | undefined>;
    const normalizedSignerMap = Object.fromEntries(
      Object.entries(signerMap)
        .map(([address, signer]) => [address.trim().toLowerCase(), signer?.trim()] as const)
        .filter(([address, signer]) => Boolean(address && signer)),
    ) as Record<string, string | undefined>;

    return normalizedSignerMap[partnerAddress.toLowerCase()] ?? partnerAddress;
  } catch {
    return partnerAddress;
  }
}

function getVerificationClient(chainId: string | null) {
  if (!chainId) return undefined;
  const parsedChainId = Number.parseInt(chainId, 10);
  if (!Number.isInteger(parsedChainId)) return undefined;

  const chain = scaffoldConfig.targetNetworks.find(targetNetwork => targetNetwork.id === parsedChainId) as
    | Chain
    | undefined;
  if (!chain) return undefined;

  const rpcFallbacks = [];
  const alchemyHttpUrl = getAlchemyHttpUrl(chain.id);
  const rpcOverrideUrl = (scaffoldConfig.rpcOverrides as ScaffoldConfig["rpcOverrides"])?.[chain.id];
  if (alchemyHttpUrl && !scaffoldConfig.isUsingDefaultAlchemyApiKey) {
    rpcFallbacks.push(http(alchemyHttpUrl));
  }
  if (rpcOverrideUrl) {
    rpcFallbacks.push(http(rpcOverrideUrl));
  }
  rpcFallbacks.push(http());
  if (alchemyHttpUrl && scaffoldConfig.isUsingDefaultAlchemyApiKey) {
    rpcFallbacks.push(http(alchemyHttpUrl));
  }

  return createPublicClient({
    chain,
    transport: fallback(rpcFallbacks),
  });
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
  const authorizedSignerAddress = getAuthorizedSignerAddress(partnerAddress);
  if (authorizedSignerAddress.toLowerCase() !== signerAddress.toLowerCase()) return null;

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > ROBOMATA_AUTH_MAX_AGE_MS) return null;

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

  const authorizedPartners = getAuthorizedPartnerAddresses();
  if (authorizedPartners.size === 0) {
    return NextResponse.json(
      { error: "Robomata partner allowlist is not configured for this environment." },
      { status: 403 },
    );
  }

  if (!authorizedPartners.has(partnerAddress.toLowerCase())) {
    return NextResponse.json({ error: "Wallet is not authorized for Robomata submissions." }, { status: 403 });
  }

  return partnerAddress;
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
