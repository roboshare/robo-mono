import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import {
  isRobomataTokenizationEnabled,
  isRobomataWorkflowMutationEnabled,
  isRobomataWorkflowServerEnabled,
} from "~~/lib/featureFlags";
import { requirePartnerAddress, requireSubmissionAccess } from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import { verifyTokenizationCompletion } from "~~/lib/robomata/server/tokenization";
import { createAuditEvent } from "~~/lib/robomata/submissions";

export const runtime = "nodejs";

function requireRobomataWorkflow() {
  if (isRobomataWorkflowServerEnabled()) return null;
  return NextResponse.json({ error: "Robomata workflow is not enabled." }, { status: 404 });
}

function requireRobomataTokenization() {
  if (isRobomataTokenizationEnabled()) return null;
  return NextResponse.json({ error: "Robomata tokenization is not enabled." }, { status: 404 });
}

function requireRobomataMutation() {
  if (isRobomataWorkflowMutationEnabled()) return null;
  return NextResponse.json({ error: "Robomata submission writes are not enabled." }, { status: 403 });
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string when provided.`);
  }
  return value.trim();
}

function normalizeDecimalId(value: unknown, field: string): string {
  const normalized = normalizeRequiredString(value, field);
  if (!/^\d+$/.test(normalized)) throw new Error(`${field} must be a decimal id string.`);
  return normalized;
}

function normalizeTxHash(value: unknown): string {
  const normalized = normalizeRequiredString(value, "txHash");
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) throw new Error("txHash must be a 32-byte hex string.");
  return normalized;
}

function isRetryableCompletionVerificationError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("receipt") ||
    message.includes("not found") ||
    message.includes("unable to verify") ||
    message.includes("timeout") ||
    message.includes("timed out")
  );
}

export async function POST(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
  try {
    const featureError = requireRobomataWorkflow();
    if (featureError) return featureError;
    const tokenizationError = requireRobomataTokenization();
    if (tokenizationError) return tokenizationError;
    const mutationError = requireRobomataMutation();
    if (mutationError) return mutationError;

    const { submissionId } = await context.params;
    const store = getSubmissionStore();
    const submission = await store.get(submissionId);

    if (!submission) {
      return NextResponse.json({ error: "Submission not found." }, { status: 404 });
    }

    const partnerAddress = await requirePartnerAddress(request);
    if (partnerAddress instanceof NextResponse) return partnerAddress;

    const accessError = requireSubmissionAccess(submission, partnerAddress);
    if (accessError) return accessError;

    if (!["ready_to_sign", "registered"].includes(submission.tokenization.status)) {
      return NextResponse.json({ error: "Prepare tokenization before completing it." }, { status: 409 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const registryAddress = normalizeRequiredString(body.registryAddress, "registryAddress");
    if (!isAddress(registryAddress)) throw new Error("registryAddress must be a valid EVM address.");
    const assetId = normalizeDecimalId(body.assetId, "assetId");
    const revenueTokenId = normalizeDecimalId(body.revenueTokenId, "revenueTokenId");
    const txHash = normalizeTxHash(body.txHash);
    const assetMetadataUri =
      normalizeOptionalString(body.assetMetadataUri, "assetMetadataUri") ??
      submission.tokenization.evm.assetMetadataUri;
    const revenueTokenMetadataUri =
      normalizeOptionalString(body.revenueTokenMetadataUri, "revenueTokenMetadataUri") ??
      submission.tokenization.evm.revenueTokenMetadataUri;

    try {
      await verifyTokenizationCompletion({
        assetId,
        assetMetadataUri,
        chainId: request.headers.get("x-robomata-chain-id")?.trim() ?? null,
        registryAddress,
        revenueTokenId,
        revenueTokenMetadataUri,
        submission,
        txHash,
      });
    } catch (error) {
      if (!isRetryableCompletionVerificationError(error)) throw error;

      submission.tokenization = {
        ...submission.tokenization,
        status: "registered",
        evm: {
          ...submission.tokenization.evm,
          registryAddress,
          assetId,
          revenueTokenId,
          txHash,
          assetMetadataUri,
          revenueTokenMetadataUri,
        },
        errorMessage:
          error instanceof Error
            ? `Tokenization transaction submitted; server verification is retryable: ${error.message}`
            : "Tokenization transaction submitted; server verification is retryable.",
        failedAt: undefined,
      };

      const saved = await store.save(submission);
      return NextResponse.json(
        {
          submission: saved,
          error: "Tokenization transaction was submitted, but server-side receipt verification is still pending.",
        },
        { status: 202 },
      );
    }

    submission.tokenization = {
      ...submission.tokenization,
      status: "offering_created",
      evm: {
        registryAddress,
        assetId,
        revenueTokenId,
        txHash,
        assetMetadataUri,
        revenueTokenMetadataUri,
      },
      completedAt: new Date().toISOString(),
      errorMessage: undefined,
      failedAt: undefined,
    };
    submission.auditEvents.unshift(
      createAuditEvent(
        "tokenization_completed",
        `Created Robomata tokenized offering for ${submission.facilityName}.`,
        {
          registryAddress,
          assetId,
          revenueTokenId: revenueTokenId ?? null,
          txHash,
        },
      ),
    );

    const saved = await store.save(submission);
    return NextResponse.json({ submission: saved });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to complete tokenization." },
      { status: 500 },
    );
  }
}
