\set ON_ERROR_STOP on

-- Restore the exact pre-migration ACL inside a transaction, prove it, then
-- roll back to the explicit service-only boundary.
BEGIN;

DROP POLICY "deny direct API access to client profiles"
  ON public.client_profiles;

REVOKE ALL PRIVILEGES ON TABLE public.client_profiles
  FROM PUBLIC, anon, authenticated;
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

GRANT DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.client_profiles TO anon, authenticated;
GRANT INSERT (
  phone,
  name,
  preferred_staff_id,
  last_service_date,
  visit_count
) ON TABLE public.client_profiles TO anon, authenticated;
GRANT UPDATE (
  name,
  preferred_staff_id,
  last_service_date,
  visit_count
) ON TABLE public.client_profiles TO anon, authenticated;

DO $rollback_proof$
DECLARE
  v_oid oid := 'public.client_profiles'::regclass;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid = v_oid
  ) OR NOT has_table_privilege(
    'anon', v_oid, 'DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR NOT has_table_privilege(
    'authenticated', v_oid, 'DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR has_table_privilege(
    'anon', v_oid, 'SELECT,INSERT,UPDATE'
  ) OR has_table_privilege(
    'authenticated', v_oid, 'SELECT,INSERT,UPDATE'
  ) OR NOT has_column_privilege(
    'anon', v_oid, 'phone', 'INSERT'
  ) OR NOT has_column_privilege(
    'authenticated', v_oid, 'visit_count', 'UPDATE'
  ) OR has_column_privilege(
    'anon', v_oid, 'email', 'INSERT'
  ) OR has_column_privilege(
    'authenticated', v_oid, 'phone_verified_at', 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'client_profiles rollback did not restore legacy ACL';
  END IF;
END
$rollback_proof$;

ROLLBACK;

\ir check-client-profile-boundary.sql
