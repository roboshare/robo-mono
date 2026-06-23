import type {
  FacilitySubmission,
  FacilitySubmissionSource,
  SubmissionTokenizationStatus,
} from "~~/lib/robomata/submissions";

export type RobomataNextAction = {
  description: string;
  href: string;
  label: string;
  stage: string;
  tone: "default" | "warning" | "success" | "info";
};

const sourceLabels: Record<FacilitySubmissionSource, { label: string; description: string }> = {
  rental_platform: {
    label: "Rental platform",
    description: "First-party rental operations and servicing data.",
  },
  external_asset_pool: {
    label: "External asset pool",
    description: "Operator-submitted evidence from an outside operating system.",
  },
  connected_external_system: {
    label: "Connected system",
    description: "External system data with a refreshable integration path.",
  },
};

export function facilitySourceLabel(source: FacilitySubmissionSource | undefined) {
  return sourceLabels[source ?? "external_asset_pool"];
}

export function tokenizationStatusLabel(status: SubmissionTokenizationStatus) {
  switch (status) {
    case "draft":
      return "Tokenization terms drafted";
    case "ready_to_sign":
      return "Approved for tokenization";
    case "registered":
      return "Tokenization verification pending";
    case "offering_created":
      return "Offering live";
    case "failed":
      return "Tokenization needs review";
    default:
      return "Not submitted to tokenization";
  }
}

export function submissionNextAction(submission: FacilitySubmission): RobomataNextAction {
  const href = `/robomata/submissions/${submission.id}`;
  const source = submission.facilitySource ?? "external_asset_pool";

  if (submission.tokenization.status === "offering_created") {
    return {
      description: "The approved facility offering is live downstream.",
      href,
      label: "View offering status",
      stage: "Offering live",
      tone: "success",
    };
  }

  if (["draft", "ready_to_sign", "registered", "failed"].includes(submission.tokenization.status)) {
    return {
      description: tokenizationStatusLabel(submission.tokenization.status),
      href,
      label: "Review approval status",
      stage: "Tokenization approval",
      tone: submission.tokenization.status === "failed" ? "warning" : "info",
    };
  }

  if (submission.evidenceCommit.status === "committed") {
    return {
      description: "Evidence is anchored. Send the packet for lender or Robolend review before tokenization.",
      href,
      label: "Share lender packet",
      stage: "Ready for lender review",
      tone: "success",
    };
  }

  if (submission.status === "ready_for_lender") {
    return {
      description: "The borrowing-base packet is clean. Anchor evidence and create a controlled lender link.",
      href,
      label: "Anchor and share packet",
      stage: "Packet ready",
      tone: "success",
    };
  }

  if (submission.status === "needs_review") {
    return {
      description: "Resolve open exceptions before the packet can move to lender review.",
      href,
      label: "Resolve exceptions",
      stage: "Needs review",
      tone: "warning",
    };
  }

  if (submission.status === "ready_to_compute") {
    return {
      description: "Receivables and evidence are present. Run the borrowing-base calculation.",
      href,
      label: "Compute borrowing base",
      stage: "Ready to compute",
      tone: "info",
    };
  }

  if (source === "rental_platform") {
    return {
      description: "Sync or import rental operations data before generating lender output.",
      href,
      label: "Sync operating data",
      stage: "Source data",
      tone: "default",
    };
  }

  if (source === "connected_external_system") {
    return {
      description: "Refresh the connected source and attach the latest evidence snapshot.",
      href,
      label: "Refresh source data",
      stage: "Source data",
      tone: "default",
    };
  }

  return {
    description: "Upload receivables, collateral files, and source evidence for this external pool.",
    href,
    label: "Upload evidence",
    stage: "Evidence onboarding",
    tone: "default",
  };
}
