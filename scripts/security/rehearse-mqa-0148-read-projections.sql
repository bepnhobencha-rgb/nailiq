\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
    'anon',
    'public.load_public_booking_snapshot(text,timestamptz)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'authenticated',
    'public.load_public_booking_snapshot(text,timestamptz)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'public snapshot caller grants are incomplete';
  END IF;

  IF pg_catalog.has_function_privilege(
    'anon',
    'public.load_salon_dashboard_projection(uuid,timestamptz,timestamptz)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.load_owner_home_projection(uuid,timestamptz,timestamptz,timestamptz)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'dashboard projection leaked beyond service_role';
  END IF;
END;
$$;

INSERT INTO public.salons(id, slug, name, phone, profile_complete)
VALUES (
  '14800000-0000-4000-8000-000000000001',
  'e2e-mqa-0148-read-projection',
  'E2E MQA-0148 Read Projection',
  '+16045550148',
  true
);

SET LOCAL ROLE anon;
DO $$
DECLARE
  v_snapshot jsonb;
BEGIN
  v_snapshot := public.load_public_booking_snapshot(
    'e2e-mqa-0148-read-projection',
    '2026-08-25T00:00:00Z'::timestamptz
  );
  IF v_snapshot #>> '{salon,slug}' IS DISTINCT FROM
       'e2e-mqa-0148-read-projection'
     OR pg_catalog.jsonb_typeof(v_snapshot -> 'services') <> 'array'
     OR pg_catalog.jsonb_typeof(v_snapshot -> 'staff') <> 'array'
     OR pg_catalog.jsonb_typeof(v_snapshot -> 'capabilities') <> 'array'
     OR pg_catalog.jsonb_typeof(v_snapshot -> 'promotions') <> 'array'
     OR pg_catalog.jsonb_typeof(v_snapshot -> 'promotion_services') <> 'array'
     OR pg_catalog.jsonb_typeof(v_snapshot -> 'combos') <> 'array'
     OR pg_catalog.jsonb_typeof(v_snapshot -> 'resources') <> 'array'
  THEN
    RAISE EXCEPTION 'anonymous public snapshot contract failed closed';
  END IF;
  IF v_snapshot #>> '{salon,phone}' IS NOT NULL
     OR v_snapshot #>> '{salon,email}' IS NOT NULL
  THEN
    RAISE EXCEPTION 'public snapshot exposed private salon contact';
  END IF;
END;
$$;
RESET ROLE;

SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_grid jsonb;
  v_home jsonb;
BEGIN
  v_grid := public.load_salon_dashboard_projection(
    '14800000-0000-4000-8000-000000000001',
    '2026-08-20T00:00:00Z'::timestamptz,
    '2026-08-30T00:00:00Z'::timestamptz
  );
  v_home := public.load_owner_home_projection(
    '14800000-0000-4000-8000-000000000001',
    '2026-07-26T00:00:00Z'::timestamptz,
    '2026-08-27T00:00:00Z'::timestamptz,
    '2026-08-01T00:00:00Z'::timestamptz
  );

  IF v_grid ->> 'services_count' IS DISTINCT FROM '0'
     OR v_grid ->> 'staff_count' IS DISTINCT FROM '0'
     OR pg_catalog.jsonb_array_length(v_grid -> 'bookings') <> 0
     OR pg_catalog.jsonb_array_length(v_home -> 'bookings') <> 0
     OR pg_catalog.jsonb_array_length(v_home -> 'staff') <> 0
     OR pg_catalog.jsonb_array_length(v_home -> 'prior_clients') <> 0
  THEN
    RAISE EXCEPTION 'service-only dashboard projection contract failed';
  END IF;
END;
$$;
RESET ROLE;

ROLLBACK;

SELECT 'PASS MQA-0148 public and dashboard read projections' AS result;
