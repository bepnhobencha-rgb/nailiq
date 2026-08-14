\set ON_ERROR_STOP on

BEGIN;
SET LOCAL TIME ZONE 'UTC';

INSERT INTO public.service_categories (slug, name_en, name_vi)
VALUES ('other', 'Other', 'Khác')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.salons (
  id, slug, name, phone, profile_complete, timezone, opening_hours,
  booking_lead_minutes, resources_enabled
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  'qa-scheduling-integrity-p1',
  'QA Scheduling Integrity P1',
  '16045550000',
  true,
  'UTC',
  '{
    "mon":{"open":"00:00","close":"23:59","closed":false},
    "tue":{"open":"00:00","close":"23:59","closed":false},
    "wed":{"open":"00:00","close":"23:59","closed":false},
    "thu":{"open":"00:00","close":"23:59","closed":false},
    "fri":{"open":"00:00","close":"23:59","closed":false},
    "sat":{"open":"00:00","close":"23:59","closed":false},
    "sun":{"open":"00:00","close":"23:59","closed":false}
  }'::jsonb,
  0,
  false
);

INSERT INTO public.staff (id, salon_id, name, job_role) VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'QA One', 'nail_tech'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'QA Two', 'nail_tech');

INSERT INTO public.services (
  id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
  is_addon, addon_timing
) VALUES
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'QA Main', 5000, 30, 0, false, 'sequential'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'QA Add-on', 1200, 10, 0, true, 'sequential');

-- The first explicit capability edit must atomically preserve legacy-all for
-- every colleague, then narrow only the selected staff member.
DO $direct_partial_write$
BEGIN
  BEGIN
    INSERT INTO public.staff_services (staff_id, service_id) VALUES (
      '20000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'direct partial legacy capability write unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END
$direct_partial_write$;

SET LOCAL ROLE service_role;
SELECT public.set_staff_service_capabilities(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  ARRAY['30000000-0000-4000-8000-000000000001'::uuid]
);
RESET ROLE;

DO $capability_transition$
DECLARE
  v_count integer;
BEGIN
  IF (SELECT staff_capability_mode FROM public.salons
      WHERE id = '10000000-0000-4000-8000-000000000001') <> 'whitelist' THEN
    RAISE EXCEPTION 'legacy capability transition did not persist whitelist mode';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.staff_services
  WHERE staff_id = '20000000-0000-4000-8000-000000000001';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'selected staff was not narrowed atomically: %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.staff_services
  WHERE staff_id = '20000000-0000-4000-8000-000000000002';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'legacy colleague capability was not safely seeded: %', v_count;
  END IF;
END
$capability_transition$;

-- RLS is the authority even when an authenticated caller bypasses the app/RPC:
-- receptionist cannot mutate capability rows; owner can reach the same row.
INSERT INTO auth.users (
  id, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at
) VALUES
  (
    '91000000-0000-4000-8000-000000000001',
    'cap-owner@nailiq.invalid', '', now(),
    '{"provider":"email","providers":["email"]}', '{}', now()
  ),
  (
    '91000000-0000-4000-8000-000000000002',
    'cap-reception@nailiq.invalid', '', now(),
    '{"provider":"email","providers":["email"]}', '{}', now()
  );
INSERT INTO public.salon_members (salon_id, user_id, role) VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    'owner'
  ),
  (
    '10000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000002',
    'receptionist'
  );

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub',
  '91000000-0000-4000-8000-000000000002',
  true
);
DO $receptionist_capability_denied$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.staff_services
  SET service_id = service_id
  WHERE staff_id = '20000000-0000-4000-8000-000000000001'
    AND service_id = '30000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'receptionist unexpectedly mutated staff capability';
  END IF;
END
$receptionist_capability_denied$;

SELECT set_config(
  'request.jwt.claim.sub',
  '91000000-0000-4000-8000-000000000001',
  true
);
DO $owner_capability_allowed$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.staff_services
  SET service_id = service_id
  WHERE staff_id = '20000000-0000-4000-8000-000000000001'
    AND service_id = '30000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'owner could not mutate own-salon staff capability';
  END IF;
