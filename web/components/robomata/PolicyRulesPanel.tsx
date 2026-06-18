import {
  ROBOMATA_AGENT_SUPERVISION_POLICY_RULES,
  ROBOMATA_BORROWING_BASE_POLICY_RULES,
  ROBOMATA_DEFAULT_POLICY_VERSION,
  ROBOMATA_PACKET_FRESHNESS_POLICY_RULES,
  type RobomataAgentPolicyRule,
  type RobomataPolicyRule,
} from "~~/lib/robomata/policyRules";

type RuleDisclosureProps<T extends RobomataPolicyRule> = {
  title: string;
  description: string;
  rules: T[];
  badges?: string[];
  renderValue?: (rule: T) => string | undefined;
};

function RuleDisclosure<T extends RobomataPolicyRule>({
  badges = [],
  description,
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
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="badge badge-ghost">{ROBOMATA_DEFAULT_POLICY_VERSION}</span>
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

export function BorrowingBasePolicyDisclosure() {
  return (
    <RuleDisclosure
      title="Borrowing-base eligibility rules"
      description="The current platform-default rules used to compute eligibility, reserves, and exceptions."
      rules={ROBOMATA_BORROWING_BASE_POLICY_RULES}
    />
  );
}

export function PacketFreshnessPolicyDisclosure() {
  return (
    <RuleDisclosure
      title="Packet freshness rules"
      description="The deterministic monitoring rules that classify lender packet freshness."
      rules={ROBOMATA_PACKET_FRESHNESS_POLICY_RULES}
    />
  );
}

export function AgentSupervisionPolicyDisclosure({ allowedActionTypes }: { allowedActionTypes?: string[] }) {
  const allowedActionTypeSet = new Set(allowedActionTypes);

  return (
    <RuleDisclosure
      title="Supervised action proposal rules"
      description="The current deterministic rules that can propose actions. Operators still approve or reject them."
      rules={ROBOMATA_AGENT_SUPERVISION_POLICY_RULES}
      renderValue={(rule: RobomataAgentPolicyRule) =>
        allowedActionTypes ? (allowedActionTypeSet.has(rule.actionType) ? "allowed" : "not allowed") : rule.actionType
      }
    />
  );
}
