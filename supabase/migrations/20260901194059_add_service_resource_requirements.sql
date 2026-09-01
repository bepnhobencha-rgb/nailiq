-- Service-level resource truth for Coco setup and the public slot grid.
-- Legacy services remain `salon_default`, preserving the established behavior
-- until an owner explicitly chooses a stricter requirement.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS resource_requirement_mode text NOT NULL DEFAULT 'salon_default',
  ADD COLUMN IF NOT EXISTS required_resource_kinds text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE public.services
  DROP CONSTRAINT IF EXISTS services_resource_requirement_mode_check,
  ADD CONSTRAINT services_resource_requirement_mode_check
    CHECK (resource_requirement_mode IN ('salon_default', 'none', 'specific'))
    NOT VALID,
  DROP CONSTRAINT IF EXISTS services_required_resource_kinds_check,
  ADD CONSTRAINT services_required_resource_kinds_check
    CHECK (
      required_resource_kinds <@ ARRAY[
        'station', 'chair', 'bed', 'backwash', 'room', 'other'
      ]::text[]
      AND (
        (resource_requirement_mode = 'specific' AND cardinality(required_resource_kinds) > 0)
        OR
        (resource_requirement_mode <> 'specific' AND cardinality(required_resource_kinds) = 0)
      )
    ) NOT VALID;

ALTER TABLE public.services
  VALIDATE CONSTRAINT services_resource_requirement_mode_check;
ALTER TABLE public.services
  VALIDATE CONSTRAINT services_required_resource_kinds_check;

COMMENT ON COLUMN public.services.resource_requirement_mode IS
  'salon_default preserves legacy resource mode; none needs no physical resource; specific restricts allocation to required_resource_kinds.';
COMMENT ON COLUMN public.services.required_resource_kinds IS
  'Owner-approved eligible salon_resources.kind values. Empty unless resource_requirement_mode=specific.';

GRANT SELECT (resource_requirement_mode, required_resource_kinds)
  ON TABLE public.services TO anon;

CREATE OR REPLACE VIEW public.public_service_catalog
WITH (security_barrier = true, security_invoker = true) AS
SELECT
  id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
  category, description, is_popular, is_featured, price_type,
  price_max_cents, is_addon, addon_timing, prep_minutes,
  resource_requirement_mode, required_resource_kinds
FROM public.services
WHERE deleted_at IS NULL;

REVOKE ALL ON TABLE public.public_service_catalog FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.public_service_catalog TO anon, authenticated, service_role;

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
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.display_order, x.id)
      FROM (
        SELECT r.id, r.name, r.kind, r.display_order
        FROM public.salon_resources AS r
        WHERE r.salon_id = s.id AND r.status = 'active' AND r.deleted_at IS NULL
      ) AS x
    ), '[]'::jsonb) ELSE '[]'::jsonb END
  )
  FROM salon AS s;
$$;

