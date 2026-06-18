"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { CheckCircleIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import type { RobomataFacilityPolicyArtifact } from "~~/lib/robomata/policyRules";
import type { FacilitySubmission, SubmissionPolicyReview } from "~~/lib/robomata/submissions";
import { notification } from "~~/utils/scaffold-eth";

type ReviewStatus = "accepted" | "needs_changes";

function reviewForArtifact(
  reviews: SubmissionPolicyReview[] | undefined,
  role: "lender" | "operator",
  artifact: RobomataFacilityPolicyArtifact,
) {
  return reviews?.find(
    review =>
      review.role === role &&
      review.reviewedArtifactId === artifact.id &&
      review.reviewedArtifactVersion === artifact.version,
  );
}

async function readJsonResponse<T>(response: Response): Promise<T & { error?: string }> {
  const text = await response.text();
  if (!text.trim()) return {} as T & { error?: string };

  try {
    return JSON.parse(text) as T & { error?: string };
  } catch {
    return {
      error: `Unexpected ${response.status} response from ${new URL(response.url).pathname}.`,
    } as T & { error?: string };
  }
}

function ReviewStatusBadge({ review }: { review?: SubmissionPolicyReview }) {
  if (!review) return <span className="badge badge-warning">Not reviewed</span>;

  return (
    <span className={`badge ${review.status === "accepted" ? "badge-success" : "badge-warning"}`}>
      {review.status === "accepted" ? "Accepted" : "Needs changes"}
    </span>
  );
}

function PolicyReviewShell({
  children,
  description,
  policyArtifact,
  review,
  title,
}: {
  children: ReactNode;
  description: string;
  policyArtifact: RobomataFacilityPolicyArtifact;
  review?: SubmissionPolicyReview;
  title: string;
}) {
  return (
    <div className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-base-content/50">
            <CheckCircleIcon className="h-4 w-4" />
            Policy review
          </div>
          <div className="mt-1 text-sm font-semibold text-base-content">{title}</div>
          <div className="mt-1 text-sm text-base-content/70">{description}</div>
          <div className="mt-2 break-all text-xs text-base-content/50">
            {policyArtifact.name} · {policyArtifact.id} · {policyArtifact.version}
          </div>
        </div>
        <ReviewStatusBadge review={review} />
      </div>
      {review ? (
        <div className="mt-3 rounded-2xl border border-base-300 bg-base-100/70 p-3 text-xs text-base-content/60">
          Reviewed {new Date(review.reviewedAt).toLocaleString()} via {review.reviewSurface.replace(/_/g, " ")}
          {review.rationale ? <div className="mt-1 text-base-content/70">{review.rationale}</div> : null}
        </div>
      ) : null}
      {children}
      <div className="mt-3 flex gap-2 text-xs text-base-content/60">
        <ExclamationTriangleIcon className="h-4 w-4 shrink-0" />
        This records acknowledgement of the current default artifact. It does not create a lender-authored override or
        change deterministic credit rules.
      </div>
    </div>
  );
}

export function OperatorPolicyReviewPanel({
  chainId,
  getAuthHeaders,
  onSubmissionUpdated,
  policyArtifact,
  signerAddress,
  submission,
}: {
  chainId: number;
  getAuthHeaders: (input: {
    chainId?: number;
    method?: string;
    path?: string;
    signerAddress?: string;
  }) => Promise<Record<string, string>>;
  onSubmissionUpdated: (submission: FacilitySubmission) => void;
  policyArtifact: RobomataFacilityPolicyArtifact;
  signerAddress?: string;
  submission: FacilitySubmission;
}) {
  const review = reviewForArtifact(submission.policyReviews, "operator", policyArtifact);
  const [isSaving, setIsSaving] = useState(false);
  const [rationale, setRationale] = useState(review?.rationale ?? "");
  const [status, setStatus] = useState<ReviewStatus>(review?.status ?? "accepted");

  const saveReview = async () => {
    const path = `/api/robomata/submissions/${submission.id}`;
    setIsSaving(true);
    try {
      const response = await fetch(path, {
        body: JSON.stringify({
          action: "reviewPolicy",
          rationale,
          status,
        }),
        headers: {
          "content-type": "application/json",
          ...(await getAuthHeaders({ chainId, method: "PATCH", path, signerAddress })),
        },
        method: "PATCH",
      });
      const payload = await readJsonResponse<{ submission?: FacilitySubmission }>(response);
      if (!response.ok || !payload.submission) throw new Error(payload.error ?? "Failed to save policy review.");
      onSubmissionUpdated(payload.submission);
      notification.success("Policy review recorded.");
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Failed to save policy review.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <PolicyReviewShell
      description="Operator acknowledgement of the active policy artifact for this submission."
      policyArtifact={policyArtifact}
      review={review}
      title="Operator policy review"
    >
      <div className="mt-3 grid gap-2 md:grid-cols-[12rem_1fr_auto]">
        <select
          className="select select-bordered select-sm rounded-full"
          disabled={isSaving}
          onChange={event => setStatus(event.target.value as ReviewStatus)}
          value={status}
        >
          <option value="accepted">Accept default policy</option>
          <option value="needs_changes">Needs changes</option>
        </select>
        <input
          className="input input-bordered input-sm rounded-full"
          disabled={isSaving}
          maxLength={500}
          onChange={event => setRationale(event.target.value)}
          placeholder="Optional rationale"
          value={rationale}
        />
        <button className="btn btn-primary btn-sm rounded-full" disabled={isSaving} onClick={saveReview}>
          Record review
        </button>
      </div>
    </PolicyReviewShell>
  );
}

export function LenderPolicyReviewPanel({
  initialReview,
  policyArtifact,
  shareToken,
}: {
  initialReview?: SubmissionPolicyReview;
  policyArtifact: RobomataFacilityPolicyArtifact;
  shareToken: string;
}) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [rationale, setRationale] = useState(initialReview?.rationale ?? "");
  const [review, setReview] = useState(initialReview);
  const [status, setStatus] = useState<ReviewStatus>(initialReview?.status ?? "accepted");

  const saveReview = async () => {
    setErrorMessage(null);
    setIsSaving(true);
    try {
      const response = await fetch(`/api/robomata/share/${encodeURIComponent(shareToken)}/policy-review`, {
        body: JSON.stringify({ rationale, status }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      const payload = await readJsonResponse<{ policyReview?: SubmissionPolicyReview }>(response);
      if (!response.ok || !payload.policyReview) throw new Error(payload.error ?? "Failed to save policy review.");
      setReview(payload.policyReview);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to save policy review.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <PolicyReviewShell
      description="Lender acknowledgement of the active policy artifact pinned to this protected packet."
      policyArtifact={policyArtifact}
      review={review}
      title="Lender policy review"
    >
      <div className="mt-3 grid gap-2 md:grid-cols-[12rem_1fr_auto]">
        <select
          className="select select-bordered select-sm rounded-full"
          disabled={isSaving}
          onChange={event => setStatus(event.target.value as ReviewStatus)}
          value={status}
        >
          <option value="accepted">Accept default policy</option>
          <option value="needs_changes">Needs changes</option>
        </select>
        <input
          className="input input-bordered input-sm rounded-full"
          disabled={isSaving}
          maxLength={500}
          onChange={event => setRationale(event.target.value)}
          placeholder="Optional lender note"
          value={rationale}
        />
        <button className="btn btn-primary btn-sm rounded-full" disabled={isSaving} onClick={saveReview}>
          Record review
        </button>
      </div>
      {errorMessage ? <div className="mt-3 text-xs text-error">{errorMessage}</div> : null}
    </PolicyReviewShell>
  );
}
