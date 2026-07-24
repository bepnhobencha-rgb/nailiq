-- AI policy decisions, system audit rows, and watchdog state are internal
-- operational records. Every runtime access path is server-only and uses the
-- service-role client. RLS currently denies API rows because these tables have
-- no allow policies, but legacy grants still leave ambient authority on
-- anon/authenticated. Remove it and make the service-only boundary explicit.

REVOKE ALL PRIVILEGES ON TABLE public.ai_policy_decisions
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.system_audit
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.watchdog_alerts
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.watchdog_state
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.ai_policy_decisions TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.system_audit TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.watchdog_alerts TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.watchdog_state TO service_role;

CREATE POLICY "deny direct API access to AI policy decisions"
  ON public.ai_policy_decisions
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to system audit"
  ON public.system_audit
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to watchdog alerts"
  ON public.watchdog_alerts
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to watchdog state"
  ON public.watchdog_state
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
        (
          'ai_policy_decisions',
          'deny direct API access to AI policy decisions'
        ),
        ('system_audit', 'deny direct API access to system audit'),
        ('watchdog_alerts', 'deny direct API access to watchdog alerts'),
        ('watchdog_state', 'deny direct API access to watchdog state')
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
      RAISE EXCEPTION 'observability-state boundary mismatch on %',
        v_target.table_name;
    END IF;
  END LOOP;
END
$proof$;
