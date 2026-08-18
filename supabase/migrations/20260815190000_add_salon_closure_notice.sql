-- Bilingual closure notice shown on the public booking page (e.g. "closed for
-- renovation Mon-Tue, reopening Wed"). Nullable — no notice when unset.
-- Content is customer-facing by design, so it's safe to expose through the
-- existing public_salon_profiles view alongside booking_closed_dates.
ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS closure_notice jsonb;

COMMENT ON COLUMN public.salons.closure_notice IS
  'Bilingual {"en": "...", "vi": "..."} banner shown on the public booking page. NULL = no banner.';

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
  logo_url,
  closure_notice
FROM public.salons
WHERE archived_at IS NULL;

ALTER VIEW public.public_salon_profiles SET (security_invoker = true);

REVOKE ALL ON TABLE public.public_salon_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.public_salon_profiles TO anon, authenticated, service_role;
