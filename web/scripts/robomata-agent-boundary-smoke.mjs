#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webDir, "..");

async function readRepoFile(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`${label} missing expected text: ${needle}`);
}

function assertMatchCountAtLeast(source, pattern, expected, label) {
  const count = source.match(pattern)?.length ?? 0;
  if (count < expected) throw new Error(`${label} expected at least ${expected} matches, found ${count}`);
}

const [
  agents,
  agentExecution,
  agentStore,
  agentRunner,
  actionRoute,
  tickRoute,
  runRoute,
  operatorPolicyRoute,
  lenderPolicyRoute,
] = await Promise.all([
  readRepoFile("web/lib/robomata/agents.ts"),
  readRepoFile("web/lib/robomata/server/agentExecution.ts"),
  readRepoFile("web/lib/robomata/server/agentStore.ts"),
  readRepoFile("web/lib/robomata/server/agentRunner.ts"),
  readRepoFile("web/app/api/robomata/submissions/[submissionId]/agent-actions/[actionId]/route.ts"),
  readRepoFile("web/app/api/robomata/agents/tick/route.ts"),
  readRepoFile("web/app/api/robomata/submissions/[submissionId]/agent-runs/route.ts"),
  readRepoFile("web/app/api/robomata/submissions/[submissionId]/agent-policy/route.ts"),
  readRepoFile("web/app/api/robomata/share/[token]/agent-policy/route.ts"),
]);

// Operator-appointed and lender-appointed policies must stay separated by authorization surface.
assertIncludes(operatorPolicyRoute, 'existingPolicy?.appointedBy === "lender"', "operator policy route");
assertIncludes(
  operatorPolicyRoute,
  'existingPolicy.appointmentAuthorizationSurface === "protected_lender_share_link"',
  "operator policy route",
);
assertIncludes(
  operatorPolicyRoute,
  "Lender-appointed agent names can only be updated through the protected lender share link.",
  "operator policy route",
);
assertIncludes(operatorPolicyRoute, 'appointedBy: "operator" as const', "operator policy route");
assertIncludes(
  operatorPolicyRoute,
  'appointmentAuthorizationSurface: "operator_submission_access" as const',
  "operator policy route",
);
assertIncludes(lenderPolicyRoute, "isOwnedLenderAppointment", "lender policy route");
assertIncludes(lenderPolicyRoute, "existingPolicy.appointmentAuthorizationId === accessedShareLink.id", "lender policy route");
assertIncludes(
  lenderPolicyRoute,
  "This protected lender share link cannot update the current agent appointment.",
  "lender policy route",
);
assertIncludes(lenderPolicyRoute, "This protected lender share link cannot revoke the current agent appointment.", "lender policy route");
assertIncludes(lenderPolicyRoute, 'appointedBy: "lender" as const', "lender policy route");
assertIncludes(
  lenderPolicyRoute,
  'appointmentAuthorizationSurface: "protected_lender_share_link" as const',
  "lender policy route",
);

// Revoked appointments must block manual runs, scheduled ticks, approvals, completions, and execution.
assertIncludes(agentRunner, 'if (policy.status === "revoked")', "agent runner");
assertIncludes(runRoute, "RobomataAgentPolicyRevokedError", "manual run route");
assertIncludes(tickRoute, "listRunnablePolicies", "scheduled tick route");
assertIncludes(agentStore, 'policy.status === "active"', "file-store runnable policy filter");
assertIncludes(agentStore, "WHERE status = 'active'", "postgres runnable policy filter");
assertIncludes(actionRoute, 'policy?.status === "revoked" && ["approved", "completed"].includes(body.status)', "action route");
assertIncludes(actionRoute, "Revoked agent policies cannot approve or complete actions.", "action route");
assertIncludes(agentStore, "runRecordRevokedError", "agent store run revocation guard");
assertMatchCountAtLeast(agentStore, /status === "revoked"/g, 6, "agent store revoked-state checks");

// Disallowed action types must be retained as skipped audit records rather than silently dropped.
assertIncludes(agentStore, 'operation: "propose"', "agent store skipped proposal gate");
assertIncludes(agentStore, '? "skipped"', "agent store skipped status assignment");
assertIncludes(agentStore, "permissionDeniedReason", "agent store skipped denial metadata");
assertIncludes(agentStore, 'return status === "skipped" ? "action_skipped" : "action_proposed";', "agent store event mapping");
assertIncludes(agentStore, "...actions.map(action =>", "agent store action event retention");

// Legacy authorization can be backfilled for approve/complete, but execution still fails closed without authorization.
assertIncludes(agentStore, "function authorizationForActionPermission", "agent store legacy authorization helper");
assertIncludes(agentStore, "action.authorization ?? buildAgentActionAuthorization(policy)", "agent store legacy authorization helper");
assertIncludes(agentStore, "function withLegacyActionAuthorization", "agent store legacy action hydrator");
assertIncludes(agentStore, "authorizationBackfilled: true", "agent store legacy action hydrator");
assertIncludes(agents, "This action is missing agent appointment authorization metadata.", "agent permission model");
assertIncludes(agentExecution, "actionAuthorization: input.action.authorization", "agent execution permission check");
assertIncludes(agentExecution, 'operation: "execute"', "agent execution permission check");

// Skipped audit records must remain immutable in both file and Postgres stores.
assertIncludes(agentStore, "Skipped audit actions cannot be changed into executable work.", "agent store skipped immutability");
assertMatchCountAtLeast(
  agentStore,
  /status === "skipped" && input\.status !== "skipped"/g,
  2,
  "file and postgres skipped immutability guards",
);

// Feature-flag-off execution and adapter failures must be retained as auditable records.
assertIncludes(actionRoute, "requireAgentExecution", "action route execution flag gate");
assertIncludes(actionRoute, "Delegated agent execution is disabled by feature flag.", "action route execution flag gate");
assertIncludes(actionRoute, "Robomata advisory execution adapter is disabled by feature flag.", "action route advisory flag gate");
assertIncludes(agentExecution, "failureAudit", "agent execution failure audit");
assertIncludes(agentExecution, "failureReason", "agent execution failure audit");
assertIncludes(actionRoute, "recordActionExecutionAudit", "action route execution failure retention");
assertIncludes(actionRoute, "executionAudit?.status === \"failed\"", "action route execution failure retention");
assertIncludes(agentStore, "action_execution_failed", "agent store execution failure event");
assertIncludes(agentStore, "executionAuditMetadata", "agent store execution audit metadata");

console.log("Robomata delegated agent boundary smoke passed.");
