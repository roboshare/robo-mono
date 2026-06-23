import { createHash } from "node:crypto";
import "server-only";
import { isRobomataAgentAdvisoryExecutionEnabled, isRobomataAgentExecutionEnabled } from "~~/lib/featureFlags";
import {
  type RobomataAgentAction,
  type RobomataAgentActionType,
  type RobomataAgentMetadata,
  type RobomataAgentPolicy,
} from "~~/lib/robomata/agents";
import { assertRobomataAgentActionPermission } from "~~/lib/robomata/server/agentPermissions";

const ADVISORY_EXECUTION_TOOL = "robomata.agent.advisory_audit.v1";
const EXECUTABLE_ACTION_TYPES = new Set<RobomataAgentActionType>(["evidence_review", "sui_root_review"]);

export type RobomataAgentExecutionAudit = {
  completedAt: string;
  executor: string;
  failureReason?: string;
  inputDigest: string;
  outputDigest: string;
  status: "failed" | "succeeded";
  tool: string;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return `0x${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function failureAudit(input: {
  action: RobomataAgentAction;
  completedAt: string;
  executor: string;
  failureReason: string;
  inputDigest: string;
}): RobomataAgentExecutionAudit {
  const output = {
    actionId: input.action.id,
    failureReason: input.failureReason,
    status: "failed",
    tool: ADVISORY_EXECUTION_TOOL,
    type: input.action.type,
  };

  return {
    completedAt: input.completedAt,
    executor: input.executor,
    failureReason: input.failureReason,
    inputDigest: input.inputDigest,
    outputDigest: digest(output),
    status: "failed",
    tool: ADVISORY_EXECUTION_TOOL,
  };
}

export function executionAuditMetadata(audit: RobomataAgentExecutionAudit): RobomataAgentMetadata {
  return {
    executionCompletedAt: audit.completedAt,
    executionExecutor: audit.executor,
    executionFailureReason: audit.failureReason ?? null,
    executionInputDigest: audit.inputDigest,
    executionOutputDigest: audit.outputDigest,
    executionStatus: audit.status,
    executionTool: audit.tool,
  };
}

export async function executeRobomataAgentAction(input: {
  action: RobomataAgentAction;
  executor: string;
  policy: RobomataAgentPolicy;
}): Promise<RobomataAgentExecutionAudit> {
  const completedAt = new Date().toISOString();
  const inputPayload = {
    actionId: input.action.id,
    actionType: input.action.type,
    authorization: input.action.authorization ?? null,
    executor: input.executor,
    policyId: input.policy.id,
    proposedAt: input.action.proposedAt,
    runId: input.action.runId,
    tool: ADVISORY_EXECUTION_TOOL,
  };
  const inputDigest = digest(inputPayload);

  try {
    if (!isRobomataAgentExecutionEnabled()) {
      throw new Error("Delegated agent execution is disabled by feature flag.");
    }
    if (!isRobomataAgentAdvisoryExecutionEnabled()) {
      throw new Error("Robomata advisory execution adapter is disabled by feature flag.");
    }
    if (input.action.status !== "approved") {
      throw new Error("Only approved agent actions can be executed.");
    }
    if (!EXECUTABLE_ACTION_TYPES.has(input.action.type)) {
      throw new Error(`${input.action.type.replace(/_/g, " ")} remains proposal-only in this execution slice.`);
    }

    assertRobomataAgentActionPermission({
      actionAuthorization: input.action.authorization,
      actionType: input.action.type,
      operation: "execute",
      policy: input.policy,
    });

    const output = {
      actionId: input.action.id,
      noStateMutation: true,
      status: "succeeded",
      summary: "Recorded advisory execution audit. No submission, packet, Sui, EVM, or evidence state was mutated.",
      tool: ADVISORY_EXECUTION_TOOL,
      type: input.action.type,
    };

    return {
      completedAt,
      executor: input.executor,
      inputDigest,
      outputDigest: digest(output),
      status: "succeeded",
      tool: ADVISORY_EXECUTION_TOOL,
    };
  } catch (error) {
    return failureAudit({
      action: input.action,
      completedAt,
      executor: input.executor,
      failureReason: error instanceof Error ? error.message : "Robomata agent execution failed.",
      inputDigest,
    });
  }
}

export function isRobomataAgentActionExecutable(type: RobomataAgentActionType): boolean {
  return EXECUTABLE_ACTION_TYPES.has(type);
}
