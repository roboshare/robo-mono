import type {
  PlatformVehicleId,
  ProtocolAssetId,
  RentalVehicleOperationalStatus,
} from "~~/lib/robomata/rentalInventory";

export type RentalStateTransitionActor = "host" | "renter" | "ops" | "system" | "payment_provider";

export type RentalStateTransitionOverrideReason =
  | "support_adjustment"
  | "safety_hold"
  | "fraud_review"
  | "payment_failure"
  | "weather_or_force_majeure"
  | "maintenance_exception"
  | "data_correction";

export type RentalStateTransitionOverride = {
  actor: RentalStateTransitionActor;
  reason: RentalStateTransitionOverrideReason;
  auditEventId: string;
  notes?: string;
  supportCaseId?: string;
};

export type RentalVehicleStateTransition = {
  from: RentalVehicleOperationalStatus;
  to: RentalVehicleOperationalStatus;
  platformVehicleId: PlatformVehicleId;
  facilityAssetId: ProtocolAssetId;
  vehicleAssetId?: ProtocolAssetId;
  actor: RentalStateTransitionActor;
  occurredAt: string;
  override?: RentalStateTransitionOverride;
};

export type RentalBookingLifecycleState =
  | "draft_quote"
  | "pending_renter_verification"
  | "pending_payment_authorization"
  | "host_review"
  | "confirmed"
  | "cancelled"
  | "check_in_open"
  | "in_trip"
  | "return_pending"
  | "completed"
  | "disputed"
  | "closed";

export type RentalBookingStateRecord = {
  bookingId: string;
  platformVehicleId: PlatformVehicleId;
  facilityAssetId: ProtocolAssetId;
  vehicleAssetId?: ProtocolAssetId;
  state: RentalBookingLifecycleState;
  previousState?: RentalBookingLifecycleState;
  stateReason?: string;
  createdAt: string;
  updatedAt: string;
  supportCaseId?: string;
};

export type RentalBookingStateTransition = {
  from: RentalBookingLifecycleState;
  to: RentalBookingLifecycleState;
  bookingId: string;
  platformVehicleId: PlatformVehicleId;
  facilityAssetId: ProtocolAssetId;
  vehicleAssetId?: ProtocolAssetId;
  actor: RentalStateTransitionActor;
  occurredAt: string;
  override?: RentalStateTransitionOverride;
};

export type RentalStateTransitionResult =
  | { allowed: true; overrideRequired: false }
  | { allowed: true; overrideRequired: true; reason: string }
  | { allowed: false; reason: string };

export const RENTAL_VEHICLE_STATE_TRANSITIONS = {
  setup: ["ready", "suspended", "retired"],
  ready: ["listed", "maintenance", "suspended", "retired"],
  listed: ["reserved", "maintenance", "suspended", "delisted"],
  reserved: ["listed", "in_trip"],
  in_trip: ["turnaround", "maintenance", "suspended"],
  turnaround: ["listed", "maintenance", "suspended", "retired"],
  maintenance: ["ready", "listed", "suspended", "retired"],
  suspended: ["ready", "listed", "maintenance", "delisted", "retired"],
  delisted: ["ready", "listed", "retired"],
  retired: [],
} as const satisfies Record<RentalVehicleOperationalStatus, readonly RentalVehicleOperationalStatus[]>;

export const RENTAL_BOOKING_STATE_TRANSITIONS = {
  draft_quote: ["pending_renter_verification", "pending_payment_authorization", "cancelled"],
  pending_renter_verification: ["pending_payment_authorization", "cancelled"],
  pending_payment_authorization: ["host_review", "confirmed", "cancelled"],
  host_review: ["confirmed", "cancelled"],
  confirmed: ["check_in_open", "cancelled", "disputed"],
  cancelled: ["closed", "disputed"],
  check_in_open: ["in_trip", "cancelled", "disputed"],
  in_trip: ["return_pending", "disputed"],
  return_pending: ["completed", "disputed"],
  completed: ["closed", "disputed"],
  disputed: ["closed"],
  closed: [],
} as const satisfies Record<RentalBookingLifecycleState, readonly RentalBookingLifecycleState[]>;

const VEHICLE_OVERRIDE_TRANSITIONS = new Set<string>([
  "listed:maintenance",
  "listed:suspended",
  "reserved:listed",
  "in_trip:maintenance",
  "in_trip:suspended",
  "suspended:listed",
  "delisted:listed",
]);

const BOOKING_OVERRIDE_TRANSITIONS = new Set<string>([
  "confirmed:disputed",
  "cancelled:disputed",
  "check_in_open:cancelled",
  "check_in_open:disputed",
  "in_trip:disputed",
  "return_pending:disputed",
  "completed:disputed",
]);

function transitionKey(from: string, to: string) {
  return `${from}:${to}`;
}

function transitionResult(input: {
  allowed: boolean;
  from: string;
  override?: RentalStateTransitionOverride;
  overrideTransitions: Set<string>;
  to: string;
}): RentalStateTransitionResult {
  if (!input.allowed) {
    return { allowed: false, reason: `Transition ${input.from} -> ${input.to} is not allowed.` };
  }

  if (input.overrideTransitions.has(transitionKey(input.from, input.to)) && !input.override) {
    return {
      allowed: true,
      overrideRequired: true,
      reason: `Transition ${input.from} -> ${input.to} requires an attributable override.`,
    };
  }

  return { allowed: true, overrideRequired: false };
}

export function validateRentalVehicleStateTransition(
  transition: Pick<RentalVehicleStateTransition, "from" | "override" | "to">,
): RentalStateTransitionResult {
  const allowedTransitions = RENTAL_VEHICLE_STATE_TRANSITIONS[
    transition.from
  ] as readonly RentalVehicleOperationalStatus[];
  return transitionResult({
    allowed: allowedTransitions.includes(transition.to),
    from: transition.from,
    override: transition.override,
    overrideTransitions: VEHICLE_OVERRIDE_TRANSITIONS,
    to: transition.to,
  });
}

export function validateRentalBookingStateTransition(
  transition: Pick<RentalBookingStateTransition, "from" | "override" | "to">,
): RentalStateTransitionResult {
  const allowedTransitions = RENTAL_BOOKING_STATE_TRANSITIONS[
    transition.from
  ] as readonly RentalBookingLifecycleState[];
  return transitionResult({
    allowed: allowedTransitions.includes(transition.to),
    from: transition.from,
    override: transition.override,
    overrideTransitions: BOOKING_OVERRIDE_TRANSITIONS,
    to: transition.to,
  });
}

export function expectedVehicleStateForBookingState(
  bookingState: RentalBookingLifecycleState,
): RentalVehicleOperationalStatus | null {
  if (
    ["draft_quote", "pending_renter_verification", "pending_payment_authorization", "host_review"].includes(
      bookingState,
    )
  ) {
    return "listed";
  }
  if (bookingState === "confirmed" || bookingState === "check_in_open") return "reserved";
  if (bookingState === "in_trip" || bookingState === "return_pending") return "in_trip";
  if (bookingState === "completed") return "turnaround";
  return null;
}
