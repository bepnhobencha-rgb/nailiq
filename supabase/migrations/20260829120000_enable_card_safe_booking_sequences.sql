-- Multi-service Phase B: allow a sequence only when its payment/no-show policy
-- can use NailIQ's existing card-on-file continuation. This never authorizes a
-- deposit, charge, refund, or any other money movement.

CREATE OR REPLACE FUNCTION public.booking_sequence_payment_policy_ready(
  p_salon_id uuid,
  p_lock boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path TO ''
AS $sequence_payment_policy$
DECLARE
  v_ready boolean := false;
BEGIN
  IF p_lock THEN
    -- A fresh create holds both policy rows until commit. Quote/readiness calls
    -- stay read-only, while create closes the config-change TOCTOU window.
    PERFORM 1 FROM public.salons s WHERE s.id = p_salon_id FOR UPDATE;
    PERFORM 1 FROM public.square_integrations sq
      WHERE sq.salon_id = p_salon_id FOR UPDATE;
  END IF;

  SELECT CASE
    WHEN coalesce(s.noshow_protection_enabled, false) IS FALSE
         AND nullif(lower(pg_catalog.btrim(s.payment_provider)), '') IS NULL
         AND NOT (
           coalesce(sq.enabled, false) AND coalesce(sq.deposit_enabled, false)
         )
      THEN true
    WHEN (
        lower(pg_catalog.btrim(coalesce(s.payment_provider, ''))) = 'square'
        OR (
          nullif(pg_catalog.btrim(s.payment_provider), '') IS NULL
          AND coalesce(sq.enabled, false)
        )
      )
      THEN coalesce(sq.enabled, false)
        AND coalesce(sq.deposit_enabled, false) IS FALSE
        AND nullif(pg_catalog.btrim(sq.access_token), '') IS NOT NULL
        AND nullif(pg_catalog.btrim(sq.application_id), '') IS NOT NULL
        AND nullif(pg_catalog.btrim(sq.merchant_id), '') IS NOT NULL
        AND nullif(pg_catalog.btrim(sq.location_id), '') IS NOT NULL
        AND lower(pg_catalog.btrim(sq.environment)) IN ('sandbox', 'production')
        AND (
          coalesce(s.noshow_protection_enabled, false) IS FALSE
          OR (
            coalesce(s.noshow_fee_percent, 0) > 0
            AND pg_catalog.jsonb_typeof(s.cancellation_policy) = 'object'
            AND nullif(pg_catalog.btrim(s.cancellation_policy ->> 'en'), '') IS NOT NULL
            AND nullif(pg_catalog.btrim(s.cancellation_policy ->> 'vi'), '') IS NOT NULL
            AND (s.cancellation_policy ->> 'en') !~ '\[[^]]+\]'
            AND (s.cancellation_policy ->> 'vi') !~ '\[[^]]+\]'
          )
        )
    ELSE false
  END
  INTO v_ready
  FROM public.salons s
  LEFT JOIN public.square_integrations sq ON sq.salon_id = s.id
  WHERE s.id = p_salon_id AND s.archived_at IS NULL;

  RETURN coalesce(v_ready, false);
END;
$sequence_payment_policy$;

REVOKE ALL ON FUNCTION public.booking_sequence_payment_policy_ready(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_sequence_payment_policy_ready(uuid, boolean)
  TO service_role;

CREATE OR REPLACE FUNCTION public.load_public_booking_sequence_readiness(
  p_salon_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO ''
AS $sequence_readiness$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_platform boolean := false;
  v_salon boolean := false;
  v_qa_allowlisted boolean := false;
  v_catalog boolean := false;
  v_capacity boolean := false;
  v_payment_policy boolean := false;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  SELECT coalesce(p.enabled, false) INTO v_platform
  FROM public.platform_flags p WHERE p.key = 'feature_multi_service_booking';
  v_platform := coalesce(v_platform, false);
  SELECT
    s.feature_flags->'multi_service_booking_enabled' = 'true'::jsonb,
    public.booking_sequence_payment_policy_ready(s.id, false)
  INTO v_salon, v_payment_policy
  FROM public.salons s
  WHERE s.id = p_salon_id AND s.archived_at IS NULL;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'not_found');
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.platform_settings ps
    WHERE ps.id = 'platform' AND ps.multi_service_booking_qa_salon_id = p_salon_id)
  INTO v_qa_allowlisted;
  SELECT (
    count(*) FILTER (WHERE svc.deleted_at IS NULL AND svc.is_addon IS FALSE
      AND svc.price_cents >= 0 AND svc.duration_minutes > 0
      AND svc.buffer_minutes >= 0 AND svc.prep_minutes BETWEEN 0 AND 180) >= 2
    AND EXISTS (SELECT 1 FROM public.staff st
      WHERE st.salon_id = p_salon_id AND st.status = 'active' AND st.deleted_at IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM public.services required
      WHERE required.salon_id = p_salon_id AND required.deleted_at IS NULL
        AND required.is_addon IS FALSE
        AND EXISTS (SELECT 1 FROM public.staff_services configured
          JOIN public.staff configured_staff ON configured_staff.id = configured.staff_id
          WHERE configured_staff.salon_id = p_salon_id
            AND configured_staff.status = 'active' AND configured_staff.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM public.staff_services ss
          JOIN public.staff capable ON capable.id = ss.staff_id
          WHERE ss.service_id = required.id AND capable.salon_id = p_salon_id
            AND capable.status = 'active' AND capable.deleted_at IS NULL)
    )
    AND (
      NOT EXISTS (SELECT 1 FROM public.salons rs
        WHERE rs.id = p_salon_id AND rs.resources_enabled IS TRUE)
      OR EXISTS (SELECT 1 FROM public.salon_resources r
        WHERE r.salon_id = p_salon_id AND r.status = 'active' AND r.deleted_at IS NULL)
    )
  ) INTO v_catalog FROM public.services svc WHERE svc.salon_id = p_salon_id;
  SELECT count(*) = 4
    AND bool_and(c.convalidated)
    AND count(*) FILTER (WHERE c.conrelid = 'public.bookings'::regclass
      AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%schedule_model%single%') = 2
    AND count(*) FILTER (WHERE c.conrelid = 'public.booking_service_segments'::regclass) = 2
  INTO v_capacity
  FROM pg_catalog.pg_constraint c
  WHERE c.conname IN (
    'bookings_no_overlap', 'bookings_resource_no_overlap',
    'booking_service_segments_staff_no_overlap',
    'booking_service_segments_resource_no_overlap'
  ) AND c.contype = 'x'
    AND c.connamespace = 'public'::regnamespace;
  v_capacity := coalesce(v_capacity, false)
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'public.bookings'::regclass
        AND t.tgname = 'enforce_single_booking_capacity_across_models'
        AND NOT t.tgisinternal)
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'public.booking_service_segments'::regclass
        AND t.tgname = 'enforce_segment_capacity_across_models'
        AND NOT t.tgisinternal)
    AND NOT has_function_privilege('anon',
      'public.quote_public_booking_sequence(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated',
      'public.create_public_booking_sequence(jsonb)', 'EXECUTE')
    AND has_function_privilege('service_role',
      'public.create_public_booking_sequence(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon',
      'public.replay_public_booking_sequence(jsonb)', 'EXECUTE')
    AND has_function_privilege('service_role',
      'public.replay_public_booking_sequence(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon',
      'public.quote_booking_sequence_reschedule(uuid,uuid,timestamptz)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated',
      'public.reschedule_booking_sequence_with_management_capability(uuid,uuid,timestamptz,text)',
      'EXECUTE')
    AND has_function_privilege('service_role',
      'public.quote_booking_sequence_reschedule(uuid,uuid,timestamptz)', 'EXECUTE')
    AND has_function_privilege('service_role',
      'public.reschedule_booking_sequence_with_management_capability(uuid,uuid,timestamptz,text)',
      'EXECUTE')
    AND NOT has_function_privilege('anon',
      'public.reschedule_booking_sequence_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)',
      'EXECUTE')
    AND has_function_privilege('service_role',
      'public.reschedule_booking_sequence_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)',
      'EXECUTE')
    AND NOT has_function_privilege('anon',
      'public.replay_booking_sequence_reschedule_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)',
      'EXECUTE')
    AND has_function_privilege('service_role',
      'public.replay_booking_sequence_reschedule_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)',
      'EXECUTE');
  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'code', 'loaded',
    'contract_version', 1,
    'schedule_model', 'segments_v1',
    'platform_enabled', v_platform,
    'salon_enabled', coalesce(v_salon, false),
    'qa_allowlisted', coalesce(v_qa_allowlisted, false),
    'catalog_ready', coalesce(v_catalog, false),
    'capacity_contract_ready', coalesce(v_capacity, false),
    'payment_policy_ready', coalesce(v_payment_policy, false),
    'ready', v_platform AND coalesce(v_salon, false)
      AND coalesce(v_qa_allowlisted, false)
      AND coalesce(v_catalog, false) AND coalesce(v_capacity, false)
      AND coalesce(v_payment_policy, false)
  );
