-- Make `salons.timezone` a required column.
--
-- Backstory: timezone has been TEXT NULL since the original schema,
-- with various code paths silently falling back to "UTC" when the
-- column held NULL or empty. That fallback is dangerous — booking
-- times persist as UTC ISO strings, and a salon configured as UTC
-- when the owner actually meant America/Vancouver produces 8-hour
-- offset chaos on every booking.
--
-- Task #04-B (FIX 04 from the 2026-05-12 risk audit) closes this by:
--   1. Backfilling any NULL/empty rows to America/Vancouver (the
--      DB column DEFAULT going forward, and the most common Canadian
--      market timezone).
--   2. Locking the column NOT NULL + DEFAULT so future inserts can
--      never reintroduce the NULL case.
--
-- Prod state at migration time (verified via Supabase MCP):
--   5 salons total, 0 NULL/empty. 4 already on America/Los_Angeles
--   (US Pacific, valid for our zone list), 1 e2e fixture on UTC
--   (e2e-receptionist-center). The UTC row isn't backfilled by this
--   migration since it isn't NULL/empty — the e2e seeder will keep
--   resetting it, and prod salons aren't affected.
--
-- Idempotent: the UPDATE is a no-op when no NULL/empty rows exist;
-- the ALTER COLUMN re-apply is harmless. Safe to re-run.

UPDATE salons
SET timezone = 'America/Vancouver'
WHERE timezone IS NULL OR timezone = '';

ALTER TABLE salons
  ALTER COLUMN timezone SET DEFAULT 'America/Vancouver',
  ALTER COLUMN timezone SET NOT NULL;
