\set ON_ERROR_STOP on

-- Run only against a disposable local database after the full migration
-- history has been applied. All IDs and customer fields below are synthetic.
BEGIN;

SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL session_replication_role = replica;

INSERT INTO public.salons (
  id, slug, name, phone, profile_complete, timezone, resources_enabled,
  booking_lead_minutes, opening_hours
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  'false-waitlist-fixture',
  'False Waitlist Fixture',
  '17785550100',
  true,
  'America/Los_Angeles',
  true,
  15,
  '{
    "sun":{"open":"09:00","close":"19:30","closed":false},
    "mon":{"open":"09:00","close":"19:30","closed":false},
    "tue":{"open":"09:00","close":"19:30","closed":false},
    "wed":{"open":"09:00","close":"19:30","closed":false},
    "thu":{"open":"09:00","close":"19:30","closed":false},
    "fri":{"open":"09:00","close":"19:30","closed":false},
    "sat":{"open":"09:00","close":"19:30","closed":false}
  }'::jsonb
);

INSERT INTO public.services (
  id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
  resource_requirement_mode, required_resource_kinds
) VALUES (
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  'Hi Lite VVIP Fixture',
  10000,
  100,
  10,
  'specific',
  ARRAY['bed']::text[]
);

INSERT INTO public.staff (id, salon_id, name)
SELECT
  ('10000000-0000-4000-8000-' || pg_catalog.lpad(n::text, 12, '0'))::uuid,
  '10000000-0000-4000-8000-000000000001'::uuid,
  'Fixture Tech ' || n
FROM pg_catalog.generate_series(101, 107) AS fixture_staff(n);

INSERT INTO public.salon_resources (id, salon_id, name, kind, display_order)
SELECT
  ('10000000-0000-4000-8000-' || pg_catalog.lpad(n::text, 12, '0'))::uuid,
  '10000000-0000-4000-8000-000000000001'::uuid,
  'Fixture Bed ' || (n - 200),
  'bed',
  n - 201
FROM pg_catalog.generate_series(201, 207) AS fixture_resources(n);

INSERT INTO public.bookings (
  id, salon_id, service_id, staff_id, resource_id, client_name,
  start_time_utc, end_time_utc, status
)
SELECT
  ('10000000-0000-4000-8000-' || pg_catalog.lpad((300 + n)::text, 12, '0'))::uuid,
  '10000000-0000-4000-8000-000000000001'::uuid,
  '10000000-0000-4000-8000-000000000002'::uuid,
  ('10000000-0000-4000-8000-' || pg_catalog.lpad((100 + n)::text, 12, '0'))::uuid,
  ('10000000-0000-4000-8000-' || pg_catalog.lpad((200 + n)::text, 12, '0'))::uuid,
  'Fixture Occupancy ' || n,
  (((pg_catalog.transaction_timestamp() AT TIME ZONE 'America/Los_Angeles')::date + 1)::timestamp
    + time '12:00') AT TIME ZONE 'America/Los_Angeles',
  (((pg_catalog.transaction_timestamp() AT TIME ZONE 'America/Los_Angeles')::date + 1)::timestamp
    + time '13:10') AT TIME ZONE 'America/Los_Angeles',
  'confirmed'
FROM pg_catalog.generate_series(1, 5) AS occupied(n);

SET LOCAL session_replication_role = origin;

DO $verify_available$
DECLARE
  v_result record;
  v_request_id uuid := '10000000-0000-4000-8000-000000000401';
  v_date date := (pg_catalog.transaction_timestamp() AT TIME ZONE 'America/Los_Angeles')::date + 1;
