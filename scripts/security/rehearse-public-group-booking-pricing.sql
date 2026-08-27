\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.reject_group_rehearsal_addon()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.name = 'Rollback add-on' THEN
    RAISE EXCEPTION 'forced group add-on rollback';
  END IF;
  RETURN NEW;
END;
$$;

DO $rehearsal$
DECLARE
  v_salon constant uuid := 'b1000000-0000-4000-8000-000000000001';
  v_service constant uuid := 'b1000000-0000-4000-8000-000000000002';
  v_addon_one constant uuid := 'b1000000-0000-4000-8000-000000000003';
  v_addon_two constant uuid := 'b1000000-0000-4000-8000-000000000004';
  v_staff_one constant uuid := 'b1000000-0000-4000-8000-000000000005';
  v_staff_two constant uuid := 'b1000000-0000-4000-8000-000000000006';
  v_voucher constant uuid := 'b1000000-0000-4000-8000-000000000007';
  v_restricted_voucher constant uuid := 'b1000000-0000-4000-8000-000000000008';
  v_free_service_voucher constant uuid := 'b1000000-0000-4000-8000-000000000013';
  v_idem constant uuid := 'b1000000-0000-4000-8000-000000000009';
  v_changed_idem constant uuid := 'b1000000-0000-4000-8000-000000000010';
  v_rollback_idem constant uuid := 'b1000000-0000-4000-8000-000000000011';
  v_cap_idem constant uuid := 'b1000000-0000-4000-8000-000000000012';
  v_penny_idem constant uuid := 'b1000000-0000-4000-8000-000000000014';
  v_penny_salon constant uuid := 'b1000000-0000-4000-8000-000000000020';
  v_penny_service constant uuid := 'b1000000-0000-4000-8000-000000000021';
  v_penny_staff_one constant uuid := 'b1000000-0000-4000-8000-000000000022';
  v_penny_staff_two constant uuid := 'b1000000-0000-4000-8000-000000000023';
  v_penny_staff_three constant uuid := 'b1000000-0000-4000-8000-000000000024';
  v_penny_addon constant uuid := 'b1000000-0000-4000-8000-000000000025';
  v_start timestamptz := date_trunc('day', clock_timestamp()) + interval '3 days 12 hours';
  v_payload jsonb;
  v_payload_changed jsonb;
  v_quote jsonb;
  v_stale_quote jsonb;
  v_result jsonb;
  v_replay jsonb;
  v_group_id uuid;
  v_booking_ids jsonb;
  v_before_bookings bigint;
  v_before_addons bigint;
  v_before_profiles bigint;
  v_before_redemptions bigint;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  IF pg_catalog.has_function_privilege(
       'anon', 'public.insert_group_bookings(jsonb)', 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', 'public.insert_group_bookings(jsonb)', 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role', 'public.insert_group_bookings(jsonb)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'legacy group writer is not service-role-only';
  END IF;

  INSERT INTO public.service_categories (slug, name_en, name_vi)
  VALUES
    ('group-pricing-rehearsal', 'Group pricing rehearsal', 'Group pricing rehearsal'),
    ('group-penny-rehearsal', 'Group penny rehearsal', 'Group penny rehearsal');

  INSERT INTO public.salons (
    id, slug, name, phone, timezone, currency_code, opening_hours, tax_lines,
    subscription_plan, noshow_protection_enabled
  ) VALUES
    (
      v_salon, 'group-pricing-rehearsal', 'Group pricing rehearsal',
      '+16045550300', 'UTC', 'CAD',
      '{
        "sun":{"open":"00:00","close":"23:59","closed":false},
        "mon":{"open":"00:00","close":"23:59","closed":false},
        "tue":{"open":"00:00","close":"23:59","closed":false},
        "wed":{"open":"00:00","close":"23:59","closed":false},
        "thu":{"open":"00:00","close":"23:59","closed":false},
        "fri":{"open":"00:00","close":"23:59","closed":false},
        "sat":{"open":"00:00","close":"23:59","closed":false}
      }'::jsonb,
      '[{"name":"GST","rate":0.05,"enabled":true}]'::jsonb,
      'premium', true
    ),
    (
      v_penny_salon, 'group-penny-rehearsal', 'Group penny rehearsal',
      '+16045550301', 'UTC', 'CAD',
      '{
        "sun":{"open":"00:00","close":"23:59","closed":false},
        "mon":{"open":"00:00","close":"23:59","closed":false},
        "tue":{"open":"00:00","close":"23:59","closed":false},
        "wed":{"open":"00:00","close":"23:59","closed":false},
        "thu":{"open":"00:00","close":"23:59","closed":false},
        "fri":{"open":"00:00","close":"23:59","closed":false},
        "sat":{"open":"00:00","close":"23:59","closed":false}
      }'::jsonb,
      '[{"name":"PENNY","rate":0.5,"enabled":true}]'::jsonb,
      'premium', false
    );

  INSERT INTO public.services (
    id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
    category, is_addon, addon_timing
  ) VALUES
    (v_service, v_salon, 'Main service', 5000, 30, 10,
     'group-pricing-rehearsal', false, 'sequential'),
    (v_addon_one, v_salon, 'Concurrent add-on', 1000, 15, 5,
     'group-pricing-rehearsal', true, 'concurrent'),
    (v_addon_two, v_salon, 'Sequential add-on', 700, 10, 5,
     'group-pricing-rehearsal', true, 'sequential'),
    (v_penny_service, v_penny_salon, 'One cent service', 1, 10, 0,
     'group-penny-rehearsal', false, 'sequential'),
    (v_penny_addon, v_penny_salon, 'Zero-cent concurrent add-on', 0, 5, 0,
     'group-penny-rehearsal', true, 'concurrent');

  INSERT INTO public.staff (id, salon_id, name, status, deleted_at)
  VALUES
    (v_staff_one, v_salon, 'Group staff one', 'active', NULL),
    (v_staff_two, v_salon, 'Group staff two', 'active', NULL),
    (v_penny_staff_one, v_penny_salon, 'Penny staff one', 'active', NULL),
    (v_penny_staff_two, v_penny_salon, 'Penny staff two', 'active', NULL),
    (v_penny_staff_three, v_penny_salon, 'Penny staff three', 'active', NULL);

  INSERT INTO public.staff_services (staff_id, service_id)
  VALUES
    (v_staff_one, v_service), (v_staff_one, v_addon_one),
    (v_staff_one, v_addon_two), (v_staff_two, v_service),
    (v_staff_two, v_addon_one), (v_staff_two, v_addon_two),
    (v_penny_staff_one, v_penny_service),
    (v_penny_staff_one, v_penny_addon),
    (v_penny_staff_two, v_penny_service),
    (v_penny_staff_three, v_penny_service),
    (v_penny_staff_three, v_penny_addon);

  INSERT INTO public.vouchers (
    id, salon_id, code, kind, amount_off_cents, max_uses,
    valid_from, expires_at
  ) VALUES (
    v_voucher, v_salon, 'GROUP300', 'promo', 300, 1,
    clock_timestamp() - interval '1 day',
    clock_timestamp() + interval '10 days'
  );
  INSERT INTO public.vouchers (
    id, salon_id, code, kind, amount_off_cents, max_uses,
    client_phone, valid_from, expires_at
  ) VALUES (
    v_restricted_voucher, v_salon, 'GROUP-RESTRICTED', 'promo', 300, 5,
    '16045550399', clock_timestamp() - interval '1 day',
    clock_timestamp() + interval '10 days'
  );
  INSERT INTO public.vouchers (
    id, salon_id, code, kind, free_service_id, max_uses,
    valid_from, expires_at
  ) VALUES (
    v_free_service_voucher, v_salon, 'GROUP-FREE-SERVICE', 'promo',
    v_service, 5, clock_timestamp() - interval '1 day',
    clock_timestamp() + interval '10 days'
  );

  v_payload := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'service_id', v_service, 'staff_id', v_staff_one,
      'start_time_utc', v_start,
      'end_time_utc', v_start + interval '55 minutes',
      'addon_service_ids', pg_catalog.jsonb_build_array(v_addon_one, v_addon_two),
      'client_name', 'Organizer', 'staff_requested_by_client', true,
      'wave_number', 1, 'seat_together', true, 'client_locale', 'en'
    ),
    pg_catalog.jsonb_build_object(
      'service_id', v_service, 'staff_id', v_staff_two,
      'start_time_utc', v_start,
      'end_time_utc', v_start + interval '40 minutes',
      'addon_service_ids', '[]'::jsonb,
      'client_name', 'Member Two', 'wave_number', 1,
      'seat_together', true, 'client_locale', 'vi'
    )
  );

  v_quote := public.quote_group_booking(
    v_salon, v_payload, v_voucher, '+1 (604) 555-0399',
    'group@example.test', true
  );
  IF v_quote->>'success' <> 'true'
     OR v_quote->>'code' <> 'quoted'
     OR (v_quote->>'group_size')::integer <> 2
     OR (v_quote->>'original_price_cents')::integer <> 10000
     OR (SELECT sum((m.value->>'original_price_cents')::integer)
         FROM pg_catalog.jsonb_array_elements(v_quote->'member_quotes') m(value))
        <> 10000
     OR (v_quote->>'email_discount_cents')::integer <> 200
     OR (v_quote->>'voucher_discount_cents')::integer <> 300
     OR (v_quote->>'pre_voucher_subtotal_cents')::integer <> 11500
     OR (v_quote->>'subtotal_cents')::integer <> 11200
     OR (v_quote->>'tax_cents')::integer <> 560
     OR (v_quote->>'total_cents')::integer <> 11760
     OR pg_catalog.jsonb_array_length(
          v_quote->'member_quotes'->0->'addon_lines'
        ) <> 2
     OR v_quote->>'pricing_fingerprint' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'authoritative group quote mismatch: %', v_quote;
  END IF;

  v_result := public.create_group_bookings(
    v_salon, v_payload, v_voucher, '+1 (604) 555-0399',
    'group@example.test', true, v_idem, v_quote->>'pricing_fingerprint'
  );
  IF v_result->>'success' <> 'true'
     OR v_result->>'code' <> 'booked'
     OR (v_result->>'idempotent')::boolean
     OR pg_catalog.jsonb_array_length(v_result->'booking_ids') <> 2 THEN
    RAISE EXCEPTION 'authoritative group create mismatch: %', v_result;
  END IF;
  v_group_id := (v_result->>'group_id')::uuid;
  v_booking_ids := v_result->'booking_ids';

  IF (SELECT count(*) FROM public.booking_card_management_continuations c
      WHERE c.booking_id = (v_booking_ids->>0)::uuid
        AND c.salon_id = v_salon
        AND c.create_idempotency_key = v_idem
        AND c.pricing_fingerprint = v_quote->>'pricing_fingerprint'
        AND c.scope = 'group_organizer'
        AND c.status = 'armed'
        AND c.reason_code = 'assessment_scheduled') <> 1
     OR EXISTS (
       SELECT 1 FROM public.booking_card_management_continuations c
       WHERE c.booking_id = (v_booking_ids->>1)::uuid
     ) THEN
    RAISE EXCEPTION 'group create did not atomically arm organizer only';
  END IF;

  IF (SELECT count(*) FROM public.bookings b
      WHERE b.group_id = v_group_id AND b.status = 'confirmed') <> 2
     OR (SELECT count(*) FROM public.bookings b
         WHERE b.group_id = v_group_id AND b.is_group_organizer) <> 1
     OR (SELECT count(*) FROM public.booking_addons ba
         WHERE ba.booking_id = (v_booking_ids->>0)::uuid) <> 2
     OR (SELECT count(*) FROM public.voucher_redemptions vr
         WHERE vr.voucher_id = v_voucher
           AND vr.booking_id = (v_booking_ids->>0)::uuid) <> 1
     OR (SELECT used_count FROM public.vouchers WHERE id = v_voucher) <> 1
     OR (SELECT email_discount_claimed_at FROM public.client_profiles
         WHERE phone = '16045550399') IS NULL
     OR (SELECT public_booking_pricing_snapshot FROM public.bookings
         WHERE id = (v_booking_ids->>0)::uuid) IS DISTINCT FROM
        (v_result->'pricing_snapshot') THEN
    RAISE EXCEPTION 'atomic group persistence mismatch';
  END IF;

  v_replay := public.create_group_bookings(
    v_salon, v_payload, v_voucher, '+1 (604) 555-0399',
    'group@example.test', true, v_idem, v_quote->>'pricing_fingerprint'
  );
  IF v_replay->>'success' <> 'true'
     OR NOT (v_replay->>'idempotent')::boolean
     OR v_replay->>'group_id' IS DISTINCT FROM v_result->>'group_id'
     OR v_replay->'booking_ids' IS DISTINCT FROM v_result->'booking_ids'
     OR v_replay->'pricing_snapshot' IS DISTINCT FROM v_result->'pricing_snapshot'
     OR (SELECT used_count FROM public.vouchers WHERE id = v_voucher) <> 1 THEN
    RAISE EXCEPTION 'exact group replay mismatch: %', v_replay;
  END IF;

  IF (SELECT count(*) FROM public.booking_card_management_continuations c
      WHERE c.booking_id = (v_booking_ids->>0)::uuid) <> 1 THEN
    RAISE EXCEPTION 'group replay duplicated its organizer continuation';
  END IF;

  v_replay := public.resolve_booking_card_management_continuation(
    v_salon, (v_booking_ids->>0)::uuid, v_idem,
    v_quote->>'pricing_fingerprint', 'group_organizer', 'card_not_required'
  );
  IF v_replay->>'ok' <> 'true'
     OR NOT EXISTS (
       SELECT 1 FROM public.booking_card_management_continuations c
       WHERE c.booking_id = (v_booking_ids->>0)::uuid
         AND c.status = 'resolved'
         AND c.reason_code = 'card_not_required'
     ) THEN
    RAISE EXCEPTION 'group organizer exact-binding resolution failed: %', v_replay;
  END IF;

  v_payload_changed := pg_catalog.jsonb_set(
    v_payload, '{0,client_name}', '"Changed organizer"'::jsonb
  );
  v_replay := public.create_group_bookings(
    v_salon, v_payload_changed, v_voucher, '+1 (604) 555-0399',
    'group@example.test', true, v_idem, v_quote->>'pricing_fingerprint'
  );
  IF v_replay->>'code' <> 'idempotency_conflict' THEN
    RAISE EXCEPTION 'changed group payload did not conflict: %', v_replay;
  END IF;

  v_payload_changed := pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      v_payload, '{0,start_time_utc}',
      pg_catalog.to_jsonb(v_start + interval '1 hour')
    ),
    '{0,end_time_utc}', pg_catalog.to_jsonb(v_start + interval '1 hour 55 minutes')
  );
  v_payload_changed := pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      v_payload_changed, '{1,start_time_utc}',
      pg_catalog.to_jsonb(v_start + interval '1 hour')
    ),
    '{1,end_time_utc}', pg_catalog.to_jsonb(v_start + interval '1 hour 40 minutes')
  );
  v_replay := public.quote_group_booking(
    v_salon, v_payload_changed, v_restricted_voucher,
    '+16045550399', NULL, false
  );
  IF v_replay->>'code' <> 'voucher_invalid' THEN
    RAISE EXCEPTION 'restricted V1 voucher was accepted: %', v_replay;
  END IF;

  v_payload_changed := pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      v_payload, '{0,start_time_utc}',
      pg_catalog.to_jsonb(v_start + interval '2 hours')
    ),
    '{0,end_time_utc}', pg_catalog.to_jsonb(v_start + interval '2 hours 55 minutes')
  );
  v_payload_changed := pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      v_payload_changed, '{1,start_time_utc}',
      pg_catalog.to_jsonb(v_start + interval '2 hours')
    ),
    '{1,end_time_utc}', pg_catalog.to_jsonb(v_start + interval '2 hours 40 minutes')
  );
  v_replay := public.quote_group_booking(
    v_salon, v_payload_changed, v_free_service_voucher,
    '+16045550399', NULL, false
  );
  IF v_replay->>'code' <> 'voucher_invalid' THEN
    RAISE EXCEPTION 'free-service V1 voucher was accepted: %', v_replay;
  END IF;

  -- A stale accepted quote must cause zero business writes.
  v_payload_changed := pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      v_payload, '{0,start_time_utc}',
      pg_catalog.to_jsonb(v_start + interval '3 hours')
    ),
    '{0,end_time_utc}', pg_catalog.to_jsonb(v_start + interval '3 hours 55 minutes')
  );
  v_payload_changed := pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      v_payload_changed, '{1,start_time_utc}',
      pg_catalog.to_jsonb(v_start + interval '3 hours')
    ),
    '{1,end_time_utc}', pg_catalog.to_jsonb(v_start + interval '3 hours 40 minutes')
  );
  v_stale_quote := public.quote_group_booking(
    v_salon, v_payload_changed, NULL, '+16045550388', NULL, false
  );
  UPDATE public.services SET price_cents = 5100 WHERE id = v_service;
  SELECT count(*) INTO v_before_bookings FROM public.bookings WHERE salon_id = v_salon;
  SELECT count(*) INTO v_before_addons FROM public.booking_addons ba
  JOIN public.bookings b ON b.id = ba.booking_id WHERE b.salon_id = v_salon;
  SELECT count(*) INTO v_before_profiles FROM public.client_profiles
    WHERE phone = '16045550388';
  SELECT count(*) INTO v_before_redemptions FROM public.voucher_redemptions
    WHERE salon_id = v_salon;
  v_replay := public.create_group_bookings(
    v_salon, v_payload_changed, NULL, '+16045550388', NULL, false,
    v_changed_idem, v_stale_quote->>'pricing_fingerprint'
  );
  IF v_replay->>'code' <> 'pricing_changed'
     OR v_replay->'quote'->>'pricing_fingerprint' =
        v_stale_quote->>'pricing_fingerprint'
     OR (SELECT count(*) FROM public.bookings WHERE salon_id = v_salon)
        <> v_before_bookings
     OR (SELECT count(*) FROM public.booking_addons ba
         JOIN public.bookings b ON b.id = ba.booking_id
         WHERE b.salon_id = v_salon) <> v_before_addons
     OR (SELECT count(*) FROM public.client_profiles
         WHERE phone = '16045550388') <> v_before_profiles
     OR (SELECT count(*) FROM public.voucher_redemptions
         WHERE salon_id = v_salon) <> v_before_redemptions THEN
    RAISE EXCEPTION 'group pricing_changed was not zero-write: %', v_replay;
  END IF;
  UPDATE public.services SET price_cents = 5000 WHERE id = v_service;

  -- Forced add-on failure must roll back every member/profile/evidence write.
  UPDATE public.services SET name = 'Rollback add-on' WHERE id = v_addon_two;
  EXECUTE 'CREATE TRIGGER reject_group_rehearsal_addon '
    'BEFORE INSERT ON public.booking_addons FOR EACH ROW '
    'EXECUTE FUNCTION pg_temp.reject_group_rehearsal_addon()';
  v_payload_changed := pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      v_payload, '{0,start_time_utc}', pg_catalog.to_jsonb(v_start + interval '5 hours')
    ),
    '{0,end_time_utc}', pg_catalog.to_jsonb(v_start + interval '5 hours 55 minutes')
  );
  v_payload_changed := pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      v_payload_changed, '{1,start_time_utc}', pg_catalog.to_jsonb(v_start + interval '5 hours')
    ),
    '{1,end_time_utc}', pg_catalog.to_jsonb(v_start + interval '5 hours 40 minutes')
  );
  v_quote := public.quote_group_booking(
    v_salon, v_payload_changed, NULL, '+16045550377', NULL, false
  );
  SELECT count(*) INTO v_before_bookings FROM public.bookings WHERE salon_id = v_salon;
  SELECT count(*) INTO v_before_profiles FROM public.client_profiles
    WHERE phone = '16045550377';
  BEGIN
    PERFORM public.create_group_bookings(
      v_salon, v_payload_changed, NULL, '+16045550377', NULL, false,
      v_rollback_idem, v_quote->>'pricing_fingerprint'
    );
    RAISE EXCEPTION 'forced group rollback unexpectedly succeeded';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'forced group add-on rollback' THEN
        RAISE;
      END IF;
  END;
  IF (SELECT count(*) FROM public.bookings WHERE salon_id = v_salon)
       <> v_before_bookings
     OR (SELECT count(*) FROM public.client_profiles
         WHERE phone = '16045550377') <> v_before_profiles THEN
    RAISE EXCEPTION 'forced group failure left partial writes';
  END IF;
  EXECUTE 'DROP TRIGGER reject_group_rehearsal_addon ON public.booking_addons';
  UPDATE public.services SET name = 'Sequential add-on' WHERE id = v_addon_two;

  -- Three one-cent members at 50% tax target two cents. Largest remainder
  -- deterministically assigns cents to member indexes 0 and 1, never three.
  v_payload_changed := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'service_id', v_penny_service, 'staff_id', v_penny_staff_one,
      'start_time_utc', v_start, 'end_time_utc', v_start + interval '10 minutes',
      'addon_service_ids', pg_catalog.jsonb_build_array(v_penny_addon),
      'client_name', 'Penny One'
    ),
    pg_catalog.jsonb_build_object(
      'service_id', v_penny_service, 'staff_id', v_penny_staff_two,
      'start_time_utc', v_start, 'end_time_utc', v_start + interval '10 minutes',
      'addon_service_ids', '[]'::jsonb, 'client_name', 'Penny Two'
    ),
    pg_catalog.jsonb_build_object(
      'service_id', v_penny_service, 'staff_id', v_penny_staff_three,
      'start_time_utc', v_start, 'end_time_utc', v_start + interval '10 minutes',
      'addon_service_ids', pg_catalog.jsonb_build_array(v_penny_addon),
      'client_name', 'Penny Three'
    )
  );
  v_quote := public.quote_group_booking(
    v_penny_salon, v_payload_changed, NULL, '+16045550366', NULL, false
  );
  IF (v_quote->>'tax_cents')::integer <> 2
     OR (v_quote->'member_quotes'->0->>'tax_cents')::integer <> 1
     OR (v_quote->'member_quotes'->1->>'tax_cents')::integer <> 1
     OR (v_quote->'member_quotes'->2->>'tax_cents')::integer <> 0
     OR (SELECT sum((m.value->>'tax_cents')::integer)
         FROM pg_catalog.jsonb_array_elements(v_quote->'member_quotes') m(value))
        <> 2 THEN
    RAISE EXCEPTION 'largest-remainder penny allocation mismatch: %', v_quote;
  END IF;
  v_result := public.create_group_bookings(
    v_penny_salon, v_payload_changed, NULL, '+16045550366', NULL, false,
    v_penny_idem, v_quote->>'pricing_fingerprint'
  );
  IF v_result->>'success' <> 'true'
     OR pg_catalog.jsonb_array_length(v_result->'booking_ids') <> 3
     OR (SELECT count(*) FROM public.bookings b
         WHERE b.group_id = (v_result->>'group_id')::uuid) <> 3
     OR (SELECT count(*) FROM public.bookings b
         WHERE b.group_id = (v_result->>'group_id')::uuid
           AND b.public_booking_pricing_fingerprint =
             v_quote->>'pricing_fingerprint') <> 3
     OR (SELECT count(*) FROM public.booking_addons ba
         WHERE ba.booking_id IN (
           SELECT b.id FROM public.bookings b
           WHERE b.group_id = (v_result->>'group_id')::uuid
         ) AND ba.service_id = v_penny_addon) <> 2
     OR (SELECT public_booking_pricing_snapshot FROM public.bookings b
         WHERE b.id = (v_result->'booking_ids'->>0)::uuid)
        IS DISTINCT FROM v_result->'pricing_snapshot' THEN
    RAISE EXCEPTION 'three-member persisted receipt mismatch: %', v_result;
  END IF;

  -- Free-plan cap is checked after replay/fingerprint and before any write.
  UPDATE public.salons SET subscription_plan = 'free' WHERE id = v_salon;
  INSERT INTO public.bookings (
    salon_id, service_id, staff_id, client_name, client_phone,
    start_time_utc, end_time_utc, status, price_cents
  )
  SELECT
    v_salon, v_service, v_staff_one, 'Cap seed ' || g, '160455504' || g,
    date_trunc('month', clock_timestamp()) + interval '1 day' + g * interval '1 minute',
    date_trunc('month', clock_timestamp()) + interval '1 day 1 minute' + g * interval '1 minute',
    'completed', 0
  FROM pg_catalog.generate_series(1, 49) g;
  SELECT count(*) INTO v_before_bookings FROM public.bookings WHERE salon_id = v_salon;
  v_payload_changed := pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      v_payload, '{0,start_time_utc}', pg_catalog.to_jsonb(v_start + interval '8 hours')
    ),
    '{0,end_time_utc}', pg_catalog.to_jsonb(v_start + interval '8 hours 55 minutes')
  );
  v_payload_changed := pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      v_payload_changed, '{1,start_time_utc}', pg_catalog.to_jsonb(v_start + interval '8 hours')
    ),
    '{1,end_time_utc}', pg_catalog.to_jsonb(v_start + interval '8 hours 40 minutes')
  );
  v_quote := public.quote_group_booking(
    v_salon, v_payload_changed, NULL, '+16045550355', NULL, false
  );
  v_replay := public.create_group_bookings(
    v_salon, v_payload_changed, NULL, '+16045550355', NULL, false,
    v_cap_idem, v_quote->>'pricing_fingerprint'
  );
  IF v_replay->>'code' <> 'monthly_booking_limit_reached'
     OR (SELECT count(*) FROM public.bookings WHERE salon_id = v_salon)
        <> v_before_bookings THEN
    RAISE EXCEPTION 'group monthly cap boundary mismatch: %', v_replay;
  END IF;

  -- Exact rollout flag detector used by the read-only preflight. Archived
  -- salons are intentionally ignored; every non-archived true boolean blocks.
  UPDATE public.salons
  SET feature_flags = pg_catalog.jsonb_set(
    feature_flags,
    '{group_booking_enabled}',
    'true'::jsonb,
    true
  )
  WHERE id = v_salon;
  IF (SELECT count(*)
      FROM public.salons s
      WHERE s.archived_at IS NULL
        AND s.feature_flags -> 'group_booking_enabled' = 'true'::jsonb) <> 1 THEN
    RAISE EXCEPTION 'group rollout flag preflight detector mismatch';
  END IF;
END;
$rehearsal$;

ROLLBACK;
