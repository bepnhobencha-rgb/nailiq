-- Customer Identity Layer — M1 (schema).
--
-- Adds a durable link from each booking to a client_profiles row, plus a flag
-- for group "party members" who have no contact of their own. Both columns are
-- NULLABLE / DEFAULT, so this is a metadata-only ADD COLUMN (no table rewrite,
-- no lock on existing rows) — safe on prod with existing bookings.
--
-- Why a FK when client_profiles is already phone-keyed:
--   * survives a customer changing their phone number,
--   * lets the merge tool repoint bookings cleanly (M6),
--   * lets a party member link to a real profile when they claim via party-link,
--   * is_party_member marks group guests who legitimately have no phone, so we
--     stop copying the booker's phone onto their rows (the root "lung tung" bug).
--
-- Backfill of existing rows happens in M7 (batched, idempotent) — NOT here, so
-- this migration stays fast and lock-light.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS client_profile_id uuid
    REFERENCES public.client_profiles (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_party_member boolean NOT NULL DEFAULT false;

-- Index for "all bookings of this customer" lookups (merge tool, history view).
-- Partial index: party members / un-backfilled rows are NULL and not worth indexing.
CREATE INDEX IF NOT EXISTS bookings_client_profile_id_idx
  ON public.bookings (client_profile_id)
  WHERE client_profile_id IS NOT NULL;

COMMENT ON COLUMN public.bookings.client_profile_id IS
  'Durable FK to the customer identity (client_profiles). NULL for un-backfilled rows and for party members without their own contact.';
COMMENT ON COLUMN public.bookings.is_party_member IS
  'True when this row is a group guest who has no phone/profile of their own (must NOT inherit the booker''s phone). Excluded from the booker''s visit/spend roll-up.';
