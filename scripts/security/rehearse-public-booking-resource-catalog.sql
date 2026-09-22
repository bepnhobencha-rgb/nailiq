\set ON_ERROR_STOP on

-- QA-only transactional rehearsal for the public booking resource projection.
-- The script creates synthetic rows, exercises anon/authenticated contracts,
-- and rolls every row back. It must never be used as a Production data seed.

BEGIN;

DO $contract$
DECLARE
  v_view_options text[];
  v_helper_oid oid;
  v_snapshot_oid oid;
  v_public_execute boolean;
  v_public_schema_usage boolean;
BEGIN
  SELECT c.reloptions
  INTO v_view_options
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'public_booking_resource_catalog'
    AND c.relkind = 'v';

  IF v_view_options IS NULL
     OR NOT ('security_invoker=true' = ANY(v_view_options)) THEN
    RAISE EXCEPTION
      'public_booking_resource_catalog is not SECURITY INVOKER';
  END IF;

  v_helper_oid := pg_catalog.to_regprocedure(
    'private.public_booking_resources_for_salon(uuid)'
  )::oid;
  IF v_helper_oid IS NULL THEN
    RAISE EXCEPTION 'public resource helper is missing';
  END IF;

  v_snapshot_oid := pg_catalog.to_regprocedure(
    'public.load_public_booking_snapshot(text,timestamp with time zone)'
  )::oid;
  IF v_snapshot_oid IS NULL THEN
    RAISE EXCEPTION 'public booking snapshot is missing';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.aclexplode(
      COALESCE(
        (SELECT p.proacl FROM pg_catalog.pg_proc AS p
          WHERE p.oid = v_helper_oid),
        pg_catalog.acldefault(
          'f',
          (SELECT p.proowner FROM pg_catalog.pg_proc AS p
            WHERE p.oid = v_helper_oid)
        )
      )
    )
    WHERE grantee = 0
      AND privilege_type = 'EXECUTE'
  ) INTO v_public_execute;

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS n
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        n.nspacl,
        pg_catalog.acldefault('n', n.nspowner)
      )
    ) AS acl
    WHERE n.nspname = 'private'
      AND acl.grantee = 0
      AND acl.privilege_type = 'USAGE'
  ) INTO v_public_schema_usage;

  IF v_public_execute
     OR v_public_schema_usage
     OR NOT pg_catalog.has_schema_privilege('anon', 'private', 'USAGE')
     OR pg_catalog.has_schema_privilege('authenticated', 'private', 'USAGE')
     OR NOT pg_catalog.has_function_privilege(
       'anon', v_helper_oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_helper_oid, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_helper_oid, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'anon', v_snapshot_oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_snapshot_oid, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_snapshot_oid, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'public resource helper ACL drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'salon_resources'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'salon_resources RLS is disabled';
  END IF;
END
$contract$;

INSERT INTO public.salons(
  id,
  slug,
  name,
  phone,
  profile_complete,
  resources_enabled
)
VALUES
  (
    '00300000-0000-4000-8000-000000000001',
    'e2e-p0-03-public-resources',
    'E2E P0-03 Public Resources',
    '+16045550301',
    true,
    true
  ),
  (
    '00300000-0000-4000-8000-000000000002',
    'e2e-p0-03-unpublished-resources',
    'E2E P0-03 Unpublished Resources',
    '+16045550302',
    false,
    true
  );

INSERT INTO public.salon_resources(
  id,
  salon_id,
  name,
  kind,
  display_order,
  status,
  deleted_at
)
VALUES
  (
    '00300000-0000-4000-8000-000000000011',
    '00300000-0000-4000-8000-000000000001',
    'E2E Bed 1',
    'bed',
    1,
    'active',
    NULL
  ),
  (
    '00300000-0000-4000-8000-000000000012',
    '00300000-0000-4000-8000-000000000001',
    'E2E Chair 2',
    'chair',
    2,
    'active',
    NULL
  ),
  (
    '00300000-0000-4000-8000-000000000013',
    '00300000-0000-4000-8000-000000000001',
    'E2E Inactive Bed',
    'bed',
    3,
    'inactive',
    NULL
  ),
  (
    '00300000-0000-4000-8000-000000000014',
    '00300000-0000-4000-8000-000000000001',
    'E2E Deleted Chair',
    'chair',
    4,
    'active',
    '2026-09-21T00:00:00Z'::timestamptz
  ),
  (
    '00300000-0000-4000-8000-000000000021',
    '00300000-0000-4000-8000-000000000002',
    'E2E Unpublished Bed',
    'bed',
    1,
    'active',
    NULL
  );

SET LOCAL ROLE anon;
DO $anon$
DECLARE
  v_rows jsonb;
  v_snapshot jsonb;
  v_direct_count integer;
  v_unpublished_count integer;
BEGIN
  SELECT pg_catalog.count(*)::integer
  INTO v_direct_count
  FROM public.salon_resources
  WHERE salon_id = '00300000-0000-4000-8000-000000000001';
  IF v_direct_count <> 0 THEN
    RAISE EXCEPTION 'anon direct resource read bypassed RLS';
  END IF;

  SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) ORDER BY r.display_order)
  INTO v_rows
  FROM private.public_booking_resources_for_salon(
    '00300000-0000-4000-8000-000000000001'
  ) AS r;

  IF pg_catalog.jsonb_array_length(COALESCE(v_rows, '[]'::jsonb)) <> 2
     OR v_rows #>> '{0,id}' IS DISTINCT FROM
       '00300000-0000-4000-8000-000000000011'
     OR v_rows #>> '{0,name}' IS DISTINCT FROM 'E2E Bed 1'
     OR v_rows #>> '{0,kind}' IS DISTINCT FROM 'bed'
     OR v_rows #>> '{1,id}' IS DISTINCT FROM
       '00300000-0000-4000-8000-000000000012'
     OR (v_rows -> 0) ? 'salon_id'
     OR (v_rows -> 0) ? 'square_team_member_id' THEN
    RAISE EXCEPTION 'anon resource projection contract failed';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_unpublished_count
  FROM private.public_booking_resources_for_salon(
    '00300000-0000-4000-8000-000000000002'
  );
  IF v_unpublished_count <> 0 THEN
    RAISE EXCEPTION 'unpublished salon resources were exposed';
  END IF;

  v_snapshot := public.load_public_booking_snapshot(
    'e2e-p0-03-public-resources',
    '2026-09-21T12:00:00Z'::timestamptz
  );
  IF v_snapshot #>> '{salon,slug}' IS DISTINCT FROM
       'e2e-p0-03-public-resources'
     OR pg_catalog.jsonb_array_length(v_snapshot -> 'resources') <> 2
     OR v_snapshot #>> '{resources,0,id}' IS DISTINCT FROM
       '00300000-0000-4000-8000-000000000011' THEN
    RAISE EXCEPTION 'anon booking snapshot resource contract failed';
  END IF;
END
$anon$;
RESET ROLE;

SET LOCAL ROLE authenticated;
DO $authenticated$
DECLARE
  v_direct_count integer;
BEGIN
  SELECT pg_catalog.count(*)::integer
  INTO v_direct_count
  FROM public.salon_resources
  WHERE salon_id = '00300000-0000-4000-8000-000000000001';
  IF v_direct_count <> 0 THEN
    RAISE EXCEPTION 'authenticated direct resource read bypassed RLS';
  END IF;
END
$authenticated$;
RESET ROLE;

ROLLBACK;

SELECT 'PASS P0-03 public booking resource catalog rehearsal' AS result;
