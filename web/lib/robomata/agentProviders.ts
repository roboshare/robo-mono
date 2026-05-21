export type AgentProviderName = "mock" | "openai" | "anthropic" | "google" | "disabled";

export type AgentReviewInput = {
  portfolio: {
    operator: string;
  };
  availableBorrowingBaseCents: number;
  exceptionCount: number;
  receivableResults: {
    id: string;
    obligor: string;
    eligible: boolean;
    ineligibleReasons: string[];
  }[];
  evidenceExceptions: {
    id: string;
    label: string;
    status: string;
  }[];
};

export type AgentReview = {
  provider: AgentProviderName;
  headline: string;
  memo: string;
  exceptionReview: string[];
  nextActions: string[];
};

type AgentProvider = {
  name: AgentProviderName;
  review: (result: AgentReviewInput) => Promise<AgentReview>;
};

const supportedProviders: AgentProviderName[] = ["mock", "openai", "anthropic", "google", "disabled"];

function normalizeProviderName(value: string | undefined): AgentProviderName {
  if (supportedProviders.includes(value as AgentProviderName)) return value as AgentProviderName;
  return "mock";
}

function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function buildMockReview(result: AgentReviewInput, provider: AgentProviderName = "mock"): AgentReview {
  const ineligibleReceivables = result.receivableResults.filter(receivable => !receivable.eligible);
  const exceptionReview = [
    ...ineligibleReceivables.map(
      receivable => `${receivable.id} ${receivable.obligor}: ${receivable.ineligibleReasons.join("; ")}`,
    ),
    ...result.evidenceExceptions.map(
      evidence => `${evidence.id} ${evidence.label}: evidence status is ${evidence.status}`,
    ),
  ];

  return {
    provider,
    headline: `${formatUsd(result.availableBorrowingBaseCents)} lender-ready availability after eligibility cuts`,
    memo: `${result.portfolio.operator} has a financeable receivables pool, but the lender package should separate clean eligible receivables from title, insurance, utilization, and lockbox exceptions before submission.`,
    exceptionReview,
    nextActions: [
      "Request updated insurance schedule for the flagged obligor before final advance.",
      "Resolve title/lien evidence exception or exclude the affected receivable from the borrowing base.",
      "Refresh telematics export and preserve the Walrus digest in the lender package.",
      "Send the borrowing-base certificate and controlled evidence links to the credit contact.",
    ],
  };
}

const disabledProvider: AgentProvider = {
  name: "disabled",
  review: async result => ({
    provider: "disabled",
    headline: "Agent review disabled",
    memo: "The borrowing-base engine still produced deterministic output, but no diligence memo was generated.",
    exceptionReview: result.exceptionCount > 0 ? ["Manual review required for all exceptions."] : [],
    nextActions: ["Enable `ROBOMATA_AGENT_PROVIDER=mock` or configure a live provider before lender review."],
  }),
};

function liveProvider(name: Exclude<AgentProviderName, "mock" | "disabled">, requiredEnv: string): AgentProvider {
  return {
    name,
    review: async result => {
      const mockReview = buildMockReview(result);

      if (!process.env[requiredEnv]) {
        return {
          ...mockReview,
          memo: `${mockReview.memo} ${name} was selected, but ${requiredEnv} is not configured, so the MVP used deterministic mock diligence output.`,
        };
      }

      return {
        ...mockReview,
        provider: name,
        memo: `${mockReview.memo} Live ${name} execution is intentionally stubbed in the MVP until provider-specific prompts, logging, and data controls are approved.`,
      };
    },
  };
}

export function getAgentProvider(name = process.env.ROBOMATA_AGENT_PROVIDER): AgentProvider {
  const providerName = normalizeProviderName(name);

  if (providerName === "disabled") return disabledProvider;
  if (providerName === "openai") return liveProvider("openai", "OPENAI_API_KEY");
  if (providerName === "anthropic") return liveProvider("anthropic", "ANTHROPIC_API_KEY");
  if (providerName === "google") return liveProvider("google", "GOOGLE_GENERATIVE_AI_API_KEY");

  return {
    name: "mock",
    review: async result => buildMockReview(result),
  };
}

export async function reviewBorrowingBase(result: AgentReviewInput): Promise<AgentReview> {
  return getAgentProvider().review(result);
}
