\set ON_ERROR_STOP on

-- Rehearse the exact emergency rollback, prove the former schema is restored,
-- then roll back the rehearsal so the hardened state remains active.
BEGIN;

ALTER EXTENSION btree_gist SET SCHEMA public;

DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'btree_gist'
      AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'rollback did not restore btree_gist to public';
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
    RAISE EXCEPTION 'rollback invalidated booking exclusion constraints';
  END IF;
END
$proof$;

ROLLBACK;
