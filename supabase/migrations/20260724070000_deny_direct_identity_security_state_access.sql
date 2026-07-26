-- OTP, authentication telemetry, and rate-limit state are server-only.
-- RLS currently denies API rows because these tables have no allow policies,
-- but several retain legacy grants. Remove that ambient authority and add an
-- explicit deny so a later permissive policy cannot accidentally expose them.

REVOKE ALL PRIVILEGES ON TABLE public.auth_events
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.email_otp_codes
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.phone_otp_sessions
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.otp_send_log
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.rate_limits
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.auth_events TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.email_otp_codes TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.phone_otp_sessions TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.otp_send_log TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.rate_limits TO service_role;

CREATE POLICY "deny direct API access to authentication events"
  ON public.auth_events
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to email OTP codes"
  ON public.email_otp_codes
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to phone OTP sessions"
  ON public.phone_otp_sessions
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to OTP send logs"
  ON public.otp_send_log
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to rate limit state"
  ON public.rate_limits
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

DO $proof$
DECLARE
  v_target record;
  v_oid oid;
BEGIN
  FOR v_target IN
    SELECT *
    FROM (
      VALUES
        ('auth_events', 'deny direct API access to authentication events'),
        ('email_otp_codes', 'deny direct API access to email OTP codes'),
        ('phone_otp_sessions', 'deny direct API access to phone OTP sessions'),
        ('otp_send_log', 'deny direct API access to OTP send logs'),
        ('rate_limits', 'deny direct API access to rate limit state')
    ) AS expected(table_name, policy_name)
  LOOP
    SELECT c.oid
      INTO v_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = v_target.table_name
      AND c.relkind = 'r';

    IF has_table_privilege(
      'anon', v_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR has_table_privilege(
      'authenticated', v_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR has_any_column_privilege(
      'anon', v_oid, 'SELECT,INSERT,UPDATE,REFERENCES'
    ) OR has_any_column_privilege(
      'authenticated', v_oid, 'SELECT,INSERT,UPDATE,REFERENCES'
    ) OR NOT has_table_privilege(
      'service_role', v_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_policy
      WHERE polrelid = v_oid
        AND polname = v_target.policy_name
        AND NOT polpermissive
        AND pg_get_expr(polqual, polrelid) = 'false'
        AND pg_get_expr(polwithcheck, polrelid) = 'false'
    ) THEN
      RAISE EXCEPTION 'identity/security state boundary mismatch on %',
        v_target.table_name;
    END IF;
  END LOOP;
END
$proof$;
