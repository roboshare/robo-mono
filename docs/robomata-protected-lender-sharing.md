# Robomata Protected Lender Packet Sharing

This document defines the Phase 2 share-link model for Robomata. It follows the
Phase 1 split:

- `/robomata` is a public marketing and product-positioning page.
- `/partner/submissions` is the authenticated operator workspace.
- Protected lender packet links expose one lender-ready packet for one
  submission. They are not public facility discovery.

## Product Intent

Fleet operators need to send a lender-ready packet without giving the lender
operator-workspace access or making facility data public. A share link should
show the current borrowing-base certificate, exception status, evidence status,
and commit status for one `FacilitySubmission`.

The link must be controlled by the operator:

- opaque token, never guessable from submission ids
- expiry
- revocation
- access status
- audit trail
- optional future recipient constraints

## Route Model

Human-facing route:

- `GET /lender/packet/[token]`

API routes:

- `POST /api/robomata/submissions/[id]/share-links`
- `GET /api/robomata/share/[token]`
- `PATCH /api/robomata/submissions/[id]/share-links/[shareLinkId]`

Do not add submission loading to `/robomata`. Do not accept
`/robomata?submission=...` as a share mechanism.

## Feature Flags

Server-side API gate:

- `ROBOMATA_SHARE_LINKS_ENABLED=true`

Client-side UI reveal:

- `NEXT_PUBLIC_ROBOMATA_SHARE_LINKS_ENABLED=true`

Token hashing hardening:

- `ROBOMATA_SHARE_LINK_TOKEN_SECRET`

Production and shared previews should require the server flag and token secret.
The public flag only reveals UI affordances; the API must remain authoritative.

## Data Model

Add `SubmissionShareLink` as a separate model instead of embedding raw tokens in
`FacilitySubmission`.

```ts
export type SubmissionShareLinkStatus = "active" | "revoked" | "expired";

export type SubmissionShareLink = {
  id: string;
  submissionId: string;
  partnerAddress: string;
  creatorPartnerAddress: string;
  creatorPrivyUserId?: string;
  tokenHash: string;
  status: SubmissionShareLinkStatus;
  recipientLabel?: string;
  recipientEmailHash?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  revokedByPartnerAddress?: string;
  lastAccessedAt?: string;
  accessCount: number;
  metadata?: Record<string, string | number | boolean | null>;
};
```

Add share events either as a companion table or embedded event payload:

```ts
export type SubmissionShareLinkAuditEvent = {
  id: string;
  shareLinkId: string;
  submissionId: string;
  type:
    | "packet_share_created"
    | "packet_share_viewed"
    | "packet_share_revoked"
    | "packet_share_expired";
  createdAt: string;
  metadata?: {
    ipHash?: string;
    userAgentHash?: string;
    recipientLabel?: string;
    expiresAt?: string;
  };
};
```

Extend `SubmissionAuditEvent["type"]` with:

- `packet_share_created`
- `packet_share_revoked`

Do not append lender view events directly to the mutable submission payload on
every read unless that write path is concurrency-safe. Prefer the share-link
audit store for view events.

## Persistence

Use a dedicated store:

- `web/lib/robomata/server/submissionShareLinkStore.ts`

Postgres table:

```sql
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

CREATE INDEX IF NOT EXISTS robomata_submission_share_links_submission_idx
  ON robomata_submission_share_links (submission_id);

CREATE INDEX IF NOT EXISTS robomata_submission_share_links_partner_idx
  ON robomata_submission_share_links (partner_address);
```

Audit table:

```sql
CREATE TABLE IF NOT EXISTS robomata_submission_share_link_events (
  id text PRIMARY KEY,
  share_link_id text NOT NULL,
  submission_id text NOT NULL,
  type text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL
);
```

Local development may use a file fallback similar to `ROBOMATA_SUBMISSIONS_FILE`,
but production and shared previews should use Postgres.

## Token Rules

Creation:

- generate at least 32 random bytes
- base64url encode for the URL token
- store only `HMAC-SHA256(token, ROBOMATA_SHARE_LINK_TOKEN_SECRET)`
- return the raw token only in the create response

Resolution:

- hash the presented token
- look up the hash
- reject missing, revoked, expired, or disabled share links
- load the bound submission by `submissionId`
- verify the link partner still owns the submission
- record access metadata in the share-link audit store
- return the redacted lender packet projection

Revocation:

- only the owning partner can revoke
- set `status = "revoked"`
- set `revokedAt` and `revokedByPartnerAddress`
- append `packet_share_revoked` audit events

Expiry:

