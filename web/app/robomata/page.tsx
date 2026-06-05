"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { SubmissionWorkspace } from "~~/components/robomata/SubmissionWorkspace";
import { isRobomataWorkflowEnabled } from "~~/lib/featureFlags";

const RobomataSubmissionView = () => {
  const searchParams = useSearchParams();
  const submissionId = searchParams.get("submission") ?? undefined;

  return <SubmissionWorkspace submissionId={submissionId} readOnly loadLatest={!submissionId} />;
};

const RobomataPage = () => (
  <>
    {isRobomataWorkflowEnabled() ? (
      <Suspense
        fallback={
          <div className="min-h-[60vh] flex items-center justify-center">
            <span className="loading loading-spinner loading-lg text-primary"></span>
          </div>
        }
      >
        <RobomataSubmissionView />
      </Suspense>
    ) : (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6">
        <div className="rounded-[2rem] border border-base-300 bg-base-100 p-8 text-center shadow-lg shadow-base-300/30">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
            Robomata workflow disabled
          </p>
          <h1 className="mt-3 text-3xl font-black tracking-tight text-base-content">
            Borrowing-base submissions are behind a release flag.
          </h1>
          <p className="mt-4 text-base-content/70">
            Enable <code>NEXT_PUBLIC_ENABLE_ROBOMATA_WORKFLOW=true</code> for preview environments that should expose
            the working submission flow.
          </p>
        </div>
      </div>
    )}
  </>
);

export default RobomataPage;
