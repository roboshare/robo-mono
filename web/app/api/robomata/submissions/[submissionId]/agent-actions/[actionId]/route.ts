import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataAgentAdvisoryExecutionEnabled,
  isRobomataAgentExecutionEnabled,
  isRobomataAgentMutationsEnabled,
  isRobomataAgentsEnabled,
  isRobomataWorkflowServerEnabled,
} from "~~/lib/featureFlags";
import type { RobomataAgentAction, RobomataAgentActionStatus } from "~~/lib/robomata/agents";
import { executeRobomataAgentAction } from "~~/lib/robomata/server/agentExecution";
import { RobomataAgentPermissionDeniedError } from "~~/lib/robomata/server/agentPermissions";
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

function requireAgentExecution() {
  if (!isRobomataAgentExecutionEnabled()) {
    return NextResponse.json({ error: "Delegated agent execution is disabled by feature flag." }, { status: 403 });
  }
  if (!isRobomataAgentAdvisoryExecutionEnabled()) {
    return NextResponse.json(
      { error: "Robomata advisory execution adapter is disabled by feature flag." },
      { status: 403 },
    );
  }
  return null;
}

function hasSuccessfulExecutionAudit(action: RobomataAgentAction): boolean {
  return action.status === "completed" && action.metadata?.executionStatus === "succeeded";
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

    const body = (await request.json().catch(() => ({}))) as {
      decisionReason?: unknown;
      execute?: unknown;
      status?: unknown;
    };
    if (typeof body.status !== "string" || !writableActionStatuses.has(body.status as RobomataAgentActionStatus)) {
      return NextResponse.json({ error: "Invalid agent action status." }, { status: 400 });
    }
    const shouldExecute = body.execute === true;
    if (shouldExecute && body.status !== "completed") {
      return NextResponse.json({ error: "Agent execution can only complete approved actions." }, { status: 400 });
    }
    if (shouldExecute) {
      const executionError = requireAgentExecution();
      if (executionError) return executionError;
    }

    const store = getRobomataAgentStore();
    const policy = await store.getPolicy(submission.id, partnerAddress);
    if (policy?.status === "revoked" && ["approved", "completed"].includes(body.status)) {
      return NextResponse.json(
        { error: "Revoked agent policies cannot approve or complete actions." },
        { status: 409 },
      );
    }

    if (shouldExecute && !policy) {
      return NextResponse.json({ error: "Current agent appointment could not be loaded." }, { status: 404 });
    }

    const actionToExecute = shouldExecute ? await store.getAction(submission.id, partnerAddress, actionId) : null;
    if (shouldExecute && !actionToExecute) {
      return NextResponse.json({ error: "Agent action not found." }, { status: 404 });
    }
    if (shouldExecute && actionToExecute && hasSuccessfulExecutionAudit(actionToExecute)) {
      return NextResponse.json({ action: actionToExecute });
    }

    const executionAudit =
      shouldExecute && policy && actionToExecute
        ? await executeRobomataAgentAction({
            action: actionToExecute,
            executor: partnerAddress,
            policy,
          })
        : undefined;

    if (executionAudit?.status === "failed") {
      const auditedAction = await store.recordActionExecutionAudit({
        actionId,
        audit: executionAudit,
        partnerAddress,
        submissionId,
      });
      if (!auditedAction) return NextResponse.json({ error: "Agent action not found." }, { status: 404 });
      return NextResponse.json(
        { action: auditedAction, error: executionAudit.failureReason, execution: executionAudit },
        { status: 409 },
      );
    }

    const action = await store.updateAction({
      actionId,
      submissionId,
      partnerAddress,
      status: body.status as "approved" | "rejected" | "completed" | "skipped",
      decisionReason: typeof body.decisionReason === "string" ? body.decisionReason : undefined,
      executionAudit,
    });
    if (!action) return NextResponse.json({ error: "Agent action not found." }, { status: 404 });

    return NextResponse.json({ action });
  } catch (error) {
    if (error instanceof RobomataAgentPolicyRevokedMutationError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof RobomataAgentPermissionDeniedError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update Robomata agent action." },
      { status: 500 },
    );
  }
}
