"use client";

import { useParams } from "next/navigation";
import { PartnerAccessGate } from "~~/components/partner/PartnerAccessGate";
import { SubmissionWorkspace } from "~~/components/robomata/SubmissionWorkspace";

const PartnerSubmissionDetailPage = () => {
  const params = useParams<{ submissionId: string }>();

  return (
    <PartnerAccessGate>
      <SubmissionWorkspace submissionId={params.submissionId} />
    </PartnerAccessGate>
  );
};

export default PartnerSubmissionDetailPage;
