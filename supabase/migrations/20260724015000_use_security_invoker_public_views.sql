-- Public booking views previously ran with the view owner's privileges. Their
-- projections were intentionally narrow, but a SECURITY DEFINER view is still
-- a privilege-escalation boundary and is reported as an ERROR by the Supabase
-- security advisor.
--
-- Make the views SECURITY INVOKER and give anon only the exact base columns
-- and rows that each projection already exposed. Authenticated dashboard reads
-- retain their existing tenant-scoped grants/policies. Public booking code uses
-- a stateless anon client so its behavior cannot change when a browser also has
-- an unrelated dashboard session.

ALTER VIEW public.public_salon_profiles SET (security_invoker = true);
ALTER VIEW public.public_service_catalog SET (security_invoker = true);
ALTER VIEW public.public_staff_profiles SET (security_invoker = true);
ALTER VIEW public.public_staff_shifts SET (security_invoker = true);
ALTER VIEW public.public_staff_unavailability SET (security_invoker = true);

GRANT SELECT (
  id,
  slug,
  name,
  created_at,
  address,
  salon_phone,
  opening_hours,
  profile_complete,
  booking_closed_dates,
  timezone,
  subscription_plan,
  plan_override,
  feature_flags,
  brand_color,
  theme_mode,
  currency_code,
  description,
  phone_otp_enabled,
  voice_ai_enabled,
  vertical,
  public_sections_enabled,
  booking_images,
  staff_selection_enabled,
  booking_lead_minutes,
  group_together_threshold_minutes,
  reference_image_enabled,
  health_ack_required,
  email_links_enabled,
  resources_enabled,
  primary_grid_axis,
  tax_lines,
  privacy_url,
  terms_url,
  default_language,
  logo_url,
  archived_at
) ON TABLE public.salons TO anon;

GRANT SELECT (
  id,
  salon_id,
  name,
  price_cents,
  duration_minutes,
  buffer_minutes,
  category,
  description,
  is_popular,
  is_featured,
  price_type,
  price_max_cents,
  is_addon,
  addon_timing,
  deleted_at
) ON TABLE public.services TO anon;

GRANT SELECT (
  id,
  salon_id,
  name,
  job_role,
  status,
  deleted_at
) ON TABLE public.staff TO anon;

GRANT SELECT (
  id,
  staff_id,
  salon_id,
  day_of_week,
  start_time,
  end_time,
  is_active
) ON TABLE public.staff_shifts TO anon;

GRANT SELECT (
  id,
  staff_id,
  salon_id,
  date
) ON TABLE public.staff_unavailability TO anon;

CREATE POLICY "public read active salon profiles"
ON public.salons FOR SELECT TO anon
USING (archived_at IS NULL);

CREATE POLICY "public read active service catalog"
ON public.services FOR SELECT TO anon
USING (deleted_at IS NULL);

CREATE POLICY "public read active staff profiles"
ON public.staff FOR SELECT TO anon
USING (deleted_at IS NULL AND status = 'active');

CREATE POLICY "public read active staff shifts"
ON public.staff_shifts FOR SELECT TO anon
USING (is_active = true);

CREATE POLICY "public read staff unavailability dates"
ON public.staff_unavailability FOR SELECT TO anon
USING (true);
