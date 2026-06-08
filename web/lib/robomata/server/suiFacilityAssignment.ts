import { Transaction } from "@mysten/sui/transactions";
import "server-only";
import {
  isRobomataPrivySuiWalletBindingEnabled,
  isRobomataSuiCommitEnabled,
  isRobomataSuiOperatorCommitEnabled,
  isRobomataSuiSponsorshipEnabled,
} from "~~/lib/featureFlags";
import { ensurePrivySuiWalletBinding } from "~~/lib/robomata/server/privySuiWallets";
import {
  getRobomataSuiClient,
  getRobomataSuiGasBudget,
  getRobomataSuiServerSigner,
  getRobomataSuiTimeoutMs,
} from "~~/lib/robomata/server/suiCommitConfig";
import { type FacilitySubmission } from "~~/lib/robomata/submissions";

type AssignmentStore = {
  beginSuiFacilityAssignment: (
    id: string,
    input: {
      expectedRootDigest: string;
      expectedUpdatedAt: string;
      facilityOperatorAddress: string;
    },
  ) => Promise<FacilitySubmission | null>;
  assignSuiFacility: (
    id: string,
    input: {
      facilityObjectId: string;
      facilityOperatorAddress: string;
      expectedRootDigest: string;
      expectedUpdatedAt: string;
      txDigest?: string;
    },
  ) => Promise<FacilitySubmission | null>;
  failSuiFacilityAssignment: (
    id: string,
    input: {
      errorMessage: string;
      expectedRootDigest: string;
    },
  ) => Promise<FacilitySubmission | null>;
};

type SuiFacilityAssignmentResult =
  | { assigned: true; submission: FacilitySubmission }
  | { assigned: false; submission: FacilitySubmission; reason: string };

function trimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function hasAssignedFacility(submission: FacilitySubmission): boolean {
  return Boolean(submission.evidenceCommit.facilityObjectId && submission.evidenceCommit.facilityOperatorAddress);
}

function normalizeHex(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/^0x/, "") ?? "";
}

function hexToBytes(value: string | undefined): number[] {
  const normalized = normalizeHex(value);
  if (!normalized) return [];

  const padded = normalized.length % 2 === 0 ? normalized : `0${normalized}`;
  return Array.from(Buffer.from(padded, "hex"));
}

