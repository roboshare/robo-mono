import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataTokenizationEnabled,
  isRobomataWorkflowMutationEnabled,
  isRobomataWorkflowServerEnabled,
} from "~~/lib/featureFlags";
import { requirePartnerAddress, requireSubmissionAccess } from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import {
  buildTokenizationAnchors,
  canDraftTokenization,
  hasOpenTokenizationBlockers,
  mergeTokenizationTerms,
} from "~~/lib/robomata/server/tokenization";
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

async function updateTerms(request: NextRequest, context: { params: Promise<{ submissionId: string }> }) {
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

    if (submission.evidenceCommit.status !== "committed" || hasOpenTokenizationBlockers(submission)) {
      return NextResponse.json({ error: "Submission is not eligible for tokenization terms." }, { status: 409 });
    }
    if (!canDraftTokenization(submission)) {
      return NextResponse.json({ error: "Submission is not eligible for tokenization terms." }, { status: 409 });
    }
    if (!["draft", "ready_to_sign", "failed"].includes(submission.tokenization.status)) {
      return NextResponse.json({ error: "Create a tokenization draft before setting terms." }, { status: 409 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const requestedOfferingLimitCents =
      typeof body.offeringLimitCents === "number" && Number.isFinite(body.offeringLimitCents)
        ? body.offeringLimitCents
        : undefined;
    const terms = mergeTokenizationTerms(submission, body);
    const capped = requestedOfferingLimitCents !== undefined && terms.offeringLimitCents < requestedOfferingLimitCents;

    submission.tokenization = {
      ...submission.tokenization,
      status: "draft",
      anchors: buildTokenizationAnchors(submission),
      terms,
      evm: {
        ...submission.tokenization.evm,
        assetMetadataUri: undefined,
        revenueTokenMetadataUri: undefined,
      },
      preparedAt: undefined,
      errorMessage: undefined,
      failedAt: undefined,
    };
    submission.auditEvents.unshift(
      createAuditEvent("tokenization_terms_updated", `Updated tokenization terms for ${submission.facilityName}.`, {
        offeringLimitCents: terms.offeringLimitCents,
        capped,
      }),
    );

    const saved = await store.save(submission);
    return NextResponse.json({ submission: saved, capped });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update tokenization terms." },
      { status: 500 },
    );
  }
}

export const POST = updateTerms;
export const PATCH = updateTerms;
