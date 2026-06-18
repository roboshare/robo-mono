import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataAgentMutationsEnabled,
  isRobomataAgentsEnabled,
  isRobomataWorkflowServerEnabled,
} from "~~/lib/featureFlags";
import type { RobomataAgentActionStatus } from "~~/lib/robomata/agents";
import { RobomataAgentPolicyRevokedMutationError, getRobomataAgentStore } from "~~/lib/robomata/server/agentStore";
import { requirePartnerAddress, requireSubmissionAccess } from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";

export const runtime = "nodejs";

const writableActionStatuses = new Set<RobomataAgentActionStatus>(["approved", "rejected", "completed", "skipped"]);

function requireRobomataAgents() {
  if (isRobomataWorkflowServerEnabled() && isRobomataAgentsEnabled()) return null;
  return NextResponse.json({ error: "Robomata agents are not enabled." }, { status: 404 });
}

function requireAgentMutations() {
  if (isRobomataAgentMutationsEnabled()) return null;
  return NextResponse.json({ error: "Robomata agent mutations are not enabled." }, { status: 403 });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ actionId: string; submissionId: string }> },
) {
  try {
    const featureError = requireRobomataAgents();
    if (featureError) return featureError;
    const mutationError = requireAgentMutations();
    if (mutationError) return mutationError;

    const partnerAddress = await requirePartnerAddress(request);
    if (partnerAddress instanceof NextResponse) return partnerAddress;

    const { actionId, submissionId } = await context.params;
    const submission = await getSubmissionStore().get(submissionId);
    if (!submission) return NextResponse.json({ error: "Submission not found." }, { status: 404 });

    const accessError = requireSubmissionAccess(submission, partnerAddress);
    if (accessError) return accessError;

    const body = (await request.json().catch(() => ({}))) as { decisionReason?: unknown; status?: unknown };
    if (typeof body.status !== "string" || !writableActionStatuses.has(body.status as RobomataAgentActionStatus)) {
      return NextResponse.json({ error: "Invalid agent action status." }, { status: 400 });
    }

    const store = getRobomataAgentStore();
    const policy = await store.getPolicy(submission.id, partnerAddress);
    if (policy?.status === "revoked" && ["approved", "completed"].includes(body.status)) {
      return NextResponse.json(
        { error: "Revoked agent policies cannot approve or complete actions." },
        { status: 409 },
      );
    }

    const action = await store.updateAction({
      actionId,
      submissionId,
      partnerAddress,
      status: body.status as "approved" | "rejected" | "completed" | "skipped",
      decisionReason: typeof body.decisionReason === "string" ? body.decisionReason : undefined,
    });
    if (!action) return NextResponse.json({ error: "Agent action not found." }, { status: 404 });

    return NextResponse.json({ action });
  } catch (error) {
    if (error instanceof RobomataAgentPolicyRevokedMutationError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update Robomata agent action." },
      { status: 500 },
    );
  }
}
