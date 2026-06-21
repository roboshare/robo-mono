import { createHash } from "node:crypto";
import { isRobomataRealEvidenceStorageRequired, isRobomataWalrusUploadsEnabled } from "~~/lib/featureFlags";
import { encryptEvidenceWithSeal, isSealEncryptionConfigured } from "~~/lib/robomata/server/sealEncryption";
import type { SubmissionEvidence, SubmissionStorageBackend } from "~~/lib/robomata/submissions";

const DEFAULT_WALRUS_EPOCHS = 3;
const DEFAULT_WALRUS_UPLOAD_TIMEOUT_MS = 20_000;
const ENCRYPTED_EVIDENCE_CONTENT_TYPE = "application/octet-stream";

type WalrusUploadResult = {
  storageBackend: SubmissionStorageBackend;
  walrusBlobId: string;
  walrusObjectId: string;
  walrusEventId?: string;
  aggregatorUrl?: string;
};

type WalrusUploadInput = {
  buffer: Buffer;
  contentType: string;
};

function digestBuffer(buffer: Buffer): string {
  return `0x${createHash("sha256").update(buffer).digest("hex")}`;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function uploadToWalrus(input: WalrusUploadInput): Promise<WalrusUploadResult> {
  const publisherUrl = process.env.WALRUS_PUBLISHER_URL;

  if (!publisherUrl) {
    throw new Error("WALRUS_PUBLISHER_URL is not configured.");
  }

  const epochs = process.env.WALRUS_STORAGE_EPOCHS ?? DEFAULT_WALRUS_EPOCHS.toString();
  const timeoutMs = parsePositiveInteger(
    process.env.ROBOMATA_WALRUS_UPLOAD_TIMEOUT_MS,
    DEFAULT_WALRUS_UPLOAD_TIMEOUT_MS,
  );
  const uploadUrl = `${publisherUrl.replace(/\/$/, "")}/v1/blobs?epochs=${epochs}`;
  const response = await withTimeout(
    signal =>
      fetch(uploadUrl, {
        method: "PUT",
        body: input.buffer,
        headers: {
          "content-type": input.contentType,
        },
        signal,
      }),
    timeoutMs,
    `Walrus upload timed out after ${timeoutMs}ms.`,
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Walrus upload failed: ${response.status} ${response.statusText} ${details}`);
  }

  const payload = await response.json();
  const newlyCreated = payload?.newlyCreated?.blobObject;
  const alreadyCertified = payload?.alreadyCertified;
  const walrusBlobId = newlyCreated?.blobId ?? alreadyCertified?.blobId;
  const walrusObjectId =
    newlyCreated?.id ??
    alreadyCertified?.blobObject?.id ??
    alreadyCertified?.objectId ??
    (walrusBlobId ? `walrus://blob/${walrusBlobId}` : undefined);
  const walrusEventId = alreadyCertified?.event?.txDigest;

  if (!walrusBlobId || !walrusObjectId) {
    throw new Error("Walrus upload response did not include blob identifiers.");
  }

  return {
    storageBackend: "walrus",
    walrusBlobId,
    walrusObjectId,
    walrusEventId,
    aggregatorUrl: process.env.WALRUS_AGGREGATOR_URL,
  };
}

function buildMockWalrusResult(digest: string): WalrusUploadResult {
  return {
    storageBackend: "walrus-mock",
    walrusBlobId: digest.replace(/^0x/, "").slice(0, 44),
    walrusObjectId: `0x${digest.replace(/^0x/, "").slice(0, 64)}`,
    aggregatorUrl: process.env.WALRUS_AGGREGATOR_URL,
  };
}

export async function createEvidenceRecord(input: {
  file: File;
  label: string;
  source: string;
  scope: string;
  status: SubmissionEvidence["status"];
  sealPolicyId: string;
  sealIdentity?: string;
  linkedReceivableIds?: string[];
}): Promise<SubmissionEvidence> {
  const plaintext = Buffer.from(await input.file.arrayBuffer());
  const plaintextDigest = digestBuffer(plaintext);
  const uploadsEnabled = isRobomataWalrusUploadsEnabled();

  if (isRobomataRealEvidenceStorageRequired() && !uploadsEnabled) {
    throw new Error(
      "Real evidence storage is required for this environment. Set ROBOMATA_WALRUS_UPLOADS_ENABLED=true and configure Walrus/Seal before uploading evidence.",
    );
  }

  if (uploadsEnabled && !isSealEncryptionConfigured(input.sealIdentity)) {
    throw new Error(
      "Seal encryption is required before real Walrus uploads are enabled. Set ROBOMATA_SUI_PACKAGE_ID and a submission facility identity, or explicit ROBOMATA_SEAL_* values.",
    );
  }

  const sealResult = uploadsEnabled
    ? await encryptEvidenceWithSeal({
        plaintext,
        sealIdentity: input.sealIdentity,
        aad: Buffer.from(
          JSON.stringify({
            label: input.label,
            source: input.source,
            scope: input.scope,
            plaintextDigest,
          }),
        ),
      })
    : null;

  const uploadBody = sealResult?.encryptedBytes ?? plaintext;
  const uploadContentType = sealResult
    ? ENCRYPTED_EVIDENCE_CONTENT_TYPE
    : input.file.type || "application/octet-stream";
  const digest = sealResult?.ciphertextDigest ?? plaintextDigest;
  const uploadResult = uploadsEnabled
    ? await uploadToWalrus({ buffer: uploadBody, contentType: uploadContentType })
    : buildMockWalrusResult(digest);

  return {
    id: `evidence_${crypto.randomUUID()}`,
    label: input.label,
    source: input.source,
    scope: input.scope,
    status: input.status,
    walrusObjectId: uploadResult.walrusObjectId,
    walrusBlobId: uploadResult.walrusBlobId,
    walrusEventId: uploadResult.walrusEventId,
    sealPolicyId: input.sealPolicyId,
    digest,
    filename: input.file.name || "upload",
    contentType: input.file.type || "application/octet-stream",
    sizeBytes: input.file.size,
    uploadedAt: new Date().toISOString(),
    linkedReceivableIds: input.linkedReceivableIds ?? [],
    storageBackend: uploadResult.storageBackend,
    encryptionBackend: sealResult ? "seal" : "none",
    aggregatorUrl: uploadResult.aggregatorUrl,
    plaintextDigest,
    ciphertextDigest: sealResult?.ciphertextDigest,
    sealPackageId: sealResult?.sealPackageId,
    sealIdentity: sealResult?.sealIdentity,
    sealThreshold: sealResult?.sealThreshold,
    sealKeyServerObjectIds: sealResult?.sealKeyServerObjectIds,
    sealKeyServerAggregatorUrl: sealResult?.sealKeyServerAggregatorUrl,
  };
}
