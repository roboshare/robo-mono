"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  ArrowPathIcon,
  CalendarDaysIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  MapPinIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";
import type { RentalBookingRecord } from "~~/lib/robomata/rentalBookings";
import type { RentalMarketplaceListing } from "~~/lib/robomata/rentalMarketplace";
import type { RentalCheckoutPaymentPlan } from "~~/lib/robomata/rentalPayments";
import type { RenterCheckoutEligibility, RenterProfile } from "~~/lib/robomata/rentalRenters";

type SearchFilters = {
  city: string;
  dateFrom: string;
  dateTo: string;
  evOnly: boolean;
  instantBookEnabled: boolean;
  maxDailyRateDollars: string;
  minSeats: string;
  region: string;
};

type BookingResult = {
  booking: RentalBookingRecord;
  checkoutEligibility: RenterCheckoutEligibility;
  renter: RenterProfile;
};

const today = new Date();
const defaultDateFrom = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
const defaultDateTo = new Date(today.getTime() + 10 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);

function cents(value: number | undefined): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 0,
    style: "currency",
  }).format((value ?? 0) / 100);
}

function dateInputToIso(value: string): string {
  return value ? new Date(`${value}T12:00:00.000Z`).toISOString() : "";
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed with status ${response.status}.`);
  return payload;
}

function searchParams(filters: SearchFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.city.trim()) params.set("city", filters.city.trim());
  if (filters.region.trim()) params.set("region", filters.region.trim());
  if (filters.dateFrom) params.set("dateFrom", dateInputToIso(filters.dateFrom));
  if (filters.dateTo) params.set("dateTo", dateInputToIso(filters.dateTo));
  if (filters.evOnly) params.set("evOnly", "true");
  if (filters.instantBookEnabled) params.set("instantBookEnabled", "true");
  if (filters.minSeats.trim()) params.set("minSeats", filters.minSeats.trim());
  if (filters.maxDailyRateDollars.trim()) {
    params.set("maxDailyRateCents", String(Math.round(Number(filters.maxDailyRateDollars) * 100)));
  }
  return params;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-xs font-bold uppercase tracking-[0.18em] text-base-content/50">{children}</span>;
}

export const RentalMarketplaceExperience = () => {
  const [filters, setFilters] = useState<SearchFilters>({
    city: "",
    dateFrom: defaultDateFrom,
    dateTo: defaultDateTo,
    evOnly: false,
    instantBookEnabled: false,
    maxDailyRateDollars: "",
    minSeats: "",
    region: "",
  });
  const [listings, setListings] = useState<RentalMarketplaceListing[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [paymentPlan, setPaymentPlan] = useState<RentalCheckoutPaymentPlan>();
  const [renterForm, setRenterForm] = useState({ displayName: "", email: "", phone: "" });
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [bookingResult, setBookingResult] = useState<BookingResult>();
  const [loadingListings, setLoadingListings] = useState(false);
  const [bookingBusy, setBookingBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [paymentPlanError, setPaymentPlanError] = useState<string>();

  const selectedListing = listings.find(listing => listing.platformVehicleId === selectedId) ?? listings[0];

  useEffect(() => {
    let active = true;
    async function loadListings() {
      setLoadingListings(true);
      setError(undefined);
      try {
        const payload = await fetchJson<{ listings: RentalMarketplaceListing[] }>(
          `/api/robomata/rental-marketplace/listings?${searchParams(filters).toString()}`,
        );
        if (!active) return;
        setListings(payload.listings);
        setSelectedId(current =>
          current && payload.listings.some(listing => listing.platformVehicleId === current)
            ? current
            : payload.listings[0]?.platformVehicleId,
        );
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : "Failed to load rental listings.");
      } finally {
        if (active) setLoadingListings(false);
      }
    }

    loadListings();
    return () => {
      active = false;
    };
  }, [filters]);

  useEffect(() => {
    if (!selectedListing) {
      setPaymentPlan(undefined);
      return;
    }

    let active = true;
    async function loadPaymentPlan() {
      setPaymentPlan(undefined);
      setPaymentPlanError(undefined);
      try {
        const payload = await fetchJson<{
          paymentPlan: RentalCheckoutPaymentPlan;
        }>("/api/robomata/rental-marketplace/payment-plan", {
          body: JSON.stringify({
            dateFrom: dateInputToIso(filters.dateFrom),
            dateTo: dateInputToIso(filters.dateTo),
            platformVehicleId: selectedListing.platformVehicleId,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        if (active) setPaymentPlan(payload.paymentPlan);
      } catch (planError) {
        if (active) {
          setPaymentPlanError(planError instanceof Error ? planError.message : "Payment plan is unavailable.");
        }
      }
    }

    loadPaymentPlan();
    return () => {
      active = false;
    };
  }, [filters.dateFrom, filters.dateTo, selectedListing]);

  async function submitBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedListing) return;
    setBookingBusy(true);
    setError(undefined);
    setBookingResult(undefined);

    try {
      const renterPayload = await fetchJson<{ renter: RenterProfile }>("/api/robomata/rental-renters", {
        body: JSON.stringify(renterForm),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const checkoutPayload = await fetchJson<{
        booking: RentalBookingRecord;
        checkoutEligibility: RenterCheckoutEligibility;
      }>("/api/robomata/rental-bookings/checkout", {
        body: JSON.stringify({
          dateFrom: dateInputToIso(filters.dateFrom),
          dateTo: dateInputToIso(filters.dateTo),
          platformVehicleId: selectedListing.platformVehicleId,
          renterId: renterPayload.renter.id,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      setBookingResult({ ...checkoutPayload, renter: renterPayload.renter });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to create rental booking.");
    } finally {
      setBookingBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <section className="overflow-hidden rounded-[2.25rem] border border-base-300 bg-base-100 shadow-xl shadow-base-300/40">
        <div className="grid gap-8 bg-[radial-gradient(circle_at_top_left,rgba(20,184,166,0.18),transparent_34%),linear-gradient(135deg,rgba(17,24,39,0.96),rgba(15,23,42,0.9))] px-6 py-9 text-white sm:px-9 lg:grid-cols-[1.1fr_0.9fr] lg:px-12">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.32em] text-teal-100/70">Roboshare Rentals</p>
            <h1 className="mt-4 max-w-3xl text-4xl font-black tracking-tight sm:text-6xl">
              Book facility-backed vehicles without touching a wallet.
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-slate-200">
              Search operational rental inventory, understand the financing asset behind the car, and start checkout
              through the offchain rental platform.
            </p>
          </div>
          <div className="rounded-[1.75rem] border border-white/15 bg-white/10 p-5 backdrop-blur">
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-teal-100/70">Current boundary</p>
            <div className="mt-4 space-y-3 text-sm leading-relaxed text-slate-100">
              <p>Booking and trip operations stay offchain.</p>
              <p>Revenue posts to the facility asset by default.</p>
              <p>Individual vehicle asset IDs remain optional for per-car financing.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-5 rounded-[2rem] border border-base-300 bg-base-100 p-5 shadow-lg shadow-base-300/30 lg:grid-cols-8">
        <label className="form-control lg:col-span-2">
          <FieldLabel>Pickup date</FieldLabel>
          <input
            className="input input-bordered mt-2 rounded-2xl"
            type="date"
            value={filters.dateFrom}
            onChange={event => setFilters(current => ({ ...current, dateFrom: event.target.value }))}
          />
        </label>
        <label className="form-control lg:col-span-2">
          <FieldLabel>Return date</FieldLabel>
          <input
            className="input input-bordered mt-2 rounded-2xl"
            type="date"
            value={filters.dateTo}
            onChange={event => setFilters(current => ({ ...current, dateTo: event.target.value }))}
          />
        </label>
        <label className="form-control lg:col-span-2">
          <FieldLabel>City</FieldLabel>
          <input
            className="input input-bordered mt-2 rounded-2xl"
            placeholder="Austin"
            value={filters.city}
            onChange={event => setFilters(current => ({ ...current, city: event.target.value }))}
          />
        </label>
        <label className="form-control">
          <FieldLabel>Seats</FieldLabel>
          <input
            className="input input-bordered mt-2 rounded-2xl"
            min="0"
            type="number"
            value={filters.minSeats}
            onChange={event => setFilters(current => ({ ...current, minSeats: event.target.value }))}
          />
        </label>
        <label className="form-control">
          <FieldLabel>Max/day</FieldLabel>
          <input
            className="input input-bordered mt-2 rounded-2xl"
            min="0"
            type="number"
            value={filters.maxDailyRateDollars}
            onChange={event => setFilters(current => ({ ...current, maxDailyRateDollars: event.target.value }))}
          />
        </label>
        <div className="flex flex-wrap gap-3 lg:col-span-8">
          <label className="flex items-center gap-2 rounded-full border border-base-300 px-4 py-2 text-sm font-semibold">
            <input
              className="checkbox checkbox-sm"
              type="checkbox"
              checked={filters.instantBookEnabled}
              onChange={event => setFilters(current => ({ ...current, instantBookEnabled: event.target.checked }))}
            />
            Instant book
          </label>
          <label className="flex items-center gap-2 rounded-full border border-base-300 px-4 py-2 text-sm font-semibold">
            <input
              className="checkbox checkbox-sm"
              type="checkbox"
              checked={filters.evOnly}
              onChange={event => setFilters(current => ({ ...current, evOnly: event.target.checked }))}
            />
            EV only
          </label>
        </div>
      </section>

      {error && (
        <div className="alert alert-error rounded-2xl">
          <ExclamationTriangleIcon className="h-5 w-5" />
          <span>{error}</span>
        </div>
      )}

      <section className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-black tracking-tight text-base-content">Available vehicles</h2>
            {loadingListings && <ArrowPathIcon className="h-5 w-5 animate-spin text-primary" />}
          </div>

          {listings.length === 0 && !loadingListings ? (
            <div className="rounded-[2rem] border border-dashed border-base-300 bg-base-100 p-8 text-center">
              <p className="font-bold text-base-content">No listings match the current filters.</p>
              <p className="mt-2 text-sm text-base-content/60">
                Try a wider date range, fewer filters, or seed rental inventory.
              </p>
            </div>
          ) : (
            listings.map(listing => (
              <button
                key={listing.platformVehicleId}
                className={`w-full rounded-[1.75rem] border bg-base-100 p-4 text-left shadow-lg shadow-base-300/25 transition ${
                  selectedListing?.platformVehicleId === listing.platformVehicleId
                    ? "border-primary"
                    : "border-base-300 hover:border-primary/40"
                }`}
                onClick={() => {
                  setSelectedId(listing.platformVehicleId);
                  setBookingResult(undefined);
                }}
              >
                <div className="flex gap-4">
                  <div
                    className="h-24 w-28 shrink-0 rounded-2xl bg-cover bg-center"
                    style={{
                      backgroundImage: listing.images[0]
                        ? `url(${listing.images[0]})`
                        : "linear-gradient(135deg, #0f172a, #14b8a6)",
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-lg font-black tracking-tight text-base-content">{listing.title}</h3>
                      <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-black uppercase tracking-[0.12em] text-primary">
                        {listing.pricing ? `${cents(listing.pricing.dailyRateCents)}/day` : "Quote"}
                      </span>
                    </div>
                    <p className="mt-2 flex items-center gap-1 text-sm text-base-content/60">
                      <MapPinIcon className="h-4 w-4" />
                      {[listing.location?.city, listing.location?.region, listing.location?.country]
                        .filter(Boolean)
                        .join(", ") || "Pickup location set by host"}
                    </p>
                    <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-base-content/70">
                      {listing.description || "Facility-backed rental vehicle with host-configured setup."}
                    </p>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        <div className="space-y-5">
          {selectedListing && (
            <div className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-xl shadow-base-300/30">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Listing</p>
                  <h2 className="mt-2 text-3xl font-black tracking-tight text-base-content">{selectedListing.title}</h2>
                  <p className="mt-2 text-base-content/70">{selectedListing.description}</p>
                </div>
                <span className="rounded-full bg-emerald-100 px-4 py-2 text-sm font-black text-emerald-700">
                  {selectedListing.status}
                </span>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl bg-base-200/70 p-4">
                  <FieldLabel>Host</FieldLabel>
                  <p className="mt-2 font-bold text-base-content">{selectedListing.host.displayName}</p>
                </div>
                <div className="rounded-2xl bg-base-200/70 p-4">
                  <FieldLabel>Financing target</FieldLabel>
                  <p className="mt-2 break-all font-mono text-xs text-base-content">
                    {selectedListing.facilityAssetId}
                  </p>
                </div>
                <div className="rounded-2xl bg-base-200/70 p-4">
                  <FieldLabel>Vehicle key</FieldLabel>
                  <p className="mt-2 break-all font-mono text-xs text-base-content">
                    {selectedListing.platformVehicleId}
                  </p>
                </div>
              </div>

              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <div className="rounded-2xl border border-base-300 p-4">
                  <CalendarDaysIcon className="h-6 w-6 text-primary" />
                  <h3 className="mt-3 font-black text-base-content">Trip estimate</h3>
                  {selectedListing.tripEstimate ? (
                    <div className="mt-3 space-y-2 text-sm text-base-content/70">
                      <div className="flex justify-between">
                        <span>{selectedListing.tripEstimate.tripDays} days</span>
                        <span>{cents(selectedListing.tripEstimate.baseAmountCents)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Discount</span>
                        <span>-{cents(selectedListing.tripEstimate.discountAmountCents)}</span>
                      </div>
                      <div className="flex justify-between font-black text-base-content">
                        <span>Total before taxes</span>
                        <span>{cents(selectedListing.tripEstimate.totalBeforeTaxesCents)}</span>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-base-content/60">Pricing is not configured for this vehicle.</p>
                  )}
                </div>
                <div className="rounded-2xl border border-base-300 p-4">
                  <ShieldCheckIcon className="h-6 w-6 text-primary" />
                  <h3 className="mt-3 font-black text-base-content">Rules and controls</h3>
                  <div className="mt-3 space-y-2 text-sm text-base-content/70">
                    <p>Minimum trip: {selectedListing.pricing?.minimumTripDays ?? 1} day(s)</p>
                    <p>Mileage/day: {selectedListing.rules?.mileageLimitPerDay ?? "Host-defined"}</p>
                    <p>Instant book: {selectedListing.availability?.instantBookEnabled ? "Enabled" : "Host review"}</p>
                    <p>{selectedListing.rules?.additionalRules || "Standard facility rental terms apply."}</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {selectedListing && (
            <form
              className="rounded-[2rem] border border-base-300 bg-base-100 p-6 shadow-xl shadow-base-300/30"
              onSubmit={submitBooking}
            >
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-base-content/50">Checkout</p>
              <h2 className="mt-2 text-2xl font-black tracking-tight text-base-content">Start booking request</h2>

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <label className="form-control sm:col-span-2">
                  <FieldLabel>Name</FieldLabel>
                  <input
                    className="input input-bordered mt-2 rounded-2xl"
                    required
                    value={renterForm.displayName}
                    onChange={event => setRenterForm(current => ({ ...current, displayName: event.target.value }))}
                  />
                </label>
                <label className="form-control">
                  <FieldLabel>Email</FieldLabel>
                  <input
                    className="input input-bordered mt-2 rounded-2xl"
                    type="email"
                    value={renterForm.email}
                    onChange={event => setRenterForm(current => ({ ...current, email: event.target.value }))}
                  />
                </label>
                <label className="form-control">
                  <FieldLabel>Phone</FieldLabel>
                  <input
                    className="input input-bordered mt-2 rounded-2xl"
                    value={renterForm.phone}
                    onChange={event => setRenterForm(current => ({ ...current, phone: event.target.value }))}
                  />
                </label>
              </div>

              <div className="mt-5 rounded-2xl bg-base-200/70 p-4 text-sm text-base-content/70">
                {paymentPlan ? (
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span>Trip authorization</span>
                      <span>{cents(paymentPlan.rentalCharge.totalAuthorizeCents)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Deposit hold</span>
                      <span>{cents(paymentPlan.depositHold.amountCents)}</span>
                    </div>
                    <div className="flex justify-between font-black text-base-content">
                      <span>Total authorization</span>
                      <span>{cents(paymentPlan.totalDueAtAuthorizationCents)}</span>
                    </div>
                  </div>
                ) : (
                  <p>{paymentPlanError ?? "Payment plan will appear once the listing and dates are valid."}</p>
                )}
              </div>

              <label className="mt-5 flex items-start gap-3 text-sm text-base-content/70">
                <input
                  className="checkbox checkbox-sm mt-0.5"
                  required
                  type="checkbox"
                  checked={acceptedTerms}
                  onChange={event => setAcceptedTerms(event.target.checked)}
                />
                <span>
                  I understand this creates an offchain booking request. Payment authorization and verification may
                  still be required before the host confirms the trip.
                </span>
              </label>

              <button className="btn btn-primary mt-5 w-full rounded-full" disabled={bookingBusy || !selectedListing}>
                {bookingBusy ? "Creating booking..." : "Create booking request"}
              </button>
            </form>
          )}

          {bookingResult && (
            <div className="rounded-[2rem] border border-emerald-200 bg-emerald-50 p-6 text-emerald-950">
              <CheckCircleIcon className="h-8 w-8 text-emerald-600" />
              <h2 className="mt-3 text-2xl font-black tracking-tight">Booking request created</h2>
              <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <p>
                  <span className="font-bold">Booking:</span> {bookingResult.booking.id}
                </p>
                <p>
                  <span className="font-bold">Status:</span> {bookingResult.booking.state}
                </p>
                <p className="sm:col-span-2">
                  <span className="font-bold">Financing target:</span> {bookingResult.booking.facilityAssetId}
                </p>
                <p className="sm:col-span-2">
                  <span className="font-bold">Verification:</span>{" "}
                  {bookingResult.checkoutEligibility.eligible
                    ? "Eligible for payment authorization"
                    : `Blocked by ${bookingResult.checkoutEligibility.blockingChecks.join(", ")}`}
                </p>
              </div>
              <div className="mt-4 rounded-2xl bg-white/70 p-4 text-sm leading-relaxed">
                Save this booking ID for renter support. Cancellation/refund outcomes are governed by the booking policy
                stored with the request and can be handled by support while renter self-service matures.
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
