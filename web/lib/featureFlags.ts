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

export function isRobomataWalrusUploadsEnabled(): boolean {
  return isEnabled(process.env.ROBOMATA_WALRUS_UPLOADS_ENABLED);
}

export function isRobomataRealEvidenceStorageRequired(): boolean {
  return isEnabled(process.env.ROBOMATA_REQUIRE_REAL_EVIDENCE_STORAGE);
}

export function isRobomataSuiCommitEnabled(): boolean {
  return isEnabled(process.env.ROBOMATA_SUI_COMMIT_ENABLED);
}

export function isRobomataSuiOperatorCommitEnabled(): boolean {
  return isEnabled(process.env.ROBOMATA_SUI_OPERATOR_COMMIT_ENABLED);
}
