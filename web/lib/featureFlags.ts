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

export function isRobomataSuiSponsorshipEnabled(): boolean {
  return isEnabled(process.env.ROBOMATA_SUI_SPONSORSHIP_ENABLED);
}

export function isRobomataPrivySuiWalletBindingEnabled(): boolean {
  return isEnabled(process.env.ROBOMATA_PRIVY_SUI_WALLET_BINDING_ENABLED);
}

export function isRobomataPrivySuiWalletBindingClientEnabled(): boolean {
  return isEnabled(process.env.NEXT_PUBLIC_ROBOMATA_PRIVY_SUI_WALLET_BINDING_ENABLED);
}

export function isRobomataShareLinksEnabled(): boolean {
  return isEnabled(process.env.ROBOMATA_SHARE_LINKS_ENABLED);
}

export function isRobomataShareLinksClientEnabled(): boolean {
  return isEnabled(process.env.NEXT_PUBLIC_ROBOMATA_SHARE_LINKS_ENABLED);
}

export function isRobomataTokenizationEnabled(): boolean {
  return isEnabled(process.env.ROBOMATA_TOKENIZATION_ENABLED);
}

export function isRobomataTokenizationClientEnabled(): boolean {
  return isEnabled(process.env.NEXT_PUBLIC_ROBOMATA_TOKENIZATION_ENABLED);
}

export function isRobomataFacilityMonitoringEnabled(): boolean {
  return isEnabled(process.env.ROBOMATA_FACILITY_MONITORING_ENABLED);
}

export function isRobomataFacilityMonitoringClientEnabled(): boolean {
  return isEnabled(process.env.NEXT_PUBLIC_ROBOMATA_FACILITY_MONITORING_ENABLED);
}

export function isRobomataFacilityMonitoringRefreshEnabled(): boolean {
  return isEnabled(process.env.ROBOMATA_FACILITY_MONITORING_REFRESH_ENABLED);
}

export function isRobomataLenderMonitoringShareEnabled(): boolean {
  return isEnabled(process.env.ROBOMATA_LENDER_MONITORING_SHARE_ENABLED);
}

export function isRobomataLenderMonitoringShareClientEnabled(): boolean {
  return isEnabled(process.env.NEXT_PUBLIC_ROBOMATA_LENDER_MONITORING_SHARE_ENABLED);
}
