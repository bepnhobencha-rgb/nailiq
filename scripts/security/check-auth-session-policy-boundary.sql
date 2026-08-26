\set ON_ERROR_STOP on

DO $$
DECLARE
  v_oid oid;
  v_def text;
BEGIN
  SELECT p.oid, pg_get_functiondef(p.oid)
  INTO v_oid, v_def
  FROM pg_proc AS p
  JOIN pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'current_auth_session_is_active'
    AND pg_get_function_identity_arguments(p.oid) = '';

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'current_auth_session_is_active() missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE oid = v_oid
      AND prosecdef AND provolatile = 's'
      AND proconfig @> ARRAY['search_path=""']::text[]
  ) THEN
    RAISE EXCEPTION 'session validator is not hardened STABLE SECURITY DEFINER';
  END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'session validator ACL mismatch';
  END IF;
  IF position('FROM auth.sessions' IN v_def) = 0
     OR position('s.id = v_session_id' IN v_def) = 0
     OR position('s.user_id = v_subject' IN v_def) = 0
     OR position('v_exp <= v_now_epoch' IN v_def) = 0
     OR position('v_claims->>''aud''' IN v_def) = 0
     OR position('v_claims ? ''is_anonymous''' IN v_def) = 0
     OR position('auth.role()' IN v_def) <> 0 THEN
    RAISE EXCEPTION 'session validator lost exact subject/session/expiry/audience binding';
  END IF;
END $$;

SELECT 'auth session boundary passed' AS result;
