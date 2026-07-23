-- Ensure anonymous visitors can load /[shop] booking pages: catalog SELECT must remain
-- permissive. Replaces legacy policy names from 20260427120000_rls_public_booking.sql.
-- Keeps salon_members "owner read own salon" (additive OR with public read).

DROP POLICY IF EXISTS "salons_select_public" ON public.salons;
DROP POLICY IF EXISTS "services_select_public" ON public.services;
DROP POLICY IF EXISTS "staff_select_public" ON public.staff;

DROP POLICY IF EXISTS "public read salons" ON public.salons;
CREATE POLICY "public read salons" ON public.salons FOR SELECT USING (true);

DROP POLICY IF EXISTS "public read services" ON public.services;
CREATE POLICY "public read services" ON public.services FOR SELECT USING (true);

DROP POLICY IF EXISTS "public read staff" ON public.staff;
CREATE POLICY "public read staff" ON public.staff FOR SELECT USING (true);
