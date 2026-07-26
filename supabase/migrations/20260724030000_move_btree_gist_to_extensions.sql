-- Supabase Security Advisor flags extensions installed in the exposed public
-- schema. btree_gist is relocatable, and the folded baseline already installs
-- it in the dedicated extensions schema. Move the drifted production instance
-- without rebuilding the exclusion constraints that prevent double-booking.

CREATE SCHEMA IF NOT EXISTS extensions;

DO $migration$
DECLARE
  v_schema text;
  v_relocatable boolean;
BEGIN
  SELECT n.nspname, e.extrelocatable
    INTO v_schema, v_relocatable
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'btree_gist';

  IF v_schema IS NULL THEN
    RAISE EXCEPTION 'btree_gist is not installed';
  END IF;

  IF v_schema = 'extensions' THEN
    RETURN;
  END IF;

  IF v_schema <> 'public' THEN
    RAISE EXCEPTION 'btree_gist is installed in unexpected schema %', v_schema;
  END IF;

  IF NOT v_relocatable THEN
    RAISE EXCEPTION 'btree_gist is not relocatable';
  END IF;

  ALTER EXTENSION btree_gist SET SCHEMA extensions;
END
$migration$;

DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'btree_gist'
      AND n.nspname = 'extensions'
  ) THEN
    RAISE EXCEPTION 'btree_gist did not move to extensions';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public'
      AND r.relname = 'bookings'
      AND c.conname IN ('bookings_no_overlap', 'bookings_resource_no_overlap')
      AND c.contype = 'x'
      AND c.convalidated
  ) <> 2 THEN
    RAISE EXCEPTION 'booking exclusion constraints are missing or invalid';
  END IF;
END
$proof$;
