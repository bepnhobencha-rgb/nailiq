-- Owner alert audit rows, durable staff-action notifications, and SMS-agent
-- conversation state are internal delivery state. Every runtime access uses a
-- server-side service-role client. Keep the existing service-only ACL and add
-- explicit restrictive policies so the intended RLS boundary is auditable.

REVOKE ALL PRIVILEGES ON TABLE public.owner_notification_log
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.scheduled_notifications
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.sms_agent_sessions
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.owner_notification_log TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.scheduled_notifications TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.sms_agent_sessions TO service_role;

CREATE POLICY "deny direct API access to owner notification log"
  ON public.owner_notification_log
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to scheduled notifications"
  ON public.scheduled_notifications
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to sms agent sessions"
  ON public.sms_agent_sessions
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
          'owner_notification_log',
          'deny direct API access to owner notification log'
        ),
        (
          'scheduled_notifications',
          'deny direct API access to scheduled notifications'
        ),
        (
          'sms_agent_sessions',
          'deny direct API access to sms agent sessions'
        )
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
      RAISE EXCEPTION 'internal-delivery boundary mismatch on %',
        v_target.table_name;
    END IF;
  END LOOP;
END
$proof$;
