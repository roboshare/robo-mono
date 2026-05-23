export type EvidenceStatus = "verified" | "exception" | "pending";

export type EvidenceCommitment = {
  id: string;
  label: string;
  source: string;
  status: EvidenceStatus;
  walrusObjectId: string;
  sealPolicyId: string;
  digest: string;
};

export type EvidenceAnchor = {
  facilityName: string;
  evidenceRoot: string;
  commitments: EvidenceCommitment[];
  suiPackagePath: string;
  nautilusRole: string;
};

export const demoEvidenceCommitments: EvidenceCommitment[] = [
  {
    id: "EVD-UCC-2026-05",
    label: "UCC / lien search export",
    source: "Commercial lien evidence provider",
    status: "verified",
    walrusObjectId: "walrus://metro-fleet/ucc-lien-2026-05",
    sealPolicyId: "seal://policy/lender-auditor-read",
    digest: "0x89f3f0b4e79fbb5db7a0a087a9d8f2d73354e02f11938fe22a6b819d8db5e0ad",
  },
  {
    id: "EVD-INS-2026-05",
    label: "Insurance schedule",
    source: "Operator-authorized insurance broker export",
    status: "exception",
    walrusObjectId: "walrus://metro-fleet/insurance-schedule-2026-05",
    sealPolicyId: "seal://policy/lender-auditor-read",
    digest: "0x31ce4f8aa06dd63f7de1e9ac8c5ffaf7ed3fc7aeb5c8aa5c067f2f8a211f8409",
  },
  {
    id: "EVD-AGING-2026-05",
    label: "Receivables aging",
    source: "Accounting export",
    status: "verified",
    walrusObjectId: "walrus://metro-fleet/receivables-aging-2026-05",
    sealPolicyId: "seal://policy/lender-auditor-read",
    digest: "0xb814088e82817fc3369ac14cf7d93350c32efaaecedb943d443f5194993df18d",
  },
  {
    id: "EVD-TEL-2026-05",
    label: "Telematics utilization",
    source: "Fleet telematics export",
    status: "pending",
    walrusObjectId: "walrus://metro-fleet/telematics-utilization-2026-05",
    sealPolicyId: "seal://policy/ops-lender-redacted",
    digest: "0x037fd69a5a9874d78db947b4fb5e7df4909299db7a8df731f2a8af8a631a6cf7",
  },
  {
    id: "EVD-LOCKBOX-2026-05",
    label: "Bank lockbox extract",
    source: "Bank reporting export",
    status: "verified",
    walrusObjectId: "walrus://metro-fleet/lockbox-2026-05",
    sealPolicyId: "seal://policy/lender-auditor-read",
    digest: "0xcad6f5fd91121a630769d8728e39f941a95fd505f9837f4816aa67c26d2ba5ef",
  },
];

function canonicalDigest(commitment: EvidenceCommitment): string {
  return commitment.digest.replace(/^0x/i, "").toLowerCase();
}

export function buildEvidenceAnchor(
  facilityName: string,
  commitments: EvidenceCommitment[] = demoEvidenceCommitments,
): EvidenceAnchor {
  return {
    facilityName,
    evidenceRoot: [...commitments]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(canonicalDigest)
      .join(":"),
    commitments,
    suiPackagePath: "protocols/sui::robomata_overflow::facility::commit_evidence",
    nautilusRole:
      "Run authorized offchain checks inside verifiable compute, then commit redacted evidence digests to Sui.",
  };
}

export function getEvidenceExceptions(commitments: EvidenceCommitment[]): EvidenceCommitment[] {
  return commitments.filter(commitment => commitment.status !== "verified");
}
