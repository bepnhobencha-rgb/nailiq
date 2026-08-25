-- MQA-0148: collapse the anonymous booking catalog into one RLS-preserving
-- PostgREST call. The function is SECURITY INVOKER on purpose: anon and
-- authenticated callers retain the same policies and column-safe views as
-- the former individual reads.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.load_public_booking_snapshot(
  p_slug text,
  p_now timestamptz DEFAULT pg_catalog.clock_timestamp()
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH salon AS MATERIALIZED (
    SELECT
      p.id, p.slug, p.name, p.address, p.salon_phone, p.opening_hours,
      p.profile_complete, p.booking_closed_dates, p.closure_notice, p.timezone,
      p.subscription_plan, p.plan_override, p.feature_flags, p.brand_color,
      p.theme_mode, p.currency_code, p.description, p.phone_otp_enabled,
      p.voice_ai_enabled, p.vertical, p.public_sections_enabled,
      p.booking_images, p.staff_selection_enabled, p.booking_lead_minutes,
      p.group_together_threshold_minutes, p.reference_image_enabled,
      p.health_ack_required, p.email_links_enabled, p.resources_enabled,
      p.tax_lines, p.privacy_url, p.terms_url, p.default_language, p.logo_url
    FROM public.public_salon_profiles AS p
    WHERE p.slug = pg_catalog.lower(pg_catalog.btrim(p_slug))
    LIMIT 1
  ), active_promotions AS MATERIALIZED (
    SELECT
      p.id, p.name, p.discount_type, p.discount_value, p.applies_to,
      p.days_of_week, p.time_start, p.time_end
    FROM public.promotions AS p
    JOIN salon AS s ON s.id = p.salon_id
    WHERE p.active IS TRUE
      AND p.starts_at <= p_now
      AND p.ends_at >= p_now
  )
  SELECT pg_catalog.jsonb_build_object(
    'salon', pg_catalog.to_jsonb(s),
    'services', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.name, x.id)
      FROM (
        SELECT
          c.id, c.name, c.duration_minutes, c.prep_minutes, c.buffer_minutes,
          c.price_cents, c.price_type, c.price_max_cents, c.category,
          c.description, c.is_popular, c.is_featured, c.is_addon,
          c.addon_timing
        FROM public.public_service_catalog AS c
        WHERE c.salon_id = s.id
      ) AS x
    ), '[]'::jsonb),
    'staff', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.name, x.id)
      FROM (
        SELECT p.id, p.name, p.job_role
        FROM public.public_staff_profiles AS p
        WHERE p.salon_id = s.id AND p.status = 'active'
      ) AS x
    ), '[]'::jsonb),
    'capabilities', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.staff_id, x.service_id)
      FROM (
        SELECT ss.staff_id, ss.service_id
        FROM public.staff_services AS ss
        JOIN public.public_staff_profiles AS p ON p.id = ss.staff_id
        WHERE p.salon_id = s.id AND p.status = 'active'
      ) AS x
    ), '[]'::jsonb),
    'promotions', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.name, p.id)
      FROM active_promotions AS p
    ), '[]'::jsonb),
    'promotion_services', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.promotion_id, x.service_id)
      FROM (
        SELECT ps.promotion_id, ps.service_id, ps.discount_type, ps.discount_value
        FROM public.promotion_services AS ps
        JOIN active_promotions AS p ON p.id = ps.promotion_id
      ) AS x
    ), '[]'::jsonb),
    'combos', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.position, x.id)
      FROM (
        SELECT
          c.id, c.name, c.description, c.service_ids, c.price_cents,
          c.discount_cents, c.duration_minutes, c.position
        FROM public.service_combos AS c
        WHERE c.salon_id = s.id AND c.is_active IS TRUE
      ) AS x
    ), '[]'::jsonb),
    'resources', CASE WHEN s.resources_enabled IS TRUE THEN COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.display_order, x.id)
      FROM (
        SELECT r.id, r.name, r.display_order
        FROM public.salon_resources AS r
        WHERE r.salon_id = s.id
          AND r.status = 'active'
          AND r.deleted_at IS NULL
      ) AS x
    ), '[]'::jsonb) ELSE '[]'::jsonb END
  )
  FROM salon AS s;
$$;

