\set ON_ERROR_STOP on

-- Restore the exact pre-migration ACL inside a transaction, prove it, and
-- roll back so the anon-only production boundary remains active.
BEGIN;

GRANT EXECUTE ON FUNCTION public.check_group_slots_available(jsonb)
  TO authenticated;

DO $rollback_proof$
DECLARE
  v_oid regprocedure :=
    to_regprocedure('public.check_group_slots_available(jsonb)');
  v_public_execute boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM aclexplode(
      COALESCE(
        (SELECT proacl FROM pg_proc WHERE oid = v_oid),
        acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
      )
    )
    WHERE grantee = 0
      AND privilege_type = 'EXECUTE'
  ) INTO v_public_execute;

  IF v_public_execute
     OR NOT has_function_privilege('anon', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION
      'rollback did not restore pre-migration group-slot probe grants';
  END IF;
END
$rollback_proof$;

ROLLBACK;

\ir check-public-rpc-role-grants.sql
