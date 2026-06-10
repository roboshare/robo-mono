import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataTokenizationEnabled,
  isRobomataWorkflowMutationEnabled,
  isRobomataWorkflowServerEnabled,
} from "~~/lib/featureFlags";
import { ROBOMATA_AUTH_HEADERS } from "~~/lib/robomata/auth";
import { requirePartnerAddress, requireSubmissionAccess } from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import {
  buildTokenizationAnchors,
  canDraftTokenization,
  hasOpenTokenizationBlockers,
  mergeTokenizationTerms,
  prepareTokenization,
} from "~~/lib/robomata/server/tokenization";
import { type FacilitySubmission, createAuditEvent } from "~~/lib/robomata/submissions";

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

export async function POST(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
  let store: ReturnType<typeof getSubmissionStore> | null = null;
  let submission: FacilitySubmission | null = null;

  try {
    const featureError = requireRobomataWorkflow();
    if (featureError) return featureError;
    const tokenizationError = requireRobomataTokenization();
    if (tokenizationError) return tokenizationError;
    const mutationError = requireRobomataMutation();
    if (mutationError) return mutationError;

    const { submissionId } = await context.params;
    store = getSubmissionStore();
    submission = await store.get(submissionId);

    if (!submission) {
      return NextResponse.json({ error: "Submission not found." }, { status: 404 });
    }

    const partnerAddress = await requirePartnerAddress(request);
    if (partnerAddress instanceof NextResponse) return partnerAddress;

    const accessError = requireSubmissionAccess(submission, partnerAddress);
    if (accessError) return accessError;

    if (submission.evidenceCommit.status !== "committed" || hasOpenTokenizationBlockers(submission)) {
      return NextResponse.json({ error: "Submission is not eligible for tokenization prepare." }, { status: 409 });
    }
    if (!canDraftTokenization(submission)) {
      return NextResponse.json({ error: "Submission is not eligible for tokenization prepare." }, { status: 409 });
    }
    if (!["draft", "ready_to_sign", "failed"].includes(submission.tokenization.status)) {
      return NextResponse.json({ error: "Create a tokenization draft before preparing call args." }, { status: 409 });
    }

    const terms = mergeTokenizationTerms(submission, {});
    submission.tokenization = {
      ...submission.tokenization,
      status: "draft",
      anchors: buildTokenizationAnchors(submission),
      terms,
      errorMessage: undefined,
      failedAt: undefined,
    };

    const prepared = await prepareTokenization({
      chainId: request.headers.get(ROBOMATA_AUTH_HEADERS.chainId)?.trim() ?? null,
      submission,
    });

    submission.tokenization = {
      ...submission.tokenization,
      status: "ready_to_sign",
      evm: {
        ...submission.tokenization.evm,
        registryAddress: prepared.evmCall.contractAddress,
        assetMetadataUri: prepared.assetMetadataUri,
        revenueTokenMetadataUri: prepared.revenueTokenMetadataUri,
      },
      preparedAt: new Date().toISOString(),
      errorMessage: undefined,
      failedAt: undefined,
    };
    submission.auditEvents.unshift(
      createAuditEvent("tokenization_prepared", `Prepared EVM tokenization call for ${submission.facilityName}.`, {
        registryAddress: prepared.evmCall.contractAddress ?? null,
        assetMetadataUri: prepared.assetMetadataUri,
        revenueTokenMetadataUri: prepared.revenueTokenMetadataUri,
      }),
    );

    const saved = await store.save(submission);
    return NextResponse.json({
      submission: saved,
      assetMetadata: prepared.assetMetadata,
      revenueTokenMetadata: prepared.revenueTokenMetadata,
      assetMetadataUri: prepared.assetMetadataUri,
      revenueTokenMetadataUri: prepared.revenueTokenMetadataUri,
      evmCall: prepared.evmCall,
    });
  } catch (error) {
    if (store && submission) {
      submission.tokenization = {
        ...submission.tokenization,
        status: "failed",
        failedAt: new Date().toISOString(),
        errorMessage: error instanceof Error ? error.message : "Failed to prepare tokenization.",
      };
      await store.save(submission).catch(() => undefined);
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to prepare tokenization." },
      { status: 500 },
    );
  }
}