REVOKE ALL ON FUNCTION public.load_public_booking_snapshot(text, timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.load_public_booking_snapshot(text, timestamptz)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.load_public_booking_snapshot(text, timestamptz) IS
  'RLS-preserving public salon and booking catalog snapshot; no owner contact, billing, provider, or internal AI data.';

-- These two projections are service-role only. Application authorization is
-- completed before either call; consolidating related reads does not widen
-- the dashboard membership boundary.
CREATE OR REPLACE FUNCTION public.load_salon_dashboard_projection(
  p_salon_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_bookings jsonb;
  v_services_count bigint;
  v_staff_count bigint;
BEGIN
  -- Separate statements keep the projection easy to audit while preserving
  -- one PostgREST round-trip from the server action.
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
          'id', b.id,
          'client_name', b.client_name,
          'client_phone', b.client_phone,
          'client_notes', b.client_notes,
          'start_time_utc', b.start_time_utc,
          'status', b.status,
          'source', b.source,
          'price_cents', b.price_cents,
          'verification_method', b.verification_method,
          'sms_confirmation_sent_at', b.sms_confirmation_sent_at,
          'sms_confirmation_failed_at', b.sms_confirmation_failed_at,
          'no_show_risk_score', b.no_show_risk_score,
          'seat_together', b.seat_together,
          'services', CASE WHEN svc.id IS NULL THEN NULL ELSE
            pg_catalog.jsonb_build_object(
              'name', svc.name,
              'price_cents', svc.price_cents
            ) END,
          'staff', CASE WHEN st.id IS NULL THEN NULL ELSE
            pg_catalog.jsonb_build_object('name', st.name) END
        ) ORDER BY b.start_time_utc, b.id
    ), '[]'::jsonb)
  INTO v_bookings
  FROM public.bookings AS b
  LEFT JOIN public.services AS svc ON svc.id = b.service_id
  LEFT JOIN public.staff AS st ON st.id = b.staff_id
  WHERE b.salon_id = p_salon_id
    AND b.status IN ('pending', 'confirmed', 'in_progress', 'completed')
    AND b.start_time_utc >= p_from
    AND b.start_time_utc <= p_to;

  SELECT pg_catalog.count(*)
  INTO v_services_count
  FROM public.services AS s
  WHERE s.salon_id = p_salon_id AND s.deleted_at IS NULL;

  SELECT pg_catalog.count(*)
  INTO v_staff_count
  FROM public.staff AS s
  WHERE s.salon_id = p_salon_id AND s.deleted_at IS NULL;

  RETURN pg_catalog.jsonb_build_object(
    'bookings', v_bookings,
    'services_count', v_services_count,
    'staff_count', v_staff_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.load_salon_dashboard_projection(uuid, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_salon_dashboard_projection(uuid, timestamptz, timestamptz)
  TO service_role;

CREATE OR REPLACE FUNCTION public.load_owner_home_projection(
  p_salon_id uuid,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_month_start timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_bookings jsonb;
  v_staff jsonb;
  v_prior_clients jsonb;
BEGIN
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
          'id', b.id,
          'status', b.status,
          'staff_id', b.staff_id,
          'service_id', b.service_id,
          'start_time_utc', b.start_time_utc,
          'end_time_utc', b.end_time_utc,
          'price_cents', b.price_cents,
          'addon_price_cents', b.addon_price_cents,
          'client_phone', b.client_phone,
          'client_profile_id', b.client_profile_id,
          'services', CASE WHEN svc.id IS NULL THEN NULL ELSE
            pg_catalog.jsonb_build_object('name', svc.name) END
        ) ORDER BY b.start_time_utc, b.id
    ), '[]'::jsonb)
  INTO v_bookings
  FROM public.bookings AS b
  LEFT JOIN public.services AS svc ON svc.id = b.service_id
  WHERE b.salon_id = p_salon_id
    AND b.start_time_utc >= p_window_start
    AND b.start_time_utc < p_window_end;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
          'id', s.id,
          'name', s.name,
          'status', s.status,
          'deleted_at', s.deleted_at
        ) ORDER BY s.created_at, s.id
    ), '[]'::jsonb)
  INTO v_staff
  FROM public.staff AS s
  WHERE s.salon_id = p_salon_id;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
          'client_phone', b.client_phone,
          'client_profile_id', b.client_profile_id
        )
    ), '[]'::jsonb)
  INTO v_prior_clients
  FROM public.bookings AS b
  WHERE b.salon_id = p_salon_id
    AND b.start_time_utc < p_month_start
    AND b.status <> 'cancelled';

  RETURN pg_catalog.jsonb_build_object(
    'bookings', v_bookings,
    'staff', v_staff,
    'prior_clients', v_prior_clients
  );
END;
$$;

REVOKE ALL ON FUNCTION public.load_owner_home_projection(uuid, timestamptz, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_owner_home_projection(uuid, timestamptz, timestamptz, timestamptz)
  TO service_role;

COMMIT;
