-- Client summaries, salon membership links, display-name overrides, and spend
-- aggregates contain tenant-scoped customer intelligence. Runtime access is
-- server-only through the service role. Remove legacy API grants and make the
-- intended RLS boundary explicit.

REVOKE ALL PRIVILEGES ON TABLE public.client_ai_summaries
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.salon_clients
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.salon_client_names
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.salon_client_spend
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.client_ai_summaries TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.salon_clients TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.salon_client_names TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.salon_client_spend TO service_role;

CREATE POLICY "deny direct API access to client ai summaries"
  ON public.client_ai_summaries
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to salon clients"
  ON public.salon_clients
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to salon client names"
  ON public.salon_client_names
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to salon client spend"
  ON public.salon_client_spend
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
          'client_ai_summaries',
          'deny direct API access to client ai summaries'
        ),
        (
          'salon_clients',
          'deny direct API access to salon clients'
        ),
        (
          'salon_client_names',
          'deny direct API access to salon client names'
        ),
        (
          'salon_client_spend',
          'deny direct API access to salon client spend'
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
      RAISE EXCEPTION 'client-intelligence boundary mismatch on %',
        v_target.table_name;
    END IF;
  END LOOP;
END
$proof$;
