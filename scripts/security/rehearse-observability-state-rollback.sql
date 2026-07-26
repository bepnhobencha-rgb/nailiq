\set ON_ERROR_STOP on

-- Restore the exact pre-migration ACL/policy shape in a transaction and prove
-- it before rolling back to the explicit service-role-only boundary.
BEGIN;

DROP POLICY "deny direct API access to AI policy decisions"
  ON public.ai_policy_decisions;
DROP POLICY "deny direct API access to system audit"
  ON public.system_audit;
DROP POLICY "deny direct API access to watchdog alerts"
  ON public.watchdog_alerts;
DROP POLICY "deny direct API access to watchdog state"
  ON public.watchdog_state;

GRANT ALL PRIVILEGES ON TABLE public.ai_policy_decisions
  TO anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.system_audit
  TO anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.watchdog_alerts
  TO anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.watchdog_state
  TO anon, authenticated;

DO $rollback_proof$
DECLARE
  v_table text;
  v_oid oid;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'ai_policy_decisions',
    'system_audit',
    'watchdog_alerts',
    'watchdog_state'
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

\ir check-observability-state-boundary.sql
