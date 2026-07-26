-- Public bookings must pass through create_public_booking, which enforces
-- tenant correlation, opening hours, conflicts and abuse limits. Production
-- drift left a permissive anon INSERT policy that bypassed all of those checks.

REVOKE INSERT ON TABLE public.bookings FROM anon;

DROP POLICY IF EXISTS bookings_insert_anon ON public.bookings;
CREATE POLICY bookings_insert_anon
ON public.bookings
FOR INSERT
TO anon
WITH CHECK (false);

COMMENT ON POLICY bookings_insert_anon ON public.bookings IS
  'Fail-closed: anonymous clients must use create_public_booking; direct table inserts are forbidden.';
