-- client_email_optouts contains a global CASL/CAN-SPAM suppression list.
-- Application reads and HMAC-verified unsubscribe writes already use the
-- server-side service-role client. Remove ineffective legacy direct API grants
-- and make that service-only boundary explicit.

REVOKE ALL PRIVILEGES ON TABLE public.client_email_optouts
  FROM PUBLIC, anon, authenticated;

-- Production has no column ACLs today. Revoke the complete current shape as
-- defense in depth so a restored historical column grant cannot survive.
REVOKE ALL PRIVILEGES (
  email,
  opted_out_at
) ON TABLE public.client_email_optouts
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.client_email_optouts TO service_role;

CREATE POLICY "deny direct API access to email optouts"
  ON public.client_email_optouts
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

DO $proof$
DECLARE
  v_oid oid := 'public.client_email_optouts'::regclass;
BEGIN
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
      AND polname = 'deny direct API access to email optouts'
      AND NOT polpermissive
      AND polcmd = '*'
      AND cardinality(polroles) = 2
      AND polroles @> ARRAY[
        (SELECT oid FROM pg_roles WHERE rolname = 'anon'),
        (SELECT oid FROM pg_roles WHERE rolname = 'authenticated')
      ]::oid[]
      AND pg_get_expr(polqual, polrelid) = 'false'
      AND pg_get_expr(polwithcheck, polrelid) = 'false'
  ) THEN
    RAISE EXCEPTION 'client_email_optouts boundary mismatch';
  END IF;
END
$proof$;
