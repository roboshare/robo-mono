import {
  ROBOMATA_AGENT_SUPERVISION_POLICY_RULES,
  ROBOMATA_BORROWING_BASE_POLICY_RULES,
  ROBOMATA_DEFAULT_FACILITY_POLICY_ARTIFACT,
  ROBOMATA_EVIDENCE_FRESHNESS_POLICY_RULES,
  ROBOMATA_PACKET_FRESHNESS_POLICY_RULES,
  ROBOMATA_SUI_ROOT_POLICY_RULES,
  type RobomataAgentPolicyRule,
  type RobomataFacilityPolicyArtifact,
  type RobomataPolicyEvaluationSummary,
  type RobomataPolicyRule,
} from "~~/lib/robomata/policyRules";

type RuleDisclosureProps<T extends RobomataPolicyRule> = {
  title: string;
  description: string;
  policyArtifact?: RobomataFacilityPolicyArtifact;
  rules: T[];
  badges?: string[];
  renderValue?: (rule: T) => string | undefined;
};

function RuleDisclosure<T extends RobomataPolicyRule>({
  badges = [],
  description,
  policyArtifact = ROBOMATA_DEFAULT_FACILITY_POLICY_ARTIFACT,
  renderValue,
  rules,
  title,
}: RuleDisclosureProps<T>) {
  return (
    <details className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-4">
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/50">Active policy</div>
            <div className="mt-1 text-sm font-semibold text-base-content">{title}</div>
            <div className="mt-1 text-sm text-base-content/70">{description}</div>
            <div className="mt-2 text-xs text-base-content/50">
              {policyArtifact.name} · {policyArtifact.id}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="badge badge-ghost">{policyArtifact.version}</span>
            <span className="badge badge-ghost">{policyArtifact.scope.replace(/_/g, " ")}</span>
            {badges.map(badge => (
              <span key={badge} className="badge badge-ghost">
                {badge}
              </span>
            ))}
          </div>
        </div>
      </summary>
      <div className="mt-4 grid gap-3">
        {rules.map(rule => {
          const value = renderValue?.(rule) ?? rule.value;

          return (
            <div key={rule.id} className="rounded-2xl border border-base-300 bg-base-100/70 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="text-sm font-semibold text-base-content">{rule.label}</div>
                {value ? <span className="badge badge-outline">{value}</span> : null}
              </div>
              <div className="mt-1 text-sm text-base-content/70">{rule.summary}</div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function evaluationBadgeClass(result: string) {
  if (result === "passed") return "badge-success";
  if (result === "warning") return "badge-warning";
  if (result === "failed") return "badge-error";
  return "badge-ghost";
}

export function PolicyEvaluationSummaryPanel({
  evaluations,
  title = "Policy evaluation detail",
}: {
  evaluations?: RobomataPolicyEvaluationSummary[];
  title?: string;
}) {
  if (!evaluations?.length) return null;

  return (
    <details className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-4">
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/50">{title}</div>
            <div className="mt-1 text-sm text-base-content/70">
              Persisted explainability metadata for deterministic policy rules.
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {evaluations.map(evaluation => (
              <span key={evaluation.ruleSetId} className={`badge ${evaluationBadgeClass(evaluation.result)}`}>
                {evaluation.ruleSetLabel}: {evaluation.result.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        </div>
      </summary>
      <div className="mt-4 space-y-4">
        {evaluations.map(evaluation => (
          <div key={evaluation.ruleSetId} className="rounded-2xl border border-base-300 bg-base-100/70 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-base-content">{evaluation.ruleSetLabel}</div>
                <div className="mt-1 text-xs text-base-content/50">
                  {evaluation.artifactName} · {evaluation.artifactVersion} · evaluated{" "}
                  {new Date(evaluation.evaluatedAt).toLocaleString()}
                </div>
              </div>
              <span className={`badge ${evaluationBadgeClass(evaluation.result)}`}>
                {evaluation.result.replace(/_/g, " ")}
              </span>
            </div>
            <div className="mt-3 grid gap-2">
              {evaluation.rules.map(rule => (
                <div key={rule.ruleId} className="rounded-xl border border-base-300 bg-base-200/40 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="text-sm font-semibold text-base-content">{rule.label}</div>
                    <span className={`badge badge-xs ${evaluationBadgeClass(rule.status)}`}>
                      {rule.status.replace(/_/g, " ")}
                    </span>
                  </div>
                  <div className="mt-1 text-sm text-base-content/70">{rule.detail ?? rule.summary}</div>
                  {rule.subjectIds?.length ? (
                    <div className="mt-2 break-all text-xs text-base-content/50">
                      Subjects: {rule.subjectIds.join(", ")}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

export function BorrowingBasePolicyDisclosure({
  policyArtifact = ROBOMATA_DEFAULT_FACILITY_POLICY_ARTIFACT,
}: {
  policyArtifact?: RobomataFacilityPolicyArtifact;
}) {
  const ruleSet = policyArtifact.ruleSets.borrowingBase;

  return (
    <RuleDisclosure
      title={ruleSet.label}
      description={ruleSet.description}
      policyArtifact={policyArtifact}
      rules={ruleSet.rules ?? ROBOMATA_BORROWING_BASE_POLICY_RULES}
    />
  );
}

export function EvidenceFreshnessPolicyDisclosure({
  policyArtifact = ROBOMATA_DEFAULT_FACILITY_POLICY_ARTIFACT,
}: {
  policyArtifact?: RobomataFacilityPolicyArtifact;
}) {
  const ruleSet = policyArtifact.ruleSets.evidenceFreshness;

  return (
    <RuleDisclosure
      title={ruleSet.label}
      description={ruleSet.description}
      policyArtifact={policyArtifact}
      rules={ruleSet.rules ?? ROBOMATA_EVIDENCE_FRESHNESS_POLICY_RULES}
    />
  );
}

export function PacketFreshnessPolicyDisclosure({
  policyArtifact = ROBOMATA_DEFAULT_FACILITY_POLICY_ARTIFACT,
}: {
  policyArtifact?: RobomataFacilityPolicyArtifact;
}) {
  const ruleSet = policyArtifact.ruleSets.packetFreshness;

  return (
    <RuleDisclosure
      title={ruleSet.label}
      description={ruleSet.description}
      policyArtifact={policyArtifact}
      rules={ruleSet.rules ?? ROBOMATA_PACKET_FRESHNESS_POLICY_RULES}
    />
  );
}

export function SuiRootPolicyDisclosure({
  policyArtifact = ROBOMATA_DEFAULT_FACILITY_POLICY_ARTIFACT,
}: {
  policyArtifact?: RobomataFacilityPolicyArtifact;
}) {
  const ruleSet = policyArtifact.ruleSets.suiRoot;

  return (
    <RuleDisclosure
      title={ruleSet.label}
      description={ruleSet.description}
      policyArtifact={policyArtifact}
      rules={ruleSet.rules ?? ROBOMATA_SUI_ROOT_POLICY_RULES}
      badges={["robomata.monitoring.v1"]}
    />
  );
}

export function AgentSupervisionPolicyDisclosure({
  allowedActionTypes,
  policyArtifact = ROBOMATA_DEFAULT_FACILITY_POLICY_ARTIFACT,
}: {
  allowedActionTypes?: string[];
  policyArtifact?: RobomataFacilityPolicyArtifact;
}) {
  const allowedActionTypeSet = new Set(allowedActionTypes);
  const ruleSet = policyArtifact.ruleSets.agentSupervision;

  return (
    <RuleDisclosure
      title={ruleSet.label}
      description={ruleSet.description}
      policyArtifact={policyArtifact}
      rules={ruleSet.rules ?? ROBOMATA_AGENT_SUPERVISION_POLICY_RULES}
      renderValue={(rule: RobomataAgentPolicyRule) =>
        allowedActionTypes ? (allowedActionTypeSet.has(rule.actionType) ? "allowed" : "not allowed") : rule.actionType
      }
    />
  );
}
