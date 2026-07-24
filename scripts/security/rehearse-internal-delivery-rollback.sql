\set ON_ERROR_STOP on

-- Restore the exact pre-migration service-only ACL with zero policies inside a
-- transaction, prove it, then roll back to the explicit deny-policy boundary.
BEGIN;

DROP POLICY "deny direct API access to owner notification log"
  ON public.owner_notification_log;
DROP POLICY "deny direct API access to scheduled notifications"
  ON public.scheduled_notifications;
DROP POLICY "deny direct API access to sms agent sessions"
  ON public.sms_agent_sessions;

REVOKE ALL PRIVILEGES ON TABLE public.owner_notification_log
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.scheduled_notifications
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.sms_agent_sessions
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.owner_notification_log TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.scheduled_notifications TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.sms_agent_sessions TO service_role;

DO $rollback_proof$
DECLARE
  v_table text;
  v_oid oid;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'owner_notification_log',
    'scheduled_notifications',
    'sms_agent_sessions'
  ]
  LOOP
    SELECT c.oid
      INTO v_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = v_table;

    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid)
       OR has_table_privilege(
         'anon', v_oid,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR has_table_privilege(
         'authenticated', v_oid,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR has_any_column_privilege(
         'anon', v_oid, 'SELECT,INSERT,UPDATE,REFERENCES'
       )
       OR has_any_column_privilege(
         'authenticated', v_oid, 'SELECT,INSERT,UPDATE,REFERENCES'
       )
       OR NOT has_table_privilege(
         'service_role', v_oid,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       ) THEN
      RAISE EXCEPTION 'rollback did not restore legacy shape on %',
        v_table;
    END IF;
  END LOOP;
END
$rollback_proof$;

ROLLBACK;

\ir check-internal-delivery-boundary.sql
