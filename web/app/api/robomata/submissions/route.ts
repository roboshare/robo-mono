import { NextRequest, NextResponse } from "next/server";
import { isRobomataWorkflowMutationEnabled, isRobomataWorkflowServerEnabled } from "~~/lib/featureFlags";
import { getPrivyUserFromRequest, requirePartnerAddress } from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import { ensureSubmissionSuiFacility } from "~~/lib/robomata/server/suiFacilityAssignment";

export const runtime = "nodejs";

function requireRobomataWorkflow() {
  if (isRobomataWorkflowServerEnabled()) return null;
  return NextResponse.json({ error: "Robomata workflow is not enabled." }, { status: 404 });
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

export async function GET(request: NextRequest) {
  const featureError = requireRobomataWorkflow();
  if (featureError) return featureError;

  const partnerAddress = await requirePartnerAddress(request);
  if (partnerAddress instanceof NextResponse) return partnerAddress;

  const submissions = await getSubmissionStore().list(partnerAddress);
  return NextResponse.json({ submissions });
}

export async function POST(request: NextRequest) {
  try {
    const featureError = requireRobomataWorkflow();
    if (featureError) return featureError;
    const mutationError = requireRobomataMutation();
    if (mutationError) return mutationError;
    const partnerAddress = await requirePartnerAddress(request);
    if (partnerAddress instanceof NextResponse) return partnerAddress;

    const body = (await request.json()) as {
      operatorName?: unknown;
      facilityName?: unknown;
      asOfDate?: unknown;
    };

    let operatorName: string;
    let facilityName: string;
    let asOfDate: string;
    try {
      operatorName = normalizeRequiredString(body.operatorName, "operatorName");
      facilityName = normalizeRequiredString(body.facilityName, "facilityName");
      asOfDate = normalizeRequiredString(body.asOfDate, "asOfDate");
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Invalid submission create fields." },
        { status: 400 },
      );
    }

    const store = getSubmissionStore();
    const submission = await store.create({
      partnerAddress,
      operatorName,
      facilityName,
      asOfDate,
    });
    const privyUser = await getPrivyUserFromRequest(request).catch(() => null);
    const assignment = await ensureSubmissionSuiFacility({
      allowDraftFacility: true,
      partnerAddress,
      privyUserId: privyUser?.id ?? null,
      store,
      submission,
    });

    return NextResponse.json({ submission: assignment.submission }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create submission." },
      { status: 500 },
    );
  }
}
