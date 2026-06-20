"use client";

import { useParams } from "next/navigation";
import { PartnerAccessGate } from "~~/components/partner/PartnerAccessGate";
import { SubmissionWorkspace } from "~~/components/robomata/SubmissionWorkspace";
import { isRobomataWorkflowEnabled } from "~~/lib/featureFlags";

const RobomataSubmissionDetailPage = () => {
  const params = useParams<{ submissionId: string }>();

  if (!isRobomataWorkflowEnabled()) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6">
        <div className="rounded-[2rem] border border-base-300 bg-base-100 p-8 text-center shadow-lg shadow-base-300/30">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Feature disabled</p>
          <h1 className="mt-3 text-3xl font-black tracking-tight text-base-content">
            Robomata facility packages are not enabled in this environment.
          </h1>
        </div>
      </div>
    );
  }

  return (
    <PartnerAccessGate>
      <SubmissionWorkspace submissionId={params.submissionId} />
    </PartnerAccessGate>
  );
};

export default RobomataSubmissionDetailPage;
