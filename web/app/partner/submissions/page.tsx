import { redirect } from "next/navigation";

const LegacyPartnerSubmissionsPage = () => {
  redirect("/operator/submissions");
};

export default LegacyPartnerSubmissionsPage;
