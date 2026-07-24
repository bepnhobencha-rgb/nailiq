-- reviews contains customer PII, bearer request tokens, and submitted feedback.
-- Public token lookup/submission and salon dashboard reads already run through
-- validated server actions with service-role clients. Remove obsolete direct
-- API write grants and make the service-only base-table boundary explicit.

REVOKE ALL PRIVILEGES ON TABLE public.reviews
  FROM PUBLIC, anon, authenticated;

-- Production has no column ACLs today. Revoke the complete current shape as
-- defense in depth so a restored historical column grant cannot survive.
REVOKE ALL PRIVILEGES (
  id,
  salon_id,
  booking_id,
  staff_id,
  service_id,
  client_phone,
  client_email,
  request_token,
  request_sent_at,
  rating,
  message,
  submitted_at,
  created_at
) ON TABLE public.reviews
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.reviews TO service_role;

CREATE POLICY "deny direct API access to reviews"
  ON public.reviews
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

DO $proof$
DECLARE
  v_oid oid := 'public.reviews'::regclass;
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
      AND polname = 'deny direct API access to reviews'
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
    RAISE EXCEPTION 'reviews boundary mismatch';
  END IF;
END
$proof$;
