import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { isRobomataWalrusUploadsEnabled } from "~~/lib/featureFlags";
import type { SubmissionEvidence, SubmissionStorageBackend } from "~~/lib/robomata/submissions";

const DEFAULT_WALRUS_EPOCHS = 3;
const SEAL_ENCRYPTION_ALGORITHM = "aes-256-gcm";

type WalrusUploadResult = {
  storageBackend: SubmissionStorageBackend;
  walrusBlobId: string;
  walrusObjectId: string;
  walrusEventId?: string;
  aggregatorUrl?: string;
  sealEncrypted: boolean;
  sealEncryptionAlgorithm?: string;
};

type WalrusUploadInput = {
  buffer: Buffer;
  contentType: string;
};

function digestBuffer(buffer: Buffer): string {
  return `0x${createHash("sha256").update(buffer).digest("hex")}`;
}

function parseSealEncryptionKey(): Buffer {
  const raw = process.env.ROBOMATA_SEAL_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error("ROBOMATA_SEAL_ENCRYPTION_KEY is required before real Walrus uploads are enabled.");
  }

  const normalized = raw.startsWith("0x") ? raw.slice(2) : raw;
  const encoding = /^[0-9a-f]+$/i.test(normalized) && normalized.length === 64 ? "hex" : "base64";
  const key = Buffer.from(normalized, encoding);
  if (key.length !== 32) {
    throw new Error("ROBOMATA_SEAL_ENCRYPTION_KEY must decode to a 32-byte key.");
  }

  return key;
}

function buildSealEncryptedEnvelope(input: {
  plaintext: Buffer;
  sealPolicyId: string;
  filename: string;
  contentType: string;
  digest: string;
}): WalrusUploadInput {
  const key = parseSealEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(SEAL_ENCRYPTION_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const envelope = {
    version: 1,
    encryption: {
      algorithm: SEAL_ENCRYPTION_ALGORITHM,
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      sealPolicyId: input.sealPolicyId,
    },
    plaintext: {
      filename: input.filename,
      contentType: input.contentType,
      sha256Digest: input.digest,
    },
    ciphertext: ciphertext.toString("base64"),
  };

  return {
    buffer: Buffer.from(JSON.stringify(envelope), "utf8"),
    contentType: "application/vnd.robomata.seal-envelope+json",
  };
}

async function uploadToWalrus(input: WalrusUploadInput): Promise<WalrusUploadResult> {
  const publisherUrl = process.env.WALRUS_PUBLISHER_URL;

  if (!publisherUrl) {
    throw new Error("WALRUS_PUBLISHER_URL is not configured.");
  }

  const epochs = process.env.WALRUS_STORAGE_EPOCHS ?? DEFAULT_WALRUS_EPOCHS.toString();
  const response = await fetch(`${publisherUrl.replace(/\/$/, "")}/v1/blobs?epochs=${epochs}`, {
    method: "PUT",
    body: input.buffer,
    headers: {
      "content-type": input.contentType,
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
    sealEncrypted: true,
    sealEncryptionAlgorithm: SEAL_ENCRYPTION_ALGORITHM,
  };
}

function buildMockWalrusResult(digest: string): WalrusUploadResult {
  return {
    storageBackend: "walrus-mock",
    walrusBlobId: digest.replace(/^0x/, "").slice(0, 44),
    walrusObjectId: `0x${digest.replace(/^0x/, "").slice(0, 64)}`,
    aggregatorUrl: process.env.WALRUS_AGGREGATOR_URL,
    sealEncrypted: false,
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
  const uploadResult = isRobomataWalrusUploadsEnabled()
    ? await uploadToWalrus(
        buildSealEncryptedEnvelope({
          plaintext: buffer,
          sealPolicyId: input.sealPolicyId,
          filename: input.file.name || "upload",
          contentType: input.file.type || "application/octet-stream",
          digest,
        }),
      )
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
    sealEncrypted: uploadResult.sealEncrypted,
    sealEncryptionAlgorithm: uploadResult.sealEncryptionAlgorithm,
  };
}
