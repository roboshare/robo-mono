import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataShareLinksEnabled,
  isRobomataWorkflowMutationEnabled,
  isRobomataWorkflowServerEnabled,
} from "~~/lib/featureFlags";
import { resolveRobomataFacilityPolicyArtifact } from "~~/lib/robomata/policyRules";
import { shareLinkHasMonitoringMetadata } from "~~/lib/robomata/server/sharedLenderPacket";
import {
  getSubmissionShareLinkStore,
  hashShareLinkMetadataValue,
} from "~~/lib/robomata/server/submissionShareLinkStore";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import type { SubmissionShareLink } from "~~/lib/robomata/shareLinks";
import {
  type FacilitySubmission,
  type SubmissionPolicyReview,
  createAuditEvent,
  createSubmissionPolicyReview,
  upsertSubmissionPolicyReview,
} from "~~/lib/robomata/submissions";

export const runtime = "nodejs";

function noStoreResponse(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

function requireLenderPolicyReview(readonly = false) {
  if (!isRobomataWorkflowServerEnabled()) {
    return noStoreResponse({ error: "Robomata workflow is not enabled." }, { status: 404 });
  }
  if (!isRobomataShareLinksEnabled()) {
    return noStoreResponse({ error: "Robomata lender packet sharing is not enabled." }, { status: 404 });
  }
  if (!readonly && !isRobomataWorkflowMutationEnabled()) {
    return noStoreResponse({ error: "Robomata submission writes are not enabled." }, { status: 403 });
  }
  return null;
}

async function loadAuthorizedShare(token: string): Promise<
  | {
      shareLink: SubmissionShareLink;
      submission: FacilitySubmission;
    }
  | { error: NextResponse }
> {
  if (!token?.trim()) {
    return { error: noStoreResponse({ error: "Share token is required." }, { status: 400 }) };
  }

  const shareLink = await getSubmissionShareLinkStore().getByToken(token);
  if (!shareLink) {
    return { error: noStoreResponse({ error: "Share link not found." }, { status: 404 }) };
  }
  if (shareLink.status === "revoked") {
    return { error: noStoreResponse({ error: "Share link has been revoked." }, { status: 410 }) };
  }
  if (shareLink.status === "expired") {
    return { error: noStoreResponse({ error: "Share link has expired." }, { status: 410 }) };
  }

  const submission = await getSubmissionStore().get(shareLink.submissionId);
  if (!submission || submission.partnerAddress.toLowerCase() !== shareLink.partnerAddress.toLowerCase()) {
    return { error: noStoreResponse({ error: "Share link not found." }, { status: 404 }) };
  }

  if (!submission.computation?.lenderPacket && !shareLinkHasMonitoringMetadata(shareLink)) {
    return {
      error: noStoreResponse(
        { error: "Lender packet is no longer available. Ask the operator to regenerate it." },
        { status: 409 },
      ),
    };
  }

  return { shareLink, submission };
}

function lenderAuthorizationId(shareLink: Pick<SubmissionShareLink, "id">) {
  return `lender_share:${shareLink.id}`;
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

function currentArtifactReview(submission: FacilitySubmission): SubmissionPolicyReview | undefined {
  const artifact = resolveRobomataFacilityPolicyArtifact({
    facilityId: submission.facilityMonitoring?.facilityId,
    submissionId: submission.id,
  }).artifact;

  return submission.policyReviews?.find(
    review =>
      review.role === "lender" &&
      review.reviewedArtifactId === artifact.id &&
      review.reviewedArtifactVersion === artifact.version,
  );
}

function normalizeStatus(value: unknown) {
  if (value === "accepted" || value === "needs_changes") return value;
  throw new Error("status must be accepted or needs_changes.");
}

function normalizeRationale(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("rationale must be a string.");
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 500) : undefined;
}

export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  try {
    const featureError = requireLenderPolicyReview(true);
    if (featureError) return featureError;

    const { token } = await context.params;
    const result = await loadAuthorizedShare(token);
    if ("error" in result) return result.error;

    const accessedShareLink = await getSubmissionShareLinkStore().recordAccess(
      result.shareLink,
      buildAccessMetadata(request),
    );
    if (!accessedShareLink) {
      return noStoreResponse({ error: "Share link is no longer active." }, { status: 410 });
    }

    return noStoreResponse({ policyReview: currentArtifactReview(result.submission) ?? null });
  } catch (error) {
    return noStoreResponse(
      { error: error instanceof Error ? error.message : "Failed to load lender policy review." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  try {
    const featureError = requireLenderPolicyReview(false);
    if (featureError) return featureError;

    const { token } = await context.params;
    const result = await loadAuthorizedShare(token);
    if ("error" in result) return result.error;

    const accessedShareLink = await getSubmissionShareLinkStore().recordAccess(
      result.shareLink,
      buildAccessMetadata(request),
    );
    if (!accessedShareLink) {
      return noStoreResponse({ error: "Share link is no longer active." }, { status: 410 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      rationale?: unknown;
      status?: unknown;
    };
    const artifact = resolveRobomataFacilityPolicyArtifact({
      facilityId: result.submission.facilityMonitoring?.facilityId,
      submissionId: result.submission.id,
    }).artifact;
    const review = createSubmissionPolicyReview({
      artifactId: artifact.id,
      artifactName: artifact.name,
      artifactVersion: artifact.version,
      rationale: normalizeRationale(body.rationale),
      reviewedBy: lenderAuthorizationId(accessedShareLink),
      reviewSurface: "protected_lender_share_link",
      role: "lender",
      status: normalizeStatus(body.status),
    });

    upsertSubmissionPolicyReview(result.submission, review);
    result.submission.auditEvents.unshift(
      createAuditEvent(
        "policy_reviewed",
        `Lender ${review.status === "accepted" ? "accepted" : "requested changes to"} policy artifact ${
          artifact.version
        }.`,
        {
          policyArtifactId: artifact.id,
          policyArtifactVersion: artifact.version,
          policyReviewRole: "lender",
          policyReviewStatus: review.status,
          shareLinkId: accessedShareLink.id,
        },
      ),
    );
    const saved = await getSubmissionStore().save(result.submission);

    return noStoreResponse({ policyReview: currentArtifactReview(saved) ?? review });
  } catch (error) {
    return noStoreResponse(
      { error: error instanceof Error ? error.message : "Failed to update lender policy review." },
      { status: 500 },
    );
  }
}
