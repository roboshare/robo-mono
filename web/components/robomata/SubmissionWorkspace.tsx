"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { type Hex, decodeEventLog, encodeFunctionData } from "viem";
import { usePublicClient, useWriteContract } from "wagmi";
import {
  ArrowPathIcon,
  CheckCircleIcon,
  CloudArrowUpIcon,
  DocumentArrowUpIcon,
  ExclamationTriangleIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";
import { AgentSupervisionPanel } from "~~/components/robomata/AgentSupervisionPanel";
import { FacilityMonitoringPanel } from "~~/components/robomata/FacilityMonitoringPanel";
import { PacketSharePanel } from "~~/components/robomata/PacketSharePanel";
import { OperatorPolicyReviewPanel } from "~~/components/robomata/PolicyReviewPanels";
import { BorrowingBasePolicyDisclosure } from "~~/components/robomata/PolicyRulesPanel";
import { ReviewBoundaryPanel } from "~~/components/robomata/ReviewBoundaryPanel";
import { FlowWalletBalances } from "~~/components/wallet/FlowWalletBalances";
import { useSelectedNetwork, useTransactor } from "~~/hooks/scaffold-eth";
import { usePrivySuiWalletBinding } from "~~/hooks/usePrivySuiWalletBinding";
import { useRobomataApiAuth } from "~~/hooks/useRobomataApiAuth";
import { sendSmartWalletCalls } from "~~/hooks/useSmartWalletTransaction";
import {
  type OperatorSuiCommitRequest,
  shouldReleaseOperatorCommitReservation,
  useSuiOperatorWallet,
} from "~~/hooks/useSuiOperatorWallet";
import { useTransactingAccount } from "~~/hooks/useTransactingAccount";
import { isRobomataTokenizationClientEnabled } from "~~/lib/featureFlags";
import { formatPercentFromBps, formatUsd } from "~~/lib/robomata/borrowingBase";
import { resolveRobomataFacilityPolicyArtifact } from "~~/lib/robomata/policyRules";
import type { FacilitySubmission, SubmissionComputation, SubmissionReceivable } from "~~/lib/robomata/submissions";
import { notification } from "~~/utils/scaffold-eth";

type SubmissionWorkspaceProps = {
  submissionId?: string;
  readOnly?: boolean;
  loadLatest?: boolean;
};

type CommitEvidenceResponse = {
  submission?: FacilitySubmission;
  operatorCommit?: OperatorSuiCommitRequest;
  txDigest?: string;
  error?: string;
};

type TokenizationPrepareResponse = {
  submission?: FacilitySubmission;
  evmCall?: {
    contractAddress?: string;
    contractName: "FacilityRegistry";
    functionName: "registerAssetAndCreateRevenueTokenPool";
    args: [string, string, string, string, string, string, string, boolean, boolean];
  };
  assetMetadataUri?: string;
  revenueTokenMetadataUri?: string;
  error?: string;
};

const facilityRegistryWriteAbi = [
  {
    type: "function",
    name: "registerAssetAndCreateRevenueTokenPool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "data", type: "bytes" },
      { name: "assetValue", type: "uint256" },
      { name: "tokenPrice", type: "uint256" },
      { name: "maturityDate", type: "uint256" },
      { name: "revenueShareBP", type: "uint256" },
      { name: "targetYieldBP", type: "uint256" },
      { name: "maxSupply", type: "uint256" },
      { name: "immediateProceeds", type: "bool" },
      { name: "protectionEnabled", type: "bool" },
    ],
    outputs: [
      { name: "assetId", type: "uint256" },
      { name: "tokenId", type: "uint256" },
      { name: "supply", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "AssetRegistered",
    inputs: [
      { name: "assetId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "assetValue", type: "uint256", indexed: false },
      { name: "status", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RevenueTokenPoolCreated",
    inputs: [
      { name: "assetId", type: "uint256", indexed: true },
      { name: "revenueTokenId", type: "uint256", indexed: true },
      { name: "partner", type: "address", indexed: true },
      { name: "assetValue", type: "uint256", indexed: false },
      { name: "supply", type: "uint256", indexed: false },
    ],
  },
] as const;

type PendingOperatorCommit = {
  operatorSignature?: string;
  sponsorGasObjectId?: string;
  sponsorSignature?: string;
  submissionId: string;
  rootDigest: string;
  transactionBytes?: string;
  txDigest?: string;
  walletAddress?: string;
  walletName: string;
};

function statusClass(status: FacilitySubmission["status"]) {
  if (status === "committed") return "badge-success";
  if (status === "ready_for_lender") return "badge-info";
  if (status === "needs_review") return "badge-warning";
  return "badge-ghost";
}

function sectionTitle(readOnly: boolean) {
  return readOnly ? "Lender-ready review surface" : "Operator submission workspace";
}

async function readJsonResponse<T>(response: Response): Promise<T & { error?: string }> {
  const text = await response.text();
  if (!text.trim()) return {} as T & { error?: string };

  try {
    return JSON.parse(text) as T & { error?: string };
  } catch {
    return {
      error: `Unexpected ${response.status} response from ${new URL(response.url).pathname}.`,
    } as T & { error?: string };
  }
}

function centsToDollarInput(cents: number | undefined): string {
  return ((cents ?? 0) / 100).toFixed(2);
}

function dollarsToCents(value: string): number {
  return Math.round(Number(value) * 100);
}

function sameSuiAddress(left?: string, right?: string) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function buildSubmissionSummaryCards(computation: SubmissionComputation) {
  const { borrowingBase } = computation;
  return [
    { label: "Gross Receivables", value: formatUsd(borrowingBase.grossReceivablesCents) },
    { label: "Eligible Receivables", value: formatUsd(borrowingBase.eligibleReceivablesCents) },
    { label: "Available Borrowing Base", value: formatUsd(borrowingBase.availableBorrowingBaseCents) },
    { label: "Open Exceptions", value: borrowingBase.exceptionCount.toString() },
    { label: "Advance Rate", value: formatPercentFromBps(borrowingBase.portfolio.advanceRateBps) },
  ];
}

export const SubmissionWorkspace = ({
  submissionId,
  readOnly = false,
  loadLatest = false,
}: SubmissionWorkspaceProps) => {
  const [submission, setSubmission] = useState<FacilitySubmission | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [editingReceivableId, setEditingReceivableId] = useState<string | null>(null);
  const [draftReceivable, setDraftReceivable] = useState<Partial<SubmissionReceivable>>({});
  const [receivablesCsvText, setReceivablesCsvText] = useState("");
  const [evidenceText, setEvidenceText] = useState("");
  const [pendingOperatorCommit, setPendingOperatorCommit] = useState<PendingOperatorCommit | null>(null);
  const [tokenizationForm, setTokenizationForm] = useState({
    offeringLimit: "",
    tokenPrice: "1.00",
    maturityMonths: "36",
    revenueSharePct: "50",
    targetYieldPct: "10",
    immediateProceeds: false,
    protectionEnabled: false,
  });
  const {
    address: accountAddress,
    chainId: accountChainId,
    connectedAddress,
    getSmartWalletClientForChain,
    isSmartWallet,
  } = useTransactingAccount();
  const selectedNetwork = useSelectedNetwork(accountChainId);
  const publicClient = usePublicClient({ chainId: selectedNetwork.id });
  const { writeContractAsync: writeFacilityRegistry } = useWriteContract();
  const writeTokenizationTransaction = useTransactor();
  const partnerAuthAddress = accountAddress;
  const signerAddress = connectedAddress ?? accountAddress;
  const getAuthHeaders = useRobomataApiAuth(partnerAuthAddress);
  const { hasSuiWallet, signAndExecuteOperatorCommit, suiWalletNames } = useSuiOperatorWallet();
  const {
    binding: privySuiBinding,
    error: privySuiBindingError,
    featureEnabled: privySuiBindingFeatureEnabled,
    isEnsuring: isEnsuringPrivySuiBinding,
  } = usePrivySuiWalletBinding({
    chainId: selectedNetwork.id,
    enabled: !readOnly,
    getAuthHeaders,
    partnerAddress: partnerAuthAddress,
    signerAddress,
  });
  const policyArtifact = useMemo(
    () =>
      resolveRobomataFacilityPolicyArtifact({
        facilityId: submission?.facilityMonitoring?.facilityId,
        submissionId: submission?.id ?? submissionId,
      }).artifact,
    [submission?.facilityMonitoring?.facilityId, submission?.id, submissionId],
  );

  const summaryCards = useMemo(
    () => (submission?.computation ? buildSubmissionSummaryCards(submission.computation) : []),
    [submission],
  );
  const isCommitted = submission?.status === "committed" || submission?.evidenceCommit.status === "committed";
  const canMutate = !readOnly && !isCommitted;
  const canRetryPendingOperatorCommit = Boolean(
    submission &&
      pendingOperatorCommit?.submissionId === submission.id &&
      pendingOperatorCommit.rootDigest === submission.evidenceCommit.rootDigest,
  );
  const tokenization = submission?.tokenization;
  const canShowTokenization = Boolean(
    isRobomataTokenizationClientEnabled() && !readOnly && submission?.evidenceCommit.status === "committed",
  );
  const isTokenizationVerificationPending = tokenization?.status === "registered";
  const isTokenized = tokenization?.status === "offering_created";
  const configuredOperatorSuiAddress = submission?.evidenceCommit.facilityOperatorAddress;
  const boundOperatorSuiAddress = privySuiBinding?.suiAddress;
  const operatorSuiAddress =
    boundOperatorSuiAddress && sameSuiAddress(boundOperatorSuiAddress, configuredOperatorSuiAddress)
      ? boundOperatorSuiAddress
      : (configuredOperatorSuiAddress ?? boundOperatorSuiAddress);
  const canRetryTokenizationVerification = Boolean(
    isTokenizationVerificationPending &&
      tokenization?.evm.registryAddress &&
      tokenization.evm.assetId &&
      tokenization.evm.revenueTokenId &&
      tokenization.evm.txHash,
  );

  const loadSubmission = useCallback(async () => {
    setIsLoading(true);
    try {
      if (!partnerAuthAddress) {
        setSubmission(null);
        setIsLoading(false);
        return;
      }

      if (submissionId) {
        const path = `/api/robomata/submissions/${submissionId}`;
        const response = await fetch(path, {
          headers: await getAuthHeaders({ chainId: selectedNetwork.id, method: "GET", path, signerAddress }),
        });
        const payload = await readJsonResponse<{ submission?: FacilitySubmission }>(response);
        if (!response.ok || !payload.submission) throw new Error(payload.error ?? "Failed to load submission.");
        setSubmission(payload.submission);
        setIsLoading(false);
        return;
      }

      if (loadLatest) {
        const path = "/api/robomata/submissions";
        const response = await fetch(path, {
          headers: await getAuthHeaders({ chainId: selectedNetwork.id, method: "GET", path, signerAddress }),
        });
        const payload = await readJsonResponse<{ submissions?: FacilitySubmission[] }>(response);
        if (!response.ok) throw new Error(payload.error ?? "Failed to load submissions.");
        setSubmission(payload.submissions?.[0] ?? null);
      }
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Failed to load submission.");
    } finally {
      setIsLoading(false);
    }
  }, [getAuthHeaders, loadLatest, partnerAuthAddress, selectedNetwork.id, signerAddress, submissionId]);

  useEffect(() => {
    void loadSubmission();
  }, [loadSubmission]);

  useEffect(() => {
    if (!submission?.tokenization?.terms) return;
    const terms = submission.tokenization.terms;
    setTokenizationForm(current => ({
      offeringLimit:
        terms.offeringLimitCents === undefined ? current.offeringLimit : centsToDollarInput(terms.offeringLimitCents),
      tokenPrice: terms.tokenPrice === undefined ? current.tokenPrice : terms.tokenPrice.toFixed(2),
      maturityMonths: terms.maturityMonths === undefined ? current.maturityMonths : String(terms.maturityMonths),
      revenueSharePct:
        terms.revenueShareBps === undefined ? current.revenueSharePct : (terms.revenueShareBps / 100).toString(),
      targetYieldPct:
        terms.targetYieldBps === undefined ? current.targetYieldPct : (terms.targetYieldBps / 100).toString(),
      immediateProceeds: terms.immediateProceeds ?? current.immediateProceeds,
      protectionEnabled: terms.protectionEnabled ?? current.protectionEnabled,
    }));
  }, [submission?.id, submission?.tokenization?.terms]);

  const updateSubmission = async (url: string, init?: RequestInit) => {
    if (!partnerAuthAddress) {
      notification.error("Connect a partner wallet before updating the submission.");
      return false;
    }

    setIsBusy(true);
    try {
      const headers = new Headers(init?.headers);
      const authHeaders = await getAuthHeaders({
        chainId: selectedNetwork.id,
        method: init?.method ?? "GET",
        path: url,
        signerAddress,
      });
      Object.entries(authHeaders).forEach(([key, value]) => headers.set(key, value));
      const response = await fetch(url, { ...init, headers });
      const payload = (await response.json().catch(() => ({}))) as { submission?: FacilitySubmission; error?: string };

      if (!response.ok || !payload.submission) {
        notification.error(payload.error ?? "Submission update failed.");
        return false;
      }

      setSubmission(payload.submission);
      return true;
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Submission update failed.");
      return false;
    } finally {
      setIsBusy(false);
    }
  };

  const importReceivables = async (file: File) => {
    if (!submission) return;
    const formData = new FormData();
    formData.set("file", file);
    const didUpdate = await updateSubmission(`/api/robomata/submissions/${submission.id}/receivables/import`, {
      method: "POST",
      body: formData,
    });
    if (didUpdate) setReceivablesCsvText("");
  };

  const importReceivablesFromText = async () => {
    const csvText = receivablesCsvText.trim();
    if (!csvText) {
      notification.error("Paste receivables CSV before importing.");
      return;
    }

    await importReceivables(new File([csvText], "receivables.csv", { type: "text/csv" }));
  };

  const uploadEvidence = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!submission) return;

    const form = event.currentTarget;
    const formData = new FormData(form);
    const uploadedFile = formData.get("file");
    if (!(uploadedFile instanceof File) || uploadedFile.size === 0) {
      if (!evidenceText.trim()) {
        notification.error("Attach an evidence file or paste evidence text.");
        return;
      }

      const label = String(formData.get("label") ?? "evidence").trim() || "evidence";
      formData.set(
        "file",
        new File([evidenceText], `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.txt`, { type: "text/plain" }),
      );
    }

    const didUpdate = await updateSubmission(`/api/robomata/submissions/${submission.id}/evidence`, {
      method: "POST",
      body: formData,
    });
    if (didUpdate) {
      form.reset();
      setEvidenceText("");
    }
  };

  const recompute = async () => {
    if (!submission) return;
    await updateSubmission(`/api/robomata/submissions/${submission.id}/compute`, { method: "POST" });
  };

  const tokenizationTermsBody = () => ({
    offeringLimitCents: dollarsToCents(tokenizationForm.offeringLimit),
    tokenPrice: Number(tokenizationForm.tokenPrice),
    maturityMonths: Number.parseInt(tokenizationForm.maturityMonths, 10),
    revenueShareBps: Math.round(Number(tokenizationForm.revenueSharePct) * 100),
    targetYieldBps: Math.round(Number(tokenizationForm.targetYieldPct) * 100),
    immediateProceeds: tokenizationForm.immediateProceeds,
    protectionEnabled: tokenizationForm.protectionEnabled,
  });

  const startTokenizationDraft = async () => {
    if (!submission) return;
    await updateSubmission(`/api/robomata/submissions/${submission.id}/tokenization/draft`, { method: "POST" });
  };

  const saveTokenizationTerms = async () => {
    if (!submission) return false;
    return await updateSubmission(`/api/robomata/submissions/${submission.id}/tokenization/terms`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tokenizationTermsBody()),
    });
  };

  const extractTokenizationIds = (logs: { data: Hex; topics: readonly Hex[] }[]) => {
    let assetId: string | undefined;
    let revenueTokenId: string | undefined;

    for (const log of logs) {
      try {
        const event = decodeEventLog({
          abi: facilityRegistryWriteAbi,
          data: log.data,
          topics: [...log.topics] as [Hex, ...Hex[]],
        });
        if (event.eventName === "AssetRegistered") {
          assetId = event.args.assetId.toString();
        }
        if (event.eventName === "RevenueTokenPoolCreated") {
          assetId = event.args.assetId.toString();
          revenueTokenId = event.args.revenueTokenId.toString();
        }
      } catch {
        // Ignore unrelated logs in the same receipt.
      }
    }

    if (!assetId) throw new Error("EVM transaction receipt did not include AssetRegistered.");
    if (!revenueTokenId) throw new Error("EVM transaction receipt did not include RevenueTokenPoolCreated.");
    return { assetId, revenueTokenId };
  };

  const prepareAndSignTokenization = async () => {
    if (!submission) return;
    if (!publicClient) {
      notification.error("Connect to a supported EVM network before tokenizing this facility.");
      return;
    }

    const didSaveTerms = await saveTokenizationTerms();
    if (!didSaveTerms) return;

    setIsBusy(true);
    try {
      const path = `/api/robomata/submissions/${submission.id}/tokenization/prepare`;
      const headers = new Headers({ "content-type": "application/json" });
      const authHeaders = await getAuthHeaders({
        chainId: selectedNetwork.id,
        method: "POST",
        path,
        signerAddress,
      });
      Object.entries(authHeaders).forEach(([key, value]) => headers.set(key, value));
      const prepareResponse = await fetch(path, { method: "POST", headers });
      const prepared = (await prepareResponse.json().catch(() => ({}))) as TokenizationPrepareResponse;
      if (prepared.submission) setSubmission(prepared.submission);
      if (!prepareResponse.ok || !prepared.evmCall?.contractAddress) {
        throw new Error(prepared.error ?? "Facility registry is not deployed for the selected network.");
      }
      const evmCall = prepared.evmCall;

      const txArgs = [
        evmCall.args[0] as `0x${string}`,
        BigInt(evmCall.args[1]),
        BigInt(evmCall.args[2]),
        BigInt(evmCall.args[3]),
        BigInt(evmCall.args[4]),
        BigInt(evmCall.args[5]),
        BigInt(evmCall.args[6]),
        evmCall.args[7],
        evmCall.args[8],
      ] as const;
      const txHash = await writeTokenizationTransaction(async () => {
        if (isSmartWallet) {
          if (!getSmartWalletClientForChain) throw new Error("Smart wallet client is not available.");
          return sendSmartWalletCalls(getSmartWalletClientForChain, selectedNetwork.id, [
            {
              to: evmCall.contractAddress as `0x${string}`,
              data: encodeFunctionData({
                abi: facilityRegistryWriteAbi,
                functionName: "registerAssetAndCreateRevenueTokenPool",
                args: txArgs,
              }),
            },
          ]);
        }

        return writeFacilityRegistry({
          address: evmCall.contractAddress as `0x${string}`,
          abi: facilityRegistryWriteAbi,
          functionName: "registerAssetAndCreateRevenueTokenPool",
          args: txArgs,
        });
      });
      if (!txHash) throw new Error("Facility tokenization transaction was not submitted.");

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      const ids = extractTokenizationIds(receipt.logs);
      const completePath = `/api/robomata/submissions/${submission.id}/tokenization/complete`;
      const completeHeaders = new Headers({ "content-type": "application/json" });
      const completeAuthHeaders = await getAuthHeaders({
        chainId: selectedNetwork.id,
        method: "POST",
        path: completePath,
        signerAddress,
      });
      Object.entries(completeAuthHeaders).forEach(([key, value]) => completeHeaders.set(key, value));
      const completeResponse = await fetch(completePath, {
        method: "POST",
        headers: completeHeaders,
        body: JSON.stringify({
          registryAddress: prepared.evmCall.contractAddress,
          assetId: ids.assetId,
          revenueTokenId: ids.revenueTokenId,
          txHash,
          assetMetadataUri: prepared.assetMetadataUri,
          revenueTokenMetadataUri: prepared.revenueTokenMetadataUri,
        }),
      });
      const completePayload = (await completeResponse.json().catch(() => ({}))) as {
        submission?: FacilitySubmission;
        error?: string;
      };
      if (!completeResponse.ok || !completePayload.submission) {
        throw new Error(completePayload.error ?? "Failed to persist tokenization result.");
      }
      setSubmission(completePayload.submission);
      if (completePayload.submission.tokenization.status === "registered") {
        notification.success("Facility registration submitted; server verification is pending.");
        return;
      }
      notification.success("Facility tokenization completed.");
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Facility tokenization failed.");
    } finally {
      setIsBusy(false);
    }
  };

  const retryTokenizationVerification = async () => {
    if (!submission || !canRetryTokenizationVerification || !tokenization) return;

    setIsBusy(true);
    try {
      const completePath = `/api/robomata/submissions/${submission.id}/tokenization/complete`;
      const completeHeaders = new Headers({ "content-type": "application/json" });
      const completeAuthHeaders = await getAuthHeaders({
        chainId: selectedNetwork.id,
        method: "POST",
        path: completePath,
        signerAddress,
      });
      Object.entries(completeAuthHeaders).forEach(([key, value]) => completeHeaders.set(key, value));
      const completeResponse = await fetch(completePath, {
        method: "POST",
        headers: completeHeaders,
        body: JSON.stringify({
          registryAddress: tokenization.evm.registryAddress,
          assetId: tokenization.evm.assetId,
          revenueTokenId: tokenization.evm.revenueTokenId,
          txHash: tokenization.evm.txHash,
          assetMetadataUri: tokenization.evm.assetMetadataUri,
          revenueTokenMetadataUri: tokenization.evm.revenueTokenMetadataUri,
        }),
      });
      const completePayload = (await completeResponse.json().catch(() => ({}))) as {
        submission?: FacilitySubmission;
        error?: string;
      };
      if (!completeResponse.ok || !completePayload.submission) {
        throw new Error(completePayload.error ?? "Failed to verify tokenization result.");
      }
      setSubmission(completePayload.submission);
      if (completePayload.submission.tokenization.status === "registered") {
        notification.info("Facility registration is still pending server verification.");
        return;
      }
      notification.success("Facility tokenization completed.");
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Facility tokenization verification failed.");
    } finally {
      setIsBusy(false);
    }
  };

  const commitEvidence = async () => {
    if (!submission) return;
    const path = `/api/robomata/submissions/${submission.id}/commit-evidence`;

    if (submission.evidenceCommit.commitMode !== "operator_configured") {
      await updateSubmission(path, { method: "POST" });
      return;
    }

    if (!partnerAuthAddress) {
      notification.error("Connect a partner wallet before committing evidence.");
      return;
    }

    setIsBusy(true);
    try {
      const completeOperatorCommit = async (commit: PendingOperatorCommit) => {
        const isSponsoredCommit = Boolean(
          commit.sponsorSignature || commit.operatorSignature || commit.transactionBytes,
        );
        const completeHeaders = new Headers({ "content-type": "application/json" });
        const completeAuthHeaders = await getAuthHeaders({
          chainId: selectedNetwork.id,
          method: "POST",
          path,
          signerAddress,
        });
        Object.entries(completeAuthHeaders).forEach(([key, value]) => completeHeaders.set(key, value));
        const completeResponse = await fetch(path, {
          method: "POST",
          headers: completeHeaders,
          body: JSON.stringify({
            mode: isSponsoredCommit ? "operator_complete_sponsored" : "operator_complete",
            operatorSignature: commit.operatorSignature,
            sponsorGasObjectId: commit.sponsorGasObjectId,
            sponsorSignature: commit.sponsorSignature,
            transactionBytes: commit.transactionBytes,
            txDigest: commit.txDigest,
            walletAddress: commit.walletAddress,
          }),
        });
        const completePayload = (await completeResponse.json().catch(() => ({}))) as CommitEvidenceResponse;
        if (completePayload.submission) setSubmission(completePayload.submission);
        if (!completeResponse.ok || !completePayload.submission) {
          const errorMessage = completePayload.error ?? "Failed to reconcile the evidence verification.";
          if (
            completePayload.submission?.evidenceCommit.status === "failed" ||
            (errorMessage.includes("Sui transaction") && errorMessage.includes("failed"))
          ) {
            setPendingOperatorCommit(null);
          }
          throw new Error(errorMessage);
        }

        if (completeResponse.status === 202) {
          setPendingOperatorCommit({ ...commit, txDigest: completePayload.txDigest ?? commit.txDigest });
          notification.error(
            completePayload.error ?? "Evidence anchoring is awaiting verification indexing. Retry completion shortly.",
          );
        } else {
          setPendingOperatorCommit(null);
          notification.success(`Evidence committed with ${commit.walletName}.`);
        }
      };

      const releasePreparedOperatorCommit = async (sponsorGasObjectId?: string) => {
        const releaseHeaders = new Headers({ "content-type": "application/json" });
        const releaseAuthHeaders = await getAuthHeaders({
          chainId: selectedNetwork.id,
          method: "POST",
          path,
          signerAddress,
        });
        Object.entries(releaseAuthHeaders).forEach(([key, value]) => releaseHeaders.set(key, value));
        const releaseResponse = await fetch(path, {
          method: "POST",
          headers: releaseHeaders,
          body: JSON.stringify({ mode: "operator_release", sponsorGasObjectId }),
        });
        const releasePayload = (await releaseResponse.json().catch(() => ({}))) as CommitEvidenceResponse;
        if (releasePayload.submission) setSubmission(releasePayload.submission);
        if (!releaseResponse.ok) {
          throw new Error(releasePayload.error ?? "Failed to release the prepared evidence anchor.");
        }
      };

      if (canRetryPendingOperatorCommit && pendingOperatorCommit) {
        await completeOperatorCommit(pendingOperatorCommit);
        return;
      }

      if (submission.evidenceCommit.status === "committing") {
        await completeOperatorCommit({
          submissionId: submission.id,
          rootDigest: submission.evidenceCommit.rootDigest ?? "",
          walletName: "verification wallet",
        });
        return;
      }

      const prepareHeaders = new Headers({ "content-type": "application/json" });
      const prepareAuthHeaders = await getAuthHeaders({
        chainId: selectedNetwork.id,
        method: "POST",
        path,
        signerAddress,
      });
      Object.entries(prepareAuthHeaders).forEach(([key, value]) => prepareHeaders.set(key, value));
      const prepareResponse = await fetch(path, {
        method: "POST",
        headers: prepareHeaders,
        body: JSON.stringify({ mode: "operator_prepare" }),
      });
      const preparePayload = (await prepareResponse.json().catch(() => ({}))) as CommitEvidenceResponse;
      if (!prepareResponse.ok || !preparePayload.submission || !preparePayload.operatorCommit) {
        throw new Error(preparePayload.error ?? "Failed to prepare the evidence anchor for operator signing.");
      }

      setSubmission(preparePayload.submission);
      let signed;
      try {
        signed = await signAndExecuteOperatorCommit(preparePayload.operatorCommit);
      } catch (error) {
        if (shouldReleaseOperatorCommitReservation(error)) {
          await releasePreparedOperatorCommit(preparePayload.operatorCommit.sponsorship?.gasObjectId);
        }
        throw error;
      }
      const pendingCommit = {
        submissionId: submission.id,
        rootDigest: preparePayload.operatorCommit.rootDigest,
        operatorSignature: signed.operatorSignature,
        sponsorGasObjectId: signed.sponsorGasObjectId,
        sponsorSignature: signed.sponsorSignature,
        transactionBytes: signed.transactionBytes,
        txDigest: signed.txDigest,
        walletAddress: signed.walletAddress,
        walletName: signed.walletName,
      };
      setPendingOperatorCommit(pendingCommit);
      await completeOperatorCommit(pendingCommit);
    } catch (error) {
      notification.error(error instanceof Error ? error.message : "Evidence anchoring failed.");
    } finally {
      setIsBusy(false);
    }
  };

  const patchSubmission = async (body: Record<string, unknown>) => {
    if (!submission) return;
    await updateSubmission(`/api/robomata/submissions/${submission.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  if (isLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <span className="loading loading-spinner loading-lg text-primary"></span>
      </div>
    );
  }

  if (!submission) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6">
        <div className="rounded-[2rem] border border-base-300 bg-base-100 p-8 text-center shadow-lg shadow-base-300/30">
          <h1 className="text-3xl font-black tracking-tight text-base-content">No submission available</h1>
          <p className="mt-4 text-base-content/70">
            {readOnly
              ? "Create a borrowing-base submission from the operator workflow first."
              : "Create a submission from the submissions index first."}
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <Link href="/robomata/submissions" className="btn btn-primary rounded-full">
              Open Robomata workspace
            </Link>
            {!readOnly ? null : (
              <Link href="/operator" className="btn btn-outline rounded-full">
                Return to operator dashboard
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30 sm:p-8">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
              {sectionTitle(readOnly)}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <h1 className="text-4xl font-black tracking-tight text-base-content sm:text-5xl">
                {submission.facilityName}
              </h1>
              <span className={`badge ${statusClass(submission.status)} capitalize`}>
                {submission.status.replace(/_/g, " ")}
              </span>
            </div>
            <p className="mt-4 text-lg leading-relaxed text-base-content/70">
              {submission.operatorName} · as of {submission.asOfDate} · {submission.receivables.length} receivables ·{" "}
              {submission.evidence.length} evidence packages
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              {readOnly ? (
                <Link href={`/robomata/submissions/${submission.id}`} className="btn btn-primary rounded-full">
                  Manage in operator workflow
                </Link>
              ) : isCommitted ? (
                <div className="rounded-2xl border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
                  This submission is committed. Create a new submission for additional evidence or receivable changes.
                </div>
              ) : (
                <>
                  <button className="btn btn-primary rounded-full" onClick={recompute} disabled={isBusy}>
                    <ArrowPathIcon className="h-4 w-4" />
                    Compute borrowing base
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:w-[360px]">
            {summaryCards.length > 0 ? (
              summaryCards.map(card => (
                <div key={card.label} className="rounded-2xl border border-base-300 bg-base-200/60 p-4">
                  <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">{card.label}</div>
                  <div className="mt-2 text-2xl font-bold text-base-content">{card.value}</div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-base-300 bg-base-200/50 p-4 text-sm text-base-content/70 sm:col-span-2">
                Import receivables and evidence, then compute the borrowing base to generate lender output and evidence
                commit state.
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1fr_0.9fr]">
        <BorrowingBasePolicyDisclosure policyArtifact={policyArtifact} />
        <OperatorPolicyReviewPanel
          chainId={selectedNetwork.id}
          getAuthHeaders={getAuthHeaders}
          onSubmissionUpdated={setSubmission}
          policyArtifact={policyArtifact}
          signerAddress={signerAddress}
          submission={submission}
        />
      </div>

      <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-6">
          {canMutate ? (
            <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
              <div className="grid gap-6 lg:grid-cols-2">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-base-content/50">
                    <DocumentArrowUpIcon className="h-4 w-4" />
                    Receivables import
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-base-content/70">
                    Upload a lender-borrowing-base style CSV with receivable id, obligor, vehicles, amount, DPD,
                    utilization, insurance, title, and lockbox fields.
                  </p>
                  <label className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-[1.5rem] border border-dashed border-base-300 bg-base-200/40 p-6 text-center text-sm text-base-content/70">
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={event => {
                        const file = event.target.files?.[0];
                        if (file) void importReceivables(file);
                      }}
                    />
                    Click to upload receivables CSV
                  </label>
                  <div className="mt-4">
                    <textarea
                      className="textarea textarea-bordered min-h-36 w-full rounded-xl px-4 py-3 text-sm leading-relaxed"
                      placeholder={`Or paste CSV:\nreceivable,obligor,vehicles,outstanding,dpd,utilization,insured,title,lockbox\nAR-1007,Northstar Delivery Co.,28,386400,12,91,yes,yes,yes`}
                      value={receivablesCsvText}
                      onChange={event => setReceivablesCsvText(event.target.value)}
                    />
                    <button
                      className="btn btn-outline mt-3 rounded-full"
                      type="button"
                      onClick={importReceivablesFromText}
                      disabled={isBusy}
                    >
                      Import pasted CSV
                    </button>
                  </div>
                </div>

                <form className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-5" onSubmit={uploadEvidence}>
                  <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-base-content/50">
                    <CloudArrowUpIcon className="h-4 w-4" />
                    Evidence upload
                  </div>
                  <div className="mt-4 grid gap-3">
                    <input name="file" type="file" className="file-input file-input-bordered w-full rounded-xl" />
                    <input
                      name="label"
                      className="input input-bordered h-11 w-full rounded-xl px-4 text-sm"
                      placeholder="Insurance schedule"
                      required
                    />
                    <input
                      name="source"
                      className="input input-bordered h-11 w-full rounded-xl px-4 text-sm"
                      placeholder="Operator-authorized insurance broker export"
                      required
                    />
                    <input
                      name="scope"
                      className="input input-bordered h-11 w-full rounded-xl px-4 text-sm"
                      placeholder="Insurance"
                      required
                    />
                    <select
                      name="status"
                      className="select select-bordered h-11 w-full rounded-xl px-4 text-sm"
                      defaultValue="pending"
                    >
                      <option value="pending">Pending</option>
                      <option value="verified">Verified</option>
                      <option value="exception">Exception</option>
                    </select>
                    <input
                      name="sealPolicyId"
                      className="input input-bordered h-11 w-full rounded-xl px-4 text-sm"
                      defaultValue="robomata_overflow::facility::seal_approve"
                    />
                    <input
                      name="linkedReceivableIds"
                      className="input input-bordered h-11 w-full rounded-xl px-4 text-sm"
                      placeholder="Linked receivable ids (comma separated)"
                    />
                    <textarea
                      className="textarea textarea-bordered min-h-28 w-full rounded-xl px-4 py-3 text-sm leading-relaxed"
                      placeholder="Or paste authorized evidence text when you do not have a local file handy."
                      value={evidenceText}
                      onChange={event => setEvidenceText(event.target.value)}
                    />
                    <button className="btn btn-primary rounded-full" type="submit" disabled={isBusy}>
                      Upload evidence
                    </button>
                  </div>
                </form>
              </div>
            </section>
          ) : null}

          <section className="overflow-hidden rounded-[2rem] border border-base-300 bg-base-100 shadow-lg shadow-base-300/30">
            <div className="border-b border-base-300 px-6 py-5">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Receivables</p>
              <h2 className="mt-2 text-2xl font-black tracking-tight text-base-content">Collateral under review</h2>
            </div>

            {submission.receivables.length === 0 ? (
              <div className="p-6 text-base-content/70">No receivables imported yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr className="text-xs uppercase tracking-[0.18em] text-base-content/50">
                      <th>Receivable</th>
                      <th>Obligor</th>
                      <th>Amount</th>
                      <th>DPD</th>
                      <th>Status</th>
                      {canMutate ? <th>Actions</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {submission.receivables.map(receivable => {
                      const result = submission.computation?.borrowingBase.receivableResults.find(
                        item => item.id === receivable.id,
                      );
                      const isEditing = editingReceivableId === receivable.id;
                      return (
                        <Fragment key={receivable.id}>
                          <tr key={receivable.id}>
                            <td className="font-semibold text-base-content">{receivable.id}</td>
                            <td>
                              <div className="font-medium text-base-content">{receivable.obligor}</div>
                              <div className="text-xs text-base-content/60">{receivable.vehicleCount} vehicles</div>
                            </td>
                            <td>{formatUsd(receivable.outstandingCents)}</td>
                            <td>{receivable.daysPastDue}</td>
                            <td>
                              <span
                                className={`badge border-0 ${
                                  result?.eligible ? "badge-success text-success-content" : "badge-warning"
                                }`}
                              >
                                {result?.eligible ? "Eligible" : receivable.excluded ? "Excluded" : "Needs review"}
                              </span>
                            </td>
                            {canMutate ? (
                              <td>
                                <div className="flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    className="btn btn-xs btn-outline"
                                    onClick={() => {
                                      setEditingReceivableId(isEditing ? null : receivable.id);
                                      setDraftReceivable(receivable);
                                    }}
                                  >
                                    {isEditing ? "Close edit" : "Edit"}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-xs btn-outline"
                                    onClick={() =>
                                      patchSubmission({
                                        action: "excludeReceivable",
                                        receivableId: receivable.id,
                                        excluded: !receivable.excluded,
                                      })
                                    }
                                  >
                                    {receivable.excluded ? "Reinstate" : "Exclude"}
                                  </button>
                                </div>
                              </td>
                            ) : null}
                          </tr>
                          {canMutate && isEditing ? (
                            <tr key={`${receivable.id}-edit`}>
                              <td colSpan={canMutate ? 6 : 5}>
                                <div className="grid gap-3 rounded-2xl bg-base-200/60 p-4 md:grid-cols-4">
                                  <input
                                    className="input input-bordered"
                                    value={draftReceivable.obligor ?? ""}
                                    onChange={event =>
                                      setDraftReceivable(current => ({ ...current, obligor: event.target.value }))
                                    }
                                  />
                                  <label className="form-control">
                                    <span className="label-text">Outstanding dollars</span>
                                    <input
                                      className="input input-bordered"
                                      type="number"
                                      min="0"
                                      step="0.01"
                                      value={centsToDollarInput(draftReceivable.outstandingCents)}
                                      onChange={event =>
                                        setDraftReceivable(current => ({
                                          ...current,
                                          outstandingCents: dollarsToCents(event.target.value),
                                        }))
                                      }
                                    />
                                  </label>
                                  <input
                                    className="input input-bordered"
                                    type="number"
                                    value={draftReceivable.daysPastDue ?? 0}
                                    onChange={event =>
                                      setDraftReceivable(current => ({
                                        ...current,
                                        daysPastDue: Number(event.target.value),
                                      }))
                                    }
                                  />
                                  <input
                                    className="input input-bordered"
                                    type="number"
                                    value={draftReceivable.utilizationPct ?? 0}
                                    onChange={event =>
                                      setDraftReceivable(current => ({
                                        ...current,
                                        utilizationPct: Number(event.target.value),
                                      }))
                                    }
                                  />
                                  <label className="label cursor-pointer justify-start gap-2">
                                    <input
                                      type="checkbox"
                                      className="checkbox checkbox-sm"
                                      checked={Boolean(draftReceivable.insured)}
                                      onChange={event =>
                                        setDraftReceivable(current => ({ ...current, insured: event.target.checked }))
                                      }
                                    />
                                    <span className="label-text">Insured</span>
                                  </label>
                                  <label className="label cursor-pointer justify-start gap-2">
                                    <input
                                      type="checkbox"
                                      className="checkbox checkbox-sm"
                                      checked={Boolean(draftReceivable.titleClear)}
                                      onChange={event =>
                                        setDraftReceivable(current => ({
                                          ...current,
                                          titleClear: event.target.checked,
                                        }))
                                      }
                                    />
                                    <span className="label-text">Title clear</span>
                                  </label>
                                  <label className="label cursor-pointer justify-start gap-2">
                                    <input
                                      type="checkbox"
                                      className="checkbox checkbox-sm"
                                      checked={Boolean(draftReceivable.lockboxMatched)}
                                      onChange={event =>
                                        setDraftReceivable(current => ({
                                          ...current,
                                          lockboxMatched: event.target.checked,
                                        }))
                                      }
                                    />
                                    <span className="label-text">Lockbox matched</span>
                                  </label>
                                  <div className="flex gap-2">
                                    <button
                                      type="button"
                                      className="btn btn-primary btn-sm rounded-full"
                                      onClick={() =>
                                        patchSubmission({
                                          action: "updateReceivable",
                                          receivableId: receivable.id,
                                          patch: draftReceivable,
                                        }).then(() => setEditingReceivableId(null))
                                      }
                                    >
                                      Save changes
                                    </button>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <div className="space-y-6">
          {!readOnly && submission.evidenceCommit.commitMode === "operator_configured" ? (
            <FlowWalletBalances
              sui={{
                address: operatorSuiAddress,
                flowLabel: "Evidence wallet",
              }}
            />
          ) : null}

          <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
              <ExclamationTriangleIcon className="h-4 w-4" />
              Exceptions and next actions
            </div>
            {submission.exceptions.length === 0 ? (
              <div className="mt-4 text-sm text-base-content/70">
                {!submission.computation
                  ? "No exceptions yet. Compute the submission first."
                  : isCommitted
                    ? "All exceptions were resolved before the evidence root was committed."
                    : "No open exceptions. The submission is ready for lender review."}
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                {submission.exceptions.map(exception => (
                  <div key={exception.id} className="rounded-[1.5rem] border border-base-300 bg-base-200/50 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-semibold text-base-content">{exception.title}</div>
                        <div className="mt-2 text-sm text-base-content/70">{exception.message}</div>
                        <div className="mt-2 text-sm font-medium text-base-content">{exception.nextAction}</div>
                      </div>
                      <span className="badge badge-warning capitalize">{exception.actionStatus}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
              <ShieldCheckIcon className="h-4 w-4" />
              Evidence library
            </div>
            {submission.evidence.length === 0 ? (
              <div className="mt-4 text-sm text-base-content/70">No evidence uploaded yet.</div>
            ) : (
              <div className="mt-4 space-y-4">
                {submission.evidence.map(evidence => (
                  <div key={evidence.id} className="rounded-[1.5rem] border border-base-300 bg-base-200/40 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-semibold text-base-content">{evidence.label}</div>
                        <div className="text-sm text-base-content/70">{evidence.source}</div>
                        <div className="mt-1 text-xs uppercase tracking-[0.16em] text-base-content/50">
                          {evidence.scope}
                        </div>
                      </div>
                      <span className={`badge ${evidence.status === "verified" ? "badge-success" : "badge-warning"}`}>
                        {evidence.status}
                      </span>
                    </div>
                    <div className="mt-3 text-sm text-base-content/70">
                      Uploaded {new Date(evidence.uploadedAt).toLocaleString()} · {evidence.filename}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold uppercase tracking-[0.14em]">
                      <span className="rounded-full bg-base-100 px-3 py-1 text-base-content/60">
                        {evidence.storageBackend === "walrus" ? "Walrus stored" : "Mock storage"}
                      </span>
                      <span className="rounded-full bg-base-100 px-3 py-1 text-base-content/60">
                        {evidence.encryptionBackend === "seal" || evidence.sealEncrypted
                          ? "Seal encrypted"
                          : "Not encrypted"}
                      </span>
                    </div>
                    {canMutate ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {(["verified", "pending", "exception"] as const).map(status => (
                          <button
                            key={status}
                            type="button"
                            className="btn btn-xs btn-outline rounded-full"
                            onClick={() =>
                              patchSubmission({
                                action: "updateEvidenceStatus",
                                evidenceId: evidence.id,
                                status,
                              })
                            }
                          >
                            Mark {status}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <details className="mt-4 rounded-2xl border border-base-300 bg-base-100 p-4">
                      <summary className="cursor-pointer text-sm font-semibold text-base-content">
                        Advanced details
                      </summary>
                      <div className="mt-3 grid gap-3 text-sm text-base-content/70">
                        <div>
                          <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">
                            Committed object digest
                          </div>
                          <div className="mt-1 break-all">{evidence.digest}</div>
                        </div>
                        <div>
                          <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">
                            Plaintext audit digest
                          </div>
                          <div className="mt-1 break-all">{evidence.plaintextDigest}</div>
                        </div>
                        {evidence.ciphertextDigest ? (
                          <div>
                            <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">
                              Seal ciphertext digest
                            </div>
                            <div className="mt-1 break-all">{evidence.ciphertextDigest}</div>
                          </div>
                        ) : null}
                        <div>
                          <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">Walrus object</div>
                          <div className="mt-1 break-all">{evidence.walrusObjectId}</div>
                        </div>
                        {evidence.walrusEventId ? (
                          <div>
                            <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">
                              Walrus certification event
                            </div>
                            <div className="mt-1 break-all">{evidence.walrusEventId}</div>
                          </div>
                        ) : null}
                        <div>
                          <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">Seal policy</div>
                          <div className="mt-1 break-all">{evidence.sealPolicyId}</div>
                        </div>
                        {evidence.sealIdentity ? (
                          <div>
                            <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">
                              Seal identity
                            </div>
                            <div className="mt-1 break-all">{evidence.sealIdentity}</div>
                          </div>
                        ) : null}
                        {evidence.sealPackageId ? (
                          <div>
                            <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">Seal package</div>
                            <div className="mt-1 break-all">{evidence.sealPackageId}</div>
                          </div>
                        ) : null}
                        {evidence.sealKeyServerObjectIds?.length ? (
                          <div>
                            <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">
                              Seal key servers
                            </div>
                            <div className="mt-1 break-all">{evidence.sealKeyServerObjectIds.join(", ")}</div>
                          </div>
                        ) : null}
                        {evidence.sealKeyServerAggregatorUrl ? (
                          <div>
                            <div className="text-xs uppercase tracking-[0.16em] text-base-content/50">
                              Seal aggregator
                            </div>
                            <div className="mt-1 break-all">{evidence.sealKeyServerAggregatorUrl}</div>
                          </div>
                        ) : null}
                      </div>
                    </details>
                  </div>
                ))}
              </div>
            )}
          </section>

          {!readOnly ? (
            <>
              <FacilityMonitoringPanel
                chainId={selectedNetwork.id}
                getAuthHeaders={getAuthHeaders}
                signerAddress={signerAddress}
                submission={submission}
              />
              <AgentSupervisionPanel
                chainId={selectedNetwork.id}
                getAuthHeaders={getAuthHeaders}
                signerAddress={signerAddress}
                submission={submission}
              />
            </>
          ) : null}

          <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
              <CheckCircleIcon className="h-4 w-4" />
              Lender packet and evidence verification
            </div>
            {submission.computation ? (
              <div className="mt-4 space-y-4">
                <div className="rounded-[1.5rem] border border-base-300 bg-base-200/50 p-4">
                  <div className="text-sm font-semibold text-base-content">
                    {submission.computation.lenderPacket.certificateId}
                  </div>
                  <div className="mt-2 text-sm text-base-content/70">
                    {submission.computation.lenderPacket.certificationStatement}
                  </div>
                  <div className="mt-4">
                    <ReviewBoundaryPanel boundary={submission.computation.lenderPacket.reviewBoundary} />
                  </div>
                  {(submission.computation.lenderPacket.diligenceQuestions ?? []).length ? (
                    <div className="mt-4 rounded-2xl border border-base-300 bg-base-100 p-4">
                      <div className="text-sm font-semibold text-base-content">Diligence questions</div>
                      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-base-content/70">
                        {(submission.computation.lenderPacket.diligenceQuestions ?? []).map(item => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-base-content/70">
                    {submission.computation.lenderPacket.borrowerRequests.map(item => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                {!readOnly ? (
                  <PacketSharePanel
                    chainId={selectedNetwork.id}
                    getAuthHeaders={getAuthHeaders}
                    isBusy={isBusy}
                    setIsBusy={setIsBusy}
                    signerAddress={signerAddress}
                    submission={submission}
                  />
                ) : null}
                <div className="rounded-[1.5rem] border border-base-300 bg-base-200/50 p-4">
                  <div className="text-sm font-semibold text-base-content">Evidence verification status</div>
                  <div className="mt-2 text-sm text-base-content/70">
                    {submission.evidenceCommit.status.replace(/_/g, " ")}
                  </div>
                  {submission.evidenceCommit.evidenceRoot ? (
                    <div className="mt-3 text-xs text-base-content/60 break-all">
                      Evidence root: {submission.evidenceCommit.evidenceRoot}
                    </div>
                  ) : null}
                  {submission.evidenceCommit.errorMessage ? (
                    <div className="mt-3 text-sm text-error">{submission.evidenceCommit.errorMessage}</div>
                  ) : null}
                  {!readOnly &&
                  ["configured", "operator_configured"].includes(submission.evidenceCommit.commitMode) &&
                  submission.evidenceCommit.status !== "committed" ? (
                    <button
                      className="btn btn-primary mt-4 rounded-full"
                      onClick={commitEvidence}
                      disabled={
                        isBusy ||
                        (submission.evidenceCommit.commitMode === "operator_configured" &&
                          submission.evidenceCommit.status !== "committing" &&
                          !hasSuiWallet &&
                          !canRetryPendingOperatorCommit)
                      }
                    >
                      {submission.evidenceCommit.status === "committing"
                        ? "Reconcile evidence verification"
                        : submission.evidenceCommit.status === "failed"
                          ? "Retry evidence verification"
                          : submission.evidenceCommit.commitMode === "operator_configured"
                            ? "Sign and anchor evidence"
                            : "Anchor evidence"}
                    </button>
                  ) : null}
                  {!readOnly && submission.evidenceCommit.commitMode === "operator_configured" ? (
                    <div className="mt-3 rounded-2xl border border-info/20 bg-info/10 p-3 text-sm text-base-content/70">
                      <div className="font-semibold text-base-content">
                        Operator-owned evidence anchoring is enabled.
                      </div>
                      {privySuiBindingFeatureEnabled ? (
                        <div className="mt-2">
                          {isEnsuringPrivySuiBinding
                            ? "Creating or locating the operator's verification wallet..."
                            : privySuiBinding
                              ? `Default verification wallet: ${privySuiBinding.suiAddress}`
                              : privySuiBindingError
                                ? `Verification wallet binding is unavailable: ${privySuiBindingError}`
                                : "Verification wallet binding is enabled but no wallet is bound yet."}
                        </div>
                      ) : null}
                      <div className="mt-2">
                        Evidence anchoring currently uses a compatible verification wallet extension
                        {suiWalletNames.length
                          ? ` (${suiWalletNames.join(", ")}).`
                          : ". No compatible verification wallet is available in this browser."}
                      </div>
                      {privySuiBinding?.suiAddress &&
                      submission.evidenceCommit.facilityOperatorAddress &&
                      privySuiBinding.suiAddress.toLowerCase() !==
                        submission.evidenceCommit.facilityOperatorAddress.toLowerCase() ? (
                        <div className="mt-2 text-warning">
                          The bound verification wallet does not match this submission&apos;s configured facility
                          operator. Update the facility operator mapping before using the embedded wallet as the signer.
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {!readOnly &&
                  submission.evidenceCommit.commitMode === "configured" &&
                  submission.evidenceCommit.status === "committing" ? (
                    <div className="mt-4 text-sm text-base-content/70">
                      Evidence anchoring is in progress. If this state becomes stale, retrying will reconcile
                      verification events before another transaction can be sent.
                    </div>
                  ) : null}
                  {!readOnly && submission.evidenceCommit.commitMode === "prepared" ? (
                    <div className="mt-4 text-sm text-base-content/70">
                      Evidence anchoring is prepared, but the runtime is not fully configured yet.
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="mt-4 text-sm text-base-content/70">
                Compute the submission to generate lender packet output and the evidence root preview.
              </div>
            )}
          </section>

          {canShowTokenization ? (
            <section className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-lg shadow-base-300/30">
              <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">
                <ShieldCheckIcon className="h-4 w-4" />
                Robolend handoff and tokenization status
              </div>
              <div className="mt-4 rounded-[1.5rem] border border-base-300 bg-base-200/50 p-4">
                <div className="text-sm font-semibold text-base-content">
                  {isTokenized
                    ? "Facility offering created"
                    : isTokenizationVerificationPending
                      ? "Facility registration is pending verification"
                      : "Committed packet is ready for lender review"}
                </div>
                <div className="mt-2 text-sm text-base-content/70">
                  {isTokenized
                    ? `Asset ${tokenization?.evm.assetId} ${
                        tokenization?.evm.revenueTokenId ? `· revenue token ${tokenization.evm.revenueTokenId}` : ""
                      }`
                    : isTokenizationVerificationPending
                      ? "The EVM transaction was submitted, but the server has not verified the registry events yet. Retry verification before submitting another registration."
                      : "Share the anchored lender packet for Robolend or lender approval before downstream tokenization."}
                </div>
                {tokenization?.anchors.rootDigest ? (
                  <div className="mt-3 space-y-1 text-xs text-base-content/60">
                    <div className="break-all">Root digest: {tokenization.anchors.rootDigest}</div>
                    {tokenization.anchors.facilityCommitment ? (
                      <div className="break-all">Facility commitment: {tokenization.anchors.facilityCommitment}</div>
                    ) : null}
                    {tokenization.anchors.suiTxDigest ? (
                      <div className="break-all">Verification tx: {tokenization.anchors.suiTxDigest}</div>
                    ) : null}
                  </div>
                ) : null}
                {isTokenized || isTokenizationVerificationPending ? (
                  <div className="mt-4 space-y-1 text-xs text-base-content/60">
                    {tokenization?.evm.registryAddress ? (
                      <div className="break-all">Registry: {tokenization.evm.registryAddress}</div>
                    ) : null}
                    {tokenization?.evm.txHash ? (
                      <div className="break-all">EVM tx: {tokenization.evm.txHash}</div>
                    ) : null}
                    {tokenization?.evm.assetMetadataUri ? (
                      <div className="break-all">Asset metadata: {tokenization.evm.assetMetadataUri}</div>
                    ) : null}
                    {isTokenizationVerificationPending ? (
                      <div className="pt-3">
                        <button
                          className="btn btn-outline btn-sm rounded-full"
                          onClick={retryTokenizationVerification}
                          disabled={isBusy || !canRetryTokenizationVerification}
                        >
                          Retry server verification
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : tokenization?.status === "not_started" ? (
                  <div className="mt-4 rounded-2xl border border-base-300 bg-base-100 p-4">
                    <div className="text-sm font-semibold text-base-content">Internal tokenization preview</div>
                    <p className="mt-2 text-sm text-base-content/70">
                      This testnet path remains available for controlled validation. The operator workflow should treat
                      tokenization as a lender-approved downstream step.
                    </p>
                    <button
                      className="btn btn-outline mt-4 rounded-full"
                      onClick={startTokenizationDraft}
                      disabled={isBusy}
                    >
                      Start internal tokenization draft
                    </button>
                  </div>
                ) : (
                  <div className="mt-5 grid gap-4 md:grid-cols-2">
                    <div className="md:col-span-2 rounded-2xl border border-base-300 bg-base-100 p-4 text-sm text-base-content/70">
                      Internal preview controls are available because tokenization is enabled in this environment. Use
                      these only after the packet has been approved for downstream tokenization.
                    </div>
                    <label className="form-control">
                      <span className="label-text mb-1 text-sm font-medium">Offering limit</span>
                      <input
                        className="input input-bordered rounded-full"
                        type="number"
                        min="0"
                        step="0.01"
                        value={tokenizationForm.offeringLimit}
                        onChange={event =>
                          setTokenizationForm(current => ({ ...current, offeringLimit: event.target.value }))
                        }
                      />
                    </label>
                    <label className="form-control">
                      <span className="label-text mb-1 text-sm font-medium">Token price</span>
                      <input
                        className="input input-bordered rounded-full"
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={tokenizationForm.tokenPrice}
                        onChange={event =>
                          setTokenizationForm(current => ({ ...current, tokenPrice: event.target.value }))
                        }
                      />
                    </label>
                    <label className="form-control">
                      <span className="label-text mb-1 text-sm font-medium">Maturity months</span>
                      <input
                        className="input input-bordered rounded-full"
                        type="number"
                        min="1"
                        max="120"
                        value={tokenizationForm.maturityMonths}
                        onChange={event =>
                          setTokenizationForm(current => ({ ...current, maturityMonths: event.target.value }))
                        }
                      />
                    </label>
                    <label className="form-control">
                      <span className="label-text mb-1 text-sm font-medium">Revenue share cap (%)</span>
                      <input
                        className="input input-bordered rounded-full"
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        value={tokenizationForm.revenueSharePct}
                        onChange={event =>
                          setTokenizationForm(current => ({ ...current, revenueSharePct: event.target.value }))
                        }
                      />
                    </label>
                    <label className="form-control">
                      <span className="label-text mb-1 text-sm font-medium">Target yield (%)</span>
                      <input
                        className="input input-bordered rounded-full"
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        value={tokenizationForm.targetYieldPct}
                        onChange={event =>
                          setTokenizationForm(current => ({ ...current, targetYieldPct: event.target.value }))
                        }
                      />
                    </label>
                    <div className="flex flex-col justify-end gap-2">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          className="toggle toggle-primary"
                          type="checkbox"
                          checked={tokenizationForm.immediateProceeds}
                          onChange={event =>
                            setTokenizationForm(current => ({
                              ...current,
                              immediateProceeds: event.target.checked,
                            }))
                          }
                        />
                        Earlier proceeds access
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          className="toggle toggle-primary"
                          type="checkbox"
                          checked={tokenizationForm.protectionEnabled}
                          onChange={event =>
                            setTokenizationForm(current => ({
                              ...current,
                              protectionEnabled: event.target.checked,
                            }))
                          }
                        />
                        Protection buffer
                      </label>
                    </div>
                    <div className="md:col-span-2 flex flex-wrap gap-3">
                      <button
                        className="btn btn-outline rounded-full"
                        onClick={saveTokenizationTerms}
                        disabled={isBusy}
                      >
                        Save terms
                      </button>
                      <button
                        className="btn btn-primary rounded-full"
                        onClick={prepareAndSignTokenization}
                        disabled={isBusy}
                      >
                        Prepare and sign offering
                      </button>
                    </div>
                    {tokenization?.errorMessage ? (
                      <div className="md:col-span-2 text-sm text-error">{tokenization.errorMessage}</div>
                    ) : null}
                  </div>
                )}
              </div>
            </section>
          ) : null}
        </div>
      </section>
    </div>
  );
};