- default expiry should be short enough for diligence, for example 14 days
- expired links can be derived at read time from `expiresAt`
- a later maintenance job may materialize `status = "expired"`

## Redacted Lender Projection

The public share API must not return the full `FacilitySubmission`. Return a
specific read projection:

```ts
export type SharedLenderPacketView = {
  shareLink: {
    id: string;
    status: SubmissionShareLinkStatus;
    expiresAt: string;
    lastAccessedAt?: string;
    accessCount: number;
  };
  submission: {
    id: string;
    operatorName: string;
    facilityName: string;
    asOfDate: string;
    status: FacilitySubmissionStatus;
    updatedAt: string;
  };
  borrowingBase: SubmissionComputation["borrowingBase"];
  lenderPacket: SubmissionComputation["lenderPacket"];
  exceptions: Array<Pick<SubmissionException, "id" | "severity" | "title" | "message" | "actionStatus">>;
  evidence: Array<{
    id: string;
    filename: string;
    scope: string;
    uploadedAt: string;
    storageBackend: SubmissionStorageBackend;
    encryptionBackend: SubmissionEncryptionBackend;
    status: EvidenceCommitment["status"];
    linkedExceptionIds: string[];
    advanced?: {
      walrusBlobId?: string;
      walrusEventId?: string;
      plaintextDigest: string;
      ciphertextDigest?: string;
      sealPackageId?: string;
      sealIdentity?: string;
      sealThreshold?: number;
      sealKeyServerObjectIds?: string[];
      suiTxDigest?: string;
      evidenceRoot?: string;
    };
  }>;
};
```

Operator-private fields must stay out of the projection:

- partner auth headers and signer metadata
- raw uploaded file bytes
- raw CSV rows beyond normalized packet output
- full audit history unrelated to the share
- mutable workspace actions

Walrus, Seal, Sui, digest, and transaction details should appear only inside an
`Advanced details` disclosure in the lender UI.

## API Behavior

`POST /api/robomata/submissions/[id]/share-links`

- requires `ROBOMATA_SHARE_LINKS_ENABLED`
- requires partner auth
- requires the authenticated partner to own the submission
- requires `submission.computation?.lenderPacket`
- accepts `expiresAt`, `recipientLabel`, and optional future recipient fields
- creates one share link and returns `{ shareLink, url, token }`

`GET /api/robomata/share/[token]`

- requires `ROBOMATA_SHARE_LINKS_ENABLED`
- does not require partner auth
- validates token, status, expiry, and ownership binding
- records a view event
- returns `{ packet: SharedLenderPacketView }`

`PATCH /api/robomata/submissions/[id]/share-links/[shareLinkId]`

- requires `ROBOMATA_SHARE_LINKS_ENABLED`
- requires partner auth
- requires the authenticated partner to own the submission and link
- supports `{ status: "revoked" }`
- should not support changing the token

## UI Behavior

Operator workspace:

- show a `Share lender packet` panel only when the server and client share flags
  are enabled
- create links from the lender packet section after computation exists
- list active, expired, and revoked links
- show expiry, last access, access count, and revoke action
- copy the generated link once after create

Lender route:

- no app navigation that implies workspace access
- show packet status, facility summary, borrowing-base output, exceptions, and
  evidence status
- show expired/revoked states without leaking packet data
- keep technical evidence details inside `Advanced details`

## Security Boundaries

This is controlled sharing, not authentication replacement.

- Treat the token as a bearer secret.
- Do not log raw tokens.
- Do not store raw tokens.
- Avoid placing raw tokens in third-party analytics events.
- Set response headers to discourage indexing and caching.
- Do not include public facility listing endpoints.
- Do not infer public access from Sui facility object ids.

Future hardening can add recipient email constraints, passcodes, lender accounts,
watermarking, and per-document access policies, but those are not Phase 2
requirements.

## Implementation Split

Recommended PR sequence:

1. ROB-145 design/spec: this document.
2. ROB-146 API/model: feature flags, share types, store, token hashing,
   create/list/revoke/resolve APIs, env docs.
3. ROB-147 UI/audit: operator share panel, lender packet token route, reusable
   packet projection components, access status UI.
4. ROB-148 QA: browser QA for public `/robomata`, partner workflow, and
   protected share flow.
5. ROB-149 release readiness: notes and release branch only after QA passes.

## Acceptance Checklist

- `/robomata` remains marketing-only.
- `/partner/submissions` remains the only editable operator workflow.
- Share links expose one lender-ready packet, not every facility.
- Token hashes are stored; raw tokens are returned only once.
- Expired and revoked links fail closed.
- Lender packet projection is redacted by construction.
- Advanced Sui/Walrus/Seal details are hidden by default.
