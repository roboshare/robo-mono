import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "server-only";
import { isRobomataShareLinksEnabled } from "~~/lib/featureFlags";
import { getRobomataPostgresSql } from "~~/lib/robomata/server/postgres";
import {
  type SubmissionShareLink,
  type SubmissionShareLinkAuditEvent,
  type SubmissionShareLinkStatus,
} from "~~/lib/robomata/shareLinks";
import type { FacilitySubmission } from "~~/lib/robomata/submissions";

export type CreateSubmissionShareLinkInput = {
  submission: FacilitySubmission;
  creatorPartnerAddress: string;
  creatorPrivyUserId?: string;
  recipientLabel?: string;
  recipientEmail?: string;
  expiresAt: string;
};

export type CreateSubmissionShareLinkResult = {
  shareLink: SubmissionShareLink;
  token: string;
};

export type ShareLinkAccessMetadata = {
  ipHash?: string;
  userAgentHash?: string;
};

type SubmissionShareLinkStore = {
  create: (input: CreateSubmissionShareLinkInput) => Promise<CreateSubmissionShareLinkResult>;
  listForSubmission: (submissionId: string, partnerAddress: string) => Promise<SubmissionShareLink[]>;
  getByToken: (token: string) => Promise<SubmissionShareLink | null>;
  recordAccess: (
    shareLink: SubmissionShareLink,
    metadata?: ShareLinkAccessMetadata,
  ) => Promise<SubmissionShareLink | null>;
  revoke: (input: {
    shareLinkId: string;
    submissionId: string;
    partnerAddress: string;
  }) => Promise<SubmissionShareLink | null>;
};

type ShareLinkFileStore = {
  links: SubmissionShareLink[];
  events: SubmissionShareLinkAuditEvent[];
};

let ensuredPostgresTables = false;
let storeSingleton: SubmissionShareLinkStore | null = null;
const fileStoreLocks = new Map<string, Promise<void>>();

function nowIsoString(): string {
  return new Date().toISOString();
}

function createShareLinkId(): string {
  return `share_${randomUUID()}`;
}

function createShareLinkEvent(
  type: SubmissionShareLinkAuditEvent["type"],
  shareLink: Pick<SubmissionShareLink, "id" | "submissionId">,
  metadata?: SubmissionShareLinkAuditEvent["metadata"],
): SubmissionShareLinkAuditEvent {
  return {
    id: `share_audit_${randomUUID()}`,
    shareLinkId: shareLink.id,
    submissionId: shareLink.submissionId,
    type,
    createdAt: nowIsoString(),
    metadata,
  };
}

function getShareLinkTokenSecret(): string {
  const configured = process.env.ROBOMATA_SHARE_LINK_TOKEN_SECRET?.trim();
  if (configured) return configured;

  if (process.env.NODE_ENV === "development") {
    return "robomata-local-share-link-token-secret";
  }

  throw new Error("ROBOMATA_SHARE_LINK_TOKEN_SECRET is required for protected lender packet sharing.");
}

export function createSubmissionShareToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSubmissionShareToken(token: string): string {
  return createHmac("sha256", getShareLinkTokenSecret()).update(token).digest("hex");
}

export function hashShareLinkMetadataValue(value: string): string {
  return createHmac("sha256", getShareLinkTokenSecret()).update(value).digest("hex");
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function hashRecipientEmail(email: string | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return undefined;
  return createHmac("sha256", getShareLinkTokenSecret()).update(normalized).digest("hex");
}

function deriveShareLinkStatus(shareLink: SubmissionShareLink, now = new Date()): SubmissionShareLinkStatus {
  if (shareLink.status === "revoked") return "revoked";
  const expiresAtMs = Date.parse(shareLink.expiresAt);
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= now.getTime()) return "expired";
  return "active";
}

function withDerivedStatus(shareLink: SubmissionShareLink): SubmissionShareLink {
  return { ...shareLink, status: deriveShareLinkStatus(shareLink) };
}

function canRecordAccess(shareLink: SubmissionShareLink): boolean {
  return deriveShareLinkStatus(shareLink) === "active";
}

function hasPostgresConfig() {
  return Boolean(process.env.POSTGRES_URL);
}

