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
  defaultTokenizationTerms,
  hasOpenTokenizationBlockers,
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

    if (["registered", "offering_created"].includes(submission.tokenization.status)) {
      return NextResponse.json({ error: "Tokenization is already completed for this submission." }, { status: 409 });
    }
    if (submission.evidenceCommit.status !== "committed") {
      return NextResponse.json({ error: "Commit evidence before drafting tokenization." }, { status: 409 });
    }
    if (hasOpenTokenizationBlockers(submission)) {
      return NextResponse.json({ error: "Resolve open exceptions before drafting tokenization." }, { status: 409 });
    }
    if (!canDraftTokenization(submission)) {
      return NextResponse.json({ error: "Submission is not eligible for tokenization draft." }, { status: 409 });
    }

    const terms = defaultTokenizationTerms(submission);
    if (terms.offeringLimitCents <= 0) {
      return NextResponse.json(
        { error: "Committed borrowing base must be positive before tokenization." },
        { status: 400 },
      );
    }

    submission.tokenization = {
      status: "draft",
      anchors: buildTokenizationAnchors(submission),
      terms,
      evm: {},
      errorMessage: undefined,
      failedAt: undefined,
    };
    submission.auditEvents.unshift(
      createAuditEvent("tokenization_drafted", `Drafted tokenization terms for ${submission.facilityName}.`, {
        offeringLimitCents: terms.offeringLimitCents,
      }),
    );

    const saved = await store.save(submission);
    return NextResponse.json({ submission: saved });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to draft tokenization." },
      { status: 500 },
    );
  }
}
