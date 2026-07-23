-- Phone OTP feature:
--   1. Per-salon toggle `phone_otp_enabled` on salons table.
--   2. `phone_otp_sessions` stores verified phone sessions (15-min TTL).
--      Service role only — no public RLS policies.

ALTER TABLE salons
  ADD COLUMN IF NOT EXISTS phone_otp_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN salons.phone_otp_enabled IS
  'When true, public booking flow requires SMS OTP to verify the customer phone.';

-- ─── phone_otp_sessions ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS phone_otp_sessions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text        NOT NULL,         -- digits only (no "+"), matches bookings.client_phone
  salon_id    uuid        NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  verified_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  consumed_at timestamptz             -- NULL until the booking is committed
);

ALTER TABLE phone_otp_sessions ENABLE ROW LEVEL SECURITY;
-- No public policies → anon cannot read or write; service role bypasses RLS.

-- Fast expiry sweep + uniqueness lookup.
CREATE INDEX IF NOT EXISTS phone_otp_sessions_expires_idx ON phone_otp_sessions (expires_at);
CREATE INDEX IF NOT EXISTS phone_otp_sessions_phone_salon_idx ON phone_otp_sessions (phone, salon_id, consumed_at);
