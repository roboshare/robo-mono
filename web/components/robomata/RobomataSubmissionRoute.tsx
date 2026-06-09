"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { PartnerAccessGate } from "~~/components/partner/PartnerAccessGate";
import { SubmissionWorkspace } from "~~/components/robomata/SubmissionWorkspace";

const RobomataSubmissionView = () => {
  const searchParams = useSearchParams();
  const submissionId = searchParams.get("submission") ?? undefined;

  return <SubmissionWorkspace submissionId={submissionId} readOnly loadLatest={!submissionId} />;
};

export const RobomataSubmissionRoute = () => (
  <PartnerAccessGate>
    <Suspense
      fallback={
        <div className="min-h-[60vh] flex items-center justify-center">
          <span className="loading loading-spinner loading-lg text-primary"></span>
        </div>
      }
    >
      <RobomataSubmissionView />
    </Suspense>
  </PartnerAccessGate>
);
