\set ON_ERROR_STOP on

-- Restore the exact mixed pre-migration ACL inside a transaction:
-- summaries/memberships were service-only, while names/spend still carried
-- ineffective legacy anon/auth grants behind policy-less RLS. Prove that shape,
-- then roll back to the explicit deny-policy boundary.
BEGIN;

DROP POLICY "deny direct API access to client ai summaries"
  ON public.client_ai_summaries;
DROP POLICY "deny direct API access to salon clients"
  ON public.salon_clients;
DROP POLICY "deny direct API access to salon client names"
  ON public.salon_client_names;
DROP POLICY "deny direct API access to salon client spend"
  ON public.salon_client_spend;

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

GRANT ALL PRIVILEGES ON TABLE public.salon_client_names
  TO anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.salon_client_spend
  TO anon, authenticated;

DO $rollback_proof$
DECLARE
  v_table text;
  v_oid oid;
  v_legacy_api_grants boolean;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'client_ai_summaries',
    'salon_clients',
    'salon_client_names',
    'salon_client_spend'
  ]
  LOOP
    SELECT c.oid
      INTO v_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = v_table;

    v_legacy_api_grants :=
      v_table IN ('salon_client_names', 'salon_client_spend');

    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid)
       OR has_table_privilege(
         'anon', v_oid,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       ) <> v_legacy_api_grants
       OR has_table_privilege(
         'authenticated', v_oid,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       ) <> v_legacy_api_grants
       OR has_any_column_privilege(
         'anon', v_oid, 'SELECT,INSERT,UPDATE,REFERENCES'
       ) <> v_legacy_api_grants
       OR has_any_column_privilege(
         'authenticated', v_oid, 'SELECT,INSERT,UPDATE,REFERENCES'
       ) <> v_legacy_api_grants
       OR NOT has_table_privilege(
         'service_role', v_oid,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR EXISTS (
         SELECT 1
         FROM pg_attribute
         WHERE attrelid = v_oid
           AND attnum > 0
           AND NOT attisdropped
           AND attacl IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'rollback did not restore legacy shape on %',
        v_table;
    END IF;
  END LOOP;
END
$rollback_proof$;

ROLLBACK;

\ir check-client-intelligence-boundary.sql
