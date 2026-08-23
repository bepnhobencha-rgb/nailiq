\set ON_ERROR_STOP on

-- Disposable local-only acceptance for MQA-0050 and MQA-0183..0186.
-- The transaction rolls back every fixture and never calls a provider.
BEGIN;

DO $schema_proof$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'salon_organizations',
    'salon_organization_members',
    'salon_organization_locations',
    'organization_staff',
    'organization_staff_locations',
    'organization_client_consents',
    'organization_loyalty_programs',
    'organization_loyalty_accounts',
    'organization_loyalty_events'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = v_table
        AND c.relrowsecurity
        AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION '% is missing forced RLS', v_table;
    END IF;

    IF pg_catalog.has_table_privilege('anon', 'public.' || v_table, 'SELECT') THEN
      RAISE EXCEPTION 'anon can select %', v_table;
    END IF;

    IF pg_catalog.has_table_privilege(
      'authenticated',
      'public.' || v_table,
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) THEN
      RAISE EXCEPTION 'authenticated has a mutation/control privilege on %', v_table;
    END IF;
  END LOOP;

  IF pg_catalog.has_function_privilege(
    'authenticated',
    'public.apply_organization_loyalty_event(uuid,uuid,uuid,uuid,text,integer,uuid,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated can invoke the service-only loyalty ledger';
  END IF;

  IF pg_catalog.has_function_privilege(
    'anon',
    'public.list_organization_clients(uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    'public.get_organization_booking_report(uuid,timestamptz,timestamptz)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anon can invoke an organization PII/reporting function';
  END IF;
END;
$schema_proof$;

INSERT INTO auth.users(id, email, created_at) VALUES
  ('51860000-0000-4000-8000-000000000001', 'chain-one-owner@nailiq.invalid', now()),
  ('51860000-0000-4000-8000-000000000002', 'chain-two-owner@nailiq.invalid', now());

INSERT INTO public.salons(id, slug, name, phone, timezone) VALUES
  ('51860000-0000-4000-8000-000000000011', 'mqa-chain-a', 'MQA Chain A', '+16045550811', 'America/Vancouver'),
  ('51860000-0000-4000-8000-000000000012', 'mqa-chain-b', 'MQA Chain B', '+14165550812', 'America/Toronto'),
  ('51860000-0000-4000-8000-000000000013', 'mqa-other-c', 'MQA Other C', '+12125550813', 'America/New_York'),
  ('51860000-0000-4000-8000-000000000014', 'mqa-other-d', 'MQA Other D', '+13125550814', 'America/Chicago');

INSERT INTO public.salon_members(salon_id, user_id, role) VALUES
  ('51860000-0000-4000-8000-000000000011', '51860000-0000-4000-8000-000000000001', 'owner'),
  ('51860000-0000-4000-8000-000000000012', '51860000-0000-4000-8000-000000000001', 'owner'),
  ('51860000-0000-4000-8000-000000000013', '51860000-0000-4000-8000-000000000002', 'owner'),
  ('51860000-0000-4000-8000-000000000014', '51860000-0000-4000-8000-000000000002', 'owner');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claim.sub', '51860000-0000-4000-8000-000000000001', true);

SELECT public.create_salon_organization(
  'MQA Chain One',
  ARRAY[
    '51860000-0000-4000-8000-000000000011'::uuid,
    '51860000-0000-4000-8000-000000000012'::uuid
  ]
);

DO $owner_boundary$
BEGIN
  BEGIN
    PERFORM public.create_salon_organization(
      'Cross Tenant Chain',
      ARRAY[
        '51860000-0000-4000-8000-000000000011'::uuid,
        '51860000-0000-4000-8000-000000000013'::uuid
      ]
    );
    RAISE EXCEPTION 'owner linked a salon from another tenant';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.salon_organizations(name, created_by)
    VALUES ('Direct write', '51860000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'authenticated directly inserted an organization';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$owner_boundary$;

SELECT set_config('request.jwt.claim.sub', '51860000-0000-4000-8000-000000000002', true);
SELECT public.create_salon_organization(
  'MQA Chain Two',
  ARRAY[
    '51860000-0000-4000-8000-000000000013'::uuid,
    '51860000-0000-4000-8000-000000000014'::uuid
  ]
);

RESET ROLE;
SELECT id AS chain_one_id
FROM public.salon_organizations
WHERE name = 'MQA Chain One' \gset
SELECT id AS chain_two_id
FROM public.salon_organizations
WHERE name = 'MQA Chain Two' \gset
SELECT set_config('nailiq.chain_one_id', :'chain_one_id', true);
SELECT set_config('nailiq.chain_two_id', :'chain_two_id', true);

INSERT INTO public.service_categories(slug, name_en, name_vi)
VALUES ('mqa-multilocation', 'MQA Multilocation', 'MQA Multilocation')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.services(id, salon_id, name, duration_minutes, price_cents, category) VALUES
  ('51860000-0000-4000-8000-000000000021', '51860000-0000-4000-8000-000000000011', 'Chain Service A', 60, 5000, 'mqa-multilocation'),
  ('51860000-0000-4000-8000-000000000022', '51860000-0000-4000-8000-000000000012', 'Chain Service B', 60, 6000, 'mqa-multilocation'),
  ('51860000-0000-4000-8000-000000000023', '51860000-0000-4000-8000-000000000013', 'Other Service C', 60, 9000, 'mqa-multilocation');

INSERT INTO public.staff(id, salon_id, name, status) VALUES
  ('51860000-0000-4000-8000-000000000031', '51860000-0000-4000-8000-000000000011', 'Shared Tech A', 'active'),
  ('51860000-0000-4000-8000-000000000032', '51860000-0000-4000-8000-000000000012', 'Shared Tech B', 'active'),
  ('51860000-0000-4000-8000-000000000033', '51860000-0000-4000-8000-000000000013', 'Other Tech C', 'active');

INSERT INTO public.staff_shifts(staff_id, salon_id, day_of_week, start_time, end_time) VALUES
  ('51860000-0000-4000-8000-000000000031', '51860000-0000-4000-8000-000000000011', 'mon', '09:00', '17:00'),
  ('51860000-0000-4000-8000-000000000032', '51860000-0000-4000-8000-000000000012', 'tue', '10:00', '18:00');

INSERT INTO public.organization_staff(id, organization_id, display_name)
VALUES ('51860000-0000-4000-8000-000000000041', :'chain_one_id', 'Shared Tech');

INSERT INTO public.organization_staff_locations(
  organization_id,
  organization_staff_id,
  salon_id,
  staff_id
) VALUES
  (:'chain_one_id', '51860000-0000-4000-8000-000000000041', '51860000-0000-4000-8000-000000000011', '51860000-0000-4000-8000-000000000031'),
  (:'chain_one_id', '51860000-0000-4000-8000-000000000041', '51860000-0000-4000-8000-000000000012', '51860000-0000-4000-8000-000000000032');

DO $mapping_boundary$
BEGIN
  BEGIN
    INSERT INTO public.organization_staff_locations(
      organization_id,
      organization_staff_id,
      salon_id,
      staff_id
    ) VALUES (
      current_setting('nailiq.chain_one_id')::uuid,
      '51860000-0000-4000-8000-000000000041',
      '51860000-0000-4000-8000-000000000011',
      '51860000-0000-4000-8000-000000000033'
    );
    RAISE EXCEPTION 'staff row was mapped to a mismatched salon';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$mapping_boundary$;

INSERT INTO public.bookings(
  id, salon_id, service_id, staff_id, client_name, start_time_utc,
  end_time_utc, status, price_cents
) VALUES (
  '51860000-0000-4000-8000-000000000051',
  '51860000-0000-4000-8000-000000000011',
  '51860000-0000-4000-8000-000000000021',
  '51860000-0000-4000-8000-000000000031',
  'Capacity Client',
  '2026-10-05 17:00:00+00',
  '2026-10-05 18:00:00+00',
  'confirmed',
  5000
);

DO $cross_location_capacity$
BEGIN
  BEGIN
    INSERT INTO public.bookings(
      id, salon_id, service_id, staff_id, client_name, start_time_utc,
      end_time_utc, status, price_cents
    ) VALUES (
      '51860000-0000-4000-8000-000000000052',
      '51860000-0000-4000-8000-000000000012',
      '51860000-0000-4000-8000-000000000022',
      '51860000-0000-4000-8000-000000000032',
      'Overlapping Client',
      '2026-10-05 17:30:00+00',
      '2026-10-05 18:30:00+00',
      'confirmed',
      6000
    );
    RAISE EXCEPTION 'shared staff was double-booked across locations';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
END;
$cross_location_capacity$;

INSERT INTO public.bookings(
  id, salon_id, service_id, staff_id, client_name, start_time_utc,
  end_time_utc, status, price_cents
) VALUES (
  '51860000-0000-4000-8000-000000000053',
  '51860000-0000-4000-8000-000000000012',
  '51860000-0000-4000-8000-000000000022',
  '51860000-0000-4000-8000-000000000032',
  'Adjacent Client',
  '2026-10-05 18:00:00+00',
  '2026-10-05 19:00:00+00',
  'confirmed',
  6000
);

DO $schedule_contract$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*)
  INTO v_count
  FROM public.organization_staff_locations AS osl
  JOIN public.staff_shifts AS ss
    ON ss.staff_id = osl.staff_id
    AND ss.salon_id = osl.salon_id
  JOIN public.salons AS s ON s.id = osl.salon_id
  WHERE osl.organization_staff_id = '51860000-0000-4000-8000-000000000041'
    AND (
      (s.timezone = 'America/Vancouver' AND ss.day_of_week = 'mon')
      OR (s.timezone = 'America/Toronto' AND ss.day_of_week = 'tue')
    );
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'location-local timezone/shift assignments were not preserved';
  END IF;
END;
$schedule_contract$;

INSERT INTO public.client_profiles(id, phone, name, email, is_vip) VALUES
  ('51860000-0000-4000-8000-000000000061', '+16045550861', 'Consented Chain Client', 'chain-client@nailiq.invalid', true),
  ('51860000-0000-4000-8000-000000000062', '+12125550862', 'Other Chain Client', 'other-client@nailiq.invalid', false);

INSERT INTO public.salon_clients(salon_id, client_profile_id, source) VALUES
  ('51860000-0000-4000-8000-000000000011', '51860000-0000-4000-8000-000000000061', 'booking'),
  ('51860000-0000-4000-8000-000000000012', '51860000-0000-4000-8000-000000000061', 'booking'),
  ('51860000-0000-4000-8000-000000000013', '51860000-0000-4000-8000-000000000061', 'booking'),
  ('51860000-0000-4000-8000-000000000013', '51860000-0000-4000-8000-000000000062', 'booking');

INSERT INTO public.salon_client_spend(
  salon_id,
  client_profile_id,
  total_spend_cents,
  payment_count
) VALUES
  ('51860000-0000-4000-8000-000000000011', '51860000-0000-4000-8000-000000000061', 1000, 1),
  ('51860000-0000-4000-8000-000000000012', '51860000-0000-4000-8000-000000000061', 2000, 1),
  ('51860000-0000-4000-8000-000000000013', '51860000-0000-4000-8000-000000000061', 9000, 1);

INSERT INTO public.organization_client_consents(
  organization_id,
  client_profile_id,
  consent_at,
  consent_source,
  granted_by
) VALUES (
  :'chain_one_id',
  '51860000-0000-4000-8000-000000000061',
  now(),
  'customer_opt_in',
  '51860000-0000-4000-8000-000000000001'
);

INSERT INTO public.bookings(
  id, salon_id, service_id, client_profile_id, client_name, client_phone,
  start_time_utc, end_time_utc, status, price_cents
) VALUES
  ('51860000-0000-4000-8000-000000000071', '51860000-0000-4000-8000-000000000011', '51860000-0000-4000-8000-000000000021', '51860000-0000-4000-8000-000000000061', 'Consented Chain Client', '+16045550861', '2026-09-01 17:00:00+00', '2026-09-01 18:00:00+00', 'completed', 5000),
  ('51860000-0000-4000-8000-000000000072', '51860000-0000-4000-8000-000000000012', '51860000-0000-4000-8000-000000000022', '51860000-0000-4000-8000-000000000061', 'Consented Chain Client', '+16045550861', '2026-09-02 17:00:00+00', '2026-09-02 18:00:00+00', 'completed', 6000),
  ('51860000-0000-4000-8000-000000000073', '51860000-0000-4000-8000-000000000013', '51860000-0000-4000-8000-000000000023', '51860000-0000-4000-8000-000000000061', 'Consented Chain Client', '+16045550861', '2026-09-03 17:00:00+00', '2026-09-03 18:00:00+00', 'completed', 9000);

INSERT INTO public.organization_loyalty_programs(
  id,
  organization_id,
  name,
  points_required
) VALUES (
  '51860000-0000-4000-8000-000000000081',
  :'chain_one_id',
  'MQA Chain Rewards',
  10
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claim.sub', '51860000-0000-4000-8000-000000000001', true);

DO $client_sharing$
DECLARE
  v_client record;
  v_count integer;
BEGIN
  SELECT * INTO STRICT v_client
  FROM public.list_organization_clients(
    current_setting('nailiq.chain_one_id')::uuid
  );

  IF v_client.client_profile_id <> '51860000-0000-4000-8000-000000000061'
     OR v_client.location_count <> 2
     OR v_client.completed_visits <> 2
     OR v_client.total_spent_cents <> 3000 THEN
    RAISE EXCEPTION 'organization client aggregation leaked or omitted a branch: %', row_to_json(v_client);
  END IF;

  SELECT count(*) INTO v_count FROM public.salon_organizations;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'RLS exposed another organization: %', v_count;
  END IF;

  BEGIN
    PERFORM public.list_organization_clients(
      current_setting('nailiq.chain_two_id')::uuid
    );
    RAISE EXCEPTION 'owner read customer profiles from another organization';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$client_sharing$;

DO $reporting$
DECLARE
  v_branch_count integer;
  v_org_booking_count bigint;
  v_branch_booking_count bigint;
  v_org_gross bigint;
  v_branch_gross bigint;
BEGIN
  SELECT count(*), sum(booking_count), sum(gross_booked_cents)
  INTO v_branch_count, v_branch_booking_count, v_branch_gross
  FROM public.get_organization_booking_report(
    current_setting('nailiq.chain_one_id')::uuid,
    '2026-09-01 00:00:00+00',
    '2026-11-01 00:00:00+00'
  )
  WHERE scope = 'branch';

  SELECT booking_count, gross_booked_cents
  INTO STRICT v_org_booking_count, v_org_gross
  FROM public.get_organization_booking_report(
    current_setting('nailiq.chain_one_id')::uuid,
    '2026-09-01 00:00:00+00',
    '2026-11-01 00:00:00+00'
  )
  WHERE scope = 'organization';

  IF v_branch_count <> 2
     OR v_org_booking_count <> v_branch_booking_count
     OR v_org_gross <> v_branch_gross THEN
    RAISE EXCEPTION 'branch and organization reporting totals diverged';
  END IF;

  BEGIN
    PERFORM public.get_organization_booking_report(
      current_setting('nailiq.chain_two_id')::uuid,
      '2026-09-01 00:00:00+00',
      '2026-11-01 00:00:00+00'
    );
    RAISE EXCEPTION 'owner read reporting from another organization';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$reporting$;

RESET ROLE;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $loyalty_round_trip$
DECLARE
  v_event_id uuid;
  v_points integer;
  v_applied boolean;
  v_event_count integer;
  v_branch_count integer;
BEGIN
  SELECT event_id, points_after, applied
  INTO v_event_id, v_points, v_applied
  FROM public.apply_organization_loyalty_event(
    current_setting('nailiq.chain_one_id')::uuid,
    '51860000-0000-4000-8000-000000000011',
    '51860000-0000-4000-8000-000000000061',
    '51860000-0000-4000-8000-000000000071',
    'earn',
    5,
    '51860000-0000-4000-8000-000000000091',
    NULL
  );
  IF NOT v_applied OR v_points <> 5 THEN
    RAISE EXCEPTION 'first branch loyalty earn failed';
  END IF;

  SELECT event_id, points_after, applied
  INTO v_event_id, v_points, v_applied
  FROM public.apply_organization_loyalty_event(
    current_setting('nailiq.chain_one_id')::uuid,
    '51860000-0000-4000-8000-000000000011',
    '51860000-0000-4000-8000-000000000061',
    '51860000-0000-4000-8000-000000000071',
    'earn',
    5,
    '51860000-0000-4000-8000-000000000091',
    NULL
  );
  IF v_applied OR v_points <> 5 THEN
    RAISE EXCEPTION 'loyalty replay was not idempotent';
  END IF;

  SELECT points_after, applied
  INTO v_points, v_applied
  FROM public.apply_organization_loyalty_event(
    current_setting('nailiq.chain_one_id')::uuid,
    '51860000-0000-4000-8000-000000000012',
    '51860000-0000-4000-8000-000000000061',
    '51860000-0000-4000-8000-000000000072',
    'earn',
    5,
    '51860000-0000-4000-8000-000000000092',
    NULL
  );
  IF NOT v_applied OR v_points <> 10 THEN
    RAISE EXCEPTION 'second branch loyalty earn failed';
  END IF;

  SELECT points_after, applied
  INTO v_points, v_applied
  FROM public.apply_organization_loyalty_event(
    current_setting('nailiq.chain_one_id')::uuid,
    '51860000-0000-4000-8000-000000000012',
    '51860000-0000-4000-8000-000000000061',
    '51860000-0000-4000-8000-000000000072',
    'redeem',
    -10,
    '51860000-0000-4000-8000-000000000093',
    NULL
  );
  IF NOT v_applied OR v_points <> 0 THEN
    RAISE EXCEPTION 'cross-location loyalty redemption failed';
  END IF;

  SELECT count(*), count(DISTINCT salon_id)
  INTO v_event_count, v_branch_count
  FROM public.organization_loyalty_events
  WHERE organization_id = current_setting('nailiq.chain_one_id')::uuid;
  IF v_event_count <> 3 OR v_branch_count <> 2 THEN
    RAISE EXCEPTION 'loyalty ledger event/branch evidence is wrong';
  END IF;

  BEGIN
    PERFORM public.apply_organization_loyalty_event(
      current_setting('nailiq.chain_one_id')::uuid,
      '51860000-0000-4000-8000-000000000013',
      '51860000-0000-4000-8000-000000000061',
      '51860000-0000-4000-8000-000000000073',
      'earn',
      5,
      '51860000-0000-4000-8000-000000000094',
      NULL
    );
    RAISE EXCEPTION 'loyalty event crossed the organization boundary';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$loyalty_round_trip$;

ROLLBACK;
SELECT 'PASS organization tenant isolation, consented profiles, shared staff capacity, loyalty and branch reporting' AS result;
