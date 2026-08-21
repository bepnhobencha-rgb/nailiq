-- MQA-0110: authenticated salon members must not receive every salons column.
--
-- RLS limits rows, not columns. The legacy authenticated table-wide SELECT
-- therefore exposed owner contact details, provider identifiers, billing
-- state, internal notes and management-only settings to every member role in
-- the same salon. Replace it with an explicit operational projection and a
-- separately role-gated management-settings loader.

REVOKE SELECT ON TABLE public.salons FROM authenticated;

-- These are either already public booking-profile facts or are required by
-- the shared dashboard shell/receptionist workflow. No owner contact field,
-- notification recipient config, payment/provider identifier, internal note,
-- tenant-pause fact or AI instruction is included.
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
  closure_notice,
  timezone,
  dashboard_modules,
  dashboard_preset,
  dashboard_density,
  setup_wizard_completed_at,
  subscription_plan,
  plan_override,
  brand_color,
  theme_mode,
  currency_code,
  description,
  phone_otp_enabled,
  voice_ai_enabled,
  basic_mode_forced,
  walkin_auto_assign,
  queue_display_mode,
  vertical,
  public_sections_enabled,
  booking_images,
  staff_selection_enabled,
  booking_lead_minutes,
  group_together_threshold_minutes,
  reference_image_enabled,
  auto_no_show_minutes,
  noshow_protection_enabled,
  winback_enabled,
  default_notification_locale,
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
) ON TABLE public.salons TO authenticated;

CREATE OR REPLACE VIEW public.salon_member_operational_profiles
WITH (security_invoker = true, security_barrier = true)
AS
SELECT
  s.id,
  s.slug,
  s.name,
  s.created_at,
  s.address,
  s.salon_phone,
  s.opening_hours,
  s.profile_complete,
  s.booking_closed_dates,
  s.closure_notice,
  s.timezone,
  s.dashboard_modules,
  s.dashboard_preset,
  s.dashboard_density,
  s.setup_wizard_completed_at,
  s.subscription_plan,
  s.plan_override,
  s.brand_color,
  s.theme_mode,
  s.currency_code,
  s.description,
  s.phone_otp_enabled,
  s.voice_ai_enabled,
  s.basic_mode_forced,
  s.walkin_auto_assign,
  s.queue_display_mode,
  s.vertical,
  s.public_sections_enabled,
  s.booking_images,
  s.staff_selection_enabled,
  s.booking_lead_minutes,
  s.group_together_threshold_minutes,
  s.reference_image_enabled,
  s.auto_no_show_minutes,
  s.noshow_protection_enabled,
  s.winback_enabled,
  s.default_notification_locale,
  s.health_ack_required,
  s.email_links_enabled,
  s.resources_enabled,
  s.primary_grid_axis,
  s.tax_lines,
  s.privacy_url,
  s.terms_url,
  s.default_language,
  s.logo_url,
  s.archived_at
FROM public.salons AS s;

COMMENT ON VIEW public.salon_member_operational_profiles IS
  'Tenant-RLS operational salon projection for authenticated dashboard members; excludes owner PII, provider IDs and management-only settings.';

REVOKE ALL ON TABLE public.salon_member_operational_profiles
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.salon_member_operational_profiles
  TO authenticated;