function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`Sui facility assignment timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  return Promise.race([operation(controller.signal), timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function isSuiFacilityAssignmentRuntimeConfigured(): boolean {
  return Boolean(
    isRobomataSuiCommitEnabled() &&
      isRobomataSuiOperatorCommitEnabled() &&
      isRobomataSuiSponsorshipEnabled() &&
      isRobomataPrivySuiWalletBindingEnabled() &&
      trimmedEnv("ROBOMATA_SUI_PACKAGE_ID") &&
      getRobomataSuiServerSigner(),
  );
}

function isSubmissionReadyForFacilityAssignment(submission: FacilitySubmission): boolean {
  return Boolean(submission.computation?.borrowingBase && normalizeHex(submission.evidenceCommit.rootDigest));
}

function buildCreateFacilityTransaction(input: {
  operatorAddress: string;
  submission: FacilitySubmission;
  senderAddress: string;
}): Transaction {
  const borrowingBase = input.submission.computation?.borrowingBase;
  const tx = new Transaction();
  tx.setSender(input.senderAddress);
  tx.setGasBudget(getRobomataSuiGasBudget());
  tx.moveCall({
    target: `${process.env.ROBOMATA_SUI_PACKAGE_ID}::facility::create_facility`,
    arguments: [
      tx.pure.address(input.operatorAddress),
      tx.pure.u64(borrowingBase?.grossReceivablesCents ?? 0),
      tx.pure.u64(borrowingBase?.eligibleReceivablesCents ?? 0),
      tx.pure.u64(borrowingBase?.portfolio.advanceRateBps ?? 0),
      tx.pure.u64(borrowingBase?.availableBorrowingBaseCents ?? 0),
      tx.pure.vector("u8", hexToBytes(input.submission.evidenceCommit.rootDigest)),
      tx.object("0x6"),
    ],
  });
  return tx;
}

function getFacilityCreatedPayload(result: unknown): { facility_id?: unknown; operator?: unknown } | null {
  const transaction = (result as { Transaction?: { events?: unknown[] } }).Transaction;
  const event = transaction?.events?.find(candidate => {
    const type =
      (candidate as { eventType?: unknown; type?: unknown }).eventType ?? (candidate as { type?: unknown }).type;
    return typeof type === "string" && type.endsWith("::FacilityCreated");
  });

  if (!event || typeof event !== "object") return null;
  const candidate = event as {
    contents?: { json?: unknown };
    json?: unknown;
    parsedJson?: unknown;
  };
  const payload = candidate.parsedJson ?? candidate.json ?? candidate.contents?.json;
  return payload && typeof payload === "object" ? (payload as { facility_id?: unknown; operator?: unknown }) : null;
}

async function createSuiFacilityForOperator(input: {
  operatorAddress: string;
  submission: FacilitySubmission;
}): Promise<{ facilityObjectId: string; txDigest?: string }> {
  const signer = getRobomataSuiServerSigner();
  if (!signer) throw new Error("ROBOMATA_SUI_PRIVATE_KEY is missing or invalid for Sui facility assignment.");

  const client = getRobomataSuiClient();
  const transaction = buildCreateFacilityTransaction({
    operatorAddress: input.operatorAddress,
    senderAddress: signer.address,
    submission: input.submission,
  });
  const result = await withTimeout(
    signal =>
      client.core.signAndExecuteTransaction({
        signer: signer.keypair,
        transaction,
        include: { effects: true, events: true },
        signal,
      }),
    getRobomataSuiTimeoutMs(),
  );

  if ((result as { FailedTransaction?: { status?: { error?: { message?: string } | string } } }).FailedTransaction) {
    const failed = (result as { FailedTransaction: { status?: { error?: { message?: string } | string } } })
      .FailedTransaction;
    const error = failed.status?.error;
    throw new Error(
      typeof error === "object" && error && "message" in error
        ? String(error.message)
        : `Sui facility assignment failed: ${String(error ?? "unknown error")}`,
    );
  }

  const payload = getFacilityCreatedPayload(result);
  const facilityObjectId = typeof payload?.facility_id === "string" ? payload.facility_id : undefined;
  if (!facilityObjectId) throw new Error("Sui facility creation did not emit FacilityCreated.facility_id.");

  const txDigest = (result as { Transaction?: { digest?: unknown } }).Transaction?.digest;
  return {
    facilityObjectId,
    txDigest: typeof txDigest === "string" ? txDigest : undefined,
  };
}

export async function ensureSubmissionSuiFacility(input: {
  partnerAddress: string;
  privyUserId: string | null;
  store: AssignmentStore;
  submission: FacilitySubmission;
}): Promise<SuiFacilityAssignmentResult> {
  if (hasAssignedFacility(input.submission)) return { assigned: false, submission: input.submission, reason: "exists" };
  if (!isSuiFacilityAssignmentRuntimeConfigured()) {
    return { assigned: false, submission: input.submission, reason: "runtime_not_configured" };
  }
  if (!isSubmissionReadyForFacilityAssignment(input.submission)) {
    return { assigned: false, submission: input.submission, reason: "compute_not_ready" };
  }
  if (!input.privyUserId) return { assigned: false, submission: input.submission, reason: "privy_user_missing" };

  const binding = await ensurePrivySuiWalletBinding({
    partnerAddress: input.partnerAddress,
    privyUserId: input.privyUserId,
  });
  const rootDigest = input.submission.evidenceCommit.rootDigest ?? "";
  const claimed = await input.store.beginSuiFacilityAssignment(input.submission.id, {
    expectedRootDigest: rootDigest,
    expectedUpdatedAt: input.submission.updatedAt,
    facilityOperatorAddress: binding.suiAddress,
  });

  if (!claimed) {
    return { assigned: false, submission: input.submission, reason: "assignment_in_progress_or_changed" };
  }

  let created: { facilityObjectId: string; txDigest?: string };
  try {
    created = await createSuiFacilityForOperator({
      operatorAddress: binding.suiAddress,
      submission: claimed,
    });
  } catch (error) {
    await input.store.failSuiFacilityAssignment(claimed.id, {
      errorMessage: error instanceof Error ? error.message : "Sui facility assignment failed.",
      expectedRootDigest: rootDigest,
    });
    throw error;
  }

  const saved = await input.store.assignSuiFacility(claimed.id, {
    facilityObjectId: created.facilityObjectId,
    facilityOperatorAddress: binding.suiAddress,
    expectedRootDigest: rootDigest,
    expectedUpdatedAt: claimed.updatedAt,
    txDigest: created.txDigest,
  });

  if (!saved) throw new Error("Sui facility was created, but submission persistence did not confirm assignment.");
  return { assigned: true, submission: saved };
}
