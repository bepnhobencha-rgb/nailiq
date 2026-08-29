\set ON_ERROR_STOP on

BEGIN;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);

DO $controlled_rollout_behavior$
DECLARE
  v_ready_salon uuid := '71000000-0000-4000-8000-000000000001';
  v_blocked_salon uuid := '71000000-0000-4000-8000-000000000002';
  v_actor uuid := '72000000-0000-4000-8000-000000000001';
  v_staff uuid := '73000000-0000-4000-8000-000000000001';
  v_blocked_staff uuid := '73000000-0000-4000-8000-000000000002';
  v_result jsonb;
BEGIN
  INSERT INTO public.salons(
    id, slug, name, phone, timezone, currency_code, subscription_plan,
    subscription_status, is_beta, feature_flags, noshow_protection_enabled,
    payment_provider, resources_enabled
  ) VALUES
    (v_ready_salon, 'controlled-rollout-ready-qa', 'Controlled Rollout Ready QA',
      '+16045550701', 'UTC', 'CAD', 'premium', 'active', false, '{}'::jsonb,
      false, NULL, false),
    (v_blocked_salon, 'controlled-rollout-blocked-qa', 'Controlled Rollout Blocked QA',
      '+16045550702', 'UTC', 'CAD', 'premium', 'active', false, '{}'::jsonb,
      false, NULL, false);

  INSERT INTO public.service_categories(slug, name_en, name_vi, sort_order)
  VALUES ('controlled-rollout-qa', 'Controlled Rollout QA', 'Controlled Rollout QA', 999);
  INSERT INTO public.services(
    id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
    prep_minutes, is_addon, addon_timing, category
  ) VALUES
    ('74000000-0000-4000-8000-000000000001', v_ready_salon,
      'Ready Service One', 1000, 30, 0, 0, false, 'sequential', 'controlled-rollout-qa'),
    ('74000000-0000-4000-8000-000000000002', v_ready_salon,
      'Ready Service Two', 1200, 30, 0, 0, false, 'sequential', 'controlled-rollout-qa'),
    ('74000000-0000-4000-8000-000000000003', v_blocked_salon,
      'Only One Service', 1000, 30, 0, 0, false, 'sequential', 'controlled-rollout-qa');
  INSERT INTO public.staff(id, salon_id, name, status) VALUES
    (v_staff, v_ready_salon, 'Ready Staff', 'active'),
    (v_blocked_staff, v_blocked_salon, 'Blocked Staff', 'active');

  INSERT INTO public.platform_flags(key, enabled, description)
  VALUES ('feature_multi_service_booking', true, 'controlled rollout rehearsal')
  ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled;

  BEGIN
    UPDATE public.salons s
    SET feature_flags = pg_catalog.jsonb_set(
      s.feature_flags, '{multi_service_booking_enabled}', 'true'::jsonb, true
    )
    WHERE s.id = v_ready_salon;
    RAISE EXCEPTION 'generic flag update bypassed rollout authorization';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  v_result := public.configure_multi_service_booking_rollout(
    v_ready_salon, true, 'ENABLE_MULTI_SERVICE_PRODUCTION', v_actor
  );
  IF v_result->>'code' <> 'enabled'
     OR coalesce((v_result#>>'{readiness,ready}')::boolean, false) IS NOT TRUE
     OR NOT EXISTS (
       SELECT 1 FROM public.multi_service_booking_rollouts r
       WHERE r.salon_id = v_ready_salon AND r.enabled IS TRUE
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.salons s
       WHERE s.id = v_ready_salon
         AND s.feature_flags->'multi_service_booking_enabled' = 'true'::jsonb
     ) THEN
    RAISE EXCEPTION 'ready salon did not enable atomically: %', v_result;
  END IF;

  UPDATE public.salons s
  SET feature_flags = s.feature_flags - 'multi_service_booking_enabled'
  WHERE s.id = v_ready_salon;
  BEGIN
    UPDATE public.salons s
    SET feature_flags = pg_catalog.jsonb_set(
      s.feature_flags, '{multi_service_booking_enabled}', 'true'::jsonb, true
    )
    WHERE s.id = v_ready_salon;
    RAISE EXCEPTION 'existing rollout row bypassed the dedicated control RPC';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  v_result := public.configure_multi_service_booking_rollout(
    v_ready_salon, true, 'ENABLE_MULTI_SERVICE_PRODUCTION', v_actor
  );
  IF v_result->>'code' <> 'enabled' THEN
    RAISE EXCEPTION 'dedicated RPC could not safely re-enable: %', v_result;
  END IF;

  v_result := public.configure_multi_service_booking_rollout(
    v_blocked_salon, true, 'ENABLE_MULTI_SERVICE_PRODUCTION', v_actor
  );
  IF v_result->>'code' <> 'not_ready'
     OR EXISTS (
       SELECT 1 FROM public.multi_service_booking_rollouts r
       WHERE r.salon_id = v_blocked_salon AND r.enabled IS TRUE
     )
     OR EXISTS (
       SELECT 1 FROM public.salons s
       WHERE s.id = v_blocked_salon
         AND s.feature_flags->'multi_service_booking_enabled' = 'true'::jsonb
     ) THEN
    RAISE EXCEPTION 'not-ready salon was not rolled back atomically: %', v_result;
  END IF;

  v_result := public.configure_multi_service_booking_rollout(
    v_ready_salon, false, 'DISABLE_MULTI_SERVICE_PRODUCTION', v_actor
  );
  IF v_result->>'code' <> 'disabled'
     OR EXISTS (
       SELECT 1 FROM public.multi_service_booking_rollouts r
       WHERE r.salon_id = v_ready_salon AND r.enabled IS TRUE
     )
     OR EXISTS (
       SELECT 1 FROM public.salons s
       WHERE s.id = v_ready_salon
         AND s.feature_flags ? 'multi_service_booking_enabled'
     ) THEN
    RAISE EXCEPTION 'ready salon did not disable atomically: %', v_result;
  END IF;

  PERFORM pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  v_result := public.configure_multi_service_booking_rollout(
    v_ready_salon, true, 'ENABLE_MULTI_SERVICE_PRODUCTION', v_actor
  );
  IF v_result->>'code' <> 'unauthorized' THEN
    RAISE EXCEPTION 'non-service caller reached controlled rollout: %', v_result;
  END IF;
END;
$controlled_rollout_behavior$;

ROLLBACK;
