import { createHash } from "node:crypto";
import { isRobomataWalrusUploadsEnabled } from "~~/lib/featureFlags";
import type { SubmissionEvidence, SubmissionStorageBackend } from "~~/lib/robomata/submissions";

const DEFAULT_WALRUS_EPOCHS = 3;

type WalrusUploadResult = {
  storageBackend: SubmissionStorageBackend;
  walrusBlobId: string;
  walrusObjectId: string;
  walrusEventId?: string;
  aggregatorUrl?: string;
};

function digestBuffer(buffer: Buffer): string {
  return `0x${createHash("sha256").update(buffer).digest("hex")}`;
}

async function uploadToWalrus(file: File): Promise<WalrusUploadResult> {
  const publisherUrl = process.env.WALRUS_PUBLISHER_URL;

  if (!publisherUrl) {
    throw new Error("WALRUS_PUBLISHER_URL is not configured.");
  }

  const epochs = process.env.WALRUS_STORAGE_EPOCHS ?? DEFAULT_WALRUS_EPOCHS.toString();
  const response = await fetch(`${publisherUrl.replace(/\/$/, "")}/v1/blobs?epochs=${epochs}`, {
    method: "PUT",
    body: Buffer.from(await file.arrayBuffer()),
    headers: {
      "content-type": file.type || "application/octet-stream",
    },
  });

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
  linkedReceivableIds?: string[];
}): Promise<SubmissionEvidence> {
  const buffer = Buffer.from(await input.file.arrayBuffer());
  const digest = digestBuffer(buffer);
  const uploadResult =
    process.env.WALRUS_PUBLISHER_URL && isRobomataWalrusUploadsEnabled()
      ? await uploadToWalrus(input.file)
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
    aggregatorUrl: uploadResult.aggregatorUrl,
  };
}
