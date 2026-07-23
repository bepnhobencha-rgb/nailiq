-- P0.1 — Fix idempotency UNIQUE so it doesn't kill every group submit.
--
-- Original migration `20260512200000_group_booking.sql` created:
--   CREATE UNIQUE INDEX idx_bookings_idempotency
--     ON public.bookings (salon_id, idempotency_key)
--     WHERE idempotency_key IS NOT NULL;
--
-- The client stamps the SAME idempotency_key on every member row of a
-- group (4 rows = same key). Row 1 inserts; row 2 violates the UNIQUE
-- on (salon_id, idempotency_key); the RPC catches `unique_violation`
-- and returns `duplicate_submission` — so every group booking failed
-- after the first member was inserted (and got rolled back).
--
-- Fix: widen the uniqueness tuple to include `staff_id` and
-- `start_time_utc`. Within one group, every member has a DIFFERENT
-- (staff_id, start_time_utc) pair (cross-member same-staff is blocked
-- upstream via the duplicateStaffIdx check). So the same group key
-- yields N unique rows. But a TRUE re-submit of the same group will
-- stamp identical (salon_id, key, staff_id, start_time_utc) on every
-- member → UNIQUE catches the very first row and the RPC returns
-- `duplicate_submission`.
--
-- Idempotency property preserved; group inserts unblocked.

DROP INDEX IF EXISTS public.idx_bookings_idempotency;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_idempotency
  ON public.bookings (salon_id, idempotency_key, staff_id, start_time_utc)
  WHERE idempotency_key IS NOT NULL;
