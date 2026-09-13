\set ON_ERROR_STOP on

-- Run only against a disposable local/CI database after migrations. This is a
-- real RLS rehearsal, with all existing constraints and triggers enabled.
-- Synthetic identities have no contact destinations; every change rolls back.
BEGIN;
SET LOCAL request.jwt.claim.role = 'service_role';
SET LOCAL request.jwt.claim.sub = '';
SET LOCAL request.jwt.claims = '{}';

INSERT INTO auth.users(id, email, created_at)
SELECT ('69130000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'booking-rls-' || n || '@example.invalid', now()
FROM generate_series(1, 8) AS n;

INSERT INTO public.salons(id, slug, name, phone, timezone)
VALUES
  ('69130000-0000-4000-8001-000000000001', 'booking-write-rls-a', 'Booking RLS A', '+16045550181', 'UTC'),
  ('69130000-0000-4000-8001-000000000002', 'booking-write-rls-b', 'Booking RLS B', '+16045550182', 'UTC');
INSERT INTO public.salon_members(salon_id, user_id, role)
SELECT '69130000-0000-4000-8001-000000000001'::uuid,
       ('69130000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       (ARRAY['owner', 'admin', 'senior', 'receptionist', 'nail_tech'])[n]
FROM generate_series(1, 5) AS n;
INSERT INTO public.salon_members(salon_id, user_id, role)
VALUES
  ('69130000-0000-4000-8001-000000000002', '69130000-0000-4000-8000-000000000006', 'owner'),
  ('69130000-0000-4000-8001-000000000001', '69130000-0000-4000-8000-000000000007', 'owner'),
  ('69130000-0000-4000-8001-000000000002', '69130000-0000-4000-8000-000000000007', 'nail_tech');

INSERT INTO public.service_categories(slug, name_en, name_vi)
VALUES ('booking-write-rls', 'Booking RLS', 'Booking RLS');
INSERT INTO public.services(id, salon_id, name, price_cents, duration_minutes, category)
VALUES
  ('69130000-0000-4000-8002-000000000001', '69130000-0000-4000-8001-000000000001', 'RLS Service A', 3000, 30, 'booking-write-rls'),
  ('69130000-0000-4000-8002-000000000002', '69130000-0000-4000-8001-000000000002', 'RLS Service B', 3000, 30, 'booking-write-rls');
INSERT INTO public.bookings(id, salon_id, service_id, client_name, source, status, joined_queue_at)
VALUES
  ('69130000-0000-4000-8003-000000000001', '69130000-0000-4000-8001-000000000001',
   '69130000-0000-4000-8002-000000000001', 'RLS Queue A', 'walkin', 'waiting', now()),
  ('69130000-0000-4000-8003-000000000002', '69130000-0000-4000-8001-000000000002',
   '69130000-0000-4000-8002-000000000002', 'RLS Queue B', 'walkin', 'waiting', now());

-- Test-only invoker helper: it cannot elevate privileges and is rolled back.
-- Require the exact RLS INSERT error for authenticated callers, so an unrelated
-- trigger/constraint/permission failure cannot masquerade as authorization.
CREATE FUNCTION pg_temp.assert_booking_write_denied(
  p_salon uuid, p_service uuid, p_booking uuid, p_can_read boolean, p_case text
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE v_rows integer; v_inserted boolean := false;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'RLS test must run as an API role: %', p_case;
  END IF;
  BEGIN
    INSERT INTO public.bookings(salon_id, service_id, client_name, source, status, joined_queue_at)
    VALUES (p_salon, p_service, 'RLS Denied Intake', 'walkin', 'waiting', now());
    v_inserted := true;
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM IS DISTINCT FROM 'new row violates row-level security policy for table "bookings"'
       AND NOT (current_user = 'anon' AND SQLERRM = 'permission denied for table bookings') THEN
      RAISE;
    END IF;
  END;
  UPDATE public.bookings SET walkin_priority = 'high' WHERE id = p_booking;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_inserted OR v_rows <> 0 THEN
    RAISE EXCEPTION 'RLS denied writes unexpectedly succeeded: % (insert=%, update_rows=%)',
      p_case, v_inserted, v_rows;
  END IF;
  SELECT count(*) INTO v_rows FROM public.bookings WHERE id = p_booking;
  IF v_rows <> (CASE WHEN p_can_read THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'SELECT boundary changed: %', p_case;
  END IF;
END;
$$;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.role = 'authenticated';
SET LOCAL request.jwt.claim.sub = '69130000-0000-4000-8000-000000000005';

-- Baseline membership-only policies fail HERE on the actual INSERT, before
-- any static policy-shape assertion. Nail tech must retain same-salon reads.
SELECT pg_temp.assert_booking_write_denied(
  '69130000-0000-4000-8001-000000000001', '69130000-0000-4000-8002-000000000001',
  '69130000-0000-4000-8003-000000000001', true, 'nail tech own salon');

DO $desk_roles$
DECLARE v_n integer; v_id uuid; v_rows integer;
BEGIN
  FOR v_n IN 1..4 LOOP
    PERFORM set_config('request.jwt.claim.sub',
      '69130000-0000-4000-8000-' || lpad(v_n::text, 12, '0'), true);
    INSERT INTO public.bookings(salon_id, service_id, client_name, source, status, joined_queue_at)
    VALUES ('69130000-0000-4000-8001-000000000001', '69130000-0000-4000-8002-000000000001',
            'RLS Desk Intake', 'walkin', 'waiting', now())
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'desk INSERT missing receipt: %', v_n; END IF;
    UPDATE public.bookings SET walkin_priority = 'medium' WHERE id = v_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 OR NOT EXISTS (SELECT 1 FROM public.bookings WHERE id = v_id AND walkin_priority = 'medium') THEN
      RAISE EXCEPTION 'desk UPDATE/readback failed: %', v_n;
    END IF;
    -- The baseline row belongs to the salon, not to the actor who inserted it.
    UPDATE public.bookings SET walkin_priority = 'low'
    WHERE id = '69130000-0000-4000-8003-000000000001';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'desk cannot update teammate intake: %', v_n; END IF;
    PERFORM pg_temp.assert_booking_write_denied(
      '69130000-0000-4000-8001-000000000002', '69130000-0000-4000-8002-000000000002',
      '69130000-0000-4000-8003-000000000002', false, 'desk role cross tenant');
  END LOOP;
END;
$desk_roles$;

-- A separate tenant's owner has authority there but not here.
SET LOCAL request.jwt.claim.sub = '69130000-0000-4000-8000-000000000006';
SELECT pg_temp.assert_booking_write_denied(
  '69130000-0000-4000-8001-000000000001', '69130000-0000-4000-8002-000000000001',
  '69130000-0000-4000-8003-000000000001', false, 'tenant B owner into A');
DO $tenant_b$
DECLARE v_rows integer;
BEGIN
  INSERT INTO public.bookings(salon_id, service_id, client_name, source, status)
  VALUES ('69130000-0000-4000-8001-000000000002', '69130000-0000-4000-8002-000000000002',
          'RLS Other Desk', 'walkin', 'waiting');
  UPDATE public.bookings SET walkin_priority = 'low'
  WHERE id = '69130000-0000-4000-8003-000000000002';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'tenant B owner lost own-salon write'; END IF;
END;
$tenant_b$;

-- Same user, different roles: role must bind to the target salon, never to
-- an arbitrary membership. WITH CHECK must also authorize the NEW salon.
SET LOCAL request.jwt.claim.sub = '69130000-0000-4000-8000-000000000007';
SELECT pg_temp.assert_booking_write_denied(
  '69130000-0000-4000-8001-000000000002', '69130000-0000-4000-8002-000000000002',
  '69130000-0000-4000-8003-000000000002', true, 'owner A and nail tech B');
DO $mixed_roles$
DECLARE v_rows integer;
BEGIN
  INSERT INTO public.bookings(salon_id, service_id, client_name, source, status)
  VALUES ('69130000-0000-4000-8001-000000000001', '69130000-0000-4000-8002-000000000001',
          'RLS Mixed Desk', 'walkin', 'waiting');
  UPDATE public.bookings SET walkin_priority = 'medium'
  WHERE id = '69130000-0000-4000-8003-000000000001';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'mixed-role owner lost tenant A write'; END IF;
  BEGIN
    UPDATE public.bookings
    SET salon_id = '69130000-0000-4000-8001-000000000002',
        service_id = '69130000-0000-4000-8002-000000000002'
    WHERE id = '69130000-0000-4000-8003-000000000001';
    RAISE EXCEPTION 'UPDATE WITH CHECK allowed owner A to move booking into tech B';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM IS DISTINCT FROM 'new row violates row-level security policy for table "bookings"' THEN RAISE; END IF;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.bookings WHERE id = '69130000-0000-4000-8003-000000000001'
                AND salon_id = '69130000-0000-4000-8001-000000000001') THEN
    RAISE EXCEPTION 'failed reparent did not preserve original booking';
  END IF;
END;
$mixed_roles$;

-- Test the ACTUAL valid role domain without removing a constraint. Unknown,
-- NULL and noncanonical roles cannot be stored; they confer no membership.
RESET ROLE;
DO $invalid_membership$
DECLARE v_role text; v_constraint text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['unknown', NULL, ' OWNER ']::text[] LOOP
    BEGIN
      INSERT INTO public.salon_members(salon_id, user_id, role)
      VALUES ('69130000-0000-4000-8001-000000000001', '69130000-0000-4000-8000-000000000008', v_role);
      RAISE EXCEPTION 'invalid role was persisted';
    EXCEPTION
      WHEN not_null_violation THEN
        IF v_role IS NOT NULL THEN RAISE; END IF;
      WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_role IS NULL OR v_constraint IS DISTINCT FROM 'salon_members_role_check' THEN RAISE; END IF;
    END;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.salon_members WHERE user_id = '69130000-0000-4000-8000-000000000008') THEN
    RAISE EXCEPTION 'invalid-role identity acquired membership';
  END IF;
END;
$invalid_membership$;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '69130000-0000-4000-8000-000000000008';
SELECT pg_temp.assert_booking_write_denied(
  '69130000-0000-4000-8001-000000000001', '69130000-0000-4000-8002-000000000001',
  '69130000-0000-4000-8003-000000000001', false, 'invalid or absent membership');

-- Live membership changes take effect on the next statement; stale JWTs do
-- not carry salon authority. Demotion preserves read, removal revokes read.
RESET ROLE;
UPDATE public.salon_members SET role = 'nail_tech'
WHERE salon_id = '69130000-0000-4000-8001-000000000001'
  AND user_id = '69130000-0000-4000-8000-000000000001';
DELETE FROM public.salon_members
WHERE salon_id = '69130000-0000-4000-8001-000000000001'
  AND user_id = '69130000-0000-4000-8000-000000000004';
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '69130000-0000-4000-8000-000000000001';
SELECT pg_temp.assert_booking_write_denied(
  '69130000-0000-4000-8001-000000000001', '69130000-0000-4000-8002-000000000001',
  '69130000-0000-4000-8003-000000000001', true, 'owner demoted to tech');
SET LOCAL request.jwt.claim.sub = '69130000-0000-4000-8000-000000000004';
SELECT pg_temp.assert_booking_write_denied(
  '69130000-0000-4000-8001-000000000001', '69130000-0000-4000-8002-000000000001',
  '69130000-0000-4000-8003-000000000001', false, 'receptionist membership removed');

-- Missing subject is unauthenticated even if the DB role is authenticated.
SET LOCAL request.jwt.claim.sub = '';
SELECT pg_temp.assert_booking_write_denied(
  '69130000-0000-4000-8001-000000000001', '69130000-0000-4000-8002-000000000001',
  '69130000-0000-4000-8003-000000000001', false, 'missing auth uid');

-- Public callers still cannot directly mutate/read bookings. Even a supplied
-- owner sub cannot turn the anon PostgreSQL role into authenticated.
RESET ROLE;
SET LOCAL ROLE anon;
SET LOCAL request.jwt.claim.role = 'anon';
SET LOCAL request.jwt.claim.sub = '69130000-0000-4000-8000-000000000007';
SELECT pg_temp.assert_booking_write_denied(
  '69130000-0000-4000-8001-000000000001', '69130000-0000-4000-8002-000000000001',
  '69130000-0000-4000-8003-000000000001', false, 'anon direct booking access');
DO $public_catalog$
BEGIN
  IF (SELECT count(*) FROM public.public_service_catalog
      WHERE id IN ('69130000-0000-4000-8002-000000000001', '69130000-0000-4000-8002-000000000002')) <> 2 THEN
    RAISE EXCEPTION 'public booking catalog access changed';
  END IF;
END;
$public_catalog$;

-- Service-role writes and the canonical terminal transition remain available.
-- No provider call, payment, or notification request is made by these inputs.
RESET ROLE;
SET LOCAL ROLE service_role;
SET LOCAL request.jwt.claim.role = 'service_role';
SET LOCAL request.jwt.claim.sub = '';
DO $service_path$
DECLARE v_id uuid; v_rows integer; v_result jsonb;
BEGIN
  INSERT INTO public.bookings(salon_id, service_id, client_name, source, status)
  VALUES ('69130000-0000-4000-8001-000000000002', '69130000-0000-4000-8002-000000000002',
          'RLS Service Path', 'walkin', 'waiting') RETURNING id INTO v_id;
  UPDATE public.bookings SET walkin_priority = 'low' WHERE id = v_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'service role UPDATE changed'; END IF;
  v_result := public.transition_booking_to_terminal_v1(
    v_id, '69130000-0000-4000-8001-000000000002', NULL, 'system', 'walkin_removed', NULL, false, false, 20);
  IF v_result->>'code' IS DISTINCT FROM 'transitioned'
     OR NOT EXISTS (SELECT 1 FROM public.bookings WHERE id = v_id AND status = 'cancelled') THEN
    RAISE EXCEPTION 'canonical service transition changed';
  END IF;
END;
$service_path$;
RESET ROLE;

DO $catalog_boundaries$
DECLARE v_policy record;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.bookings'::regclass)
     OR NOT has_table_privilege('authenticated', 'public.bookings', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.bookings', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.bookings', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.bookings', 'INSERT,UPDATE') THEN
    RAISE EXCEPTION 'booking RLS/grant boundary changed';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.bookings'::regclass) <> 7 THEN
    RAISE EXCEPTION 'booking policy set changed';
  END IF;
  FOR v_policy IN
    SELECT polname, polcmd, polroles, pg_get_expr(polqual, polrelid) AS using_expr,
           pg_get_expr(polwithcheck, polrelid) AS check_expr
    FROM pg_policy WHERE polrelid = 'public.bookings'::regclass AND polname LIKE '%_anon'
  LOOP
    IF v_policy.polroles IS DISTINCT FROM ARRAY['anon'::regrole::oid]
       OR (v_policy.polcmd IN ('r', 'w', 'd') AND v_policy.using_expr IS DISTINCT FROM 'false')
       OR (v_policy.polcmd IN ('a', 'w') AND v_policy.check_expr IS DISTINCT FROM 'false') THEN
      RAISE EXCEPTION 'anon direct booking policy widened';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid = 'public.bookings'::regclass
      AND polname IN ('bookings_insert_authenticated', 'owner update own salon bookings')
      AND (polroles IS DISTINCT FROM ARRAY['authenticated'::regrole::oid] OR NOT polpermissive)
  ) THEN RAISE EXCEPTION 'authenticated write policy role/kind changed'; END IF;
  IF has_function_privilege('anon',
      'public.transition_booking_to_terminal_v1(uuid,uuid,uuid,text,text,uuid,boolean,boolean,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated',
      'public.transition_booking_to_terminal_v1(uuid,uuid,uuid,text,text,uuid,boolean,boolean,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'terminal service RPC exposed to public/authenticated';
  END IF;
END;
$catalog_boundaries$;

ROLLBACK;
\echo 'PASS booking write role RLS: desk, tech, tenant, mixed roles, invalid membership, revocation, anon, service'
