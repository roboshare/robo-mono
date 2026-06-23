import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataAgentMutationsEnabled,
  isRobomataAgentsEnabled,
  isRobomataWorkflowServerEnabled,
} from "~~/lib/featureFlags";
import {
  RobomataAgentPolicyPausedError,
  RobomataAgentPolicyRevokedError,
  runRobomataAgentForSubmission,
} from "~~/lib/robomata/server/agentRunner";
import { RobomataAgentPolicyRevokedMutationError, getRobomataAgentStore } from "~~/lib/robomata/server/agentStore";
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

    const store = getRobomataAgentStore();
    const [runs, actions] = await Promise.all([
      store.listRuns(result.submission.id, result.partnerAddress),
      store.listActions(result.submission.id, result.partnerAddress),
    ]);
    return NextResponse.json({ actions, runs });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load Robomata agent runs." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
  try {
    const featureError = requireRobomataAgents();
    if (featureError) return featureError;
    const mutationError = requireAgentMutations();
    if (mutationError) return mutationError;

    const { submissionId } = await context.params;
    const result = await loadAuthorizedSubmission(request, submissionId);
    if (result.error) return result.error;

    const body = (await request.json().catch(() => ({}))) as { force?: unknown };
    const runResult = await runRobomataAgentForSubmission({
      submission: result.submission,
      force: body.force === true,
    });

    return NextResponse.json(runResult);
  } catch (error) {
    if (error instanceof RobomataAgentPolicyPausedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof RobomataAgentPolicyRevokedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof RobomataAgentPolicyRevokedMutationError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to run Robomata agent." },
      { status: 500 },
    );
  }
}
