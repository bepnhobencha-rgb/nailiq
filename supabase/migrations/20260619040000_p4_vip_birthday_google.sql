-- P4: VIP Care + Review Responder infrastructure
-- Adds birthday field to client_profiles + Google Place ID to salons.

-- ── client_profiles: date of birth for birthday care ─────────────────────────
ALTER TABLE client_profiles
  ADD COLUMN IF NOT EXISTS date_of_birth date;

COMMENT ON COLUMN client_profiles.date_of_birth IS
  'Birthday (date only, no year required) — used by VIP Care to send personalised messages 7 days before each birthday.';

-- ── salons: Google Place ID for review polling ────────────────────────────────
ALTER TABLE salons
  ADD COLUMN IF NOT EXISTS google_place_id text;

COMMENT ON COLUMN salons.google_place_id IS
  'Google Maps Place ID (e.g. ChIJN1t_tDeuEmsRUsoyG83frY4). Used by Review Responder to poll new reviews via Google Places API.';
