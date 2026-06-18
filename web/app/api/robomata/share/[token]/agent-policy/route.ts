import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataAgentMutationsEnabled,
  isRobomataAgentsEnabled,
  isRobomataLenderAgentAppointmentEnabled,
  isRobomataShareLinksEnabled,
  isRobomataWorkflowServerEnabled,
} from "~~/lib/featureFlags";
import type { RobomataAgentPolicy } from "~~/lib/robomata/agents";
import { RobomataAgentPolicyRevokedMutationError, getRobomataAgentStore } from "~~/lib/robomata/server/agentStore";
import { shareLinkHasMonitoringMetadata } from "~~/lib/robomata/server/sharedLenderPacket";
import {
  getSubmissionShareLinkStore,
  hashShareLinkMetadataValue,
} from "~~/lib/robomata/server/submissionShareLinkStore";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import type { SubmissionShareLink } from "~~/lib/robomata/shareLinks";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";

export const runtime = "nodejs";

function noStoreResponse(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

function requireLenderAppointment(readonly = false) {
  if (!isRobomataWorkflowServerEnabled()) {
    return noStoreResponse({ error: "Robomata workflow is not enabled." }, { status: 404 });
  }
  if (!isRobomataShareLinksEnabled()) {
    return noStoreResponse({ error: "Robomata lender packet sharing is not enabled." }, { status: 404 });
  }
  if (!isRobomataAgentsEnabled()) {
    return noStoreResponse({ error: "Robomata agents are not enabled." }, { status: 404 });
  }
  if (!isRobomataLenderAgentAppointmentEnabled()) {
    return noStoreResponse({ error: "Lender agent appointment is not enabled." }, { status: 404 });
  }
  if (!readonly && !isRobomataAgentMutationsEnabled()) {
    return noStoreResponse({ error: "Robomata agent mutations are not enabled." }, { status: 403 });
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

function serializeLenderAgentPolicy(policy: RobomataAgentPolicy | null) {
  if (!policy) return null;

  return {
    appointedAgentName: policy.appointedAgentName,
    appointedAt: policy.appointedAt,
    appointedBy: policy.appointedBy,
    appointmentAuthorizationId: policy.appointmentAuthorizationId,
    appointmentAuthorizationSurface: policy.appointmentAuthorizationSurface,
    id: policy.id,
    revocationAuthorizationSurface: policy.revocationAuthorizationSurface,
    revocationReason: policy.revocationReason,
    revokedAt: policy.revokedAt,
    revokedBy: policy.revokedBy,
    status: policy.status,
    updatedAt: policy.updatedAt,
  };
}

function serializeAppointmentFlags() {
  return {
    agentsEnabled: isRobomataAgentsEnabled(),
    lenderAppointmentEnabled: isRobomataLenderAgentAppointmentEnabled(),
    mutationsEnabled: isRobomataAgentMutationsEnabled(),
    shareLinksEnabled: isRobomataShareLinksEnabled(),
  };
}

export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  try {
    const featureError = requireLenderAppointment(true);
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

    const policy = await getRobomataAgentStore().getPolicy(result.submission.id, result.submission.partnerAddress);

    return noStoreResponse({
      appointmentFlags: serializeAppointmentFlags(),
      policy: serializeLenderAgentPolicy(policy),
    });
  } catch (error) {
    return noStoreResponse(
      { error: error instanceof Error ? error.message : "Failed to load lender agent appointment." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  try {
    const featureError = requireLenderAppointment(false);
    if (featureError) return featureError;

    const { token } = await context.params;
    const result = await loadAuthorizedShare(token);
    if ("error" in result) return result.error;

    const body = (await request.json().catch(() => ({}))) as {
      appointedAgentName?: unknown;
      revocationReason?: unknown;
      status?: unknown;
    };
    const isRevocation = body.status === "revoked";
    if (!isRevocation && (typeof body.appointedAgentName !== "string" || !body.appointedAgentName.trim())) {
      return noStoreResponse({ error: "appointedAgentName is required." }, { status: 400 });
    }
    if (body.status !== undefined && !isRevocation) {
      return noStoreResponse({ error: "Invalid lender appointment status." }, { status: 400 });
    }

    const accessedShareLink = await getSubmissionShareLinkStore().recordAccess(
      result.shareLink,
      buildAccessMetadata(request),
    );
    if (!accessedShareLink) {
      return noStoreResponse({ error: "Share link is no longer active." }, { status: 410 });
    }

    const existingPolicy = await getRobomataAgentStore().getPolicy(
      result.submission.id,
      result.submission.partnerAddress,
    );
    if (existingPolicy?.status === "revoked") {
      return noStoreResponse({ error: "The current agent appointment has already been revoked." }, { status: 409 });
    }
    const isExistingLenderAppointment =
      existingPolicy?.appointedBy === "lender" &&
      existingPolicy.appointmentAuthorizationSurface === "protected_lender_share_link";
    const isOwnedLenderAppointment =
      isExistingLenderAppointment && existingPolicy.appointmentAuthorizationId === accessedShareLink.id;
    if (!isRevocation && isExistingLenderAppointment && !isOwnedLenderAppointment) {
      return noStoreResponse(
        { error: "This protected lender share link cannot update the current agent appointment." },
        { status: 403 },
      );
    }
    if (isRevocation && !isOwnedLenderAppointment) {
      return noStoreResponse(
        { error: "This protected lender share link cannot revoke the current agent appointment." },
        { status: 403 },
      );
    }

    const policy = await getRobomataAgentStore().updatePolicy({
      submission: result.submission,
      ...(isRevocation
        ? {}
        : {
            appointedAgentName: body.appointedAgentName,
            appointedBy: "lender" as const,
            appointerAddress: lenderAuthorizationId(accessedShareLink),
            appointmentAuthorizationId: accessedShareLink.id,
            appointmentAuthorizationSurface: "protected_lender_share_link" as const,
          }),
      revocationAuthorizationSurface: isRevocation ? "protected_lender_share_link" : undefined,
      revocationReason: body.revocationReason,
      revokedBy: isRevocation ? lenderAuthorizationId(accessedShareLink) : undefined,
      status: isRevocation ? "revoked" : undefined,
      ...(isExistingLenderAppointment ? {} : { autoApproveActionTypes: [] }),
    });

    return noStoreResponse({
      appointmentFlags: serializeAppointmentFlags(),
      policy: serializeLenderAgentPolicy(policy),
    });
  } catch (error) {
    if (error instanceof RobomataAgentPolicyRevokedMutationError) {
      return noStoreResponse({ error: error.message }, { status: 409 });
    }
    return noStoreResponse(
      { error: error instanceof Error ? error.message : "Failed to update lender agent appointment." },
      { status: 500 },
    );
  }
}