CREATE OR REPLACE FUNCTION public.load_salon_member_operational_profile(
  p_salon_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_role text;
  v_profile jsonb;
BEGIN
  IF p_salon_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'invalid_request'
    );
  END IF;

  IF v_actor_id IS NULL
     OR NOT public.current_auth_session_is_active()
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'unauthorized'
    );
  END IF;

  SELECT sm.role
  INTO v_role
  FROM public.salon_members AS sm
  WHERE sm.salon_id = p_salon_id
    AND sm.user_id = v_actor_id
  FOR SHARE;

  IF NOT FOUND OR v_role NOT IN (
    'owner', 'admin', 'senior', 'receptionist', 'nail_tech'
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'forbidden'
    );
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'id', s.id,
    'slug', s.slug,
    'name', s.name,
    'created_at', s.created_at,
    'address', s.address,
    'salon_phone', s.salon_phone,
    'opening_hours', s.opening_hours,
    'profile_complete', s.profile_complete,
    'booking_closed_dates', s.booking_closed_dates,
    'closure_notice', s.closure_notice,
    'timezone', s.timezone,
    'dashboard_modules', s.dashboard_modules,
    'dashboard_preset', s.dashboard_preset,
    'dashboard_density', s.dashboard_density,
    'setup_wizard_completed_at', s.setup_wizard_completed_at,
    'subscription_plan', s.subscription_plan,
    'plan_override', s.plan_override,
    -- feature_flags is freeform management JSONB. Members receive only exact
    -- operational booleans and strictly validated theme colors; malformed or
    -- unknown keys (including legacy PII) are discarded.
    'feature_flags', (
      SELECT coalesce(
        pg_catalog.jsonb_object_agg(flag.key, flag.value ORDER BY flag.key),
        '{}'::jsonb
      )
      FROM pg_catalog.jsonb_each(coalesce(s.feature_flags, '{}'::jsonb)) AS flag
      WHERE (
        pg_catalog.jsonb_typeof(flag.value) = 'boolean'
        AND flag.key = ANY (ARRAY[
          'walkin_queue_enabled', 'walkin_auto_assign',
          'receptionist_center_enabled', 'receptionist_shell_v2_enabled',
          'guided_admin_setup_enabled', 'waitlist_attention_enabled',
          'archived_booking_recovery_enabled', 'rush_hour_mode_enabled',
          'soft_hold_enabled', 'density_mode_enabled',
          'smart_assignment_enabled', 'availability_engine_enabled',
          'ai_rule_first_optimization', 'nail_tryon_enabled',
          'ai_text_receptionist_enabled', 'staff_request_tracking',
          'customer_wait_page_enabled', 'phone_autolookup_enabled',
          'client_profiles_enabled', 'vip_flag_enabled',
          'repeat_customer_badge', 'reports_enabled', 'audit_log_enabled',
          'operational_metrics', 'client_health_score',
          'smart_retention_alerts', 'churn_detection', 'loyalty_enabled',
          'group_booking_enabled', 'multi_service_booking_enabled',
          'multi_location_enabled', 'booking_pause_enabled',
          'referral_qr_enabled', 'sms_campaigns_enabled',
          'qr_checkin_enabled', 'stripe_subscription_enabled',
          'unlimited_staff', 'unlimited_services', 'unlimited_bookings',
          'admin_copilot_enabled', 'ai_control_center_enabled',
          'waitlist_auto_book', 'ai_noshow_policy_live',
          'ai_noshow_policy_shadow', 'photo_confirmation',
          'ai_rebook', 'ai_winback', 'ai_first_visit_nurture'
        ]::text[])
      ) OR (
        flag.key = ANY (ARRAY[
          'drc_accent_color', 'drc_bg_color',
          'receptionist_preview_bg_color'
        ]::text[])
        AND pg_catalog.jsonb_typeof(flag.value) = 'string'
        AND pg_catalog.length(flag.value #>> '{}') = 7
        AND (flag.value #>> '{}') ~ '^#[0-9A-Fa-f]{6}$'
      )
    ),
    'brand_color', s.brand_color,
    'theme_mode', s.theme_mode,
    'currency_code', s.currency_code,
    'description', s.description,
    'phone_otp_enabled', s.phone_otp_enabled,
    'voice_ai_enabled', s.voice_ai_enabled,
    'basic_mode_forced', s.basic_mode_forced,
    'walkin_auto_assign', s.walkin_auto_assign,
    'queue_display_mode', s.queue_display_mode,
    'vertical', s.vertical,
    'public_sections_enabled', s.public_sections_enabled,
    'booking_images', s.booking_images,
    'staff_selection_enabled', s.staff_selection_enabled,
    'booking_lead_minutes', s.booking_lead_minutes,
    'group_together_threshold_minutes', s.group_together_threshold_minutes,
    'reference_image_enabled', s.reference_image_enabled,
    'auto_no_show_minutes', s.auto_no_show_minutes,
    'noshow_protection_enabled', s.noshow_protection_enabled,
    'winback_enabled', s.winback_enabled,
    'default_notification_locale', s.default_notification_locale,
    'health_ack_required', s.health_ack_required,
    'email_links_enabled', s.email_links_enabled,
    'resources_enabled', s.resources_enabled,
    'primary_grid_axis', s.primary_grid_axis,
    'tax_lines', s.tax_lines,
    'privacy_url', s.privacy_url,
    'terms_url', s.terms_url,
    'default_language', s.default_language,
    'logo_url', s.logo_url,
    'archived_at', s.archived_at,
    -- Only the two bounded lifecycle thresholds are exposed. Legacy or
    -- malicious extra JSON keys never cross this member boundary.
    'client_segment_settings', pg_catalog.jsonb_build_object(
      'new_max_visits', CASE
        WHEN pg_catalog.length(coalesce(
          s.client_segment_settings->>'new_max_visits',
          s.client_segment_settings->>'newMaxVisits',
          ''
        )) BETWEEN 1 AND 16
        AND coalesce(
          s.client_segment_settings->>'new_max_visits',
          s.client_segment_settings->>'newMaxVisits',
          ''
        ) ~ '^-?[0-9]+(\.[0-9]+)?$'
        THEN greatest(
          1,
          least(
            50,
            pg_catalog.round(coalesce(
              s.client_segment_settings->>'new_max_visits',
              s.client_segment_settings->>'newMaxVisits'
            )::numeric)::integer
          )
        )
        ELSE 1
      END,
      'at_risk_days', CASE
        WHEN pg_catalog.length(coalesce(
          s.client_segment_settings->>'at_risk_days',
          s.client_segment_settings->>'atRiskDays',
          ''
        )) BETWEEN 1 AND 16
        AND coalesce(
          s.client_segment_settings->>'at_risk_days',
          s.client_segment_settings->>'atRiskDays',
          ''
        ) ~ '^-?[0-9]+(\.[0-9]+)?$'
        THEN greatest(
          7,
          least(
            365,
            pg_catalog.round(coalesce(
              s.client_segment_settings->>'at_risk_days',
              s.client_segment_settings->>'atRiskDays'
            )::numeric)::integer
          )
        )
        ELSE 60
      END
    ),
    -- The raw JSONB is management-only. This normalized copy exactly matches
    -- the receptionist parser defaults and discards every unknown key.
    'staff_notification_settings', pg_catalog.jsonb_build_object(
      'enabled', CASE
        WHEN pg_catalog.jsonb_typeof(
          s.staff_notification_settings->'enabled'
        ) = 'boolean'
        THEN (s.staff_notification_settings->>'enabled')::boolean
        ELSE true
      END,
      'defaultLocale', CASE
        WHEN pg_catalog.lower(pg_catalog.btrim(
          coalesce(
            s.staff_notification_settings->>'defaultLocale',
            s.default_notification_locale,
            'en'
          )
        )) = 'vi'
        THEN 'vi'
        ELSE 'en'
      END,
      'channels', pg_catalog.jsonb_build_object(
        'sms', CASE
          WHEN pg_catalog.jsonb_typeof(
            s.staff_notification_settings->'channels'->'sms'
          ) = 'boolean'
          THEN (
            s.staff_notification_settings->'channels'->>'sms'
          )::boolean
          ELSE true
        END,
        'email', CASE
          WHEN pg_catalog.jsonb_typeof(
            s.staff_notification_settings->'channels'->'email'
          ) = 'boolean'
          THEN (
            s.staff_notification_settings->'channels'->>'email'
          )::boolean
          ELSE true
        END
      ),
      'eventDefaults', pg_catalog.jsonb_build_object(
        'create', CASE
          WHEN pg_catalog.jsonb_typeof(
            s.staff_notification_settings->'eventDefaults'->'create'
          ) = 'boolean'
          THEN (
            s.staff_notification_settings->'eventDefaults'->>'create'
          )::boolean
          ELSE true
        END,
        'reschedule', CASE
          WHEN pg_catalog.jsonb_typeof(
            s.staff_notification_settings->'eventDefaults'->'reschedule'
          ) = 'boolean'
          THEN (
            s.staff_notification_settings->'eventDefaults'->>'reschedule'
          )::boolean
          ELSE true
        END,
        'cancel', CASE
          WHEN pg_catalog.jsonb_typeof(
            s.staff_notification_settings->'eventDefaults'->'cancel'
          ) = 'boolean'
          THEN (
            s.staff_notification_settings->'eventDefaults'->>'cancel'
          )::boolean
          ELSE true
        END,
        'no_show', CASE
          WHEN pg_catalog.jsonb_typeof(
            s.staff_notification_settings->'eventDefaults'->'no_show'
          ) = 'boolean'
          THEN (
            s.staff_notification_settings->'eventDefaults'->>'no_show'
          )::boolean
          ELSE false
        END,
        'staff_change', CASE
          WHEN pg_catalog.jsonb_typeof(
            s.staff_notification_settings->'eventDefaults'->'staff_change'
          ) = 'boolean'
          THEN (
            s.staff_notification_settings->'eventDefaults'->>'staff_change'
          )::boolean
          ELSE true
        END
      )
    )
  )
  INTO v_profile
  FROM public.salons AS s
  WHERE s.id = p_salon_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'salon_not_found'
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'code', 'loaded',
    'contract_version', 1,
    'salon_id', p_salon_id,
    'role', v_role,
    'salon', v_profile
  );
