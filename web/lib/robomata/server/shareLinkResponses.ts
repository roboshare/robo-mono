import "server-only";
import type { SubmissionShareLink } from "~~/lib/robomata/shareLinks";

export function toShareLinkResponse(shareLink: SubmissionShareLink) {
  return {
    id: shareLink.id,
    submissionId: shareLink.submissionId,
    partnerAddress: shareLink.partnerAddress,
    creatorPartnerAddress: shareLink.creatorPartnerAddress,
    creatorPrivyUserId: shareLink.creatorPrivyUserId,
    status: shareLink.status,
    recipientLabel: shareLink.recipientLabel,
    expiresAt: shareLink.expiresAt,
    createdAt: shareLink.createdAt,
    updatedAt: shareLink.updatedAt,
    revokedAt: shareLink.revokedAt,
    revokedByPartnerAddress: shareLink.revokedByPartnerAddress,
    lastAccessedAt: shareLink.lastAccessedAt,
    accessCount: shareLink.accessCount,
    metadata: shareLink.metadata,
  };
}
