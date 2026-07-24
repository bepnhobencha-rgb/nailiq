\set ON_ERROR_STOP on

-- Restore the exact pre-migration security mode in a transaction, prove it,
-- then roll back so SECURITY INVOKER remains active.
BEGIN;

ALTER FUNCTION public.salon_has_staff_services(uuid)
  SECURITY DEFINER;

DO $rollback_proof$
DECLARE
  v_oid oid :=
    to_regprocedure('public.salon_has_staff_services(uuid)')::oid;
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION
      'rollback did not restore SECURITY DEFINER for salon_has_staff_services';
  END IF;

  IF has_function_privilege('anon', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'rollback unexpectedly changed the function ACL';
  END IF;
END
$rollback_proof$;

ROLLBACK;

\ir check-salon-staff-capability-invoker.sql
