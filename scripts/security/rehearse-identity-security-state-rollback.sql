\set ON_ERROR_STOP on

-- Restore the exact pre-migration ACL/policy shape in a transaction and prove
-- it before rolling back to the explicit service-role-only boundary.
BEGIN;

DROP POLICY "deny direct API access to authentication events"
  ON public.auth_events;
DROP POLICY "deny direct API access to email OTP codes"
  ON public.email_otp_codes;
DROP POLICY "deny direct API access to phone OTP sessions"
  ON public.phone_otp_sessions;
DROP POLICY "deny direct API access to OTP send logs"
  ON public.otp_send_log;
DROP POLICY "deny direct API access to rate limit state"
  ON public.rate_limits;

GRANT ALL PRIVILEGES ON TABLE public.auth_events TO anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.email_otp_codes TO anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.phone_otp_sessions TO authenticated;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.phone_otp_sessions TO anon;

DO $rollback_proof$
DECLARE
  v_target text;
  v_oid oid;
BEGIN
  FOREACH v_target IN ARRAY ARRAY[
    'auth_events',
    'email_otp_codes',
    'phone_otp_sessions',
    'otp_send_log',
    'rate_limits'
  ]
  LOOP
    SELECT c.oid
      INTO v_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = v_target;

    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid) THEN
      RAISE EXCEPTION 'rollback left a policy on %', v_target;
    END IF;
  END LOOP;

  IF NOT has_table_privilege(
    'anon', 'public.auth_events',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR NOT has_table_privilege(
    'authenticated', 'public.auth_events',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR NOT has_table_privilege(
    'anon', 'public.email_otp_codes',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR NOT has_table_privilege(
    'authenticated', 'public.email_otp_codes',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR has_table_privilege(
    'anon', 'public.phone_otp_sessions', 'SELECT'
  ) OR NOT has_table_privilege(
    'anon', 'public.phone_otp_sessions',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR NOT has_table_privilege(
    'authenticated', 'public.phone_otp_sessions',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR has_table_privilege(
    'anon', 'public.otp_send_log',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR has_table_privilege(
    'authenticated', 'public.otp_send_log',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR has_table_privilege(
    'anon', 'public.rate_limits',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR has_table_privilege(
    'authenticated', 'public.rate_limits',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) THEN
    RAISE EXCEPTION 'rollback did not restore the production ACL shape';
  END IF;
END
$rollback_proof$;

ROLLBACK;

\ir check-identity-security-state-boundary.sql
