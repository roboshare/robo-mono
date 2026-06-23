import "server-only";
import { isRobomataAgentExecutionEnabled } from "~~/lib/featureFlags";
import {
  type RobomataAgentActionAuthorization,
  type RobomataAgentActionPermissionOperation,
  type RobomataAgentActionType,
  type RobomataAgentPolicy,
  getRobomataAgentActionPermissionDenial,
} from "~~/lib/robomata/agents";

export class RobomataAgentPermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RobomataAgentPermissionDeniedError";
  }
}

export function assertRobomataAgentActionPermission(input: {
  actionAuthorization?: RobomataAgentActionAuthorization;
  actionType: RobomataAgentActionType;
  operation: RobomataAgentActionPermissionOperation;
  policy: RobomataAgentPolicy;
}) {
  const denial = getRobomataAgentActionPermissionDenial({
    ...input,
    executionEnabled: input.operation === "execute" ? isRobomataAgentExecutionEnabled() : undefined,
  });
  if (denial) throw new RobomataAgentPermissionDeniedError(denial);
}
