-- Anonymous visitors only need the public booking profile. The salons table
-- also contains owner PII, Stripe identifiers, subscription state, admin notes
-- and internal AI/notification configuration, so a table-wide SELECT grant is
-- an unsafe data boundary even with row-level security enabled.

REVOKE ALL PRIVILEGES ON TABLE public.salons FROM anon;

GRANT SELECT (
  id,
  slug,
  name,
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
  tax_lines,
  privacy_url,
  terms_url,
  default_language,
  logo_url
) ON TABLE public.salons TO anon;

