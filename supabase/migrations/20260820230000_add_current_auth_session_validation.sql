-- MQA-0134 / MQA-0135: immediate revoked-session fence for sensitive actions.
--
-- Supabase access JWTs remain cryptographically valid until exp. Auth removes
-- auth.sessions rows on sign-out/revocation, so callers that need immediate
-- revocation semantics must prove that the JWT's session_id still belongs to
-- the authenticated subject. The function intentionally returns one boolean:
-- it reveals no session metadata and fails closed for malformed claims.

CREATE OR REPLACE FUNCTION public.current_auth_session_is_active()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claims jsonb := auth.jwt();
  v_subject uuid := auth.uid();
  v_session_id uuid;
  v_exp bigint;
  v_now_epoch bigint := floor(extract(epoch FROM statement_timestamp()))::bigint;
BEGIN
  IF v_subject IS NULL
     OR pg_catalog.jsonb_typeof(v_claims) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_claims->'aud') IS DISTINCT FROM 'string'
     OR v_claims->>'aud' IS DISTINCT FROM 'authenticated'
     OR pg_catalog.jsonb_typeof(v_claims->'exp') IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(v_claims->'session_id') IS DISTINCT FROM 'string'
     OR (
       v_claims ? 'is_anonymous'
       AND v_claims->'is_anonymous' IS DISTINCT FROM 'false'::jsonb
     )
     OR coalesce(v_claims->>'session_id', '') !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
  THEN
    RETURN false;
  END IF;

  BEGIN
    v_session_id := (v_claims->>'session_id')::uuid;
    v_exp := (v_claims->>'exp')::bigint;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RETURN false;
  END;

  IF v_exp <= v_now_epoch THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM auth.sessions AS s
    WHERE s.id = v_session_id
      AND s.user_id = v_subject
  );
END;
$$;

COMMENT ON FUNCTION public.current_auth_session_is_active() IS
  'Authenticated-only, no-PII session_id revocation fence for sensitive server actions.';

REVOKE ALL ON FUNCTION public.current_auth_session_is_active() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_auth_session_is_active() FROM anon;
REVOKE ALL ON FUNCTION public.current_auth_session_is_active() FROM service_role;
GRANT EXECUTE ON FUNCTION public.current_auth_session_is_active() TO authenticated;
