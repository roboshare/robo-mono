import Link from "next/link";
import { PartnerAccessGate } from "~~/components/partner/PartnerAccessGate";
import { SubmissionMonitoringWorkspace } from "~~/components/robomata/SubmissionMonitoringWorkspace";
import { isRobomataWorkflowEnabled, isRobomataWorkflowServerEnabled } from "~~/lib/featureFlags";

type RobomataSubmissionMonitoringPageProps = {
  params: Promise<{ submissionId: string }>;
};

const RobomataSubmissionMonitoringPage = async ({ params }: RobomataSubmissionMonitoringPageProps) => {
  const { submissionId } = await params;

  if (!isRobomataWorkflowEnabled() || !isRobomataWorkflowServerEnabled()) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6">
        <div className="rounded-[2rem] border border-base-300 bg-base-100 p-8 text-center shadow-lg shadow-base-300/30">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Feature disabled</p>
          <h1 className="mt-3 text-3xl font-black tracking-tight text-base-content">
            Robomata monitoring is not enabled in this environment.
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-base-content/70">
            Monitoring requires the Robomata workflow runtime. Open the workspace for currently available product
            surfaces.
          </p>
          <div className="mt-6">
            <Link href="/robomata/submissions" className="btn btn-primary rounded-full">
              Open Robomata workspace
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <PartnerAccessGate>
      <SubmissionMonitoringWorkspace submissionId={submissionId} />
    </PartnerAccessGate>
  );
};

export default RobomataSubmissionMonitoringPage;
