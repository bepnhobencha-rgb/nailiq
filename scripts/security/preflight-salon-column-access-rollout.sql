\set ON_ERROR_STOP on

DO $$
DECLARE
  v_missing text;
  v_bad_update_policy integer;
BEGIN
  SELECT pg_catalog.string_agg(required.column_name, ', ')
  INTO v_missing
  FROM (
    VALUES
      ('id'), ('slug'), ('name'), ('timezone'), ('feature_flags'),
      ('staff_notification_settings'), ('client_segment_settings'),
      ('noshow_protection_enabled'), ('winback_enabled'), ('email'),
      ('stripe_customer_id'), ('admin_notes'), ('superadmin_locked_at')
  ) AS required(column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns AS c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'salons'
      AND c.column_name = required.column_name
  );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'salons rollout prerequisite columns missing: %', v_missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'salons'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'salons RLS must be enabled before column hardening';
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_bad_update_policy
  FROM pg_catalog.pg_policies AS p
  WHERE p.schemaname = 'public'
    AND p.tablename = 'salons'
    AND p.cmd = 'UPDATE'
    AND (
      coalesce(p.qual, '') NOT LIKE '%owner%admin%'
      OR coalesce(p.with_check, '') NOT LIKE '%owner%admin%'
    );
  IF v_bad_update_policy <> 0 THEN
    RAISE EXCEPTION 'salons UPDATE policy is not owner/admin scoped';
  END IF;
END $$;

SELECT
  pg_catalog.count(*) AS salon_rows,
  pg_catalog.pg_size_pretty(
    pg_catalog.pg_total_relation_size('public.salons')
  ) AS salons_total_size,
  has_table_privilege('authenticated', 'public.salons', 'SELECT')
    AS authenticated_table_select_before_or_after,
  (
    SELECT pg_catalog.count(*)
    FROM information_schema.role_column_grants
    WHERE table_schema = 'public'
      AND table_name = 'salons'
      AND grantee = 'authenticated'
      AND privilege_type = 'SELECT'
  ) AS authenticated_select_columns
FROM public.salons;

SELECT 'salon column access preflight passed' AS result;
