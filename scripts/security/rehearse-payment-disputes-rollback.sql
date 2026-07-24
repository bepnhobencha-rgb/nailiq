\set ON_ERROR_STOP on

-- Restore the exact pre-migration service-only ACL inside a transaction, prove
-- it, then roll back to the explicit service-only boundary.
BEGIN;

DROP POLICY "deny direct API access to payment disputes"
  ON public.payment_disputes;

REVOKE ALL PRIVILEGES ON TABLE public.payment_disputes
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES (
  id,
  salon_id,
  provider,
  provider_dispute_id,
  payment_ref,
  booking_id,
  client_phone,
  amount_cents,
  currency,
  reason,
  status,
  evidence_due_at,
  raw,
  created_at,
  updated_at
) ON TABLE public.payment_disputes
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.payment_disputes TO service_role;

DO $rollback_proof$
DECLARE
  v_oid oid := 'public.payment_disputes'::regclass;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid = v_oid
  ) OR has_table_privilege(
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
  ) OR EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = v_oid
      AND attnum > 0
      AND NOT attisdropped
      AND attacl IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'payment_disputes rollback did not restore legacy ACL';
  END IF;
END
$rollback_proof$;

ROLLBACK;

\ir check-payment-disputes-boundary.sql
