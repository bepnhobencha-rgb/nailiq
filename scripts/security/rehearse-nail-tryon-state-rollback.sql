\set ON_ERROR_STOP on

-- Restore the exact pre-migration service-only ACL with zero policies inside a
-- transaction, prove it, then roll back to the explicit deny-policy boundary.
BEGIN;

DROP POLICY "deny direct API access to nail tryon cleanup queue"
  ON public.nail_tryon_cleanup_queue;
DROP POLICY "deny direct API access to nail tryon events"
  ON public.nail_tryon_events;
DROP POLICY "deny direct API access to nail tryon sessions"
  ON public.nail_tryon_sessions;

REVOKE ALL PRIVILEGES ON TABLE public.nail_tryon_cleanup_queue
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.nail_tryon_events
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.nail_tryon_sessions
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.nail_tryon_cleanup_queue TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.nail_tryon_events TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.nail_tryon_sessions TO service_role;

DO $rollback_proof$
DECLARE
  v_table text;
  v_oid oid;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'nail_tryon_cleanup_queue',
    'nail_tryon_events',
    'nail_tryon_sessions'
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

\ir check-nail-tryon-state-boundary.sql
