\set ON_ERROR_STOP on
BEGIN;

DO $rehearsal$
DECLARE
  v_salon constant uuid := '49000000-0000-4000-8000-000000000001';
  v_service constant uuid := '49000000-0000-4000-8000-000000000002';
  v_staff_one constant uuid := '49000000-0000-4000-8000-000000000003';
  v_staff_two constant uuid := '49000000-0000-4000-8000-000000000004';
  v_staff_three constant uuid := '49000000-0000-4000-8000-000000000005';
  v_station_one constant uuid := '49000000-0000-4000-8000-000000000006';
  v_station_two constant uuid := '49000000-0000-4000-8000-000000000007';
  v_room constant uuid := '49000000-0000-4000-8000-000000000008';
  v_equipment constant uuid := '49000000-0000-4000-8000-000000000009';
  v_start timestamptz := date_trunc('day', statement_timestamp())
    + interval '4 days 10 hours';
  v_end timestamptz := v_start + interval '30 minutes';
  v_payload jsonb;
  v_quote jsonb;
  v_result jsonb;
  v_before bigint;
  v_first_booking uuid;
  v_second_booking uuid;
  v_parent uuid := '49000000-0000-4000-8000-000000000020';
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  INSERT INTO public.service_categories(slug, name_en, name_vi)
  VALUES ('capacity-rehearsal', 'Capacity rehearsal', 'Capacity rehearsal');
  INSERT INTO public.salons(
    id, slug, name, phone, timezone, currency_code, opening_hours, tax_lines,
    subscription_plan, resources_enabled
  ) VALUES (
    v_salon, 'capacity-rehearsal', 'Capacity rehearsal', '+16045550490',
    'UTC', 'CAD',
    '{
      "sun":{"open":"00:00","close":"23:59","closed":false},
      "mon":{"open":"00:00","close":"23:59","closed":false},
      "tue":{"open":"00:00","close":"23:59","closed":false},
      "wed":{"open":"00:00","close":"23:59","closed":false},
      "thu":{"open":"00:00","close":"23:59","closed":false},
      "fri":{"open":"00:00","close":"23:59","closed":false},
      "sat":{"open":"00:00","close":"23:59","closed":false}
    }'::jsonb, '[]'::jsonb, 'premium', false
  );
  INSERT INTO public.services(
    id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
    category, is_addon, addon_timing
  ) VALUES (
    v_service, v_salon, 'Thirty minute service', 5000, 30, 0,
    'capacity-rehearsal', false, 'sequential'
  );
  INSERT INTO public.staff(id, salon_id, name, status, deleted_at) VALUES
    (v_staff_one, v_salon, 'Capacity Staff 1', 'active', NULL),
    (v_staff_two, v_salon, 'Capacity Staff 2', 'active', NULL),
    (v_staff_three, v_salon, 'Capacity Staff 3', 'active', NULL);
  INSERT INTO public.staff_services(staff_id, service_id) VALUES
    (v_staff_one, v_service), (v_staff_two, v_service),
    (v_staff_three, v_service);

  -- MQA-0049: a configured local-date vacation is authoritative at write,
  -- even though the older single/group quote layers remain advisory.
  INSERT INTO public.staff_unavailability(staff_id, salon_id, date, reason)
  VALUES (v_staff_one, v_salon, (v_start AT TIME ZONE 'UTC')::date, 'Vacation');

  v_quote := public.quote_public_booking(
    v_salon, v_service, v_staff_one, v_start, v_end, ARRAY[]::uuid[],
    NULL, NULL, '+16045550491', NULL, false
  );
  IF v_quote->>'code' <> 'quoted' THEN
    RAISE EXCEPTION 'single advisory quote fixture changed: %', v_quote;
  END IF;
  v_before := (SELECT count(*) FROM public.bookings WHERE salon_id = v_salon);
  v_result := public.create_public_booking(
    v_salon, v_service, v_staff_one, 'Vacation Single', '+16045550491',
    v_start, v_end, 'confirmed', NULL, NULL, NULL, NULL, NULL
  );
  IF v_result->>'code' <> 'slot_conflict'
     OR (SELECT count(*) FROM public.bookings WHERE salon_id = v_salon) <> v_before
  THEN
    RAISE EXCEPTION 'single vacation write was not blocked atomically: %', v_result;
  END IF;

  v_payload := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'service_id', v_service, 'staff_id', v_staff_one,
      'start_time_utc', v_start, 'end_time_utc', v_end,
      'addon_service_ids', '[]'::jsonb, 'client_name', 'Vacation Organizer',
      'staff_requested_by_client', true, 'wave_number', 1,
      'seat_together', true, 'client_locale', 'en'
    ),
    pg_catalog.jsonb_build_object(
      'service_id', v_service, 'staff_id', v_staff_two,
      'start_time_utc', v_start, 'end_time_utc', v_end,
      'addon_service_ids', '[]'::jsonb, 'client_name', 'Vacation Member',
      'staff_requested_by_client', true, 'wave_number', 1,
      'seat_together', true, 'client_locale', 'en'
    )
  );
  v_quote := public.quote_group_booking(
    v_salon, v_payload, NULL, '+16045550492', NULL, false
  );
  IF v_quote->>'code' <> 'quoted' THEN
    RAISE EXCEPTION 'group advisory quote fixture changed: %', v_quote;
  END IF;
  v_result := public.create_group_bookings(
    v_salon, v_payload, NULL, '+16045550492', NULL, false,
    '49000000-0000-4000-8000-000000000030',
    v_quote->>'pricing_fingerprint'
  );
  IF v_result->>'code' <> 'slot_conflict'
     OR EXISTS (SELECT 1 FROM public.bookings WHERE salon_id = v_salon)
  THEN
    RAISE EXCEPTION 'group vacation write was not all-or-nothing: %', v_result;
  END IF;

  -- The guard checks every local date touched by a half-open occupied range.
  INSERT INTO public.staff_unavailability(staff_id, salon_id, date, reason)
  VALUES (
    v_staff_two, v_salon,
    ((v_start + interval '1 day') AT TIME ZONE 'UTC')::date,
    'Second vacation day'
  );
  BEGIN
    INSERT INTO public.bookings(
      salon_id, service_id, staff_id, client_name, client_phone,
      start_time_utc, end_time_utc, status, source, schedule_model
    ) VALUES (
      v_salon, v_service, v_staff_two, 'Cross midnight vacation',
      '16045550493', date_trunc('day', v_start + interval '1 day') - interval '15 minutes',
      date_trunc('day', v_start + interval '1 day') + interval '15 minutes',
      'confirmed', 'appointment', 'single'
    );
    RAISE EXCEPTION 'cross-midnight vacation write unexpectedly succeeded';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  DELETE FROM public.staff_unavailability WHERE salon_id = v_salon;

  -- MQA-0055: two active pedicure stations admit exactly two simultaneous
  -- customers with different staff; the N+1 request is rejected.
  INSERT INTO public.salon_resources(
    id, salon_id, name, kind, display_order, status
  ) VALUES
    (v_station_one, v_salon, 'Pedicure Station 1', 'station', 1, 'active'),
    (v_station_two, v_salon, 'Pedicure Station 2', 'station', 2, 'active');
  UPDATE public.salons SET resources_enabled = true WHERE id = v_salon;

  v_result := public.create_public_booking(
    v_salon, v_service, v_staff_one, 'Station One', '+16045550494',
    v_start + interval '2 days', v_end + interval '2 days',
    'confirmed', NULL, NULL, NULL, NULL, NULL
  );
  IF v_result->>'success' <> 'true' THEN
    RAISE EXCEPTION 'first station booking failed: %', v_result;
  END IF;
  v_first_booking := (v_result->>'booking_id')::uuid;
  v_result := public.create_public_booking(
    v_salon, v_service, v_staff_two, 'Station Two', '+16045550495',
    v_start + interval '2 days', v_end + interval '2 days',
    'confirmed', NULL, NULL, NULL, NULL, NULL
  );
  IF v_result->>'success' <> 'true' THEN
    RAISE EXCEPTION 'second station booking failed: %', v_result;
  END IF;
  v_second_booking := (v_result->>'booking_id')::uuid;
  v_result := public.create_public_booking(
    v_salon, v_service, v_staff_three, 'Station Overflow', '+16045550496',
    v_start + interval '2 days', v_end + interval '2 days',
    'confirmed', NULL, NULL, NULL, NULL, NULL
  );
  IF v_result->>'code' <> 'slot_conflict'
     OR (SELECT count(DISTINCT resource_id) FROM public.bookings
         WHERE id IN (v_first_booking, v_second_booking)) <> 2
     OR (SELECT count(*) FROM public.bookings b
         JOIN public.salon_resources r ON r.id = b.resource_id
         WHERE b.id IN (v_first_booking, v_second_booking)
           AND r.kind = 'station') <> 2
  THEN
    RAISE EXCEPTION 'pedicure station N+1 invariant failed: %', v_result;
  END IF;

  INSERT INTO public.salon_resources(
    id, salon_id, name, kind, display_order, status
  ) VALUES
    (v_room, v_salon, 'Shared Treatment Room', 'room', 3, 'active'),
    (v_equipment, v_salon, 'Shared LED Equipment', 'other', 4, 'active');

  -- Resource-mode group writes may not bypass physical capacity with NULL.
  v_payload := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'service_id', v_service, 'staff_id', v_staff_one,
      'start_time_utc', v_start + interval '3 days',
      'end_time_utc', v_end + interval '3 days',
      'addon_service_ids', '[]'::jsonb, 'client_name', 'No Resource One'
    ),
    pg_catalog.jsonb_build_object(
      'service_id', v_service, 'staff_id', v_staff_two,
      'start_time_utc', v_start + interval '3 days',
      'end_time_utc', v_end + interval '3 days',
      'addon_service_ids', '[]'::jsonb, 'client_name', 'No Resource Two'
    )
  );
  v_quote := public.quote_group_booking(
    v_salon, v_payload, NULL, '+16045550497', NULL, false
  );
  v_before := (SELECT count(*) FROM public.bookings WHERE salon_id = v_salon);
  v_result := public.create_group_bookings(
    v_salon, v_payload, NULL, '+16045550497', NULL, false,
    '49000000-0000-4000-8000-000000000031',
    v_quote->>'pricing_fingerprint'
  );
  IF v_quote->>'code' <> 'quoted' OR v_result->>'code' <> 'slot_conflict'
     OR (SELECT count(*) FROM public.bookings WHERE salon_id = v_salon) <> v_before
  THEN
    RAISE EXCEPTION 'resource-mode NULL group bypass remained: %, %',
      v_quote, v_result;
  END IF;

  -- MQA-0056: a room is an exclusive physical resource shared by staff. The
  -- first booking owns it for the interval; a different staff member conflicts.
  v_result := public.create_public_booking(
    v_salon, v_service, v_staff_one, 'Room Owner', '+16045550498',
    v_start + interval '4 days', v_end + interval '4 days',
    'confirmed', NULL, NULL, NULL, NULL, NULL, v_room
  );
  IF v_result->>'success' <> 'true' THEN
    RAISE EXCEPTION 'shared room owner booking failed: %', v_result;
  END IF;
  v_result := public.create_public_booking(
    v_salon, v_service, v_staff_two, 'Room Conflict', '+16045550499',
    v_start + interval '4 days', v_end + interval '4 days',
    'confirmed', NULL, NULL, NULL, NULL, NULL, v_room
  );
  IF v_result->>'code' <> 'slot_conflict' THEN
    RAISE EXCEPTION 'same-room/different-staff conflict accepted: %', v_result;
  END IF;

  -- MQA-0057: generic scarce equipment uses kind=other and receives the same
  -- exclusive resource/cross-model guarantees without inventing a new kind.
  v_result := public.create_public_booking(
    v_salon, v_service, v_staff_one, 'Equipment Owner', '+16045550500',
    v_start + interval '5 days', v_end + interval '5 days',
    'confirmed', NULL, NULL, NULL, NULL, NULL, v_equipment
  );
  IF v_result->>'success' <> 'true' THEN
    RAISE EXCEPTION 'equipment owner booking failed: %', v_result;
  END IF;
  v_result := public.create_public_booking(
    v_salon, v_service, v_staff_two, 'Equipment Conflict', '+16045550501',
    v_start + interval '5 days', v_end + interval '5 days',
    'confirmed', NULL, NULL, NULL, NULL, NULL, v_equipment
  );
  IF v_result->>'code' <> 'slot_conflict' THEN
    RAISE EXCEPTION 'equipment conflict accepted: %', v_result;
  END IF;

  INSERT INTO public.bookings(
    id, salon_id, service_id, staff_id, resource_id, client_name, client_phone,
    start_time_utc, end_time_utc, status, source, schedule_model
  ) VALUES (
    v_parent, v_salon, v_service, v_staff_three, v_station_one,
    'Temporary sequence parent', '16045550502',
    v_start + interval '6 days', v_end + interval '6 days',
    'confirmed', 'appointment', 'segments_v1'
  );
  BEGIN
    INSERT INTO public.booking_service_segments(
      booking_id, salon_id, position, line_id, service_id, staff_id,
      resource_id, service_name, staff_name, customer_start_utc,
      customer_end_utc, occupied_start_utc, occupied_end_utc,
      prep_minutes, service_duration_minutes, sequential_addon_minutes,
      trailing_buffer_minutes, original_service_price_cents,
      service_pre_voucher_cents, addon_pre_voucher_cents,
      promo_discount_cents, email_discount_cents, voucher_discount_cents,
      service_price_cents, addon_price_cents, subtotal_cents, tax_cents,
      total_cents, addon_lines, tax_breakdown,
      reservation_status
    ) VALUES (
      v_parent, v_salon, 0,
      '49000000-0000-4000-8000-000000000021', v_service, v_staff_three,
      v_equipment, 'Thirty minute service', 'Capacity Staff 3',
      v_start + interval '5 days', v_end + interval '5 days',
      v_start + interval '5 days', v_end + interval '5 days',
      0, 30, 0, 0, 5000, 5000, 0, 0, 0, 0,
      5000, 0, 5000, 0, 5000, '[]'::jsonb, '[]'::jsonb, 'confirmed'
    );
    RAISE EXCEPTION 'cross-model equipment conflict unexpectedly succeeded';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  DELETE FROM public.bookings WHERE id = v_parent;

  IF EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.salon_id = v_salon AND b.client_name IN (
      'Vacation Single', 'Vacation Organizer', 'Vacation Member',
      'Cross midnight vacation', 'Station Overflow', 'No Resource One',
      'No Resource Two', 'Room Conflict', 'Equipment Conflict'
    )
  ) THEN
    RAISE EXCEPTION 'a rejected capacity write left booking row(s): %', (
      SELECT pg_catalog.string_agg(b.client_name, ', ' ORDER BY b.client_name)
      FROM public.bookings b
      WHERE b.salon_id = v_salon AND b.client_name IN (
        'Vacation Single', 'Vacation Organizer', 'Vacation Member',
        'Cross midnight vacation', 'Station Overflow', 'No Resource One',
        'No Resource Two', 'Room Conflict', 'Equipment Conflict'
      )
    );
  END IF;
END
$rehearsal$;

ROLLBACK;
SELECT 'booking vacation/resource capacity behavior passed' AS result;
