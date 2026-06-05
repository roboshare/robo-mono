"use client";

import { useSearchParams } from "next/navigation";
import { SubmissionWorkspace } from "~~/components/robomata/SubmissionWorkspace";

const RobomataPage = () => {
  const searchParams = useSearchParams();
  const submissionId = searchParams.get("submission") ?? undefined;

  return <SubmissionWorkspace submissionId={submissionId} readOnly loadLatest={!submissionId} />;
};

export default RobomataPage;
