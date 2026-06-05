const enabledValues = new Set(["1", "true", "yes", "on"]);

function isEnabled(value: string | undefined): boolean {
  return enabledValues.has((value ?? "").trim().toLowerCase());
}

export function isRobomataWorkflowEnabled(): boolean {
  return isEnabled(process.env.NEXT_PUBLIC_ENABLE_ROBOMATA_WORKFLOW);
}

export function isRobomataWorkflowServerEnabled(): boolean {
  return isEnabled(process.env.ROBOMATA_WORKFLOW_ENABLED);
}

export function isRobomataWorkflowMutationEnabled(): boolean {
  return isEnabled(process.env.ROBOMATA_WORKFLOW_MUTATIONS_ENABLED);
}