END
$owner_capability_allowed$;
RESET ROLE;

-- Restore the add-on for the first staff member so the group itemization
-- tests below exercise two equally capable providers.
INSERT INTO public.staff_services (staff_id, service_id) VALUES
  ('20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002');

INSERT INTO public.vouchers (
  id, salon_id, code, kind, amount_off_cents, max_uses, expires_at
) VALUES (
  '40000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'QA-ONCE',
  'promo',
  1000,
  1,
  clock_timestamp() + interval '30 days'
);

DO $test$
DECLARE
  v_start timestamptz := date_trunc('minute', clock_timestamp()) + interval '2 days';
  v_end timestamptz;
  v_payload jsonb;
  v_first jsonb;
  v_replay jsonb;
  v_changed jsonb;
  v_mixed_capability jsonb;
  v_failed jsonb;
  v_public_payload jsonb;
  v_public_first jsonb;
  v_public_replay jsonb;
  v_public_changed jsonb;
  v_public_otp_reuse jsonb;
  v_booking_ids uuid[];
  v_count integer;
  v_token_id uuid;
  v_old_start timestamptz;
  v_target timestamptz := date_trunc('day', clock_timestamp() + interval '6 days') + interval '12 hours';
  v_fold_date date;
  v_fold_start timestamptz;
  v_reschedule record;
  v_target_day text;
