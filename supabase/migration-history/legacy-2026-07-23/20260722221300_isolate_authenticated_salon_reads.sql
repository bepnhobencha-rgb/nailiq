-- Separate the public booking profile from the tenant-owned salons table.
-- The view intentionally exposes only booking-safe columns and is the only
-- cross-tenant salon surface available to anon/authenticated sessions.

CREATE OR REPLACE VIEW public.public_salon_profiles
WITH (security_barrier = true)
AS
SELECT
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
  logo_url
FROM public.salons
WHERE archived_at IS NULL;

REVOKE ALL ON TABLE public.public_salon_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.public_salon_profiles TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "public read salons" ON public.salons;
REVOKE ALL PRIVILEGES ON TABLE public.salons FROM anon;

