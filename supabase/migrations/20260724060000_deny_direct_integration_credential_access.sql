-- Integration credentials are server-only. RLS already denied every API row
-- because these tables had no policies, but legacy schema grants still gave
-- anon/authenticated every table privilege. Make the boundary explicit and
-- defense-in-depth without changing service-role integration flows.

REVOKE ALL PRIVILEGES ON TABLE public.square_integrations
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.wix_integrations
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.square_integrations TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.wix_integrations TO service_role;

CREATE POLICY "deny direct API access to Square credentials"
  ON public.square_integrations
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY "deny direct API access to Wix credentials"
  ON public.wix_integrations
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON POLICY "deny direct API access to Square credentials"
  ON public.square_integrations IS
  'Defense-in-depth deny for API roles; Square access tokens are service-role only.';

COMMENT ON POLICY "deny direct API access to Wix credentials"
  ON public.wix_integrations IS
  'Defense-in-depth deny for API roles; Wix API keys are service-role only.';

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
          'square_integrations',
          'deny direct API access to Square credentials'
        ),
        (
          'wix_integrations',
          'deny direct API access to Wix credentials'
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
      'anon',
      v_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR has_table_privilege(
      'authenticated',
      v_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR NOT has_table_privilege(
      'service_role',
      v_oid,
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
      RAISE EXCEPTION 'integration credential boundary mismatch on %',
        v_target.table_name;
    END IF;
  END LOOP;
END
$proof$;
