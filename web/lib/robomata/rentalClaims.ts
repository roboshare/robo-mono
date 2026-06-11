import type { PlatformVehicleId, ProtocolAssetId } from "~~/lib/robomata/rentalInventory";
import type { RentalSupportActor } from "~~/lib/robomata/rentalSupport";

export type RentalClaimKind =
  | "damage"
  | "late_return"
  | "missing_vehicle"
  | "payment_dispute"
  | "fraud_review"
  | "safety";

export type RentalClaimStatus =
  | "open"
  | "evidence_collection"
  | "adjudicating"
  | "approved"
  | "denied"
  | "settled"
  | "closed";

export type RentalClaimEvidenceItem = {
  id: string;
  kind: "photo" | "condition_report" | "provider_event" | "support_note" | "document";
  uri?: string;
  digest?: `0x${string}`;
  notes?: string;
  capturedAt: string;
  actor?: RentalSupportActor;
};

export type RentalPayoutHoldStatus = "not_held" | "held" | "partially_released" | "released" | "captured";

export type RentalPayoutHold = {
  status: RentalPayoutHoldStatus;
  amountCents?: number;
  reason?: string;
  heldAt?: string;
  releasedAt?: string;
  releaseConditions?: string[];
};

export type RentalClaimRecord = {
  id: string;
  bookingId: string;
  platformVehicleId: PlatformVehicleId;
  facilityAssetId: ProtocolAssetId;
  vehicleAssetId?: ProtocolAssetId;
  kind: RentalClaimKind;
  status: RentalClaimStatus;
  severity: "low" | "medium" | "high";
  openedBy: RentalSupportActor;
  assignedTo?: string;
  evidence: RentalClaimEvidenceItem[];
  payoutHold: RentalPayoutHold;
  adjudicationNotes?: string;
  supportCaseId?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
};

export type RentalClaimCreateInput = {
  kind: RentalClaimKind;
  severity: "low" | "medium" | "high";
  openedBy: RentalSupportActor;
  evidence?: RentalClaimEvidenceItem[];
  payoutHoldAmountCents?: number;
  payoutHoldReason?: string;
  releaseConditions?: string[];
  supportCaseId?: string;
};

export type RentalClaimUpdateInput = {
  assignedTo?: string;
  evidence?: RentalClaimEvidenceItem[];
  payoutHold?: Partial<RentalPayoutHold>;
  status?: RentalClaimStatus;
  adjudicationNotes?: string;
};
