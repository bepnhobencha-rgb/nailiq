-- Public booking needs a small staff/service catalog and availability facts,
-- not tenant user IDs, external provider IDs, deleted rows, or time-off reasons.

CREATE OR REPLACE VIEW public.public_service_catalog
WITH (security_barrier = true) AS
SELECT
  id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
  category, description, is_popular, is_featured, price_type,
  price_max_cents, is_addon, addon_timing
FROM public.services
WHERE deleted_at IS NULL;

CREATE OR REPLACE VIEW public.public_staff_profiles
WITH (security_barrier = true) AS
SELECT id, salon_id, name, job_role, status
FROM public.staff
WHERE deleted_at IS NULL AND status = 'active';

CREATE OR REPLACE VIEW public.public_staff_shifts
WITH (security_barrier = true) AS
SELECT id, staff_id, salon_id, day_of_week, start_time, end_time, is_active
FROM public.staff_shifts
WHERE is_active = true;

CREATE OR REPLACE VIEW public.public_staff_unavailability
WITH (security_barrier = true) AS
SELECT id, staff_id, salon_id, date
FROM public.staff_unavailability;

REVOKE ALL ON TABLE
  public.public_service_catalog,
  public.public_staff_profiles,
  public.public_staff_shifts,
  public.public_staff_unavailability
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE
  public.public_service_catalog,
  public.public_staff_profiles,
  public.public_staff_shifts,
  public.public_staff_unavailability
TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "public read services" ON public.services;
DROP POLICY IF EXISTS "public read staff" ON public.staff;
DROP POLICY IF EXISTS "anon read staff_shifts" ON public.staff_shifts;
DROP POLICY IF EXISTS "anon read staff_unavailability" ON public.staff_unavailability;

REVOKE ALL PRIVILEGES ON TABLE public.services FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.staff FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.staff_shifts FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.staff_unavailability FROM anon;

CREATE POLICY "members read services for own salon"
ON public.services FOR SELECT TO authenticated
USING (
  salon_id IN (
    SELECT salon_id FROM public.salon_members WHERE user_id = (SELECT auth.uid())
  )
);

CREATE POLICY "members read staff for own salon"
ON public.staff FOR SELECT TO authenticated
USING (
  salon_id IN (
    SELECT salon_id FROM public.salon_members WHERE user_id = (SELECT auth.uid())
  )
);

