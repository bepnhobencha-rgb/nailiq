-- Security fix (Task #09-A, Finding 3 from pre-launch audit):
-- prevent anon direct INSERT into bookings. The previous policy used
-- `with check (true)` which let any anon-key client write rows
-- directly to `public.bookings` via PostgREST, bypassing all the
-- app-layer validation in `submitPublicBooking.ts`
-- (staff/service ↔ salon correlation, opening hours, lead-time
-- buffer, capability check, etc.).
--
-- All inserts must go through `create_public_booking`, which is a
-- SECURITY DEFINER function — it bypasses RLS internally so the
-- policy can hard-deny anon INSERTs at the table level.
--
-- Reversal: change `WITH CHECK (false)` back to `(true)` and re-run.

DROP POLICY IF EXISTS bookings_insert_anon ON public.bookings;

CREATE POLICY bookings_insert_anon ON public.bookings
  FOR INSERT
  TO anon
  WITH CHECK (false);

-- Belt-and-suspenders: make sure anon can still execute the RPC
-- that we now require as the only insert path. The original
-- migration already grants this, but re-granting is idempotent and
-- guards against accidental revokes.
GRANT EXECUTE ON FUNCTION public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz, text
) TO anon;
