-- Party links and salon invite tokens are bearer capabilities. Every runtime
-- access path resolves them on the server with the service-role client. RLS
-- currently denies API rows because these tables have no allow policies, but
-- legacy grants still leave ambient authority on anon/authenticated. Remove it
-- and make the service-only boundary explicit.

REVOKE ALL PRIVILEGES ON TABLE public.party_links
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.party_link_claims
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.party_link_change_requests
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.salon_invite_tokens
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.party_links TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.party_link_claims TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.party_link_change_requests TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.salon_invite_tokens TO service_role;

CREATE POLICY "deny direct API access to party links"
  ON public.party_links
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to party link claims"
  ON public.party_link_claims
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to party link change requests"
  ON public.party_link_change_requests
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "deny direct API access to salon invite tokens"
  ON public.salon_invite_tokens
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
        ('party_links', 'deny direct API access to party links'),
        ('party_link_claims', 'deny direct API access to party link claims'),
        (
          'party_link_change_requests',
          'deny direct API access to party link change requests'
        ),
        ('salon_invite_tokens', 'deny direct API access to salon invite tokens')
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
      RAISE EXCEPTION 'capability-token boundary mismatch on %',
        v_target.table_name;
    END IF;
  END LOOP;
END
$proof$;
