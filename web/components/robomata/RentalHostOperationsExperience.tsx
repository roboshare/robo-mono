"use client";

import { FormEvent, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { ExclamationTriangleIcon, TruckIcon } from "@heroicons/react/24/outline";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
import { useRobomataApiAuth } from "~~/hooks/useRobomataApiAuth";
import type {
  RentalVehicleDateRange,
  RentalVehicleHostControlsUpdate,
  RentalVehicleHostSetupUpdate,
  RentalVehicleMaintenanceHold,
  RentalVehicleRecord,
} from "~~/lib/robomata/rentalInventory";
import type { RentalVehicleConditionRating } from "~~/lib/robomata/rentalTrips";

type ApiResult<T> = T & {
  error?: string;
};

type TripAction = "check-in" | "check-out" | "incident" | "claim";

type OperationalStatusSelection = NonNullable<RentalVehicleHostControlsUpdate["operationalStatus"]> | "keep_current";

const statusOptions: Array<Exclude<OperationalStatusSelection, "keep_current">> = [
  "listed",
  "maintenance",
  "suspended",
  "delisted",
  "retired",
];

const conditionOptions: RentalVehicleConditionRating[] = ["clean", "minor_wear", "damage_reported", "unsafe"];
const checkInConditionOptions = conditionOptions.filter(option => option !== "unsafe");

function currencyFromCents(value?: number) {
  return value ? (value / 100).toFixed(2) : "";
}

function centsFromCurrency(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : undefined;
}

function numberFromInput(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isoFromLocal(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function formatVehicleLabel(vehicle: RentalVehicleRecord) {
  const parts = [vehicle.display.year, vehicle.display.make, vehicle.display.model, vehicle.display.trim].filter(
    Boolean,
  );
  return parts.length > 0 ? parts.join(" ") : vehicle.platformVehicleId;
}

function rangeFromForm(input: {
  current?: RentalVehicleDateRange[];
  endsAt: string;
  prefix: string;
  reason: string;
  startsAt: string;
}): RentalVehicleDateRange[] | undefined {
  const startsAt = isoFromLocal(input.startsAt);
  const endsAt = isoFromLocal(input.endsAt);
  if (!startsAt || !endsAt) return input.current;
  return [
    ...(input.current ?? []),
    {
      id: `${input.prefix}_${Date.now()}`,
      startsAt,
      endsAt,
      reason: input.reason.trim() || undefined,
      createdAt: new Date().toISOString(),
    },
  ];
}

function maintenanceHoldFromForm(input: {
  current?: RentalVehicleMaintenanceHold[];
  endsAt: string;
  reason: string;
  startsAt: string;
}): RentalVehicleMaintenanceHold[] | undefined {
  const startsAt = isoFromLocal(input.startsAt);
  const endsAt = isoFromLocal(input.endsAt);
  if (!startsAt || !endsAt) return input.current;
  return [
    ...(input.current ?? []),
    {
      id: `rmh_${Date.now()}`,
      startsAt,
      endsAt,
      expectedReturnToServiceAt: endsAt,
      reason: input.reason.trim() || undefined,
      createdAt: new Date().toISOString(),
    },
  ];
}

export const RentalHostOperationsExperience = () => {
  const { address: accountAddress } = useAccount();
  const { targetNetwork } = useTargetNetwork();
  const signerAddress = accountAddress;
  const getAuthHeaders = useRobomataApiAuth(accountAddress);
  const [facilityAssetId, setFacilityAssetId] = useState("");
  const [vehicles, setVehicles] = useState<RentalVehicleRecord[]>([]);
  const [selectedVehicleId, setSelectedVehicleId] = useState("");
  const [bookingId, setBookingId] = useState("");
  const [tripAction, setTripAction] = useState<TripAction>("check-in");
  const [condition, setCondition] = useState<RentalVehicleConditionRating>("clean");
  const [odometerMiles, setOdometerMiles] = useState("");
  const [fuelPercent, setFuelPercent] = useState("");
  const [chargePercent, setChargePercent] = useState("");
  const [tripPhotoUri, setTripPhotoUri] = useState("");
  const [tripNotes, setTripNotes] = useState("");
  const [exceptionSeverity, setExceptionSeverity] = useState<"low" | "medium" | "high">("medium");
  const [incidentKind, setIncidentKind] = useState("vehicle_condition");
  const [incidentStatus, setIncidentStatus] = useState("open");
  const [supportCaseId, setSupportCaseId] = useState("");
  const [claimKind, setClaimKind] = useState("damage");
  const [claimSeverity, setClaimSeverity] = useState<"low" | "medium" | "high">("medium");
  const [payoutHoldAmount, setPayoutHoldAmount] = useState("");
  const [setupPhotoUri, setSetupPhotoUri] = useState("");
  const [publicDescription, setPublicDescription] = useState("");
  const [pickupAddress, setPickupAddress] = useState("");
  const [pickupCity, setPickupCity] = useState("");
  const [pickupRegion, setPickupRegion] = useState("");
  const [pickupCountry, setPickupCountry] = useState("US");
  const [dailyRate, setDailyRate] = useState("");
  const [setupMinimumTripDays, setSetupMinimumTripDays] = useState("1");
  const [setupAdvanceNoticeHours, setSetupAdvanceNoticeHours] = useState("");
  const [timezone, setTimezone] = useState("America/Chicago");
  const [instantBook, setInstantBook] = useState(false);
  const [mileageLimit, setMileageLimit] = useState("");
  const [additionalRules, setAdditionalRules] = useState("");
  const [controlDailyRate, setControlDailyRate] = useState("");
  const [controlMinimumTripDays, setControlMinimumTripDays] = useState("");
  const [operationalStatus, setOperationalStatus] = useState<OperationalStatusSelection>("keep_current");
  const [manualApproval, setManualApproval] = useState(false);
  const [maxTripDays, setMaxTripDays] = useState("");
  const [minimumNoticeHours, setMinimumNoticeHours] = useState("");
  const [blackoutStart, setBlackoutStart] = useState("");
  const [blackoutEnd, setBlackoutEnd] = useState("");
  const [blackoutReason, setBlackoutReason] = useState("");
  const [maintenanceStart, setMaintenanceStart] = useState("");
  const [maintenanceEnd, setMaintenanceEnd] = useState("");
  const [maintenanceReason, setMaintenanceReason] = useState("");
  const [safetyReason, setSafetyReason] = useState("");
  const [tripSupportCaseId, setTripSupportCaseId] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedVehicle = vehicles.find(vehicle => vehicle.platformVehicleId === selectedVehicleId) ?? vehicles[0];

  async function rentalApi<T>(path: string, method = "GET", body?: unknown): Promise<ApiResult<T>> {
    if (!accountAddress || !signerAddress) throw new Error("Connect an operator wallet first.");
    const authPath = path.split("?")[0] ?? path;
    const headers = await getAuthHeaders({ chainId: targetNetwork.id, method, path: authPath, signerAddress });
    const response = await fetch(path, {
      method,
      headers: {
        ...headers,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = (await response.json()) as ApiResult<T>;
    if (!response.ok) throw new Error(payload.error ?? `Rental API request failed: ${response.status}`);
    return payload;
  }

  async function loadVehicles() {
    if (!accountAddress) {
      setVehicles([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (facilityAssetId.trim()) params.set("facilityAssetId", facilityAssetId.trim());
      const path = `/api/robomata/rental-inventory/vehicles${params.size > 0 ? `?${params.toString()}` : ""}`;
      const payload = await rentalApi<{ vehicles: RentalVehicleRecord[] }>(path);
      setVehicles(payload.vehicles ?? []);
      setSelectedVehicleId(current =>
        payload.vehicles.some(vehicle => vehicle.platformVehicleId === current)
          ? current
          : (payload.vehicles[0]?.platformVehicleId ?? ""),
      );
      setMessage(`Loaded ${payload.vehicles.length} rental vehicle${payload.vehicles.length === 1 ? "" : "s"}.`);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load rental vehicles.");
      setVehicles([]);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (!selectedVehicle) return;
    const setup = selectedVehicle.hostSetup;
    const controls = selectedVehicle.hostControls;
    setSetupPhotoUri(setup?.photoUris?.[0] ?? selectedVehicle.display.imageUris?.[0] ?? "");
    setPublicDescription(setup?.publicDescription ?? "");
    setPickupAddress(setup?.pickupDropoff?.addressLabel ?? "");
    setPickupCity(setup?.pickupDropoff?.city ?? "");
    setPickupRegion(setup?.pickupDropoff?.region ?? "");
    setPickupCountry(setup?.pickupDropoff?.country ?? "US");
    setDailyRate(currencyFromCents(setup?.pricing?.dailyRateCents));
    setSetupMinimumTripDays(String(setup?.pricing?.minimumTripDays ?? 1));
    setSetupAdvanceNoticeHours(
      setup?.availability?.advanceNoticeHours ? String(setup.availability.advanceNoticeHours) : "",
    );
    setTimezone(setup?.availability?.timezone ?? "America/Chicago");
    setInstantBook(Boolean(setup?.availability?.instantBookEnabled));
    setMileageLimit(setup?.rules?.mileageLimitPerDay ? String(setup.rules.mileageLimitPerDay) : "");
    setAdditionalRules(setup?.rules?.additionalRules ?? "");
    setControlDailyRate(currencyFromCents(controls?.pricing?.dailyRateCents ?? setup?.pricing?.dailyRateCents));
    setControlMinimumTripDays(String(controls?.pricing?.minimumTripDays ?? setup?.pricing?.minimumTripDays ?? 1));
    setOperationalStatus(
      statusOptions.includes(selectedVehicle.operationalStatus as Exclude<OperationalStatusSelection, "keep_current">)
        ? (selectedVehicle.operationalStatus as Exclude<OperationalStatusSelection, "keep_current">)
        : "keep_current",
    );
    setManualApproval(Boolean(controls?.bookingReview.requireManualApproval));
    setMaxTripDays(controls?.bookingReview.maxTripDays ? String(controls.bookingReview.maxTripDays) : "");
    setMinimumNoticeHours(
      controls?.bookingReview.minimumNoticeHours ? String(controls.bookingReview.minimumNoticeHours) : "",
    );
  }, [selectedVehicle]);

  useEffect(() => {
    if (tripAction === "check-in" && condition === "unsafe") {
      setCondition("damage_reported");
    }
  }, [condition, tripAction]);

  async function saveSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedVehicle) return;
    setIsSaving(true);
    setError(null);
    try {
      const existingPhotoUris =
        selectedVehicle.hostSetup?.photoUris && selectedVehicle.hostSetup.photoUris.length > 0
          ? selectedVehicle.hostSetup.photoUris
          : (selectedVehicle.display.imageUris ?? []);
      const existingPickupDropoff = selectedVehicle.hostSetup?.pickupDropoff;
      const primaryPhotoUri = setupPhotoUri.trim();
      const setup: RentalVehicleHostSetupUpdate = {
        photoUris: primaryPhotoUri
          ? [primaryPhotoUri, ...existingPhotoUris.filter(uri => uri !== primaryPhotoUri)]
          : existingPhotoUris,
        publicDescription: publicDescription.trim(),
        pickupDropoff: {
          ...existingPickupDropoff,
          addressLabel: pickupAddress.trim(),
          city: pickupCity.trim() || undefined,
          region: pickupRegion.trim() || undefined,
          country: pickupCountry.trim() || undefined,
          deliveryAvailable: existingPickupDropoff?.deliveryAvailable ?? false,
        },
        pricing: {
          currency: "USD",
          dailyRateCents: centsFromCurrency(dailyRate),
          minimumTripDays: numberFromInput(setupMinimumTripDays),
        },
        availability: {
          timezone: timezone.trim(),
          instantBookEnabled: instantBook,
          advanceNoticeHours: numberFromInput(setupAdvanceNoticeHours),
        },
        rules: {
          mileageLimitPerDay: numberFromInput(mileageLimit),
          additionalRules: additionalRules.trim() || undefined,
        },
      };
      const path = `/api/robomata/rental-inventory/vehicles/${encodeURIComponent(selectedVehicle.platformVehicleId)}/setup`;
      const payload = await rentalApi<{ vehicle: RentalVehicleRecord }>(path, "PATCH", { setup });
      setVehicles(current =>
        current.map(vehicle =>
          vehicle.platformVehicleId === payload.vehicle.platformVehicleId ? payload.vehicle : vehicle,
        ),
      );
      setMessage(`Saved setup for ${formatVehicleLabel(payload.vehicle)}.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save setup.");
    } finally {
      setIsSaving(false);
    }
  }

  async function saveControls(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedVehicle) return;
    setIsSaving(true);
    setError(null);
    try {
      const existingControlsAvailability =
        selectedVehicle.hostControls?.availability ?? selectedVehicle.hostSetup?.availability ?? {};
      const controls: RentalVehicleHostControlsUpdate = {
        pricing: {
          currency: "USD",
          dailyRateCents: centsFromCurrency(controlDailyRate),
          minimumTripDays: numberFromInput(controlMinimumTripDays),
        },
        availability: {
          ...existingControlsAvailability,
          timezone: timezone.trim(),
          instantBookEnabled: instantBook,
        },
        blackoutRanges: rangeFromForm({
          current: selectedVehicle.hostControls?.blackoutRanges,
          startsAt: blackoutStart,
          endsAt: blackoutEnd,
          reason: blackoutReason,
          prefix: "rbo",
        }),
        maintenanceHolds: maintenanceHoldFromForm({
          current: selectedVehicle.hostControls?.maintenanceHolds,
          startsAt: maintenanceStart,
          endsAt: maintenanceEnd,
          reason: maintenanceReason,
        }),
        bookingReview: {
          autoAcceptEnabled: instantBook && !manualApproval,
          requireManualApproval: manualApproval,
          maxTripDays: numberFromInput(maxTripDays),
          minimumNoticeHours: numberFromInput(minimumNoticeHours),
        },
        ...(operationalStatus === "keep_current" ? {} : { operationalStatus }),
      };
      const path = `/api/robomata/rental-inventory/vehicles/${encodeURIComponent(selectedVehicle.platformVehicleId)}/controls`;
      const payload = await rentalApi<{ vehicle: RentalVehicleRecord }>(path, "PATCH", controls);
      setVehicles(current =>
        current.map(vehicle =>
          vehicle.platformVehicleId === payload.vehicle.platformVehicleId ? payload.vehicle : vehicle,
        ),
      );
      setBlackoutStart("");
      setBlackoutEnd("");
      setBlackoutReason("");
      setMaintenanceStart("");
      setMaintenanceEnd("");
      setMaintenanceReason("");
      setMessage(`Saved controls for ${formatVehicleLabel(payload.vehicle)}.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save controls.");
    } finally {
      setIsSaving(false);
    }
  }

  async function performSafetyTakedown() {
    if (!selectedVehicle) return;
    setIsSaving(true);
    setError(null);
    try {
      const path = `/api/robomata/rental-inventory/vehicles/${encodeURIComponent(
        selectedVehicle.platformVehicleId,
      )}/safety-takedown`;
      const payload = await rentalApi<{ vehicle: RentalVehicleRecord }>(path, "POST", {
        reason: safetyReason.trim() || "Operator safety takedown",
        supportCaseId: supportCaseId.trim() || undefined,
      });
      setVehicles(current =>
        current.map(vehicle =>
          vehicle.platformVehicleId === payload.vehicle.platformVehicleId ? payload.vehicle : vehicle,
        ),
      );
      setMessage(`${formatVehicleLabel(payload.vehicle)} is suspended from rental availability.`);
    } catch (takedownError) {
      setError(takedownError instanceof Error ? takedownError.message : "Failed to perform safety takedown.");
    } finally {
      setIsSaving(false);
    }
  }

  async function submitTripAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bookingId.trim()) {
      setError("Booking ID is required.");
      return;
    }
    if (tripAction === "check-in" && condition === "unsafe") {
      setError("Unsafe check-ins must be blocked before handoff. Suspend the vehicle or record an incident instead.");
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const normalizedBookingId = encodeURIComponent(bookingId.trim());
      const actor = { id: accountAddress ?? "operator", role: "ops" as const };
      let path = `/api/robomata/rental-bookings/${normalizedBookingId}/${tripAction}`;
      let body: unknown;
      if (tripAction === "check-in" || tripAction === "check-out") {
        body = {
          actor: accountAddress,
          condition,
          photoUris: tripPhotoUri.trim() ? [tripPhotoUri.trim()] : [],
          odometerMiles: numberFromInput(odometerMiles),
          fuelPercent: numberFromInput(fuelPercent),
          chargePercent: numberFromInput(chargePercent),
          notes: tripNotes.trim() || undefined,
          ...(tripAction === "check-out" && (condition === "damage_reported" || condition === "unsafe")
            ? {
                exception: {
                  kind: condition === "unsafe" ? "safety" : "damage",
                  severity: condition === "unsafe" ? "high" : exceptionSeverity,
                  notes: tripNotes.trim() || undefined,
                  claimRecommended: true,
                  disputeRecommended: true,
                },
              }
            : {}),
        };
      } else if (tripAction === "incident") {
        path = `/api/robomata/rental-bookings/${normalizedBookingId}/incidents`;
        body = {
          actor,
          kind: incidentKind,
          status: incidentStatus,
          notes: tripNotes.trim() || undefined,
          supportCaseId: tripSupportCaseId.trim() || undefined,
        };
      } else {
        path = `/api/robomata/rental-bookings/${normalizedBookingId}/claims`;
        body = {
          openedBy: actor,
          kind: claimKind,
          severity: claimSeverity,
          payoutHoldAmountCents: centsFromCurrency(payoutHoldAmount),
          payoutHoldReason: tripNotes.trim() || "Rental claim opened from host operations",
          releaseConditions: ["Ops adjudication completed", "Renter evidence review completed"],
          supportCaseId: tripSupportCaseId.trim() || undefined,
          evidence: tripPhotoUri.trim()
            ? [
                {
                  id: `rce_${Date.now()}`,
                  kind: "photo",
                  uri: tripPhotoUri.trim(),
                  notes: tripNotes.trim() || undefined,
                  capturedAt: new Date().toISOString(),
                  actor,
                },
              ]
            : undefined,
        };
      }
      const payload = await rentalApi<{ booking?: { platformVehicleId?: string } }>(path, "POST", body);
      if (payload.booking?.platformVehicleId) {
        const vehiclePath = `/api/robomata/rental-inventory/vehicles?platformVehicleId=${encodeURIComponent(
          payload.booking.platformVehicleId,
        )}`;
        const vehiclePayload = await rentalApi<{ vehicles: RentalVehicleRecord[] }>(vehiclePath);
        const refreshedVehicle = vehiclePayload.vehicles[0];
        if (refreshedVehicle) {
          setVehicles(current =>
            current.map(vehicle =>
              vehicle.platformVehicleId === refreshedVehicle.platformVehicleId ? refreshedVehicle : vehicle,
            ),
          );
        }
      }
      setMessage(`Recorded ${tripAction.replace("-", " ")} for booking ${bookingId.trim()}.`);
    } catch (tripError) {
      setError(tripError instanceof Error ? tripError.message : "Failed to record trip operation.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <section className="overflow-hidden rounded-[2rem] border border-base-300 bg-base-100 shadow-xl shadow-base-300/30">
        <div className="grid gap-6 bg-gradient-to-br from-slate-950 via-slate-900 to-emerald-950 p-8 text-white lg:grid-cols-[1fr_22rem]">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.32em] text-emerald-200/80">Rental operations</p>
            <h1 className="mt-4 max-w-3xl text-4xl font-black tracking-tight sm:text-5xl">
              Turn facility inventory into controlled, rentable vehicles.
            </h1>
            <p className="mt-4 max-w-3xl text-base text-slate-200">
              Manage setup completeness, listing controls, safety status, trip handoff, incidents, and claims from the
              same partner-authorized workspace keyed by <code>platformVehicleId</code>.
            </p>
          </div>
          <div className="rounded-[1.5rem] border border-white/10 bg-white/10 p-5 backdrop-blur">
            <p className="text-sm font-semibold text-emerald-100">Operator context</p>
            <p className="mt-2 break-all text-sm text-slate-200">
              {accountAddress ?? "Connect wallet to load vehicles"}
            </p>
            <p className="mt-4 text-xs uppercase tracking-[0.2em] text-slate-400">Network</p>
            <p className="text-sm text-slate-100">{targetNetwork.name}</p>
          </div>
        </div>
      </section>

      {message && <div className="alert alert-success shadow-sm">{message}</div>}
      {error && (
        <div className="alert alert-error shadow-sm">
          <ExclamationTriangleIcon className="h-5 w-5" />
          <span>{error}</span>
        </div>
      )}

      <section className="grid gap-5 lg:grid-cols-[22rem_1fr]">
        <aside className="rounded-[1.5rem] border border-base-300 bg-base-100 p-5 shadow-lg shadow-base-300/20">
          <form
            className="flex flex-col gap-3"
            onSubmit={event => {
              event.preventDefault();
              void loadVehicles();
            }}
          >
            <label className="form-control">
              <span className="label-text font-semibold">Facility asset ID</span>
              <input
                className="input input-bordered"
                placeholder="Optional filter"
                value={facilityAssetId}
                onChange={event => setFacilityAssetId(event.target.value)}
              />
            </label>
            <button className="btn btn-primary" disabled={!accountAddress || isLoading} type="submit">
              {isLoading ? "Loading..." : "Load rental vehicles"}
            </button>
          </form>

          <div className="mt-5 flex flex-col gap-2">
            {vehicles.map(vehicle => (
              <button
                className={`rounded-2xl border p-4 text-left transition ${
                  selectedVehicle?.platformVehicleId === vehicle.platformVehicleId
                    ? "border-primary bg-primary/10"
                    : "border-base-300 bg-base-200/40 hover:border-primary/50"
                }`}
                key={vehicle.platformVehicleId}
                onClick={() => setSelectedVehicleId(vehicle.platformVehicleId)}
                type="button"
              >
                <div className="flex items-center gap-3">
                  <TruckIcon className="h-5 w-5 text-primary" />
                  <div>
                    <p className="font-bold">{formatVehicleLabel(vehicle)}</p>
                    <p className="text-xs text-base-content/60">{vehicle.platformVehicleId}</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  <span className="badge badge-outline">{vehicle.operationalStatus}</span>
                  <span className="badge badge-outline">{vehicle.hostSetup?.status ?? "setup not started"}</span>
                </div>
              </button>
            ))}
            {vehicles.length === 0 && (
              <div className="rounded-2xl border border-dashed border-base-300 p-5 text-sm text-base-content/60">
                No rental vehicles loaded yet.
              </div>
            )}
          </div>
        </aside>

        <div className="flex flex-col gap-5">
          {selectedVehicle ? (
            <>
              <section className="rounded-[1.5rem] border border-base-300 bg-base-100 p-5 shadow-lg shadow-base-300/20">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.24em] text-base-content/50">
                      Selected vehicle
                    </p>
                    <h2 className="mt-2 text-2xl font-black">{formatVehicleLabel(selectedVehicle)}</h2>
                    <p className="text-sm text-base-content/60">
                      Facility {selectedVehicle.facilityAssetId}
                      {selectedVehicle.vehicleAssetId ? ` / Vehicle asset ${selectedVehicle.vehicleAssetId}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <span className="badge badge-primary">{selectedVehicle.operationalStatus}</span>
                    <span className="badge badge-outline">{selectedVehicle.hostSetup?.status ?? "not_started"}</span>
                  </div>
                </div>
                {selectedVehicle.hostSetup?.validationErrors?.length ? (
                  <div className="mt-4 rounded-2xl bg-warning/10 p-4 text-sm">
                    <p className="font-bold text-warning-content">Setup blockers</p>
                    <ul className="mt-2 list-disc pl-5">
                      {selectedVehicle.hostSetup.validationErrors.map(item => (
                        <li key={`${item.field}-${item.message}`}>{item.message}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>

              <section className="grid gap-5 xl:grid-cols-2">
                <form
                  className="rounded-[1.5rem] border border-base-300 bg-base-100 p-5 shadow-lg shadow-base-300/20"
                  onSubmit={event => void saveSetup(event)}
                >
                  <h3 className="text-xl font-black">Host setup</h3>
                  <p className="mt-1 text-sm text-base-content/60">Complete the listing prerequisites for this car.</p>
                  <div className="mt-5 grid gap-3">
                    <input
                      className="input input-bordered"
                      placeholder="Public photo URI"
                      value={setupPhotoUri}
                      onChange={event => setSetupPhotoUri(event.target.value)}
                    />
                    <textarea
                      className="textarea textarea-bordered min-h-24"
                      placeholder="Public description"
                      value={publicDescription}
                      onChange={event => setPublicDescription(event.target.value)}
                    />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <input
                        className="input input-bordered"
                        placeholder="Pickup address"
                        value={pickupAddress}
                        onChange={event => setPickupAddress(event.target.value)}
                      />
                      <input
                        className="input input-bordered"
                        placeholder="City"
                        value={pickupCity}
                        onChange={event => setPickupCity(event.target.value)}
                      />
                      <input
                        className="input input-bordered"
                        placeholder="Region"
                        value={pickupRegion}
                        onChange={event => setPickupRegion(event.target.value)}
                      />
                      <input
                        className="input input-bordered"
                        placeholder="Country"
                        value={pickupCountry}
                        onChange={event => setPickupCountry(event.target.value)}
                      />
                      <input
                        className="input input-bordered"
                        placeholder="Daily rate USD"
                        value={dailyRate}
                        onChange={event => setDailyRate(event.target.value)}
                      />
                      <input
                        className="input input-bordered"
                        placeholder="Minimum trip days"
                        value={setupMinimumTripDays}
                        onChange={event => setSetupMinimumTripDays(event.target.value)}
                      />
                      <input
                        className="input input-bordered"
                        placeholder="Timezone"
                        value={timezone}
                        onChange={event => setTimezone(event.target.value)}
                      />
                      <input
                        className="input input-bordered"
                        placeholder="Setup advance notice hours"
                        value={setupAdvanceNoticeHours}
                        onChange={event => setSetupAdvanceNoticeHours(event.target.value)}
                      />
                      <input
                        className="input input-bordered"
                        placeholder="Mileage limit/day"
                        value={mileageLimit}
                        onChange={event => setMileageLimit(event.target.value)}
                      />
                    </div>
                    <textarea
                      className="textarea textarea-bordered"
                      placeholder="Additional rules"
                      value={additionalRules}
                      onChange={event => setAdditionalRules(event.target.value)}
                    />
                    <label className="label cursor-pointer justify-start gap-3">
                      <input
                        className="toggle toggle-primary"
                        type="checkbox"
                        checked={instantBook}
                        onChange={event => setInstantBook(event.target.checked)}
                      />
                      <span className="label-text">Instant book eligible</span>
                    </label>
                  </div>
                  <button className="btn btn-primary mt-5" disabled={isSaving} type="submit">
                    Save setup
                  </button>
                </form>

                <form
                  className="rounded-[1.5rem] border border-base-300 bg-base-100 p-5 shadow-lg shadow-base-300/20"
                  onSubmit={event => void saveControls(event)}
                >
                  <h3 className="text-xl font-black">Listing controls</h3>
                  <p className="mt-1 text-sm text-base-content/60">
                    Update pricing, availability, review rules, and status.
                  </p>
                  <div className="mt-5 grid gap-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <input
                        className="input input-bordered"
                        placeholder="Daily rate USD"
                        value={controlDailyRate}
                        onChange={event => setControlDailyRate(event.target.value)}
                      />
                      <select
                        className="select select-bordered"
                        value={operationalStatus}
                        onChange={event => setOperationalStatus(event.target.value as OperationalStatusSelection)}
                      >
                        <option value="keep_current">Keep current status ({selectedVehicle.operationalStatus})</option>
                        {statusOptions.map(status => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                      <input
                        className="input input-bordered"
                        placeholder="Max trip days"
                        value={maxTripDays}
                        onChange={event => setMaxTripDays(event.target.value)}
                      />
                      <input
                        className="input input-bordered"
                        placeholder="Controls minimum trip days"
                        value={controlMinimumTripDays}
                        onChange={event => setControlMinimumTripDays(event.target.value)}
                      />
                      <input
                        className="input input-bordered"
                        placeholder="Minimum notice hours"
                        value={minimumNoticeHours}
                        onChange={event => setMinimumNoticeHours(event.target.value)}
                      />
                    </div>
                    <label className="label cursor-pointer justify-start gap-3">
                      <input
                        className="toggle toggle-primary"
                        type="checkbox"
                        checked={manualApproval}
                        onChange={event => setManualApproval(event.target.checked)}
                      />
                      <span className="label-text">Require manual booking approval</span>
                    </label>
                    <div className="rounded-2xl bg-base-200/70 p-4">
                      <p className="font-bold">Add blackout range</p>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <input
                          className="input input-bordered"
                          type="datetime-local"
                          value={blackoutStart}
                          onChange={event => setBlackoutStart(event.target.value)}
                        />
                        <input
                          className="input input-bordered"
                          type="datetime-local"
                          value={blackoutEnd}
                          onChange={event => setBlackoutEnd(event.target.value)}
                        />
                      </div>
                      <input
                        className="input input-bordered mt-3 w-full"
                        placeholder="Blackout reason"
                        value={blackoutReason}
                        onChange={event => setBlackoutReason(event.target.value)}
                      />
                    </div>
                    <div className="rounded-2xl bg-base-200/70 p-4">
                      <p className="font-bold">Add maintenance hold</p>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <input
                          className="input input-bordered"
                          type="datetime-local"
                          value={maintenanceStart}
                          onChange={event => setMaintenanceStart(event.target.value)}
                        />
                        <input
                          className="input input-bordered"
                          type="datetime-local"
                          value={maintenanceEnd}
                          onChange={event => setMaintenanceEnd(event.target.value)}
                        />
                      </div>
                      <input
                        className="input input-bordered mt-3 w-full"
                        placeholder="Maintenance reason"
                        value={maintenanceReason}
                        onChange={event => setMaintenanceReason(event.target.value)}
                      />
                    </div>
                  </div>
                  <button className="btn btn-primary mt-5" disabled={isSaving} type="submit">
                    Save controls
                  </button>
                </form>
              </section>

              <section className="grid gap-5 xl:grid-cols-[1fr_1fr]">
                <div className="rounded-[1.5rem] border border-error/30 bg-error/5 p-5">
                  <h3 className="text-xl font-black">Safety takedown</h3>
                  <p className="mt-1 text-sm text-base-content/70">
                    Suspend the vehicle from rental availability while preserving the audit context.
                  </p>
                  <div className="mt-4 grid gap-3">
                    <input
                      className="input input-bordered"
                      placeholder="Support case ID"
                      value={supportCaseId}
                      onChange={event => setSupportCaseId(event.target.value)}
                    />
                    <textarea
                      className="textarea textarea-bordered"
                      placeholder="Safety reason"
                      value={safetyReason}
                      onChange={event => setSafetyReason(event.target.value)}
                    />
                    <button
                      className="btn btn-error"
                      disabled={isSaving}
                      onClick={() => void performSafetyTakedown()}
                      type="button"
                    >
                      Suspend vehicle
                    </button>
                  </div>
                </div>

                <form
                  className="rounded-[1.5rem] border border-base-300 bg-base-100 p-5 shadow-lg shadow-base-300/20"
                  onSubmit={event => void submitTripAction(event)}
                >
                  <h3 className="text-xl font-black">Trip handoff, incidents, and claims</h3>
                  <p className="mt-1 text-sm text-base-content/60">
                    Record operational actions from an existing booking ID.
                  </p>
                  <div className="mt-5 grid gap-3">
                    <input
                      className="input input-bordered"
                      placeholder="Booking ID"
                      value={bookingId}
                      onChange={event => setBookingId(event.target.value)}
                    />
                    <select
                      className="select select-bordered"
                      value={tripAction}
                      onChange={event => setTripAction(event.target.value as TripAction)}
                    >
                      <option value="check-in">Check in</option>
                      <option value="check-out">Check out</option>
                      <option value="incident">Incident</option>
                      <option value="claim">Claim</option>
                    </select>
                    {(tripAction === "check-in" || tripAction === "check-out") && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <select
                          className="select select-bordered"
                          value={condition}
                          onChange={event => setCondition(event.target.value as RentalVehicleConditionRating)}
                        >
                          {(tripAction === "check-in" ? checkInConditionOptions : conditionOptions).map(option => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                        <select
                          className="select select-bordered"
                          value={exceptionSeverity}
                          onChange={event => setExceptionSeverity(event.target.value as typeof exceptionSeverity)}
                        >
                          <option value="low">Low severity</option>
                          <option value="medium">Medium severity</option>
                          <option value="high">High severity</option>
                        </select>
                        <input
                          className="input input-bordered"
                          placeholder="Odometer miles"
                          value={odometerMiles}
                          onChange={event => setOdometerMiles(event.target.value)}
                        />
                        <input
                          className="input input-bordered"
                          placeholder="Fuel percent"
                          value={fuelPercent}
                          onChange={event => setFuelPercent(event.target.value)}
                        />
                        <input
                          className="input input-bordered"
                          placeholder="Charge percent"
                          value={chargePercent}
                          onChange={event => setChargePercent(event.target.value)}
                        />
                      </div>
                    )}
                    {tripAction === "incident" && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <select
                          className="select select-bordered"
                          value={incidentKind}
                          onChange={event => setIncidentKind(event.target.value)}
                        >
                          <option value="renter_support">Renter support</option>
                          <option value="host_support">Host support</option>
                          <option value="refund_adjustment">Refund adjustment</option>
                          <option value="late_return">Late return</option>
                          <option value="vehicle_condition">Vehicle condition</option>
                          <option value="payment_exception">Payment exception</option>
                          <option value="safety">Safety</option>
                        </select>
                        <select
                          className="select select-bordered"
                          value={incidentStatus}
                          onChange={event => setIncidentStatus(event.target.value)}
                        >
                          <option value="open">Open</option>
                          <option value="waiting">Waiting</option>
                          <option value="resolved">Resolved</option>
                          <option value="escalated">Escalated</option>
                        </select>
                      </div>
                    )}
                    {tripAction === "claim" && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <select
                          className="select select-bordered"
                          value={claimKind}
                          onChange={event => setClaimKind(event.target.value)}
                        >
                          <option value="damage">Damage</option>
                          <option value="late_return">Late return</option>
                          <option value="missing_vehicle">Missing vehicle</option>
                          <option value="payment_dispute">Payment dispute</option>
                          <option value="fraud_review">Fraud review</option>
                          <option value="safety">Safety</option>
                        </select>
                        <select
                          className="select select-bordered"
                          value={claimSeverity}
                          onChange={event => setClaimSeverity(event.target.value as typeof claimSeverity)}
                        >
                          <option value="low">Low severity</option>
                          <option value="medium">Medium severity</option>
                          <option value="high">High severity</option>
                        </select>
                        <input
                          className="input input-bordered"
                          placeholder="Payout hold USD"
                          value={payoutHoldAmount}
                          onChange={event => setPayoutHoldAmount(event.target.value)}
                        />
                      </div>
                    )}
                    <input
                      className="input input-bordered"
                      placeholder="Condition/evidence photo URI"
                      value={tripPhotoUri}
                      onChange={event => setTripPhotoUri(event.target.value)}
                    />
                    {(tripAction === "incident" || tripAction === "claim") && (
                      <input
                        className="input input-bordered"
                        placeholder="Trip support case ID"
                        value={tripSupportCaseId}
                        onChange={event => setTripSupportCaseId(event.target.value)}
                      />
                    )}
                    <textarea
                      className="textarea textarea-bordered"
                      placeholder="Notes"
                      value={tripNotes}
                      onChange={event => setTripNotes(event.target.value)}
                    />
                  </div>
                  <button className="btn btn-primary mt-5" disabled={isSaving} type="submit">
                    Record operation
                  </button>
                </form>
              </section>
            </>
          ) : (
            <section className="rounded-[1.5rem] border border-dashed border-base-300 bg-base-100 p-10 text-center">
              <h2 className="text-2xl font-black">Load a rental vehicle to begin.</h2>
              <p className="mx-auto mt-2 max-w-2xl text-base-content/60">
                The workspace will show host setup, listing controls, safety takedown, and trip operations once a
                partner-authorized vehicle is selected.
              </p>
            </section>
          )}
        </div>
      </section>
    </main>
  );
};
