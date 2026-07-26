-- client_profiles is a global, phone-keyed customer identity table containing
-- PII and cross-salon intelligence. Runtime access is server-only or through
-- narrowly audited SECURITY DEFINER RPCs. Remove every legacy table/column
-- grant and make the direct-API deny boundary explicit.

REVOKE ALL PRIVILEGES ON TABLE public.client_profiles
  FROM PUBLIC, anon, authenticated;

-- Historical migrations granted INSERT/UPDATE on selected columns. Table-level
-- REVOKE does not remove column ACLs, so enumerate the complete current shape.
REVOKE ALL PRIVILEGES (
  id,
  phone,
  name,
  preferred_staff_id,
  last_service_date,
  visit_count,
  created_at,
  email,
  total_spent_cents,
  notes,
  is_vip,
  updated_at,
  deleted_at,
  no_show_count,
  birthday,
  birthday_voucher_sent_year,
  square_customer_id,
  phone_verified_at,
  date_of_birth,
  marketing_consent_at,
  email_discount_claimed_at,
  marketing_email_consent_at
) ON TABLE public.client_profiles
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.client_profiles TO service_role;

CREATE POLICY "deny direct API access to client profiles"
  ON public.client_profiles
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

DO $proof$
DECLARE
  v_oid oid := 'public.client_profiles'::regclass;
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
      AND polname = 'deny direct API access to client profiles'
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
    RAISE EXCEPTION 'client_profiles boundary mismatch';
  END IF;
END
$proof$;
