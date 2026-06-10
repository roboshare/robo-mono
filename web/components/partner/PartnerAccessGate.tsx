"use client";

import type { PropsWithChildren, ReactNode } from "react";
import { useReadContract } from "wagmi";
import { useSelectedNetwork } from "~~/hooks/scaffold-eth";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import { getDeployedContract } from "~~/utils/contracts";

type PartnerAccessGateProps = PropsWithChildren<{
  loadingMessage?: ReactNode;
}>;

export const PartnerAccessGate = ({ children, loadingMessage }: PartnerAccessGateProps) => {
  const { address: accountAddress, chainId: accountChainId } = useTransactingAccount();
  const selectedNetwork = useSelectedNetwork(accountChainId);
  const partnerManagerContract = getDeployedContract(selectedNetwork.id, "PartnerManager");

  const { data: isAuthorizedPartner, isLoading: isCheckingPartner } = useReadContract({
    address: partnerManagerContract?.address,
    abi: partnerManagerContract?.abi,
    functionName: "isAuthorizedPartner",
    args: [accountAddress as string],
    query: { enabled: !!accountAddress && !!partnerManagerContract },
  });

  if (!accountAddress) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center py-20 text-xl opacity-70">Please log in to access the dashboard.</div>
      </div>
    );
  }

  if (isCheckingPartner) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        {loadingMessage ?? <span className="loading loading-spinner loading-lg text-primary"></span>}
      </div>
    );
  }

  if (!isAuthorizedPartner) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center py-16 px-6 max-w-xl">
          <h2 className="text-2xl font-bold">Operator Access Required</h2>
          <p className="mt-3 opacity-70">
            This dashboard is only available to authorized operators. If you believe this is an error, please contact
            the Roboshare team.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};