function canUseFileStore() {
  return process.env.NODE_ENV === "development";
}

function requireDurableStoreForEnabledSharing() {
  if (!isRobomataShareLinksEnabled()) return;
  if (hasPostgresConfig() || canUseFileStore()) return;

  throw new Error("Robomata share links require POSTGRES_URL outside local development.");
}

function fileStorePath(): string {
  return process.env.ROBOMATA_SHARE_LINKS_FILE || path.join(os.tmpdir(), "robomata-share-links.json");
}

async function readFileStore(filePath: string): Promise<ShareLinkFileStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) return { links: [], events: [] };
    const parsed = JSON.parse(raw) as Partial<ShareLinkFileStore>;
    return { links: parsed.links ?? [], events: parsed.events ?? [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { links: [], events: [] };
    throw error;
  }
}

async function writeFileStore(filePath: string, fileStore: ShareLinkFileStore) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(fileStore, null, 2), "utf8");
}

async function withFileStoreWriteLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileStoreLocks.get(filePath) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = previous.then(() => new Promise<void>(resolve => (release = resolve)));
  fileStoreLocks.set(filePath, current);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (fileStoreLocks.get(filePath) === current) fileStoreLocks.delete(filePath);
  }
}

function createShareLink(input: CreateSubmissionShareLinkInput, token: string): SubmissionShareLink {
  const createdAt = nowIsoString();
  return {
    id: createShareLinkId(),
    submissionId: input.submission.id,
    partnerAddress: input.submission.partnerAddress,
    creatorPartnerAddress: input.creatorPartnerAddress,
    creatorPrivyUserId: input.creatorPrivyUserId,
    tokenHash: hashSubmissionShareToken(token),
    status: "active",
    recipientLabel: normalizeOptionalString(input.recipientLabel),
    recipientEmailHash: hashRecipientEmail(input.recipientEmail),
    expiresAt: input.expiresAt,
    createdAt,
    updatedAt: createdAt,
    accessCount: 0,
  };
}

