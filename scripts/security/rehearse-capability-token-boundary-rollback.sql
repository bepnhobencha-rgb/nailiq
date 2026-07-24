\set ON_ERROR_STOP on

-- Restore the exact pre-migration ACL/policy shape in a transaction and prove
-- it before rolling back to the explicit service-role-only boundary.
BEGIN;

DROP POLICY "deny direct API access to party links"
  ON public.party_links;
DROP POLICY "deny direct API access to party link claims"
  ON public.party_link_claims;
DROP POLICY "deny direct API access to party link change requests"
  ON public.party_link_change_requests;
DROP POLICY "deny direct API access to salon invite tokens"
  ON public.salon_invite_tokens;

GRANT ALL PRIVILEGES ON TABLE public.party_links
  TO anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.party_link_claims
  TO anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.party_link_change_requests
  TO anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.salon_invite_tokens
  TO anon, authenticated;

DO $rollback_proof$
DECLARE
  v_table text;
  v_oid oid;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'party_links',
    'party_link_claims',
    'party_link_change_requests',
    'salon_invite_tokens'
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

\ir check-capability-token-boundary.sql