END;
$sequence_readiness$;

REVOKE ALL ON FUNCTION public.load_public_booking_sequence_readiness(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_public_booking_sequence_readiness(uuid)
  TO service_role;

-- These two functions are intentionally patched from their already-deployed,
-- reviewed definitions. Each replacement is exact and the migration aborts on
-- any upstream body drift instead of silently weakening the policy boundary.
DO $sequence_policy_patch$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.resolve_booking_sequence_pricing_and_schedule(jsonb,boolean)'::regprocedure
  ) INTO v_definition;
  v_old := $old_resolver$IF v_noshow_protection_enabled OR v_payment_provider IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'payment_not_supported');
  END IF;$old_resolver$;
  v_new := $new_resolver$IF NOT public.booking_sequence_payment_policy_ready(v_salon_id, p_lock_claims) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'payment_not_supported');
  END IF;$new_resolver$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'booking sequence resolver payment guard drifted';
  END IF;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := $old_readiness$'capacity_contract_ready', true,
      'ready', true$old_readiness$;
  v_new := $new_readiness$'capacity_contract_ready', true,
      'payment_policy_ready', true,
      'ready', true$new_readiness$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'booking sequence quote readiness projection drifted';
  END IF;
  EXECUTE pg_catalog.replace(v_definition, v_old, v_new);

  SELECT pg_catalog.pg_get_functiondef(
    'public.create_public_booking_sequence(jsonb)'::regprocedure
  ) INTO v_definition;
  v_old := $old_create$IF v_locked_noshow_protection_enabled OR v_locked_payment_provider IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'payment_not_supported');
  END IF;$old_create$;
  v_new := $new_create$IF NOT public.booking_sequence_payment_policy_ready(v_salon_id, true) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'payment_not_supported');
  END IF;$new_create$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'booking sequence create payment guard drifted';
  END IF;
  EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END;
$sequence_policy_patch$;
