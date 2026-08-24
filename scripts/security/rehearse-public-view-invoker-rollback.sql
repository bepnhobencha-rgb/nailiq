\set ON_ERROR_STOP on

-- Rehearse the exact emergency rollback, then roll the rehearsal itself back so
-- the hardened state remains active.
begin;

ALTER VIEW public.public_salon_profiles RESET (security_invoker);
ALTER VIEW public.public_service_catalog RESET (security_invoker);
ALTER VIEW public.public_staff_profiles RESET (security_invoker);
ALTER VIEW public.public_staff_shifts RESET (security_invoker);
ALTER VIEW public.public_staff_unavailability RESET (security_invoker);

DROP POLICY "public read active salon profiles" ON public.salons;
DROP POLICY "public read active service catalog" ON public.services;
DROP POLICY "public read active staff profiles" ON public.staff;
DROP POLICY "public read active staff shifts" ON public.staff_shifts;
DROP POLICY "public read staff unavailability dates" ON public.staff_unavailability;

REVOKE SELECT (
  id, slug, name, created_at, address, salon_phone, opening_hours,
  profile_complete, booking_closed_dates, timezone, subscription_plan,
  plan_override, feature_flags, brand_color, theme_mode, currency_code,
  description, phone_otp_enabled, voice_ai_enabled, vertical,
  public_sections_enabled, booking_images, staff_selection_enabled,
  booking_lead_minutes, group_together_threshold_minutes,
  reference_image_enabled, health_ack_required, email_links_enabled,
  resources_enabled, primary_grid_axis, tax_lines, privacy_url, terms_url,
  default_language, logo_url, archived_at, closure_notice
) ON public.salons FROM anon;

REVOKE SELECT (
  id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
  category, description, is_popular, is_featured, price_type,
  price_max_cents, is_addon, addon_timing, prep_minutes, deleted_at
) ON public.services FROM anon;

REVOKE SELECT (id, salon_id, name, job_role, status, deleted_at)
  ON public.staff FROM anon;
REVOKE SELECT (
  id, staff_id, salon_id, day_of_week, start_time, end_time, is_active,
  break_start_time, break_end_time
)
  ON public.staff_shifts FROM anon;
REVOKE SELECT (id, staff_id, salon_id, date)
  ON public.staff_unavailability FROM anon;

do $proof$
begin
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in (
        'public_salon_profiles',
        'public_service_catalog',
        'public_staff_profiles',
        'public_staff_shifts',
        'public_staff_unavailability'
      )
      and coalesce(c.reloptions, '{}'::text[]) @> array['security_invoker=true']
  ) then
    raise exception 'rollback left a public view in security-invoker mode';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and policyname in (
        'public read active salon profiles',
        'public read active service catalog',
        'public read active staff profiles',
        'public read active staff shifts',
        'public read staff unavailability dates'
      )
  ) then
    raise exception 'rollback left a public-view base policy installed';
  end if;

  if exists (
    select 1
    from information_schema.column_privileges
    where table_schema = 'public'
      and table_name in (
        'salons',
        'services',
        'staff',
        'staff_shifts',
        'staff_unavailability'
      )
      and grantee = 'anon'
      and privilege_type = 'SELECT'
  ) then
    raise exception 'rollback left anonymous base-column grants installed';
  end if;
end
$proof$;

rollback;
