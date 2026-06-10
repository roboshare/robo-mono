import { NextRequest, NextResponse } from "next/server";
import { isRobomataShareLinksEnabled, isRobomataWorkflowServerEnabled } from "~~/lib/featureFlags";
import { buildResolvedSharedLenderPacketView } from "~~/lib/robomata/server/sharedLenderPacket";
import {
  getSubmissionShareLinkStore,
  hashShareLinkMetadataValue,
} from "~~/lib/robomata/server/submissionShareLinkStore";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";

export const runtime = "nodejs";

function requireRobomataShareLinks() {
  if (!isRobomataWorkflowServerEnabled()) {
    return NextResponse.json({ error: "Robomata workflow is not enabled." }, { status: 404 });
  }
  if (!isRobomataShareLinksEnabled()) {
    return NextResponse.json({ error: "Robomata lender packet sharing is not enabled." }, { status: 404 });
  }

  return null;
}

function noStoreResponse(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || request.headers.get("x-real-ip")?.trim() || null;
}

function buildAccessMetadata(request: NextRequest) {
  const ip = getClientIp(request);
  const userAgent = request.headers.get("user-agent")?.trim();

  return {
    ...(ip ? { ipHash: hashShareLinkMetadataValue(ip) } : {}),
    ...(userAgent ? { userAgentHash: hashShareLinkMetadataValue(userAgent) } : {}),
  };
}

export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  try {
    const featureError = requireRobomataShareLinks();
    if (featureError) return featureError;

    const { token } = await context.params;
    if (!token?.trim()) {
      return noStoreResponse({ error: "Share token is required." }, { status: 400 });
    }

    const shareLinkStore = getSubmissionShareLinkStore();
    const shareLink = await shareLinkStore.getByToken(token);
    if (!shareLink) {
      return noStoreResponse({ error: "Share link not found." }, { status: 404 });
    }

    if (shareLink.status === "revoked") {
      return noStoreResponse({ error: "Share link has been revoked." }, { status: 410 });
    }
    if (shareLink.status === "expired") {
      return noStoreResponse({ error: "Share link has expired." }, { status: 410 });
    }

    const submission = await getSubmissionStore().get(shareLink.submissionId);
    if (!submission || submission.partnerAddress.toLowerCase() !== shareLink.partnerAddress.toLowerCase()) {
      return noStoreResponse({ error: "Share link not found." }, { status: 404 });
    }

    if (!submission.computation?.lenderPacket) {
      return noStoreResponse(
        { error: "Lender packet is no longer available. Ask the operator to regenerate it." },
        {
          status: 409,
        },
      );
    }

    const accessedShareLink = await shareLinkStore.recordAccess(shareLink, buildAccessMetadata(request));
    if (!accessedShareLink) {
      return noStoreResponse({ error: "Share link is no longer active." }, { status: 410 });
    }

    return noStoreResponse({
      packet: await buildResolvedSharedLenderPacketView({ shareLink: accessedShareLink, submission }),
    });
  } catch (error) {
    return noStoreResponse(
      { error: error instanceof Error ? error.message : "Failed to load lender packet share link." },
      { status: 500 },
    );
  }
}
