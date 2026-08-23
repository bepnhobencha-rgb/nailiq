-- Forward-only correction for the sequence hardening migration. PostgreSQL's
-- SQL-standard TRIM syntax is not exposed as pg_catalog.trim(text); the
-- schema-qualified callable is pg_catalog.btrim(text). Keep migration history
-- immutable and replace only those two calls in the just-created function.
DO $repair_capture$
DECLARE
  v_definition text;
  v_repaired text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.capture_staff_change_notification_occurrence()'::regprocedure
  ) INTO STRICT v_definition;
  IF (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(v_definition,'pg_catalog.trim(',''))
  ) / pg_catalog.length('pg_catalog.trim(')<>2 THEN
    RAISE EXCEPTION 'unexpected staff-change capture definition; refusing repair';
  END IF;
  v_repaired:=pg_catalog.replace(
    v_definition,'pg_catalog.trim(','pg_catalog.btrim('
  );
  EXECUTE v_repaired;
END;
$repair_capture$;

REVOKE ALL ON FUNCTION public.capture_staff_change_notification_occurrence()
  FROM PUBLIC,anon,authenticated,service_role;
