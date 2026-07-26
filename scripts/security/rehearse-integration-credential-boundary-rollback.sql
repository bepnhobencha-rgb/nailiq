\set ON_ERROR_STOP on

-- Restore the exact pre-migration shape inside a transaction, prove it, then
-- roll it back so the explicit service-role-only boundary remains active.
BEGIN;

DROP POLICY "deny direct API access to Square credentials"
  ON public.square_integrations;
DROP POLICY "deny direct API access to Wix credentials"
  ON public.wix_integrations;

GRANT ALL PRIVILEGES ON TABLE public.square_integrations
  TO anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.wix_integrations
  TO anon, authenticated;

DO $rollback_proof$
DECLARE
  v_table text;
  v_oid oid;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'square_integrations',
    'wix_integrations'
  ]
  LOOP
    SELECT c.oid
      INTO v_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = v_table;

    IF EXISTS (
      SELECT 1 FROM pg_policy WHERE polrelid = v_oid
    ) THEN
      RAISE EXCEPTION 'rollback left a policy on %', v_table;
    END IF;

    IF NOT has_table_privilege(
      'anon',
      v_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR NOT has_table_privilege(
      'authenticated',
      v_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) THEN
      RAISE EXCEPTION 'rollback did not restore legacy grants on %', v_table;
    END IF;
  END LOOP;
END
$rollback_proof$;

ROLLBACK;

\ir check-integration-credential-boundary.sql
