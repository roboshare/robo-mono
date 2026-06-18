import { isRobomataLlmReviewEnabled } from "~~/lib/featureFlags";
import type { BorrowingBaseResult } from "~~/lib/robomata/borrowingBase";

export type AgentProviderName = "mock" | "openai" | "anthropic" | "google" | "disabled";
export type AgentReviewMode = "disabled" | "deterministic" | "deterministic_fallback" | "llm_live" | "llm_stubbed";
export type AgentReviewProviderStatus =
  | "configured_disabled"
  | "configured_without_feature_flag"
  | "configured_without_key"
  | "configured_without_model"
  | "deterministic_mock"
  | "live_completed"
  | "live_error_fallback"
  | "stubbed_pending_controls";

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
  providerStatus?: AgentReviewProviderStatus;
  reviewMode?: AgentReviewMode;
  model?: string;
  sourceOfTruth?: "borrowing_base_rules";
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
const openAiReviewTimeoutMs = 8_000;
const openAiExceptionRowLimit = 25;

const openAiReviewSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    headline: {
      type: "string",
      description: "One concise lender-facing headline for the review.",
    },
    memo: {
      type: "string",
      description: "A lender-facing diligence memo. It must not change deterministic borrowing-base results.",
    },
    exceptionReview: {
      type: "array",
      items: { type: "string" },
      description: "Concise exception notes derived only from supplied receivable and evidence exceptions.",
    },
    nextActions: {
      type: "array",
      items: { type: "string" },
      description: "Concrete borrower or operator follow-up requests.",
    },
  },
  required: ["headline", "memo", "exceptionReview", "nextActions"],
} as const;

type OpenAiReviewPayload = Pick<AgentReview, "exceptionReview" | "headline" | "memo" | "nextActions">;

type OpenAiResponseOutputContent = {
  text?: string;
  type?: string;
};

type OpenAiResponseOutputItem = {
  content?: OpenAiResponseOutputContent[];
};

type OpenAiResponseBody = {
  error?: {
    message?: string;
  };
  output?: OpenAiResponseOutputItem[];
  output_text?: string;
};

type OpenAiReviewPrompt = {
  instruction: string;
  portfolio: AgentReviewInput["portfolio"];
  availableBorrowingBaseCents: number;
  exceptionCount: number;
  receivableSummary: {
    totalReceivables: number;
    eligibleReceivables: number;
    ineligibleReceivables: number;
    includedExceptionRows: number;
    omittedExceptionRows: number;
  };
  receivableExceptions: AgentReviewInput["receivableResults"];
  evidenceExceptions: AgentReviewInput["evidenceExceptions"];
  omittedEvidenceExceptions: number;
};

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

export function buildAgentReviewInput(result: BorrowingBaseResult): AgentReviewInput {
  return {
    portfolio: {
      operator: result.portfolio.operator,
    },
    availableBorrowingBaseCents: result.availableBorrowingBaseCents,
    exceptionCount: result.exceptionCount,
    receivableResults: result.receivableResults.map(receivable => ({
      id: receivable.id,
      obligor: receivable.obligor,
      eligible: receivable.eligible,
      ineligibleReasons: receivable.ineligibleReasons,
    })),
    evidenceExceptions: result.evidenceExceptions.map(evidence => ({
      id: evidence.id,
      label: evidence.label,
      status: evidence.status,
    })),
  };
}

function reviewBoundary(
  provider: AgentProviderName,
  providerStatus: AgentReviewProviderStatus,
  reviewMode: AgentReviewMode,
): Pick<AgentReview, "model" | "provider" | "providerStatus" | "reviewMode" | "sourceOfTruth"> {
  return {
    provider,
    providerStatus,
    reviewMode,
    model: process.env.ROBOMATA_AGENT_REVIEW_MODEL?.trim() || undefined,
    sourceOfTruth: "borrowing_base_rules",
  };
}

function buildMockReview(
  result: AgentReviewInput,
  boundary = reviewBoundary("mock", "deterministic_mock", "deterministic"),
): AgentReview {
  const ineligibleReceivables = result.receivableResults.filter(receivable => !receivable.eligible);
  const exceptionReview = [
    ...ineligibleReceivables.map(
      receivable => `${receivable.id} ${receivable.obligor}: ${receivable.ineligibleReasons.join("; ")}`,
    ),
    ...result.evidenceExceptions.map(
      evidence => `${evidence.id} ${evidence.label}: evidence status is ${evidence.status}`,
    ),
  ];

  if (result.exceptionCount === 0) {
    return {
      ...boundary,
      headline: `${formatUsd(result.availableBorrowingBaseCents)} lender-ready availability with no open exceptions`,
      memo: `${result.portfolio.operator} has a clean receivables pool under the configured borrowing-base policy and is ready for lender packet delivery.`,
      exceptionReview: [],
      nextActions: [
        "Send the borrowing-base certificate and controlled evidence links to the credit contact.",
        "Preserve the current evidence root for lender and auditor review.",
        "Schedule the next receivables refresh before the next borrowing-base update.",
      ],
    };
  }

  return {
    ...boundary,
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

function boundedText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, maxLength);
}

