import { redirect } from "next/navigation";

type LegacyPartnerSubmissionDetailPageProps = {
  params: Promise<{ submissionId: string }>;
};

const LegacyPartnerSubmissionDetailPage = async ({ params }: LegacyPartnerSubmissionDetailPageProps) => {
  const { submissionId } = await params;

  redirect(`/operator/submissions/${submissionId}`);
};

export default LegacyPartnerSubmissionDetailPage;