async function ensurePostgresTables() {
  if (ensuredPostgresTables) return;

  const sql = getRobomataPostgresSql();
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_submission_share_links (
      id text PRIMARY KEY,
      submission_id text NOT NULL,
      partner_address text NOT NULL,
      creator_partner_address text NOT NULL,
      creator_privy_user_id text,
      token_hash text NOT NULL UNIQUE,
      status text NOT NULL,
      recipient_label text,
      recipient_email_hash text,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      revoked_by_partner_address text,
      last_accessed_at timestamptz,
      access_count integer NOT NULL DEFAULT 0,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_submission_share_links_submission_idx
      ON robomata_submission_share_links (submission_id);
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS robomata_submission_share_links_partner_idx
      ON robomata_submission_share_links (partner_address);
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_submission_share_link_events (
      id text PRIMARY KEY,
      share_link_id text NOT NULL,
      submission_id text NOT NULL,
      type text NOT NULL,
      metadata jsonb,
      created_at timestamptz NOT NULL
    );
  `;

  ensuredPostgresTables = true;
}

function createFileStore(): SubmissionShareLinkStore {
  const filePath = fileStorePath();

  return {
    async create(input) {
      const token = createSubmissionShareToken();
      const shareLink = createShareLink(input, token);
      const event = createShareLinkEvent("packet_share_created", shareLink, {
        recipientLabel: shareLink.recipientLabel ?? null,
        expiresAt: shareLink.expiresAt,
      });

      await withFileStoreWriteLock(filePath, async () => {
        const fileStore = await readFileStore(filePath);
        fileStore.links.unshift(shareLink);
        fileStore.events.unshift(event);
        await writeFileStore(filePath, fileStore);
      });

      return { shareLink, token };
    },
    async listForSubmission(submissionId, partnerAddress) {
      const fileStore = await readFileStore(filePath);
      return fileStore.links
        .filter(
          link =>
            link.submissionId === submissionId && link.partnerAddress.toLowerCase() === partnerAddress.toLowerCase(),
        )
        .map(withDerivedStatus)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    async getByToken(token) {
      const tokenHash = hashSubmissionShareToken(token);
      const fileStore = await readFileStore(filePath);
      const shareLink = fileStore.links.find(link => link.tokenHash === tokenHash);
      return shareLink ? withDerivedStatus(shareLink) : null;
    },
    async recordAccess(shareLink, metadata) {
      return withFileStoreWriteLock(filePath, async () => {
        const accessedAt = nowIsoString();
        const fileStore = await readFileStore(filePath);
        let updatedShareLink: SubmissionShareLink | null = null;
        fileStore.links = fileStore.links.map(link => {
          if (link.id !== shareLink.id) return link;
          if (!canRecordAccess(link)) return link;
          updatedShareLink = {
            ...link,
            lastAccessedAt: accessedAt,
            accessCount: link.accessCount + 1,
            updatedAt: accessedAt,
          };
          return updatedShareLink;
        });
        if (!updatedShareLink) return null;
        fileStore.events.unshift(createShareLinkEvent("packet_share_viewed", updatedShareLink, metadata));
        await writeFileStore(filePath, fileStore);
        return withDerivedStatus(updatedShareLink);
      });
    },
    async revoke(input) {
      return withFileStoreWriteLock(filePath, async () => {
        const revokedAt = nowIsoString();
        const fileStore = await readFileStore(filePath);
        let updatedShareLink: SubmissionShareLink | null = null;
        fileStore.links = fileStore.links.map(link => {
          if (
            link.id !== input.shareLinkId ||
            link.submissionId !== input.submissionId ||
            link.partnerAddress.toLowerCase() !== input.partnerAddress.toLowerCase()
          ) {
            return link;
          }
          updatedShareLink = {
            ...link,
            status: "revoked",
            revokedAt,
            revokedByPartnerAddress: input.partnerAddress,
            updatedAt: revokedAt,
          };
          return updatedShareLink;
        });
        if (!updatedShareLink) return null;
        fileStore.events.unshift(createShareLinkEvent("packet_share_revoked", updatedShareLink));
        await writeFileStore(filePath, fileStore);
        return updatedShareLink;
      });
    },
  };
}

function createPostgresStore(): SubmissionShareLinkStore {
  const sql = getRobomataPostgresSql();

  return {
    async create(input) {
      await ensurePostgresTables();
      const token = createSubmissionShareToken();
      const shareLink = createShareLink(input, token);
      const event = createShareLinkEvent("packet_share_created", shareLink, {
        recipientLabel: shareLink.recipientLabel ?? null,
        expiresAt: shareLink.expiresAt,
      });

      await sql.begin(async tx => {
        await tx`
          INSERT INTO robomata_submission_share_links (
            id,
            submission_id,
            partner_address,
            creator_partner_address,
            creator_privy_user_id,
            token_hash,
            status,
            recipient_label,
            recipient_email_hash,
            expires_at,
            access_count,
            payload,
            created_at,
            updated_at
          )
          VALUES (
            ${shareLink.id},
            ${shareLink.submissionId},
            ${shareLink.partnerAddress},
            ${shareLink.creatorPartnerAddress},
            ${shareLink.creatorPrivyUserId ?? null},
            ${shareLink.tokenHash},
            ${shareLink.status},
            ${shareLink.recipientLabel ?? null},
            ${shareLink.recipientEmailHash ?? null},
            ${shareLink.expiresAt}::timestamptz,
            ${shareLink.accessCount},
            ${JSON.stringify(shareLink)}::jsonb,
            ${shareLink.createdAt}::timestamptz,
            ${shareLink.updatedAt}::timestamptz
          );
        `;
        await tx`
          INSERT INTO robomata_submission_share_link_events (id, share_link_id, submission_id, type, metadata, created_at)
          VALUES (
            ${event.id},
            ${event.shareLinkId},
            ${event.submissionId},
            ${event.type},
            ${JSON.stringify(event.metadata ?? {})}::jsonb,
            ${event.createdAt}::timestamptz
          );
        `;
      });

      return { shareLink, token };
    },
    async listForSubmission(submissionId, partnerAddress) {
      await ensurePostgresTables();
      const rows = (await sql`
        SELECT payload
        FROM robomata_submission_share_links
        WHERE submission_id = ${submissionId}
          AND lower(partner_address) = ${partnerAddress.toLowerCase()}
        ORDER BY created_at DESC;
      `) as Array<{ payload: SubmissionShareLink }>;

      return rows.map(row => withDerivedStatus(row.payload));
    },
    async getByToken(token) {
      await ensurePostgresTables();
      const tokenHash = hashSubmissionShareToken(token);
      const rows = (await sql`
        SELECT payload
        FROM robomata_submission_share_links
        WHERE token_hash = ${tokenHash}
        LIMIT 1;
      `) as Array<{ payload: SubmissionShareLink }>;

      const row = rows[0];
      return row ? withDerivedStatus(row.payload) : null;
    },
    async recordAccess(shareLink, metadata) {
      await ensurePostgresTables();
      const accessedAt = nowIsoString();
      const rows = (await sql`
          UPDATE robomata_submission_share_links
          SET
            last_accessed_at = ${accessedAt}::timestamptz,
            access_count = access_count + 1,
            payload = jsonb_set(
              jsonb_set(
                jsonb_set(
                  payload,
                  '{lastAccessedAt}',
                  to_jsonb(${accessedAt}::text)
                ),
                '{accessCount}',
                to_jsonb(access_count + 1)
              ),
              '{updatedAt}',
              to_jsonb(${accessedAt}::text)
            ),
            updated_at = ${accessedAt}::timestamptz
          WHERE id = ${shareLink.id}
            AND status = 'active'
            AND expires_at > now()
          RETURNING payload;
        `) as Array<{ payload: SubmissionShareLink }>;

      const row = rows[0];
      if (!row) return null;

      const nextShareLink = withDerivedStatus(row.payload);
      const event = createShareLinkEvent("packet_share_viewed", nextShareLink, metadata);

      await sql`
          INSERT INTO robomata_submission_share_link_events (id, share_link_id, submission_id, type, metadata, created_at)
          VALUES (
            ${event.id},
            ${event.shareLinkId},
            ${event.submissionId},
            ${event.type},
            ${JSON.stringify(event.metadata ?? {})}::jsonb,
            ${event.createdAt}::timestamptz
          );
        `;

      return nextShareLink;
    },
    async revoke(input) {
      await ensurePostgresTables();
      const revokedAt = nowIsoString();
      const rows = (await sql`
        UPDATE robomata_submission_share_links
        SET
          status = 'revoked',
          revoked_at = ${revokedAt}::timestamptz,
          revoked_by_partner_address = ${input.partnerAddress},
          payload = jsonb_set(
            jsonb_set(
              jsonb_set(
                jsonb_set(payload, '{status}', to_jsonb('revoked'::text)),
                '{revokedAt}',
                to_jsonb(${revokedAt}::text)
              ),
              '{revokedByPartnerAddress}',
              to_jsonb(${input.partnerAddress}::text)
            ),
            '{updatedAt}',
            to_jsonb(${revokedAt}::text)
          ),
          updated_at = ${revokedAt}::timestamptz
        WHERE id = ${input.shareLinkId}
          AND submission_id = ${input.submissionId}
          AND lower(partner_address) = ${input.partnerAddress.toLowerCase()}
        RETURNING payload;
      `) as Array<{ payload: SubmissionShareLink }>;

      const row = rows[0];
      if (!row) return null;

      const event = createShareLinkEvent("packet_share_revoked", row.payload);
      await sql`
        INSERT INTO robomata_submission_share_link_events (id, share_link_id, submission_id, type, metadata, created_at)
        VALUES (
          ${event.id},
          ${event.shareLinkId},
          ${event.submissionId},
          ${event.type},
          ${JSON.stringify(event.metadata ?? {})}::jsonb,
          ${event.createdAt}::timestamptz
        );
      `;

      return withDerivedStatus(row.payload);
    },
  };
}

export function getSubmissionShareLinkStore(): SubmissionShareLinkStore {
  if (!storeSingleton) {
    requireDurableStoreForEnabledSharing();
    storeSingleton = hasPostgresConfig() ? createPostgresStore() : createFileStore();
  }

  return storeSingleton;
}