END;
$$;

COMMENT ON FUNCTION public.load_salon_member_operational_profile(uuid) IS
  'Active-session tenant-member operational salon loader with normalized notification/segment settings and no owner PII or provider identifiers.';

REVOKE ALL ON FUNCTION public.load_salon_member_operational_profile(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_salon_member_operational_profile(uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.load_salon_owner_admin_settings(
  p_salon_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_role text;
  v_settings jsonb;
BEGIN
  IF p_salon_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'invalid_request'
    );
  END IF;

  IF v_actor_id IS NULL
     OR NOT public.current_auth_session_is_active()
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'unauthorized'
    );
  END IF;

  -- The row lock makes a concurrent membership downgrade/removal serialize
  -- with this read: the caller receives either the fully authorized snapshot
  -- before the change or a denial after it, never a post-revocation snapshot.
  SELECT sm.role
  INTO v_role
  FROM public.salon_members AS sm
  WHERE sm.salon_id = p_salon_id
    AND sm.user_id = v_actor_id
  FOR SHARE;

  IF NOT FOUND OR v_role NOT IN ('owner', 'admin') THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'forbidden'
    );
  END IF;

  SELECT pg_catalog.jsonb_build_object(
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
  INTO v_settings
  FROM public.salons AS s
  WHERE s.id = p_salon_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'salon_not_found'
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'code', 'loaded',
    'contract_version', 1,
    'salon_id', p_salon_id,
    'role', v_role,
    'settings', v_settings
  );
END;
$$;

COMMENT ON FUNCTION public.load_salon_owner_admin_settings(uuid) IS
  'Active-session owner/admin-only curated salon management settings loader; excludes provider identifiers, billing state, internal platform notes and tenant-pause metadata.';

REVOKE ALL ON FUNCTION public.load_salon_owner_admin_settings(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_salon_owner_admin_settings(uuid)
  TO authenticated;