function boundedStringList(value: unknown, fallback: string[], maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value
    .map(item => boundedText(item, "", maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
  return items.length ? items : fallback;
}

function outputTextFromOpenAiResponse(body: OpenAiResponseBody): string | undefined {
  if (body.output_text?.trim()) return body.output_text;

  return body.output
    ?.flatMap(item => item.content ?? [])
    .map(content => content.text)
    .find((text): text is string => Boolean(text?.trim()));
}

function parseOpenAiReviewPayload(text: string, fallback: AgentReview, result: AgentReviewInput): OpenAiReviewPayload {
  const parsed = JSON.parse(text) as Partial<OpenAiReviewPayload>;
  const exceptionReview =
    result.exceptionCount === 0 ? [] : boundedStringList(parsed.exceptionReview, fallback.exceptionReview, 12, 240);

  return {
    headline: boundedText(parsed.headline, fallback.headline, 160),
    memo: boundedText(parsed.memo, fallback.memo, 1_200),
    exceptionReview,
    nextActions: boundedStringList(parsed.nextActions, fallback.nextActions, 8, 220),
  };
}

function openAiReviewPrompt(result: AgentReviewInput): string {
  const receivableExceptions = result.receivableResults.filter(receivable => !receivable.eligible);
  const includedReceivableExceptions = receivableExceptions.slice(0, openAiExceptionRowLimit);
  const includedEvidenceExceptions = result.evidenceExceptions.slice(0, openAiExceptionRowLimit);
  const prompt: OpenAiReviewPrompt = {
    instruction:
      "Prepare advisory lender diligence text. Do not recalculate availability, eligibility, exceptions, or reserves. The deterministic borrowing-base rules are the source of credit truth.",
    portfolio: result.portfolio,
    availableBorrowingBaseCents: result.availableBorrowingBaseCents,
    exceptionCount: result.exceptionCount,
    receivableSummary: {
      totalReceivables: result.receivableResults.length,
      eligibleReceivables: result.receivableResults.length - receivableExceptions.length,
      ineligibleReceivables: receivableExceptions.length,
      includedExceptionRows: includedReceivableExceptions.length,
      omittedExceptionRows: Math.max(receivableExceptions.length - includedReceivableExceptions.length, 0),
    },
    receivableExceptions: includedReceivableExceptions,
    evidenceExceptions: includedEvidenceExceptions,
    omittedEvidenceExceptions: Math.max(result.evidenceExceptions.length - includedEvidenceExceptions.length, 0),
  };

  return JSON.stringify(prompt);
}

async function reviewWithOpenAi(result: AgentReviewInput, fallback: AgentReview): Promise<AgentReview> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.ROBOMATA_AGENT_REVIEW_MODEL?.trim();

  if (!apiKey) {
    return {
      ...fallback,
      memo: `${fallback.memo} openai was selected, but OPENAI_API_KEY is not configured, so the review used deterministic fallback output.`,
    };
  }

  if (!model) {
    return {
      ...buildMockReview(result, reviewBoundary("openai", "configured_without_model", "deterministic_fallback")),
      memo: `${fallback.memo} openai was selected, but ROBOMATA_AGENT_REVIEW_MODEL is not configured, so the review used deterministic fallback output.`,
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), openAiReviewTimeoutMs);
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        body: JSON.stringify({
          input: [
            {
              role: "system",
              content:
                "You are a private-credit diligence reviewer. Return only schema-compliant JSON. Never override deterministic borrowing-base results.",
            },
            {
              role: "user",
              content: openAiReviewPrompt(result),
            },
          ],
          model,
          store: false,
          text: {
            format: {
              type: "json_schema",
              name: "robomata_borrowing_base_review",
              schema: openAiReviewSchema,
              strict: true,
            },
          },
        }),
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as OpenAiResponseBody;
      if (!response.ok) throw new Error(body.error?.message ?? `OpenAI review failed with ${response.status}.`);

      const outputText = outputTextFromOpenAiResponse(body);
      if (!outputText) throw new Error("OpenAI review response did not include output text.");

      return {
        ...parseOpenAiReviewPayload(outputText, fallback, result),
        ...reviewBoundary("openai", "live_completed", "llm_live"),
        model,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    void error;
    return {
      ...buildMockReview(result, reviewBoundary("openai", "live_error_fallback", "deterministic_fallback")),
      memo: `${fallback.memo} Live openai review failed, so the review used deterministic fallback output.`,
    };
  }
}

const disabledProvider: AgentProvider = {
  name: "disabled",
  review: async result => ({
    ...reviewBoundary("disabled", "configured_disabled", "disabled"),
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
      const liveReviewEnabled = isRobomataLlmReviewEnabled();
      const mockReview = buildMockReview(
        result,
        reviewBoundary(
          name,
          liveReviewEnabled ? "configured_without_key" : "configured_without_feature_flag",
          "deterministic_fallback",
        ),
      );

      if (!liveReviewEnabled) {
        return {
          ...mockReview,
          memo: `${mockReview.memo} ${name} was selected, but ROBOMATA_LLM_REVIEW_ENABLED is not enabled, so the review used deterministic fallback output.`,
        };
      }

      if (name === "openai") return reviewWithOpenAi(result, mockReview);

      if (!process.env[requiredEnv]) {
        return {
          ...mockReview,
          memo: `${mockReview.memo} ${name} was selected, but ${requiredEnv} is not configured, so the MVP used deterministic mock diligence output.`,
        };
      }

      return {
        ...buildMockReview(result, reviewBoundary(name, "stubbed_pending_controls", "llm_stubbed")),
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