REVOKE ALL ON FUNCTION public.load_public_booking_snapshot(text, timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.load_public_booking_snapshot(text, timestamptz)
  TO anon, authenticated, service_role;

-- No PII: only occupied staff/resource/time intervals needed to reject false-open
-- customer slots. SECURITY DEFINER is required because anon cannot read booking
-- rows directly. Exact salon scoping and narrow output preserve that boundary.
CREATE OR REPLACE FUNCTION public.public_booking_capacity_for_range(
  p_salon_id uuid,
  p_start timestamptz,
  p_end timestamptz
)
RETURNS TABLE(
  staff_id uuid,
  resource_id uuid,
  start_time_utc timestamptz,
  end_time_utc timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT b.staff_id, b.resource_id, b.start_time_utc, b.end_time_utc
  FROM public.bookings AS b
  WHERE b.salon_id = p_salon_id
    AND b.deleted_at IS NULL
    AND b.status NOT IN ('cancelled', 'waiting', 'no_show', 'completed')
    AND b.start_time_utc < p_end
    AND b.end_time_utc > p_start
  UNION ALL
  SELECT seg.staff_id, seg.resource_id, seg.occupied_start_utc, seg.occupied_end_utc
  FROM public.booking_service_segments AS seg
  WHERE seg.salon_id = p_salon_id
    AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
    AND seg.occupied_start_utc < p_end
    AND seg.occupied_end_utc > p_start;
$$;

REVOKE ALL ON FUNCTION public.public_booking_capacity_for_range(uuid, timestamptz, timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_booking_capacity_for_range(uuid, timestamptz, timestamptz)
  TO anon, authenticated, service_role;
COMMENT ON FUNCTION public.public_booking_capacity_for_range(uuid, timestamptz, timestamptz) IS
  'Public booking conflict intervals by staff/resource; returns no customer or booking identity fields.';

-- Commit-time backstop for the single-booking path. Existing booking functions
-- may initially choose a legacy resource; the trigger replaces it with the first
-- compatible free resource before the exclusion constraint closes races.
CREATE OR REPLACE FUNCTION public.enforce_booking_service_resource_requirement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_resources_enabled boolean := false;
  v_mode text := 'salon_default';
  v_kinds text[] := '{}'::text[];
BEGIN
  SELECT coalesce(s.resources_enabled, false)
  INTO v_resources_enabled
  FROM public.salons AS s
  WHERE s.id = NEW.salon_id;

  IF NOT v_resources_enabled THEN
    RETURN NEW;
  END IF;

  SELECT svc.resource_requirement_mode, svc.required_resource_kinds
  INTO v_mode, v_kinds
  FROM public.services AS svc
  WHERE svc.id = NEW.service_id AND svc.salon_id = NEW.salon_id;

  IF v_mode = 'none' THEN
    NEW.resource_id := NULL;
    RETURN NEW;
  END IF;

  IF v_mode <> 'specific' THEN
    RETURN NEW;
  END IF;

  IF NEW.resource_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.salon_resources AS chosen
    WHERE chosen.id = NEW.resource_id
      AND chosen.salon_id = NEW.salon_id
      AND chosen.status = 'active'
      AND chosen.deleted_at IS NULL
      AND chosen.kind = ANY(v_kinds)
  ) THEN
    SELECT resource.id
    INTO NEW.resource_id
    FROM public.salon_resources AS resource
    WHERE resource.salon_id = NEW.salon_id
      AND resource.status = 'active'
      AND resource.deleted_at IS NULL
      AND resource.kind = ANY(v_kinds)
      AND NOT EXISTS (
        SELECT 1 FROM public.bookings AS existing
        WHERE existing.salon_id = NEW.salon_id
          AND existing.resource_id = resource.id
          AND existing.id IS DISTINCT FROM NEW.id
          AND existing.deleted_at IS NULL
          AND existing.status NOT IN ('cancelled', 'waiting', 'no_show', 'completed')
          AND pg_catalog.tstzrange(existing.start_time_utc, existing.end_time_utc, '[)')
            && pg_catalog.tstzrange(NEW.start_time_utc, NEW.end_time_utc, '[)')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.booking_service_segments AS segment
        WHERE segment.salon_id = NEW.salon_id
          AND segment.resource_id = resource.id
          AND segment.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
          AND pg_catalog.tstzrange(segment.occupied_start_utc, segment.occupied_end_utc, '[)')
            && pg_catalog.tstzrange(NEW.start_time_utc, NEW.end_time_utc, '[)')
      )
    ORDER BY resource.display_order, resource.id
    LIMIT 1;
  END IF;

  IF NEW.resource_id IS NULL THEN
    RAISE EXCEPTION 'no_compatible_resource_available' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_booking_service_resource_requirement()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS bookings_service_resource_requirement ON public.bookings;
CREATE TRIGGER bookings_service_resource_requirement
BEFORE INSERT OR UPDATE OF service_id, resource_id, start_time_utc, end_time_utc
ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.enforce_booking_service_resource_requirement();

COMMIT;
