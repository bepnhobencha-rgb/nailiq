-- Owner-controlled timing policy for later waves in oversized group bookings.
-- Expand-only and backward-compatible: existing salons retain the current exact
-- capacity-ready behavior.
alter table public.salons
  add column if not exists group_wave_strategy text not null
  default 'maximize_revenue';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'salons_group_wave_strategy_check'
      and conrelid = 'public.salons'::regclass
  ) then
    alter table public.salons
      add constraint salons_group_wave_strategy_check
      check (group_wave_strategy in (
        'maximize_revenue',
        'balanced',
        'on_time'
      ));
  end if;
end
$$;

comment on column public.salons.group_wave_strategy is
  'Later-wave timing: exact capacity-ready, 5-minute balance, or 15-minute customer cadence.';

-- The public view is security-invoker, so its caller also needs the underlying
-- column privilege. This policy value contains no customer or provider data.
grant select (group_wave_strategy) on table public.salons
  to anon, authenticated;

-- Public booking needs this non-sensitive policy to produce the same schedule
-- as authenticated Voice AI. Preserve the view's narrow grant boundary and
-- security-invoker behavior.
create or replace view public.public_salon_profiles
with (security_barrier = true)
as
select
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
  closure_notice,
  group_wave_strategy
from public.salons
where archived_at is null;

alter view public.public_salon_profiles set (security_invoker = true);

revoke all on table public.public_salon_profiles
  from public, anon, authenticated;
grant select on table public.public_salon_profiles
  to anon, authenticated, service_role;

-- Keep the curated owner/admin settings projection in sync without restoring
-- broad authenticated SELECT access to salons.
create or replace function public.load_salon_owner_admin_settings(
  p_salon_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_role text;
  v_settings jsonb;
begin
  if p_salon_id is null then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'invalid_request'
    );
  end if;

  if v_actor_id is null
     or not public.current_auth_session_is_active()
  then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'unauthorized'
    );
  end if;

  select sm.role
  into v_role
  from public.salon_members as sm
  where sm.salon_id = p_salon_id
    and sm.user_id = v_actor_id
  for share;

  if not found or v_role not in ('owner', 'admin') then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'forbidden'
    );
  end if;

  select pg_catalog.jsonb_build_object(
    'dashboard_modules', s.dashboard_modules,
    'dashboard_preset', s.dashboard_preset,
    'email', s.email,
    'email_verified', s.email_verified,
    'subscription_plan', s.subscription_plan,
    'brand_color', s.brand_color,
    'logo_url', s.logo_url,
    'theme_mode', s.theme_mode,
    'walkin_auto_assign', s.walkin_auto_assign,
    'queue_display_mode', s.queue_display_mode,
    'phone_otp_enabled', s.phone_otp_enabled,
    'reminders_enabled', s.reminders_enabled,
    'reminder_24h_enabled', s.reminder_24h_enabled,
    'reminder_3h_enabled', s.reminder_3h_enabled,
    'sms_reminders_enabled', s.sms_reminders_enabled,
    'booking_verification_mode', s.booking_verification_mode,
    'google_review_url', s.google_review_url,
    'google_place_id', s.google_place_id,
    'yelp_business_id', s.yelp_business_id,
    'voice_ai_enabled', s.voice_ai_enabled,
    'voice_ai_persona_name', s.voice_ai_persona_name,
    'vertical', s.vertical,
    'staff_selection_enabled', s.staff_selection_enabled,
    'booking_lead_minutes', s.booking_lead_minutes,
    'group_together_threshold_minutes', s.group_together_threshold_minutes,
    'group_wave_strategy', s.group_wave_strategy,
    'group_decline_cutoff_hours', s.group_decline_cutoff_hours,
    'reference_image_enabled', s.reference_image_enabled,
    'auto_no_show_minutes', s.auto_no_show_minutes,
    'winback_enabled', s.winback_enabled,
    'client_segment_settings', s.client_segment_settings,
    'feature_flags', s.feature_flags,
    'resources_enabled', s.resources_enabled,
    'primary_grid_axis', s.primary_grid_axis
  ) || pg_catalog.jsonb_build_object(
    'ai_manager_instructions', s.ai_manager_instructions,
    'sms_outbound_enabled', s.sms_outbound_enabled,
    'email_outbound_enabled', s.email_outbound_enabled,
    'customer_channel', s.customer_channel,
    'owner_notification_channel', s.owner_notification_channel,
    'owner_phone', s.owner_phone,
    'owner_notification_settings', s.owner_notification_settings,
    'staff_notification_settings', s.staff_notification_settings,
    'default_notification_locale', s.default_notification_locale,
    'timezone', s.timezone,
    'tax_lines', s.tax_lines,
    'cancellation_policy', s.cancellation_policy,
    'payment_provider', s.payment_provider,
    'noshow_protection_enabled', s.noshow_protection_enabled,
    'noshow_fee_percent', s.noshow_fee_percent,
    'noshow_risk_threshold', s.noshow_risk_threshold,
    'noshow_group_whole_party', s.noshow_group_whole_party,
    'noshow_deposit_escalation_threshold',
      s.noshow_deposit_escalation_threshold,
    'noshow_require_new_customer', s.noshow_require_new_customer,
    'noshow_require_prior_noshow', s.noshow_require_prior_noshow,
    'noshow_min_noshow_count', s.noshow_min_noshow_count,
    'noshow_require_high_risk', s.noshow_require_high_risk,
    'self_cancel_window_hours', s.self_cancel_window_hours,
    'self_cancel_fee_enabled', s.self_cancel_fee_enabled,
    'self_cancel_fee_percent', s.self_cancel_fee_percent
  )
  into v_settings
  from public.salons as s
  where s.id = p_salon_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'salon_not_found'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'success', true,
    'code', 'loaded',
    'contract_version', 1,
    'salon_id', p_salon_id,
    'role', v_role,
    'settings', v_settings
  );
end;
$$;

comment on function public.load_salon_owner_admin_settings(uuid) is
  'Active-session owner/admin-only curated salon management settings loader; excludes provider identifiers, billing state, internal platform notes and tenant-pause metadata.';

revoke all on function public.load_salon_owner_admin_settings(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.load_salon_owner_admin_settings(uuid)
  to authenticated;
