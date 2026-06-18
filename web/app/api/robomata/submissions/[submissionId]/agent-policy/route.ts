import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataAgentMutationsEnabled,
  isRobomataAgentsEnabled,
  isRobomataWorkflowServerEnabled,
} from "~~/lib/featureFlags";
import { getRobomataAgentStore } from "~~/lib/robomata/server/agentStore";
import { requirePartnerAddress, requireSubmissionAccess } from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";

export const runtime = "nodejs";

function requireRobomataAgents() {
  if (isRobomataWorkflowServerEnabled() && isRobomataAgentsEnabled()) return null;
  return NextResponse.json({ error: "Robomata agents are not enabled." }, { status: 404 });
}

function requireAgentMutations() {
  if (isRobomataAgentMutationsEnabled()) return null;
  return NextResponse.json({ error: "Robomata agent mutations are not enabled." }, { status: 403 });
}

async function loadAuthorizedSubmission(request: NextRequest, submissionId: string) {
  const partnerAddress = await requirePartnerAddress(request);
  if (partnerAddress instanceof NextResponse) return { error: partnerAddress };

  const submission = await getSubmissionStore().get(submissionId);
  if (!submission) return { error: NextResponse.json({ error: "Submission not found." }, { status: 404 }) };

  const accessError = requireSubmissionAccess(submission, partnerAddress);
  if (accessError) return { error: accessError };

  return { partnerAddress, submission };
}

export async function GET(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
  try {
    const featureError = requireRobomataAgents();
    if (featureError) return featureError;

    const { submissionId } = await context.params;
    const result = await loadAuthorizedSubmission(request, submissionId);
    if (result.error) return result.error;

    const policy = await getRobomataAgentStore().getOrCreateDefaultPolicy(result.submission);
    return NextResponse.json({ policy });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load Robomata agent policy." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
  try {
    const featureError = requireRobomataAgents();
    if (featureError) return featureError;
    const mutationError = requireAgentMutations();
    if (mutationError) return mutationError;

    const { submissionId } = await context.params;
    const result = await loadAuthorizedSubmission(request, submissionId);
    if (result.error) return result.error;

    const body = (await request.json().catch(() => ({}))) as {
      allowedActionTypes?: unknown;
      appointedAgentName?: unknown;
      autoApproveActionTypes?: unknown;
      revocationReason?: unknown;
      status?: unknown;
    };
    const status =
      body.status === "active" || body.status === "paused" || body.status === "revoked" ? body.status : undefined;
    if (body.status !== undefined && !status) {
      return NextResponse.json({ error: "Invalid agent policy status." }, { status: 400 });
    }

    const existingPolicy = await getRobomataAgentStore().getPolicy(
      result.submission.id,
      result.submission.partnerAddress,
    );
    if (existingPolicy?.status === "revoked") {
      return NextResponse.json(
        { error: "Revoked agent policies cannot be mutated through this endpoint." },
        { status: 409 },
      );
    }
    if (
      body.appointedAgentName !== undefined &&
      existingPolicy?.appointedBy === "lender" &&
      existingPolicy.appointmentAuthorizationSurface === "protected_lender_share_link"
    ) {
      return NextResponse.json(
        { error: "Lender-appointed agent names can only be updated through the protected lender share link." },
        { status: 403 },
      );
    }
    const policy = await getRobomataAgentStore().updatePolicy({
      submission: result.submission,
      status,
      allowedActionTypes: body.allowedActionTypes,
      autoApproveActionTypes: body.autoApproveActionTypes,
      appointedAgentName: body.appointedAgentName,
      revocationAuthorizationSurface: status === "revoked" ? "operator_submission_access" : undefined,
      revocationReason: body.revocationReason,
      revokedBy: status === "revoked" ? result.partnerAddress : undefined,
      ...(body.appointedAgentName !== undefined
        ? {
            appointedBy: "operator" as const,
            appointerAddress: result.partnerAddress,
            appointmentAuthorizationId: result.partnerAddress,
            appointmentAuthorizationSurface: "operator_submission_access" as const,
          }
        : {}),
    });

    return NextResponse.json({ policy });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update Robomata agent policy." },
      { status: 500 },
    );
  }
}
