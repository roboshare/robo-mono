import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataAgentRefreshEnabled,
  isRobomataAgentsEnabled,
  isRobomataWorkflowServerEnabled,
} from "~~/lib/featureFlags";
import { runRobomataAgentForSubmission } from "~~/lib/robomata/server/agentRunner";
import { getRobomataAgentStore } from "~~/lib/robomata/server/agentStore";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";

export const runtime = "nodejs";

function requireRobomataAgentTick(request: NextRequest) {
  if (!isRobomataWorkflowServerEnabled() || !isRobomataAgentsEnabled()) {
    return NextResponse.json({ error: "Robomata agents are not enabled." }, { status: 404 });
  }
  if (!isRobomataAgentRefreshEnabled()) {
    return NextResponse.json({ error: "Robomata agent refresh is not enabled." }, { status: 403 });
  }

  const expectedSecret = process.env.ROBOMATA_AGENT_TICK_SECRET?.trim();
  if (!expectedSecret) {
    return NextResponse.json({ error: "ROBOMATA_AGENT_TICK_SECRET is not configured." }, { status: 500 });
  }

  const providedSecret = request.headers.get("x-robomata-agent-tick-secret")?.trim();
  if (!providedSecret || providedSecret !== expectedSecret) {
    return NextResponse.json({ error: "Invalid Robomata agent tick secret." }, { status: 401 });
  }

  return null;
}

export async function POST(request: NextRequest) {
  try {
    const featureError = requireRobomataAgentTick(request);
    if (featureError) return featureError;

    const policies = await getRobomataAgentStore().listRunnablePolicies();
    const results = [];

    for (const policy of policies) {
      const submission = await getSubmissionStore().get(policy.submissionId);
      if (!submission) {
        results.push({
          error: "Submission not found.",
          policyId: policy.id,
          status: "skipped",
          submissionId: policy.submissionId,
        });
        continue;
      }

      try {
        const result = await runRobomataAgentForSubmission({ submission });
        results.push({
          actionCount: result.run.actionCount,
          policyId: policy.id,
          runId: result.run.id,
          status: "completed",
          submissionId: policy.submissionId,
        });
      } catch (error) {
        results.push({
          error: error instanceof Error ? error.message : "Failed to run Robomata agent.",
          policyId: policy.id,
          status: "failed",
          submissionId: policy.submissionId,
        });
      }
    }

    return NextResponse.json({ count: results.length, results });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to tick Robomata agents." },
      { status: 500 },
    );
  }
}
