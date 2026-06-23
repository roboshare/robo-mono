import {
  type RobomataBorrowingBasePolicyParameters,
  type RobomataFacilityPolicyArtifact,
  resolveRobomataBorrowingBasePolicyParameters,
} from "~~/lib/robomata/policyRules";

export type EvidenceStatus = "verified" | "exception" | "pending";

export type Receivable = {
  id: string;
  obligor: string;
  vehicleCount: number;
  outstandingCents: number;
  daysPastDue: number;
  utilizationPct: number;
  insured: boolean;
  titleClear: boolean;
  lockboxMatched: boolean;
  manuallyExcluded?: boolean;
};

export type EvidenceCommitment = {
  id: string;
  label: string;
  source: string;
  scope?: string;
  status: EvidenceStatus;
  walrusObjectId: string;
  sealPolicyId: string;
  digest: string;
};

export type FleetPortfolio = {
  operator: string;
  facilityName: string;
  asOfDate: string;
  advanceRateBps: number;
  concentrationLimitPct: number;
  receivables: Receivable[];
  evidence: EvidenceCommitment[];
};

export type ReceivableResult = Receivable & {
  eligible: boolean;
  ineligibleReasons: string[];
};

export type BorrowingBaseResult = {
  portfolio: FleetPortfolio;
  grossReceivablesCents: number;
  eligibleReceivablesCents: number;
  concentrationReserveCents: number;
  advanceRateCents: number;
  availableBorrowingBaseCents: number;
  exceptionCount: number;
  receivableResults: ReceivableResult[];
  evidenceExceptions: EvidenceCommitment[];
};

type CalculateBorrowingBaseOptions = {
  policyArtifact?: RobomataFacilityPolicyArtifact;
};

const demoBorrowingBasePolicy = resolveRobomataBorrowingBasePolicyParameters();

export const demoPortfolio: FleetPortfolio = {
  operator: "MetroFleet Logistics",
  facilityName: "MetroFleet 2026 Fleet Receivables Facility",
  asOfDate: "2026-05-21",
  advanceRateBps: demoBorrowingBasePolicy.advanceRateBps,
  concentrationLimitPct: demoBorrowingBasePolicy.concentrationLimitPct,
  receivables: [
    {
      id: "AR-1007",
      obligor: "Northstar Delivery Co.",
      vehicleCount: 28,
      outstandingCents: 386_400_00,
      daysPastDue: 12,
      utilizationPct: 91,
      insured: true,
      titleClear: true,
      lockboxMatched: true,
    },
    {
      id: "AR-1011",
      obligor: "Cobalt Courier Group",
      vehicleCount: 22,
      outstandingCents: 308_900_00,
      daysPastDue: 28,
      utilizationPct: 84,
      insured: true,
      titleClear: true,
      lockboxMatched: true,
    },
    {
      id: "AR-1016",
      obligor: "Lakefront Field Services",
      vehicleCount: 17,
      outstandingCents: 214_700_00,
      daysPastDue: 48,
      utilizationPct: 76,
      insured: true,
      titleClear: false,
      lockboxMatched: true,
    },
    {
      id: "AR-1022",
      obligor: "Prairie Parts Express",
      vehicleCount: 15,
      outstandingCents: 188_300_00,
      daysPastDue: 9,
      utilizationPct: 88,
      insured: false,
      titleClear: true,
      lockboxMatched: true,
    },
    {
      id: "AR-1029",
      obligor: "Redline Mobile Repair",
      vehicleCount: 10,
      outstandingCents: 141_800_00,
      daysPastDue: 18,
      utilizationPct: 67,
      insured: true,
      titleClear: true,
      lockboxMatched: false,
    },
  ],
  evidence: [
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
  ],
};

function receivablePolicyReasons(
  receivable: Receivable,
  borrowingBasePolicy: RobomataBorrowingBasePolicyParameters,
): string[] {
  const ineligibleReasons: string[] = [];

  if (receivable.manuallyExcluded) ineligibleReasons.push("Manually excluded");
  if (receivable.daysPastDue > borrowingBasePolicy.maxDaysPastDue) {
    ineligibleReasons.push(`Over ${borrowingBasePolicy.maxDaysPastDue} days past due`);
  }
  if (!receivable.insured) ineligibleReasons.push("Insurance evidence exception");
  if (!receivable.titleClear) ineligibleReasons.push("Title or lien evidence exception");
  if (!receivable.lockboxMatched) ineligibleReasons.push("Lockbox cash mapping exception");
  if (receivable.utilizationPct < borrowingBasePolicy.minUtilizationPct) {
    ineligibleReasons.push("Utilization below policy floor");
  }

  return ineligibleReasons;
}

export function calculateBorrowingBase(
  portfolio: FleetPortfolio = demoPortfolio,
  options: CalculateBorrowingBaseOptions = {},
): BorrowingBaseResult {
  const borrowingBasePolicy = resolveRobomataBorrowingBasePolicyParameters({
    artifact: options.policyArtifact,
  });
  const grossReceivablesCents = portfolio.receivables.reduce((sum, receivable) => sum + receivable.outstandingCents, 0);

  const receivableResults = portfolio.receivables.map(receivable => {
    const ineligibleReasons = receivablePolicyReasons(receivable, borrowingBasePolicy);

    return {
      ...receivable,
      eligible: ineligibleReasons.length === 0,
      ineligibleReasons,
    };
  });

  const eligibleReceivablesCents = receivableResults
    .filter(receivable => receivable.eligible)
    .reduce((sum, receivable) => sum + receivable.outstandingCents, 0);
  const concentrationLimitCents = Math.floor((eligibleReceivablesCents * portfolio.concentrationLimitPct) / 100);

  const eligibleExposureByObligor = receivableResults
    .filter(receivable => receivable.eligible)
    .reduce<Map<string, number>>((exposureByObligor, receivable) => {
      exposureByObligor.set(
        receivable.obligor,
        (exposureByObligor.get(receivable.obligor) ?? 0) + receivable.outstandingCents,
      );

      return exposureByObligor;
    }, new Map());

  const concentrationReserveCents = Array.from(eligibleExposureByObligor.values()).reduce(
    (reserveCents, exposureCents) => reserveCents + Math.max(0, exposureCents - concentrationLimitCents),
    0,
  );
  const advanceRateCents = Math.floor((eligibleReceivablesCents * portfolio.advanceRateBps) / 10_000);
  const availableBorrowingBaseCents = Math.max(0, advanceRateCents - concentrationReserveCents);
  const evidenceExceptions = portfolio.evidence.filter(evidence => evidence.status !== "verified");
  const receivableExceptionCount = receivableResults.filter(receivable => !receivable.eligible).length;

  return {
    portfolio,
    grossReceivablesCents,
    eligibleReceivablesCents,
    concentrationReserveCents,
    advanceRateCents,
    availableBorrowingBaseCents,
    exceptionCount: receivableExceptionCount + evidenceExceptions.length,
    receivableResults,
    evidenceExceptions,
  };
}

export function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatPercentFromBps(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}
