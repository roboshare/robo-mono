type GoogleGeminiPart = {
  text?: string;
};

type GoogleGeminiContent = {
  parts?: GoogleGeminiPart[];
};

type GoogleGeminiResponseBody = {
  candidates?: {
    content?: GoogleGeminiContent;
  }[];
  error?: {
    message?: string;
  };
};

type GenerateGoogleGeminiContentInput = {
  apiKey: string;
  model: string;
  systemInstruction: string;
  timeoutMs: number;
  userPrompt: string;
};

export const GOOGLE_GEMINI_API_KEY_ENV = "GOOGLE_GENERATIVE_AI_API_KEY";
export const GOOGLE_GEMINI_GENERATE_CONTENT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

function normalizedGeminiModel(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith("models/") ? trimmed.slice("models/".length) : trimmed;
}

export function googleGeminiGenerateContentUrl(model: string): string {
  return `${GOOGLE_GEMINI_GENERATE_CONTENT_ENDPOINT}/${encodeURIComponent(normalizedGeminiModel(model))}:generateContent`;
}

export function jsonTextFromProviderOutput(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function outputTextFromGoogleGeminiResponse(body: GoogleGeminiResponseBody): string | undefined {
  const text = body.candidates?.[0]?.content?.parts
    ?.map(part => part.text)
    .filter((partText): partText is string => Boolean(partText?.trim()))
    .join("");

  return text?.trim() ? text : undefined;
}

export async function generateGoogleGeminiContent(input: GenerateGoogleGeminiContentInput): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const response = await fetch(googleGeminiGenerateContentUrl(input.model), {
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: input.userPrompt }],
            role: "user",
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
        },
        systemInstruction: {
          parts: [{ text: input.systemInstruction }],
        },
      }),
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": input.apiKey,
      },
      method: "POST",
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as GoogleGeminiResponseBody;
    if (!response.ok) throw new Error(body.error?.message ?? `Google Gemini request failed with ${response.status}.`);

    const outputText = outputTextFromGoogleGeminiResponse(body);
    if (!outputText) throw new Error("Google Gemini response did not include output text.");
    return outputText;
  } finally {
    clearTimeout(timeout);
  }
}
