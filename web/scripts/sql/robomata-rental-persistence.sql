-- Robomata rental platform production persistence bootstrap.
-- This file is intentionally idempotent so preview and production environments
-- can run it before enabling rental feature flags.

CREATE TABLE IF NOT EXISTS robomata_rental_inventory_manifests (
  id text PRIMARY KEY,
  facility_asset_id text NOT NULL,
  digest text NOT NULL,
  generated_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  ref jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS robomata_rental_inventory_manifests_facility_idx
  ON robomata_rental_inventory_manifests (facility_asset_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS robomata_rental_vehicles (
  platform_vehicle_id text PRIMARY KEY,
  facility_asset_id text NOT NULL,
  vehicle_asset_id text,
  inventory_manifest_digest text NOT NULL,
  operational_status text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS robomata_rental_vehicles_facility_idx
  ON robomata_rental_vehicles (facility_asset_id, platform_vehicle_id);

CREATE TABLE IF NOT EXISTS robomata_rental_inventory_ingestion_runs (
  id text PRIMARY KEY,
  facility_asset_id text,
  manifest_id text,
  manifest_digest text,
  status text NOT NULL,
  trigger text NOT NULL,
  payload jsonb NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS robomata_rental_inventory_ingestion_runs_manifest_idx
  ON robomata_rental_inventory_ingestion_runs (manifest_id, started_at DESC);

CREATE INDEX IF NOT EXISTS robomata_rental_inventory_ingestion_runs_facility_idx
  ON robomata_rental_inventory_ingestion_runs (facility_asset_id, started_at DESC);

CREATE TABLE IF NOT EXISTS robomata_rental_inventory_sync_checkpoints (
  id text PRIMARY KEY,
  chain_id integer NOT NULL,
  registry text NOT NULL,
  registry_address text NOT NULL,
  next_block numeric NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS robomata_rental_inventory_sync_checkpoints_registry_idx
  ON robomata_rental_inventory_sync_checkpoints (chain_id, registry_address);

CREATE TABLE IF NOT EXISTS robomata_rental_renters (
  id text PRIMARY KEY,
  email text,
  phone text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS robomata_rental_renters_email_idx
  ON robomata_rental_renters (email);

CREATE TABLE IF NOT EXISTS robomata_rental_bookings (
  id text PRIMARY KEY,
  renter_id text NOT NULL,
  platform_vehicle_id text NOT NULL,
  facility_asset_id text NOT NULL,
  state text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS robomata_rental_bookings_vehicle_idx
  ON robomata_rental_bookings (platform_vehicle_id, created_at DESC);

CREATE INDEX IF NOT EXISTS robomata_rental_bookings_renter_idx
  ON robomata_rental_bookings (renter_id, created_at DESC);

CREATE TABLE IF NOT EXISTS robomata_rental_payments (
  id text PRIMARY KEY,
  booking_id text NOT NULL,
  provider text NOT NULL,
  provider_payment_intent_id text UNIQUE NOT NULL,
  status text NOT NULL,
  posting_blocked boolean NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS robomata_rental_payments_booking_idx
  ON robomata_rental_payments (booking_id);

CREATE TABLE IF NOT EXISTS robomata_rental_trips (
  id text PRIMARY KEY,
  booking_id text NOT NULL,
  platform_vehicle_id text NOT NULL,
  facility_asset_id text NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS robomata_rental_trips_booking_idx
  ON robomata_rental_trips (booking_id);

CREATE TABLE IF NOT EXISTS robomata_rental_support_incidents (
  id text PRIMARY KEY,
  booking_id text NOT NULL,
  platform_vehicle_id text NOT NULL,
  facility_asset_id text NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS robomata_rental_support_incidents_booking_idx
  ON robomata_rental_support_incidents (booking_id, created_at DESC);

CREATE TABLE IF NOT EXISTS robomata_rental_audit_events (
  id text PRIMARY KEY,
  booking_id text NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS robomata_rental_audit_events_booking_idx
  ON robomata_rental_audit_events (booking_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS robomata_rental_claims (
  id text PRIMARY KEY,
  booking_id text NOT NULL,
  platform_vehicle_id text NOT NULL,
  facility_asset_id text NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS robomata_rental_claims_booking_idx
  ON robomata_rental_claims (booking_id, created_at DESC);

CREATE TABLE IF NOT EXISTS robomata_rental_revenue_ledger_entries (
  id text PRIMARY KEY,
  platform_vehicle_id text NOT NULL,
  posting_asset_id text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS robomata_rental_revenue_ledger_asset_idx
  ON robomata_rental_revenue_ledger_entries (posting_asset_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS robomata_rental_revenue_posting_batches (
  id text PRIMARY KEY,
  idempotency_key text UNIQUE NOT NULL,
  posting_asset_id text NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS robomata_rental_revenue_posting_batches_asset_idx
  ON robomata_rental_revenue_posting_batches (posting_asset_id, created_at DESC);

COMMENT ON TABLE robomata_rental_renters IS
  'Rental renter profiles retain contact fields, verification statuses, provider references, expiry, actor attribution, and audit events only; raw identity documents and sanctions payloads stay with vendors.';

COMMENT ON TABLE robomata_rental_bookings IS
  'Rental booking records retain checkout, lifecycle, cancellation policy, and provider reference IDs; raw payment method data and client secrets are prohibited.';

COMMENT ON TABLE robomata_rental_payments IS
  'Rental payment records retain Stripe provider IDs, statuses, amounts, timestamps, posting block state, and event references only; raw payment method data and client secrets stay with Stripe.';

COMMENT ON TABLE robomata_rental_claims IS
  'Rental claims retain evidence references, digests, notes, and payout holds; raw evidence blobs and documents stay in controlled object/provider storage.';

COMMENT ON TABLE robomata_rental_audit_events IS
  'Rental audit events retain operational facts for compliance and support without raw PII, payment method, or provider payload data.';
