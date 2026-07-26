\set ON_ERROR_STOP on

-- Restore the exact pre-migration ACL/policy shape in a transaction and prove
-- it before rolling back to the explicit service-role-only boundary.
BEGIN;

DROP POLICY "deny direct API access to campaign schedules"
  ON public.campaign_schedules;
DROP POLICY "deny direct API access to notification templates"
  ON public.notification_templates;
DROP POLICY "deny direct API access to reoptin sends"
  ON public.reoptin_sends;
DROP POLICY "deny direct API access to winback suggestions"
  ON public.winback_suggestions;

GRANT ALL PRIVILEGES ON TABLE public.campaign_schedules
  TO anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.notification_templates
  TO anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.reoptin_sends
  TO anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.winback_suggestions
  TO anon, authenticated;

DO $rollback_proof$
DECLARE
  v_table text;
  v_oid oid;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'campaign_schedules',
    'notification_templates',
    'reoptin_sends',
    'winback_suggestions'
  ]
  LOOP
    SELECT c.oid
      INTO v_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = v_table;

    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid)
       OR NOT has_table_privilege(
         'anon', v_oid,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR NOT has_table_privilege(
         'authenticated', v_oid,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR NOT has_table_privilege(
         'service_role', v_oid,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       ) THEN
      RAISE EXCEPTION 'rollback did not restore the legacy shape on %',
        v_table;
    END IF;
  END LOOP;
END
$rollback_proof$;

ROLLBACK;

\ir check-notification-automation-boundary.sql
