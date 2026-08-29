-- Keep the public multi-service entrypoint honest: Phase A cannot create a
-- sequence booking when no-show protection or a payment provider is enabled.
-- Expose that limitation in the readiness proof so the UI fails before the
-- customer enters a multi-step booking flow.
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
    coalesce(s.noshow_protection_enabled, false) IS FALSE
      AND nullif(trim(s.payment_provider), '') IS NULL
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
