-- Remove the Security Advisor ERROR on the public resource view without opening
-- salon_resources RLS. The booking snapshot calls one narrow, salon-scoped
-- definer helper in a non-exposed schema; the public snapshot itself remains
-- SECURITY INVOKER.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER VIEW public.public_booking_resource_catalog
  SET (security_invoker = true);

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA private TO anon, service_role;

CREATE OR REPLACE FUNCTION private.public_booking_resources_for_salon(
  p_salon_id uuid
)
RETURNS TABLE(
  id uuid,
  name text,
  kind text,
  display_order integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT r.id, r.name, r.kind, r.display_order
  FROM public.salon_resources AS r
  JOIN public.salons AS s ON s.id = r.salon_id
  WHERE r.salon_id = p_salon_id
    AND r.status = 'active'
    AND r.deleted_at IS NULL
    AND s.archived_at IS NULL
    AND s.profile_complete IS TRUE
    AND s.resources_enabled IS TRUE
  ORDER BY r.display_order, r.id;
$$;

COMMENT ON FUNCTION private.public_booking_resources_for_salon(uuid) IS
  'Internal public-booking projection for one published salon: active resource id, name, kind and display order only. The private schema is not exposed by the Data API.';
REVOKE ALL ON FUNCTION private.public_booking_resources_for_salon(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.public_booking_resources_for_salon(uuid)
  TO anon, service_role;

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
    WHERE p.active IS TRUE AND p.starts_at <= p_now AND p.ends_at >= p_now
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
          c.addon_timing, c.resource_requirement_mode, c.required_resource_kinds
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
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) ORDER BY r.display_order, r.id)
      FROM private.public_booking_resources_for_salon(s.id) AS r
    ), '[]'::jsonb) ELSE '[]'::jsonb END
  )
  FROM salon AS s;
$$;

REVOKE ALL ON FUNCTION public.load_public_booking_snapshot(text, timestamptz)
  FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.load_public_booking_snapshot(text, timestamptz)
  TO anon, service_role;

COMMIT;

-- Rollback boundary: restore the source-controlled 20260908014241 view and
-- snapshot definitions, then drop
-- private.public_booking_resources_for_salon(uuid). Retain the private schema if
-- another audited object uses it; otherwise revoke its role usage and drop it.
