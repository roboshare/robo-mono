import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataShareLinksEnabled,
  isRobomataWorkflowMutationEnabled,
  isRobomataWorkflowServerEnabled,
} from "~~/lib/featureFlags";
import { toShareLinkResponse } from "~~/lib/robomata/server/shareLinkResponses";
import { requirePartnerAddress, requireSubmissionAccess } from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionShareLinkStore } from "~~/lib/robomata/server/submissionShareLinkStore";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import { addAuditEvent } from "~~/lib/robomata/submissions";

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

function requireShareLinkMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata submission writes are not enabled." }, { status: 403 });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ submissionId: string; shareLinkId: string }> },
) {
  try {
    const featureError = requireRobomataShareLinks();
    if (featureError) return featureError;
    const mutationError = requireShareLinkMutation();
    if (mutationError) return mutationError;

    const partnerAddress = await requirePartnerAddress(request);
    if (partnerAddress instanceof NextResponse) return partnerAddress;

    const { submissionId, shareLinkId } = await context.params;
    const submissionStore = getSubmissionStore();
    const submission = await submissionStore.get(submissionId);

    if (!submission) {
      return NextResponse.json({ error: "Submission not found." }, { status: 404 });
    }

    const accessError = requireSubmissionAccess(submission, partnerAddress);
    if (accessError) return accessError;

    const body = (await request.json().catch(() => ({}))) as { status?: unknown };
    if (body.status !== "revoked") {
      return NextResponse.json({ error: "Only share-link revocation is supported." }, { status: 400 });
    }

    const shareLink = await getSubmissionShareLinkStore().revoke({ shareLinkId, submissionId, partnerAddress });
    if (!shareLink) {
      return NextResponse.json({ error: "Share link not found." }, { status: 404 });
    }

    addAuditEvent(
      submission,
      "packet_share_revoked",
      `Revoked lender packet share link for ${submission.facilityName}.`,
      {
        shareLinkId: shareLink.id,
      },
    );
    await submissionStore.save(submission).catch(() => undefined);

    return NextResponse.json({ shareLink: toShareLinkResponse(shareLink) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update lender packet share link." },
      { status: 500 },
    );
  }
}
