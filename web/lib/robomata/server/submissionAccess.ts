import { NextRequest, NextResponse } from "next/server";
import { isAddress, verifyMessage } from "viem";
import { ROBOMATA_AUTH_HEADERS, ROBOMATA_AUTH_MAX_AGE_MS, buildRobomataAuthMessage } from "~~/lib/robomata/auth";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";

function getAuthorizedPartnerAddresses(): Set<string> {
  return new Set(
    (process.env.ROBOMATA_AUTHORIZED_PARTNER_ADDRESSES ?? "")
      .split(",")
      .map(address => address.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function getVerifiedPartnerAddress(request: NextRequest): Promise<string | null> {
  const partnerAddress = request.headers.get(ROBOMATA_AUTH_HEADERS.partnerAddress)?.trim();
  const signature = request.headers.get(ROBOMATA_AUTH_HEADERS.signature)?.trim();
  const timestamp = request.headers.get(ROBOMATA_AUTH_HEADERS.timestamp)?.trim();

  if (!partnerAddress || !signature || !timestamp || !isAddress(partnerAddress)) return null;

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > ROBOMATA_AUTH_MAX_AGE_MS) return null;

  const valid = await verifyMessage({
    address: partnerAddress,
    message: buildRobomataAuthMessage({ partnerAddress, timestamp }),
    signature: signature as `0x${string}`,
  });

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