BEGIN
  SELECT * INTO v_result
  FROM public.evaluate_individual_waitlist_capacity(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    NULL,
    v_date,
    '12:00 PM'
  );

  IF v_result.outcome <> 'slot_available'
     OR v_result.slot_label <> '12:00 PM'
     OR v_result.eligible_staff_count <> 7
     OR v_result.eligible_resource_count <> 7
     OR v_result.free_staff_count <> 2
     OR v_result.free_resource_count <> 2 THEN
    RAISE EXCEPTION 'Hi-Lite capacity fixture failed: %', row_to_json(v_result);
  END IF;

  SELECT * INTO v_result
  FROM public.create_public_capacity_rescue_request_v2(
    '10000000-0000-4000-8000-000000000001',
    v_request_id,
    'individual',
    '10000000-0000-4000-8000-000000000002',
    NULL,
    v_date,
    '12:00 PM',
    1,
    'Fixture Customer',
    '17785550101',
    'fixture@example.invalid',
    'en',
    pg_catalog.jsonb_build_object(
      'serviceIds', pg_catalog.jsonb_build_array('10000000-0000-4000-8000-000000000002'),
      'staffPreference', 'any',
      'source', 'slot_unavailable'
    ),
    'fixture-sha'
  );

  IF v_result.guard_outcome <> 'slot_available' OR v_result.id IS NOT NULL THEN
    RAISE EXCEPTION 'database guard did not reject false waitlist: %', row_to_json(v_result);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.booking_waitlist_entries AS entry
    WHERE entry.salon_id = '10000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'false waitlist row was persisted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.capacity_rescue_decision_events AS event
    WHERE event.request_id = v_request_id
      AND event.outcome = 'slot_available'
      AND event.free_staff_count = 2
      AND event.free_resource_count = 2
  ) THEN
    RAISE EXCEPTION 'PII-free decision evidence was not persisted';
  END IF;
END;
$verify_available$;

SET LOCAL session_replication_role = replica;

INSERT INTO public.bookings (
  id, salon_id, service_id, staff_id, resource_id, client_name,
  start_time_utc, end_time_utc, status
)
SELECT
  ('10000000-0000-4000-8000-' || pg_catalog.lpad((300 + n)::text, 12, '0'))::uuid,
  '10000000-0000-4000-8000-000000000001'::uuid,
  '10000000-0000-4000-8000-000000000002'::uuid,
  ('10000000-0000-4000-8000-' || pg_catalog.lpad((100 + n)::text, 12, '0'))::uuid,
  ('10000000-0000-4000-8000-' || pg_catalog.lpad((200 + n)::text, 12, '0'))::uuid,
  'Fixture Occupancy ' || n,
  (((pg_catalog.transaction_timestamp() AT TIME ZONE 'America/Los_Angeles')::date + 1)::timestamp
    + time '12:00') AT TIME ZONE 'America/Los_Angeles',
  (((pg_catalog.transaction_timestamp() AT TIME ZONE 'America/Los_Angeles')::date + 1)::timestamp
    + time '13:10') AT TIME ZONE 'America/Los_Angeles',
  'confirmed'
FROM pg_catalog.generate_series(6, 7) AS occupied(n);

SET LOCAL session_replication_role = origin;

DO $verify_unavailable$
DECLARE
  v_result record;
  v_request_id uuid := '10000000-0000-4000-8000-000000000402';
  v_date date := (pg_catalog.transaction_timestamp() AT TIME ZONE 'America/Los_Angeles')::date + 1;
BEGIN
  SELECT * INTO v_result
  FROM public.create_public_capacity_rescue_request_v2(
    '10000000-0000-4000-8000-000000000001',
    v_request_id,
    'individual',
    '10000000-0000-4000-8000-000000000002',
    NULL,
    v_date,
    '12:00 PM',
    1,
    'Fixture Full Customer',
    '17785550102',
    'fixture-full@example.invalid',
    'en',
    pg_catalog.jsonb_build_object(
      'serviceIds', pg_catalog.jsonb_build_array('10000000-0000-4000-8000-000000000002'),
      'staffPreference', 'any',
      'source', 'slot_unavailable'
    ),
    'fixture-sha'
  );

  IF v_result.guard_outcome <> 'slot_unavailable'
     OR v_result.id IS NULL
     OR v_result.status <> 'waiting'
     OR v_result.created_new IS NOT TRUE THEN
    RAISE EXCEPTION 'legitimate full-capacity waitlist failed: %', row_to_json(v_result);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.booking_waitlist_entries AS entry
    WHERE entry.id = v_result.id
      AND entry.request_id = v_request_id
  ) THEN
    RAISE EXCEPTION 'legitimate waitlist receipt was not persisted';
  END IF;
END;
$verify_unavailable$;

ROLLBACK;
