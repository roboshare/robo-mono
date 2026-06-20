import { NextRequest, NextResponse } from "next/server";
import {
  isRobomataFacilityMonitoringEnabled,
  isRobomataWalrusUploadsEnabled,
  isRobomataWorkflowMutationEnabled,
  isRobomataWorkflowServerEnabled,
} from "~~/lib/featureFlags";
import { getFacilityMonitoringStore } from "~~/lib/robomata/server/facilityMonitoringStore";
import { getPrivyUserFromRequest, requirePartnerAddress } from "~~/lib/robomata/server/submissionAccess";
import { getSubmissionStore } from "~~/lib/robomata/server/submissionStore";
import { ensureSubmissionSuiFacility } from "~~/lib/robomata/server/suiFacilityAssignment";
import type { FacilitySubmissionSource } from "~~/lib/robomata/submissions";

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

function normalizeFacilitySource(value: unknown): FacilitySubmissionSource {
  if (value === "rental_platform" || value === "external_asset_pool" || value === "connected_external_system") {
    return value;
  }

  return "external_asset_pool";
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

    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Submission create payload must be a JSON object." }, { status: 400 });
    }
    const fields = body as Record<string, unknown>;

    let operatorName: string;
    let facilityName: string;
    let asOfDate: string;
    const facilitySource = normalizeFacilitySource(fields.facilitySource);
    try {
      operatorName = normalizeRequiredString(fields.operatorName, "operatorName");
      facilityName = normalizeRequiredString(fields.facilityName, "facilityName");
      asOfDate = normalizeRequiredString(fields.asOfDate, "asOfDate");
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Invalid submission create fields." },
        { status: 400 },
      );
    }

    const store = getSubmissionStore();
    const submission = await store.create({
      partnerAddress,
      facilitySource,
      operatorName,
      facilityName,
      asOfDate,
    });
    const privyUser = await getPrivyUserFromRequest(request).catch(() => null);
    let createdSubmission = submission;
    let assignmentError: unknown;
    try {
      const assignment = await ensureSubmissionSuiFacility({
        allowDraftFacility: true,
        partnerAddress,
        privyUserId: privyUser?.id ?? null,
        store,
        submission,
      });
      createdSubmission = assignment.submission;
    } catch (error) {
      assignmentError = error;
      createdSubmission = (await store.get(submission.id)) ?? submission;
    }

    if (isRobomataWalrusUploadsEnabled() && !createdSubmission.evidenceCommit.facilityObjectId) {
      return NextResponse.json(
        {
          submission: createdSubmission,
          error:
            assignmentError instanceof Error
              ? `Sui facility assignment is required before real evidence uploads: ${assignmentError.message}`
              : "Sui facility assignment is required before real evidence uploads.",
        },
        { status: assignmentError ? 503 : 409 },
      );
    }

    if (isRobomataFacilityMonitoringEnabled()) {
      const facility = await getFacilityMonitoringStore().syncFacility(createdSubmission);
      createdSubmission.facilityMonitoring = {
        facilityId: facility.id,
        status: facility.status,
      };
      createdSubmission = await store.save(createdSubmission);
    }

    return NextResponse.json({ submission: createdSubmission }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create submission." },
      { status: 500 },
    );
  }
}
