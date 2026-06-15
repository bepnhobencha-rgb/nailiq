-- MEDIUM-2: staff INSERT/UPDATE/DELETE policies gated only on salon membership
-- (any role) → a low-priv receptionist/nail_tech could tamper with staff.user_id
-- via direct PostgREST. The app writes staff exclusively via the service-role
-- client (bypasses RLS), so these only ever apply to direct authenticated REST.
-- Gate them to owner/admin. SELECT ("public read staff", needed by the public
-- booking page) is left untouched.
DROP POLICY IF EXISTS "owner insert staff for own salon" ON public.staff;
DROP POLICY IF EXISTS "owner update staff for own salon" ON public.staff;
DROP POLICY IF EXISTS "owner delete staff for own salon" ON public.staff;

CREATE POLICY "managers insert staff for own salon" ON public.staff
  FOR INSERT TO authenticated
  WITH CHECK (salon_id IN (
    SELECT salon_id FROM public.salon_members
    WHERE user_id = (select auth.uid()) AND role IN ('owner','admin')
  ));

CREATE POLICY "managers update staff for own salon" ON public.staff
  FOR UPDATE TO authenticated
  USING (salon_id IN (
    SELECT salon_id FROM public.salon_members
    WHERE user_id = (select auth.uid()) AND role IN ('owner','admin')
  ))
  WITH CHECK (salon_id IN (
    SELECT salon_id FROM public.salon_members
    WHERE user_id = (select auth.uid()) AND role IN ('owner','admin')
  ));

CREATE POLICY "managers delete staff for own salon" ON public.staff
  FOR DELETE TO authenticated
  USING (salon_id IN (
    SELECT salon_id FROM public.salon_members
    WHERE user_id = (select auth.uid()) AND role IN ('owner','admin')
  ));
