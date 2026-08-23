\set ON_ERROR_STOP on

BEGIN;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);

DO $chair_balance$
DECLARE
  v_salon uuid := '17700000-0000-4000-8000-000000000001';
  v_service_one uuid := '17700000-0000-4000-8000-000000000011';
  v_service_two uuid := '17700000-0000-4000-8000-000000000012';
  v_staff_one uuid := '17700000-0000-4000-8000-000000000021';
  v_staff_two uuid := '17700000-0000-4000-8000-000000000022';
  v_resource_heavy uuid := '17700000-0000-4000-8000-000000000031';
  v_resource_busy uuid := '17700000-0000-4000-8000-000000000032';
  v_resource_balanced uuid := '17700000-0000-4000-8000-000000000033';
  v_start timestamptz := date_trunc('day', transaction_timestamp() + interval '8 days')
    + interval '12 hours';
  v_request jsonb;
  v_quote jsonb;
  v_preferred_quote jsonb;
  v_busy_quote jsonb;
  v_tie_quote jsonb;
BEGIN
  INSERT INTO public.salons(
    id, slug, name, phone, timezone, opening_hours, currency_code,
    subscription_plan, subscription_status, is_beta, resources_enabled,
    tax_lines, feature_flags
  ) VALUES (
    v_salon, 'disposable-chair-balance-qa', 'Disposable Chair Balance QA',
    '+16045550777', 'UTC',
    '{"sun":{"open":"00:00","close":"23:59","closed":false},"mon":{"open":"00:00","close":"23:59","closed":false},"tue":{"open":"00:00","close":"23:59","closed":false},"wed":{"open":"00:00","close":"23:59","closed":false},"thu":{"open":"00:00","close":"23:59","closed":false},"fri":{"open":"00:00","close":"23:59","closed":false},"sat":{"open":"00:00","close":"23:59","closed":false}}'::jsonb,
    'CAD', 'premium', 'active', true, true, '[]'::jsonb, '{}'::jsonb
  );
  INSERT INTO public.service_categories(slug, name_en, name_vi, sort_order)
  VALUES ('qa-chair-balance', 'QA Chair Balance', 'QA Chair Balance', 997);
  INSERT INTO public.services(
    id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
    prep_minutes, is_addon, addon_timing, category
  ) VALUES
    (v_service_one, v_salon, 'Chair Balance One', 3000, 30, 0, 0,
      false, 'sequential', 'qa-chair-balance'),
    (v_service_two, v_salon, 'Chair Balance Two', 3000, 30, 0, 0,
      false, 'sequential', 'qa-chair-balance');
  INSERT INTO public.staff(id, salon_id, name, status) VALUES
    (v_staff_one, v_salon, 'Chair Balance Staff One', 'active'),
    (v_staff_two, v_salon, 'Chair Balance Staff Two', 'active');
  INSERT INTO public.salon_resources(
    id, salon_id, name, kind, display_order, status
  ) VALUES
    (v_resource_heavy, v_salon, 'Heavy Chair', 'chair', 10, 'active'),
    (v_resource_busy, v_salon, 'Busy Chair', 'chair', 20, 'active'),
    (v_resource_balanced, v_salon, 'Balanced Chair', 'chair', 0, 'active');

  INSERT INTO public.platform_flags(key, enabled, description)
  VALUES ('feature_multi_service_booking', true, 'chair balancing rehearsal')
  ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled;

  PERFORM public.configure_multi_service_booking_qa_salon(
    v_salon, true, 'ENABLE_MULTI_SERVICE_QA'
  );

  -- Completed work counts as wear. Cancelled work must not distort the score.
  INSERT INTO public.bookings(
    salon_id, service_id, staff_id, resource_id, client_name, client_phone,
    start_time_utc, end_time_utc, status, source, schedule_model
  ) VALUES
    (v_salon, v_service_one, v_staff_two, v_resource_heavy,
      'Heavy Wear One', '16045550701', v_start - interval '4 hours',
      v_start - interval '2 hours', 'completed', 'appointment', 'single'),
    (v_salon, v_service_one, v_staff_two, v_resource_balanced,
      'Balanced Wear', '16045550702', v_start - interval '3 hours',
      v_start - interval '2 hours 30 minutes', 'completed', 'appointment', 'single'),
    (v_salon, v_service_one, v_staff_two, v_resource_balanced,
      'Cancelled Wear', '16045550703', v_start - interval '6 hours',
      v_start - interval '1 hour', 'cancelled', 'appointment', 'single'),
    (v_salon, v_service_one, v_staff_two, v_resource_busy,
      'Live Conflict', '16045550704', v_start,
      v_start + interval '30 minutes', 'confirmed', 'appointment', 'single');

  IF public.salon_resource_booked_minutes_for_day(
       v_salon, v_resource_heavy, v_start::date, 'UTC', '[]'::jsonb, NULL
     ) <> 120
     OR public.salon_resource_booked_minutes_for_day(
       v_salon, v_resource_busy, v_start::date, 'UTC', '[]'::jsonb, NULL
     ) <> 30
     OR public.salon_resource_booked_minutes_for_day(
       v_salon, v_resource_balanced, v_start::date, 'UTC', '[]'::jsonb, NULL
     ) <> 30 THEN
    RAISE EXCEPTION 'salon/day booked-minute score is incorrect';
  END IF;

  v_request := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'salon_id', v_salon,
    'request_id', '17700000-0000-4000-8000-000000000041'::uuid,
    'requested_start_time_utc', v_start,
    'lines', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'line_id', '17700000-0000-4000-8000-000000000051'::uuid,
        'position', 0, 'service_id', v_service_one,
        'staff_preference', 'any', 'preferred_resource_id', NULL,
        'addon_service_ids', '[]'::jsonb
      ),
      pg_catalog.jsonb_build_object(
        'line_id', '17700000-0000-4000-8000-000000000052'::uuid,
        'position', 1, 'service_id', v_service_two,
        'staff_preference', 'any', 'preferred_resource_id', NULL,
        'addon_service_ids', '[]'::jsonb
      )
    ),
    'same_staff_for_all', false,
    'voucher_code', NULL,
    'apply_email_discount', false,
    'customer', pg_catalog.jsonb_build_object(
      'name', 'Chair Balance Customer', 'phone', '+1 604 555 0777',
      'email', 'chair-balance@example.test'
    )
  );

  v_quote := public.quote_public_booking_sequence(v_request);
  IF coalesce((v_quote->>'success')::boolean, false) IS NOT TRUE
     OR (v_quote#>>'{segments,0,resource_id}')::uuid <> v_resource_balanced
     OR (v_quote#>>'{segments,1,resource_id}')::uuid <> v_resource_busy
     OR (v_quote#>>'{segments,0,customer_start_utc}')::timestamptz <> v_start THEN
    RAISE EXCEPTION 'availability-first balanced allocation failed: %', v_quote;
  END IF;

  -- A declared preference wins even when that chair has more booked minutes.
  v_preferred_quote := public.quote_public_booking_sequence(
    pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(v_request, '{request_id}',
          pg_catalog.to_jsonb('17700000-0000-4000-8000-000000000042'::uuid)),
        '{lines}', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'line_id', '17700000-0000-4000-8000-000000000053'::uuid,
            'position', 0, 'service_id', v_service_one,
            'staff_preference', 'any',
            'preferred_resource_id', v_resource_heavy,
            'addon_service_ids', '[]'::jsonb
          )
        )
      ),
      '{requested_start_time_utc}', pg_catalog.to_jsonb(v_start + interval '2 hours')
    )
  );
  IF coalesce((v_preferred_quote->>'success')::boolean, false) IS NOT TRUE
     OR (v_preferred_quote#>>'{segments,0,resource_id}')::uuid <> v_resource_heavy THEN
    RAISE EXCEPTION 'explicit chair preference was overridden: %', v_preferred_quote;
  END IF;

  -- A declared but occupied chair is rejected; balancing may not bypass it.
  v_busy_quote := public.quote_public_booking_sequence(
    pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(v_request, '{request_id}',
        pg_catalog.to_jsonb('17700000-0000-4000-8000-000000000043'::uuid)),
      '{lines}', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_id', '17700000-0000-4000-8000-000000000054'::uuid,
          'position', 0, 'service_id', v_service_one,
          'staff_preference', 'any',
          'preferred_resource_id', v_resource_busy,
          'addon_service_ids', '[]'::jsonb
        )
      )
    )
  );
  IF v_busy_quote->>'code' <> 'slot_conflict' THEN
    RAISE EXCEPTION 'occupied explicit chair was not rejected: %', v_busy_quote;
  END IF;

  -- With equal zero-minute scores on another day, owner display order then UUID
  -- is the deterministic tie-break.
  v_tie_quote := public.quote_public_booking_sequence(
    pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(v_request, '{request_id}',
          pg_catalog.to_jsonb('17700000-0000-4000-8000-000000000044'::uuid)),
        '{requested_start_time_utc}', pg_catalog.to_jsonb(v_start + interval '1 day')
      ),
      '{lines}', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_id', '17700000-0000-4000-8000-000000000055'::uuid,
          'position', 0, 'service_id', v_service_one,
          'staff_preference', 'any', 'preferred_resource_id', NULL,
          'addon_service_ids', '[]'::jsonb
        )
      )
    )
  );
  IF coalesce((v_tie_quote->>'success')::boolean, false) IS NOT TRUE
     OR (v_tie_quote#>>'{segments,0,resource_id}')::uuid <> v_resource_balanced THEN
    RAISE EXCEPTION 'stable display-order tie-break failed: %', v_tie_quote;
  END IF;
END;
$chair_balance$;

ROLLBACK;

DO $chair_balance_cleanup$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.salons
    WHERE id = '17700000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'chair balancing rehearsal left fixture rows';
  END IF;
END;
$chair_balance_cleanup$;

SELECT 'chair_resource_balancing_pass' AS result;
