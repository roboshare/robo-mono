import { redirect } from "next/navigation";

const LegacyOperatorSubmissionDetailPage = async ({ params }: { params: Promise<{ submissionId: string }> }) => {
  const { submissionId } = await params;
  redirect(`/robomata/submissions/${encodeURIComponent(submissionId)}`);
};

export default LegacyOperatorSubmissionDetailPage;
