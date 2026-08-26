\set ON_ERROR_STOP on
BEGIN;
DROP FUNCTION public.current_auth_session_is_active();
ROLLBACK;

DO $$ BEGIN
  IF to_regprocedure('public.current_auth_session_is_active()') IS NULL THEN
    RAISE EXCEPTION 'rollback rehearsal did not restore session validator';
  END IF;
END $$;
SELECT 'auth session rollback passed' AS result;
