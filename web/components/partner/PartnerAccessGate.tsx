"use client";

import { useEffect, useMemo, useState } from "react";
import type { PropsWithChildren, ReactNode } from "react";
import { useReadContract } from "wagmi";
import { OperatorLoginRequired } from "~~/components/partner/OperatorLoginRequired";
import { useSelectedNetwork } from "~~/hooks/scaffold-eth";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import { getDeployedContract } from "~~/utils/contracts";
import { getSubgraphQueryUrl } from "~~/utils/subgraph";

type PartnerAccessGateProps = PropsWithChildren<{
  loadingMessage?: ReactNode;
}>;

type SubgraphPartnerAuthorization = {
  isAuthorized?: boolean;
  isLoading: boolean;
};

const PARTNER_AUTHORIZATION_QUERY = `
  query PartnerAuthorization($id: ID!) {
    partner(id: $id) {
      isAuthorized
    }
  }
`;

const useSubgraphPartnerAuthorization = (
  accountAddress: string | undefined,
  chainId: number | undefined,
): SubgraphPartnerAuthorization => {
  const subgraphUrl = useMemo(() => getSubgraphQueryUrl(chainId), [chainId]);
  const [isAuthorized, setIsAuthorized] = useState<boolean | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!accountAddress || !subgraphUrl) {
      setIsAuthorized(undefined);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsAuthorized(undefined);
    setIsLoading(true);

    fetch(subgraphUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: PARTNER_AUTHORIZATION_QUERY,
        variables: { id: accountAddress.toLowerCase() },
      }),
    })
      .then(async response => {
        const payload = (await response.json()) as {
          data?: { partner?: { isAuthorized?: boolean } | null };
          errors?: Array<{ message?: string }>;
        };

        if (!response.ok || payload.errors?.length) {
          throw new Error(payload.errors?.[0]?.message ?? "Failed to read partner authorization from subgraph.");
        }

        if (!cancelled) setIsAuthorized(payload.data?.partner?.isAuthorized === true);
      })
      .catch(() => {
        if (!cancelled) {
          setIsAuthorized(undefined);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accountAddress, subgraphUrl]);

  return { isAuthorized, isLoading };
};

export const PartnerAccessGate = ({ children, loadingMessage }: PartnerAccessGateProps) => {
  const { address: accountAddress, chainId: accountChainId } = useTransactingAccount();
  const selectedNetwork = useSelectedNetwork(accountChainId);
  const partnerManagerContract = getDeployedContract(selectedNetwork.id, "PartnerManager");
  const subgraphAuthorization = useSubgraphPartnerAuthorization(accountAddress, selectedNetwork.id);

  const {
    data: isAuthorizedPartner,
    isLoading: isCheckingPartner,
    isError: isPartnerContractCheckError,
    isSuccess: isPartnerContractCheckSuccess,
  } = useReadContract({
    address: partnerManagerContract?.address,
    abi: partnerManagerContract?.abi,
    functionName: "isAuthorizedPartner",
    args: [accountAddress as string],
    query: { enabled: !!accountAddress && !!partnerManagerContract },
  });
  const contractAuthorized = isAuthorizedPartner === true;
  const contractDenied = isPartnerContractCheckSuccess && isAuthorizedPartner === false;
  const contractUnavailable = !partnerManagerContract || isPartnerContractCheckError;
  const subgraphAuthorized = subgraphAuthorization.isAuthorized === true;
  const isAuthorized = contractAuthorized || (contractUnavailable && subgraphAuthorized);
  const isVerifyingAuthorization =
    !isAuthorized &&
    !contractDenied &&
    ((!!partnerManagerContract && !isPartnerContractCheckError && isCheckingPartner) ||
      (contractUnavailable && subgraphAuthorization.isLoading));

  if (!accountAddress) {
    return <OperatorLoginRequired />;
  }

  if (isVerifyingAuthorization) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        {loadingMessage ?? <span className="loading loading-spinner loading-lg text-primary"></span>}
      </div>
    );
  }

  if (!isAuthorized) {
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
