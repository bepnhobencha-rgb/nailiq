\set ON_ERROR_STOP on

-- Restore the exact pre-migration ACL inside a transaction, prove it, then roll
-- back to the explicit service-only boundary.
BEGIN;

DROP POLICY "deny direct API access to reviews"
  ON public.reviews;

REVOKE ALL PRIVILEGES ON TABLE public.reviews
  FROM PUBLIC, anon, authenticated;
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

GRANT ALL PRIVILEGES ON TABLE public.reviews
  TO anon, authenticated, service_role;
REVOKE SELECT ON TABLE public.reviews
  FROM anon, authenticated;

DO $rollback_proof$
DECLARE
  v_oid oid := 'public.reviews'::regclass;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid = v_oid
  ) OR has_table_privilege('anon', v_oid, 'SELECT')
     OR has_table_privilege('authenticated', v_oid, 'SELECT')
     OR NOT has_table_privilege('anon', v_oid, 'INSERT')
     OR NOT has_table_privilege('anon', v_oid, 'UPDATE')
     OR NOT has_table_privilege('anon', v_oid, 'DELETE')
     OR NOT has_table_privilege('anon', v_oid, 'TRUNCATE')
     OR NOT has_table_privilege('anon', v_oid, 'REFERENCES')
     OR NOT has_table_privilege('anon', v_oid, 'TRIGGER')
     OR NOT has_table_privilege('authenticated', v_oid, 'INSERT')
     OR NOT has_table_privilege('authenticated', v_oid, 'UPDATE')
     OR NOT has_table_privilege('authenticated', v_oid, 'DELETE')
     OR NOT has_table_privilege('authenticated', v_oid, 'TRUNCATE')
     OR NOT has_table_privilege('authenticated', v_oid, 'REFERENCES')
     OR NOT has_table_privilege('authenticated', v_oid, 'TRIGGER')
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
    RAISE EXCEPTION 'reviews rollback did not restore legacy ACL';
  END IF;
END
$rollback_proof$;

ROLLBACK;

\ir check-reviews-boundary.sql
