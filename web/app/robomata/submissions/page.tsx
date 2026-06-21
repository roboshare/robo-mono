"use client";

import Link from "next/link";
import { SubmissionIndex } from "~~/components/robomata/SubmissionIndex";
import { isRobomataWorkflowEnabled, isRobomataWorkflowServerEnabled } from "~~/lib/featureFlags";

const RobomataSubmissionsPage = () =>
  isRobomataWorkflowEnabled() && isRobomataWorkflowServerEnabled() ? (
    <SubmissionIndex />
  ) : (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6">
      <div className="rounded-[2rem] border border-base-300 bg-base-100 p-8 text-center shadow-lg shadow-base-300/30">
        <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Feature disabled</p>
        <h1 className="mt-3 text-3xl font-black tracking-tight text-base-content">
          Robomata facility packages are not enabled in this environment.
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-base-content/70">
          The workspace requires both the public Robomata flag and the server workflow runtime. Open the dashboard for
          currently available product spaces.
        </p>
        <div className="mt-6">
          <Link href="/dashboard" className="btn btn-primary rounded-full">
            Open dashboard
          </Link>
        </div>
      </div>
    </div>
  );

export default RobomataSubmissionsPage;
