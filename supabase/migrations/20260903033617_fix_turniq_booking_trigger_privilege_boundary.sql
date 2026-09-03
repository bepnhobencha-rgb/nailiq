-- TurnIQ P0: keep the booking confirmation trigger able to inspect the private
-- TurnIQ ledger without exposing that ledger to authenticated salon users.
--
-- Root cause: the trigger was SECURITY INVOKER while turniq_assignments is
-- intentionally service-role-only. Any authenticated update that moved a
-- walk-in from waiting to confirmed reached the trigger and failed with 42501
-- before the trigger could determine that no active TurnIQ assignment existed.
--
-- Rollback boundary: keep TurnIQ OFF, drop the
-- turniq_assignment_confirmation_safety trigger before restoring SECURITY
-- INVOKER. Never grant authenticated direct access to TurnIQ ledger tables.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER FUNCTION public.enforce_turniq_assignment_confirmation_safety()
  SECURITY DEFINER;

-- Trigger execution does not require a browser-callable function grant. Keep
-- the helper unreachable as a direct Data API RPC.
REVOKE ALL ON FUNCTION public.enforce_turniq_assignment_confirmation_safety()
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.enforce_turniq_assignment_confirmation_safety() IS
  'M3D fail-closed TurnIQ booking revalidation. Runs as its locked owner so authenticated booking updates can inspect the private ledger without receiving ledger privileges.';

DO $proof$
DECLARE
  v_guard regprocedure :=
    'public.enforce_turniq_assignment_confirmation_safety()'::regprocedure;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    WHERE p.oid = v_guard
      AND p.prosecdef IS TRUE
      AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
  ) THEN
    RAISE EXCEPTION
      'TurnIQ booking confirmation guard must be postgres-owned SECURITY DEFINER';
  END IF;

  IF pg_catalog.has_function_privilege('anon', v_guard, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_guard, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'TurnIQ booking confirmation guard must not be browser-callable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS t
    WHERE t.tgrelid = 'public.bookings'::regclass
      AND t.tgfoid = v_guard
      AND t.tgname = 'turniq_assignment_confirmation_safety'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION
      'TurnIQ booking confirmation guard trigger is not attached';
  END IF;
END
$proof$;

COMMIT;
