-- Nail Try-On sessions contain anonymous credential hashes and private object
-- paths; events and cleanup rows are internal telemetry/worker state. Runtime
-- access is server-only through the service role. Preserve that ACL and make
-- the intended RLS boundary explicit.

REVOKE ALL PRIVILEGES ON TABLE public.nail_tryon_cleanup_queue
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.nail_tryon_events
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.nail_tryon_sessions
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.nail_tryon_cleanup_queue TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.nail_tryon_events TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.nail_tryon_sessions TO service_role;

CREATE POLICY "deny direct API access to nail tryon cleanup queue"
  ON public.nail_tryon_cleanup_queue
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to nail tryon events"
  ON public.nail_tryon_events
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to nail tryon sessions"
  ON public.nail_tryon_sessions
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
          'nail_tryon_cleanup_queue',
          'deny direct API access to nail tryon cleanup queue'
        ),
        (
          'nail_tryon_events',
          'deny direct API access to nail tryon events'
        ),
        (
          'nail_tryon_sessions',
          'deny direct API access to nail tryon sessions'
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
      RAISE EXCEPTION 'nail-tryon state boundary mismatch on %',
        v_target.table_name;
    END IF;
  END LOOP;
END
$proof$;
