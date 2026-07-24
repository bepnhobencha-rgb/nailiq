\set ON_ERROR_STOP on

-- Restore the exact pre-migration table ACL inside a transaction, prove it,
-- then roll back to the explicit service-only boundary.
BEGIN;

DROP POLICY "deny direct API access to email optouts"
  ON public.client_email_optouts;

REVOKE ALL PRIVILEGES ON TABLE public.client_email_optouts
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES (
  email,
  opted_out_at
) ON TABLE public.client_email_optouts
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.client_email_optouts
  TO anon, authenticated, service_role;

DO $rollback_proof$
DECLARE
  v_oid oid := 'public.client_email_optouts'::regclass;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid = v_oid
  ) OR NOT has_table_privilege(
    'anon', v_oid,
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR NOT has_table_privilege(
    'authenticated', v_oid,
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR NOT has_table_privilege(
    'service_role', v_oid,
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = v_oid
      AND attnum > 0
      AND NOT attisdropped
      AND attacl IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'client_email_optouts rollback did not restore legacy ACL';
  END IF;
END
$rollback_proof$;

ROLLBACK;

\ir check-email-optout-boundary.sql