BEGIN
  v_end := v_start + interval '40 minutes';
  v_payload := jsonb_build_array(
    jsonb_build_object(
      'salon_id', '10000000-0000-4000-8000-000000000001',
      'staff_id', '20000000-0000-4000-8000-000000000001',
      'service_id', '30000000-0000-4000-8000-000000000001',
      'client_name', 'QA Lead',
      'client_phone', '16045550001',
      'start_time_utc', v_start,
      'end_time_utc', v_end,
      'addon_service_ids', jsonb_build_array(
        '30000000-0000-4000-8000-000000000002',
        '30000000-0000-4000-8000-000000000002'
      ),
      'idempotency_key', '50000000-0000-4000-8000-000000000001',
      'notification_capability', '52000000-0000-4000-8000-000000000001',
      'voucher_id', '40000000-0000-4000-8000-000000000001',
      'booking_channel', 'online'
    ),
    jsonb_build_object(
      'salon_id', '10000000-0000-4000-8000-000000000001',
      'staff_id', '20000000-0000-4000-8000-000000000002',
      'service_id', '30000000-0000-4000-8000-000000000001',
      'client_name', 'QA Guest',
      'client_phone', '16045550002',
      'start_time_utc', v_start,
      'end_time_utc', v_end,
      'addon_service_ids', jsonb_build_array(
        '30000000-0000-4000-8000-000000000002',
        '30000000-0000-4000-8000-000000000002'
      ),
      'idempotency_key', '50000000-0000-4000-8000-000000000001',
      'notification_capability', '52000000-0000-4000-8000-000000000001',
      'booking_channel', 'online'
    )
  );

  v_first := public.insert_group_bookings_unlimited(v_payload);
  IF coalesce((v_first->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'initial group failed: %', v_first;
  END IF;
  v_replay := public.insert_group_bookings_unlimited(v_payload);
  IF v_replay->>'group_id' <> v_first->>'group_id'
     OR v_replay->'booking_ids' <> v_first->'booking_ids'
     OR coalesce((v_replay->>'idempotent_replay')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'exact retry did not replay original result: %', v_replay;
  END IF;

  SELECT array_agg(value::text::uuid ORDER BY ordinality)
  INTO v_booking_ids
  FROM jsonb_array_elements_text(v_first->'booking_ids') WITH ORDINALITY;

  IF NOT EXISTS (
    SELECT 1
    FROM public.group_booking_requests r
    WHERE r.salon_id = '10000000-0000-4000-8000-000000000001'
      AND r.request_id = '50000000-0000-4000-8000-000000000001'
      AND r.notification_capability_sha256 = extensions.digest(
        convert_to('52000000-0000-4000-8000-000000000001', 'UTF8'),
        'sha256'
      )
      AND r.notification_capability_expires_at > clock_timestamp()
      AND (r.result->'booking_ids'->>0)::uuid = v_booking_ids[1]
  ) THEN
    RAISE EXCEPTION 'notification capability was not atomically bound to organizer';
  END IF;

  v_mixed_capability := jsonb_set(
    v_payload, '{0,idempotency_key}',
    '"50000000-0000-4000-8000-000000000011"'::jsonb
  );
  v_mixed_capability := jsonb_set(
    v_mixed_capability, '{1,idempotency_key}',
    '"50000000-0000-4000-8000-000000000011"'::jsonb
  );
  v_mixed_capability := jsonb_set(
    v_mixed_capability, '{1,notification_capability}',
    '"52000000-0000-4000-8000-000000000002"'::jsonb
  );
  v_mixed_capability := public.insert_group_bookings_unlimited(v_mixed_capability);
  IF v_mixed_capability->>'code' <> 'invalid_notification_capability' THEN
    RAISE EXCEPTION 'mixed notification capability was accepted: %', v_mixed_capability;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.bookings
  WHERE id = ANY(v_booking_ids)
    AND price_cents = 5000
    AND addon_price_cents = 1200;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'authoritative booking prices were not stored once';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.booking_addons
  WHERE booking_id = ANY(v_booking_ids)
    AND service_id = '30000000-0000-4000-8000-000000000002'
    AND price_cents = 1200;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'add-on itemization count expected 2, got %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.voucher_redemptions
  WHERE voucher_id = '40000000-0000-4000-8000-000000000001'
    AND booking_id = v_booking_ids[1]
    AND discount_applied_cents = 1000;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'voucher redemption count expected 1, got %', v_count;
  END IF;

  v_changed := jsonb_set(v_payload, '{0,client_name}', '"Changed Lead"'::jsonb);
  v_changed := public.insert_group_bookings_unlimited(v_changed);
  IF v_changed->>'code' <> 'idempotency_conflict' THEN
    RAISE EXCEPTION 'changed payload reused request: %', v_changed;
  END IF;

  IF public.group_booking_request_completed(
    '10000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001'
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'completed request retry gate returned false';
  END IF;

  INSERT INTO public.phone_otp_sessions (
    id, phone, salon_id, expires_at, consumed_at
  ) VALUES (
    '51000000-0000-4000-8000-000000000001',
    '16045550001',
    '10000000-0000-4000-8000-000000000001',
    clock_timestamp() - interval '1 day',
    clock_timestamp() - interval '1 day'
  );
  IF public.validate_group_booking_otp_session(
    '51000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '16045550001',
    '50000000-0000-4000-8000-000000000001'
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'completed exact retry could not reuse consumed OTP proof';
  END IF;
  IF public.validate_group_booking_otp_session(
    '51000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '16045550001',
    '50000000-0000-4000-8000-000000000009'
  ) IS TRUE THEN
    RAISE EXCEPTION 'consumed OTP authorized an uncommitted request';
  END IF;

  -- Prove the public canonical wrapper also replays before abuse counters and
  -- rejects a changed payload under the request key. Enable OTP and run as the
  -- actual anon role so verification lock/consume/profile evidence share the
  -- booking transaction.
  UPDATE public.salons
  SET phone_otp_enabled = true
  WHERE id = '10000000-0000-4000-8000-000000000001';
  INSERT INTO public.phone_otp_sessions (
    id, phone, salon_id, expires_at
  ) VALUES (
    '51000000-0000-4000-8000-000000000002',
    '16045550001',
    '10000000-0000-4000-8000-000000000001',
    clock_timestamp() + interval '15 minutes'
  );
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  v_public_payload := v_payload;
  v_public_payload := jsonb_set(
    v_public_payload, '{0,idempotency_key}',
    '"50000000-0000-4000-8000-000000000009"'::jsonb
  );
  v_public_payload := jsonb_set(
    v_public_payload, '{1,idempotency_key}',
    '"50000000-0000-4000-8000-000000000009"'::jsonb
  );
  v_public_payload := jsonb_set(
    v_public_payload, '{0,notification_capability}',
    '"52000000-0000-4000-8000-000000000009"'::jsonb
  );
  v_public_payload := jsonb_set(
    v_public_payload, '{1,notification_capability}',
    '"52000000-0000-4000-8000-000000000009"'::jsonb
  );
  v_public_payload := jsonb_set(
    v_public_payload, '{0,start_time_utc}',
    to_jsonb(v_start + interval '2 hours')
  );
  v_public_payload := jsonb_set(
    v_public_payload, '{0,end_time_utc}',
    to_jsonb(v_end + interval '2 hours')
  );
  v_public_payload := jsonb_set(
    v_public_payload, '{1,start_time_utc}',
    to_jsonb(v_start + interval '2 hours')
  );
  v_public_payload := jsonb_set(
    v_public_payload, '{1,end_time_utc}',
    to_jsonb(v_end + interval '2 hours')
  );
  v_public_payload := v_public_payload #- '{0,voucher_id}';
  v_public_first := public.insert_group_bookings(
    v_public_payload,
    '51000000-0000-4000-8000-000000000002'
  );
  IF coalesce((v_public_first->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'public canonical group failed: %', v_public_first;
  END IF;
  v_public_replay := public.insert_group_bookings(
    v_public_payload,
    '51000000-0000-4000-8000-000000000002'
  );
  IF v_public_replay->>'group_id' <> v_public_first->>'group_id'
     OR coalesce((v_public_replay->>'idempotent_replay')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'public exact retry did not return original: %', v_public_replay;
  END IF;
  v_public_changed := jsonb_set(
    v_public_payload, '{0,client_name}', '"Changed Public Lead"'::jsonb
  );
  v_public_changed := public.insert_group_bookings(
    v_public_changed,
    '51000000-0000-4000-8000-000000000002'
  );
  IF v_public_changed->>'code' <> 'idempotency_conflict' THEN
    RAISE EXCEPTION 'public changed payload reused request: %', v_public_changed;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.phone_otp_sessions s
    WHERE s.id = '51000000-0000-4000-8000-000000000002'
      AND s.consumed_at IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.bookings b
    JOIN public.client_profiles cp ON cp.id = b.client_profile_id
    WHERE b.id = (v_public_first->'booking_ids'->>0)::uuid
      AND b.otp_session_id = '51000000-0000-4000-8000-000000000002'
      AND b.verification_method = 'otp'
      AND cp.phone_verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'public group OTP evidence was not committed atomically';
  END IF;

  v_public_otp_reuse := jsonb_set(
    v_public_payload, '{0,idempotency_key}',
    '"50000000-0000-4000-8000-000000000010"'::jsonb
  );
  v_public_otp_reuse := jsonb_set(
    v_public_otp_reuse, '{1,idempotency_key}',
    '"50000000-0000-4000-8000-000000000010"'::jsonb
  );
  v_public_otp_reuse := jsonb_set(
    v_public_otp_reuse, '{0,start_time_utc}',
    to_jsonb(v_start + interval '4 hours')
  );
  v_public_otp_reuse := jsonb_set(
    v_public_otp_reuse, '{0,end_time_utc}',
    to_jsonb(v_end + interval '4 hours')
  );
  v_public_otp_reuse := jsonb_set(
    v_public_otp_reuse, '{1,start_time_utc}',
    to_jsonb(v_start + interval '4 hours')
  );
  v_public_otp_reuse := jsonb_set(
    v_public_otp_reuse, '{1,end_time_utc}',
    to_jsonb(v_end + interval '4 hours')
  );
  v_public_otp_reuse := public.insert_group_bookings(
    v_public_otp_reuse,
    '51000000-0000-4000-8000-000000000002'
  );
  IF v_public_otp_reuse->>'code' <> 'otp_invalid' THEN
    RAISE EXCEPTION 'consumed OTP authorized a different request: %', v_public_otp_reuse;
  END IF;

  DELETE FROM public.staff_services
  WHERE staff_id IN (
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002'
  );
  IF (SELECT staff_capability_mode FROM public.salons
      WHERE id = '10000000-0000-4000-8000-000000000001') <> 'whitelist' THEN
    RAISE EXCEPTION 'capability mode reopened after final-row deletion';
  END IF;
  v_failed := jsonb_set(
    v_payload,
    '{0,idempotency_key}',
    '"50000000-0000-4000-8000-000000000002"'::jsonb
  );
  v_failed := jsonb_set(
    v_failed,
    '{1,idempotency_key}',
    '"50000000-0000-4000-8000-000000000002"'::jsonb
  );
  v_failed := public.insert_group_bookings_unlimited(v_failed);
  IF v_failed->>'code' <> 'staff_incapable' THEN
    RAISE EXCEPTION 'empty configured whitelist did not fail closed: %', v_failed;
  END IF;

  INSERT INTO public.staff_services (staff_id, service_id) VALUES
    ('20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001'),
    ('20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002');

  v_old_start := date_trunc('day', clock_timestamp() + interval '4 days') + interval '9 hours';
  INSERT INTO public.bookings (
    id, salon_id, staff_id, service_id, client_name, client_phone,
    start_time_utc, end_time_utc, status
  ) VALUES (
    '60000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'QA Reschedule',
    '16045550003',
    v_old_start,
    v_old_start + interval '40 minutes',
    'confirmed'
  );
  INSERT INTO public.booking_addons (
    booking_id, service_id, name, price_cents, duration_minutes
  ) VALUES (
    '60000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000002',
    'QA Add-on',
    1200,
    10
  );
  INSERT INTO public.booking_reminder_tokens (
    id, booking_id, salon_id, expires_at
  ) VALUES (
    '70000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    clock_timestamp() + interval '2 days'
  );
  INSERT INTO public.booking_waitlist_entries (
    id, salon_id, service_id, staff_id, booking_date,
    client_name, client_phone, source
  ) VALUES (
    '71000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    v_old_start::date,
    'QA Waitlist', '16045550009', 'slot_unavailable'
  );

  -- Every policy failure below must be typed and must leave the token usable.
  -- Capability applies to the complete main + add-on bundle.
  DELETE FROM public.staff_services
  WHERE staff_id = '20000000-0000-4000-8000-000000000001'
    AND service_id = '30000000-0000-4000-8000-000000000002';
  SELECT * INTO v_reschedule
  FROM public.reschedule_booking_as_customer(
    '70000000-0000-4000-8000-000000000001',
    v_target,
    v_target + interval '1 minute'
  );
  IF v_reschedule.code <> 'staff_incapable' THEN
    RAISE EXCEPTION 'reschedule capability gate failed: %', row_to_json(v_reschedule);
  END IF;
  INSERT INTO public.staff_services (staff_id, service_id) VALUES (
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000002'
  );

  UPDATE public.salons
  SET booking_closed_dates = jsonb_build_array(to_char(v_target, 'YYYY-MM-DD'))
  WHERE id = '10000000-0000-4000-8000-000000000001';
  SELECT * INTO v_reschedule
  FROM public.reschedule_booking_as_customer(
    '70000000-0000-4000-8000-000000000001',
    v_target,
    v_target + interval '1 minute'
  );
  IF v_reschedule.code <> 'closed_day' THEN
    RAISE EXCEPTION 'reschedule closed-date gate failed: %', row_to_json(v_reschedule);
  END IF;
  UPDATE public.salons
  SET booking_closed_dates = '[]'::jsonb
  WHERE id = '10000000-0000-4000-8000-000000000001';

  v_target_day := lower(to_char(v_target, 'Dy'));
  INSERT INTO public.staff_shifts (
    id, staff_id, salon_id, day_of_week, start_time, end_time, is_active
  ) VALUES (
    '80000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    v_target_day, '13:00', '18:00', true
  );
  SELECT * INTO v_reschedule
  FROM public.reschedule_booking_as_customer(
    '70000000-0000-4000-8000-000000000001',
    v_target,
    v_target + interval '1 minute'
  );
  IF v_reschedule.code <> 'outside_shift' THEN
    RAISE EXCEPTION 'reschedule shift gate failed: %', row_to_json(v_reschedule);
  END IF;

  UPDATE public.staff_shifts
  SET start_time = '00:00', end_time = '23:59',
      break_start_time = time '11:30', break_end_time = time '12:30'
  WHERE id = '80000000-0000-4000-8000-000000000001';
  SELECT * INTO v_reschedule
  FROM public.reschedule_booking_as_customer(
    '70000000-0000-4000-8000-000000000001',
    v_target,
    v_target + interval '1 minute'
  );
  IF v_reschedule.code <> 'staff_break' THEN
    RAISE EXCEPTION 'reschedule break gate failed: %', row_to_json(v_reschedule);
  END IF;
  DELETE FROM public.staff_shifts
  WHERE id = '80000000-0000-4000-8000-000000000001';

  INSERT INTO public.staff_unavailability (
    id, staff_id, salon_id, date, reason
  ) VALUES (
    '81000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    v_target::date, 'QA policy proof'
  );
  SELECT * INTO v_reschedule
  FROM public.reschedule_booking_as_customer(
    '70000000-0000-4000-8000-000000000001',
    v_target,
    v_target + interval '1 minute'
  );
  IF v_reschedule.code <> 'staff_unavailable' THEN
    RAISE EXCEPTION 'reschedule unavailability gate failed: %', row_to_json(v_reschedule);
  END IF;
  DELETE FROM public.staff_unavailability
  WHERE id = '81000000-0000-4000-8000-000000000001';

  SELECT * INTO v_reschedule
  FROM public.reschedule_booking_as_customer(
    '70000000-0000-4000-8000-000000000001',
    clock_timestamp() + interval '400 days',
    clock_timestamp() + interval '400 days 1 minute'
  );
  IF v_reschedule.code <> 'booking_horizon' THEN
    RAISE EXCEPTION 'reschedule horizon gate failed: %', row_to_json(v_reschedule);
  END IF;

  -- Resource mode keeps the old chair only when it is free. If every chair is
  -- occupied the move fails atomically; after one chair is freed the same
  -- still-valid token reassigns the booking to that chair.
  INSERT INTO public.salon_resources (id, salon_id, name, kind, display_order)
  VALUES
    ('82000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'QA Chair 1', 'chair', 1),
    ('82000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'QA Chair 2', 'chair', 2);
  UPDATE public.salons SET resources_enabled = true
  WHERE id = '10000000-0000-4000-8000-000000000001';
  UPDATE public.bookings
  SET resource_id = '82000000-0000-4000-8000-000000000001'
  WHERE id = '60000000-0000-4000-8000-000000000001';
  INSERT INTO public.bookings (
    id, salon_id, staff_id, service_id, resource_id, client_name, client_phone,
    start_time_utc, end_time_utc, status
  ) VALUES
    (
      '83000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000001',
      '82000000-0000-4000-8000-000000000001',
      'QA Chair Occupant 1', '16045550005',
      v_target, v_target + interval '40 minutes', 'confirmed'
    ),
    (
      '83000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001',
      NULL,
      '30000000-0000-4000-8000-000000000001',
      '82000000-0000-4000-8000-000000000002',
      'QA Chair Occupant 2', '16045550006',
      v_target, v_target + interval '40 minutes', 'confirmed'
    );
  SELECT * INTO v_reschedule
  FROM public.reschedule_booking_as_customer(
    '70000000-0000-4000-8000-000000000001',
    v_target,
    v_target + interval '1 minute'
  );
  IF v_reschedule.code <> 'resource_conflict' THEN
    RAISE EXCEPTION 'reschedule resource conflict failed: %', row_to_json(v_reschedule);
  END IF;
  DELETE FROM public.bookings
  WHERE id = '83000000-0000-4000-8000-000000000002';

  SELECT * INTO v_reschedule
  FROM public.reschedule_booking_as_customer(
    '70000000-0000-4000-8000-000000000001',
    v_target,
    v_target + interval '1 minute'
  );
  IF v_reschedule.ok IS NOT TRUE
     OR v_reschedule.previous_start_utc <> v_old_start
     OR v_reschedule.new_end_utc <> v_target + interval '40 minutes' THEN
    RAISE EXCEPTION 'reschedule did not use locked old time/block: %', row_to_json(v_reschedule);
  END IF;
  IF (SELECT resource_id FROM public.bookings
      WHERE id = '60000000-0000-4000-8000-000000000001')
       <> '82000000-0000-4000-8000-000000000002'::uuid THEN
    RAISE EXCEPTION 'reschedule did not reassign the free resource';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.booking_waitlist_entries w
    WHERE w.id = '71000000-0000-4000-8000-000000000001'
      AND w.status = 'notified'
      AND w.claim_token IS NOT NULL
      AND w.promotion_request_id = '70000000-0000-4000-8000-000000000001'
      AND w.offered_staff_id = '20000000-0000-4000-8000-000000000001'
      AND w.offered_start_utc = v_old_start
      AND w.offered_end_utc = v_old_start + interval '40 minutes'
  ) THEN
    RAISE EXCEPTION 'reschedule waitlist promotion was not exactly correlated';
  END IF;

  -- End-to-end DST fold: a positive 40-minute UTC block beginning at the
  -- first Toronto 01:30 legitimately renders as 01:10 after the fall-back.
  -- The authoritative reschedule boundary must preserve elapsed time instead
  -- of rejecting the earlier-looking ending wall clock.
  SELECT day::date INTO v_fold_date
  FROM pg_catalog.generate_series(
    current_date + 1,
    current_date + 365,
    interval '1 day'
  ) AS candidate(day)
  WHERE (
    ((day::date + 1)::timestamp AT TIME ZONE 'America/Toronto')
      - (day::date::timestamp AT TIME ZONE 'America/Toronto')
  ) = interval '25 hours'
  ORDER BY day
  LIMIT 1;
  IF v_fold_date IS NULL THEN
    RAISE EXCEPTION 'could not find Toronto DST fold in next year';
  END IF;
  -- PostgreSQL resolves an ambiguous timestamp to the standard-time
  -- occurrence; subtract one hour to select the same deterministic first
  -- occurrence used by salonWallTimeToUtcIso.
  v_fold_start :=
    (v_fold_date + time '01:30') AT TIME ZONE 'America/Toronto'
    - interval '1 hour';

  UPDATE public.salons
  SET timezone = 'America/Toronto'
  WHERE id = '10000000-0000-4000-8000-000000000001';
  INSERT INTO public.bookings (
    id, salon_id, staff_id, service_id, client_name, client_phone,
    start_time_utc, end_time_utc, status
  ) VALUES (
    '60000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'QA DST Fold',
    '16045550004',
    v_old_start + interval '2 hours',
    v_old_start + interval '2 hours 40 minutes',
    'confirmed'
  );
  INSERT INTO public.booking_reminder_tokens (
    id, booking_id, salon_id, expires_at
  ) VALUES (
    '70000000-0000-4000-8000-000000000002',
    '60000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    clock_timestamp() + interval '2 days'
  );

  SELECT * INTO v_reschedule
  FROM public.reschedule_booking_as_customer(
    '70000000-0000-4000-8000-000000000002',
    v_fold_start,
    v_fold_start + interval '1 minute'
  );
  IF v_reschedule.ok IS NOT TRUE
     OR v_reschedule.new_end_utc <> v_fold_start + interval '40 minutes'
     OR (v_reschedule.new_end_utc AT TIME ZONE 'America/Toronto')::time
          >= (v_reschedule.new_start_utc AT TIME ZONE 'America/Toronto')::time THEN
    RAISE EXCEPTION 'DST-fold reschedule lost elapsed-time semantics: %', row_to_json(v_reschedule);
  END IF;
END
$test$;

ROLLBACK;
