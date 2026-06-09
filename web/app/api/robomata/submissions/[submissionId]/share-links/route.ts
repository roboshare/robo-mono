import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataShareLinksEnabled,
  isRobomataWorkflowMutationEnabled,
  isRobomataWorkflowServerEnabled,
} from "~~/lib/featureFlags";
import { toShareLinkResponse } from "~~/lib/robomata/server/shareLinkResponses";
import {
  getPrivyUserFromRequest,
  requirePartnerAddress,
  requireSubmissionAccess,
} from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionShareLinkStore } from "~~/lib/robomata/server/submissionShareLinkStore";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import { addAuditEvent } from "~~/lib/robomata/submissions";

export const runtime = "nodejs";

const DEFAULT_SHARE_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_SHARE_LINK_TTL_MS = 90 * 24 * 60 * 60 * 1000;

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

function normalizeExpiry(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return new Date(Date.now() + DEFAULT_SHARE_LINK_TTL_MS).toISOString();
  }

  if (typeof value !== "string") {
    throw new Error("expiresAt must be an ISO timestamp.");
  }

  const expiresAtMs = Date.parse(value);
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error("expiresAt must be an ISO timestamp.");
  }
  if (expiresAtMs <= Date.now()) {
    throw new Error("expiresAt must be in the future.");
  }
  if (expiresAtMs - Date.now() > MAX_SHARE_LINK_TTL_MS) {
    throw new Error("expiresAt must be within 90 days.");
  }

  return new Date(expiresAtMs).toISOString();
}

function normalizeOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const normalized = value.trim();
  return normalized || undefined;
}

async function readCreateShareLinkBody(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new Error("Request body must be a valid JSON object. Use {} for default share-link settings.");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object.");
  }

  return body as {
    expiresAt?: unknown;
    recipientLabel?: unknown;
    recipientEmail?: unknown;
  };
}

export async function GET(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
  const featureError = requireRobomataShareLinks();
  if (featureError) return featureError;

  const partnerAddress = await requirePartnerAddress(request);
  if (partnerAddress instanceof NextResponse) return partnerAddress;

  const { submissionId } = await context.params;
  const submission = await getSubmissionStore().get(submissionId);

  if (!submission) {
    return NextResponse.json({ error: "Submission not found." }, { status: 404 });
  }

  const accessError = requireSubmissionAccess(submission, partnerAddress);
  if (accessError) return accessError;

  const shareLinks = await getSubmissionShareLinkStore().listForSubmission(submission.id, partnerAddress);
  return NextResponse.json({ shareLinks: shareLinks.map(toShareLinkResponse) });
}

export async function POST(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
  try {
    const featureError = requireRobomataShareLinks();
    if (featureError) return featureError;
    const mutationError = requireShareLinkMutation();
    if (mutationError) return mutationError;

    const partnerAddress = await requirePartnerAddress(request);
    if (partnerAddress instanceof NextResponse) return partnerAddress;

    const { submissionId } = await context.params;
    const submissionStore = getSubmissionStore();
    const submission = await submissionStore.get(submissionId);

    if (!submission) {
      return NextResponse.json({ error: "Submission not found." }, { status: 404 });
    }

    const accessError = requireSubmissionAccess(submission, partnerAddress);
    if (accessError) return accessError;

    if (!submission.computation?.lenderPacket) {
      return NextResponse.json({ error: "Compute the lender packet before creating a share link." }, { status: 409 });
    }

    let body: Awaited<ReturnType<typeof readCreateShareLinkBody>>;
    let expiresAt: string;
    let recipientLabel: string | undefined;
    let recipientEmail: string | undefined;
    try {
      body = await readCreateShareLinkBody(request);
      expiresAt = normalizeExpiry(body.expiresAt);
      recipientLabel = normalizeOptionalString(body.recipientLabel, "recipientLabel");
      recipientEmail = normalizeOptionalString(body.recipientEmail, "recipientEmail");
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Invalid share-link fields." },
        { status: 400 },
      );
    }

    const privyUser = await getPrivyUserFromRequest(request).catch(() => null);
    const { shareLink, token } = await getSubmissionShareLinkStore().create({
      submission,
      creatorPartnerAddress: partnerAddress,
      creatorPrivyUserId: privyUser?.id,
      recipientLabel,
      recipientEmail,
      expiresAt,
    });

    addAuditEvent(
      submission,
      "packet_share_created",
      `Created lender packet share link for ${submission.facilityName}.`,
      {
        shareLinkId: shareLink.id,
        expiresAt: shareLink.expiresAt,
        recipientLabel: shareLink.recipientLabel ?? null,
      },
    );
    await submissionStore.save(submission).catch(() => undefined);

    const apiUrl = new URL(`/api/robomata/share/${token}`, request.nextUrl.origin);
    return NextResponse.json(
      { shareLink: toShareLinkResponse(shareLink), token, url: apiUrl.toString(), apiUrl: apiUrl.toString() },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create lender packet share link." },
      { status: 500 },
    );
  }
}
