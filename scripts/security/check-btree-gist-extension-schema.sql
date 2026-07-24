\set ON_ERROR_STOP on

DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'btree_gist'
      AND n.nspname = 'extensions'
  ) THEN
    RAISE EXCEPTION 'btree_gist is not installed in extensions';
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
