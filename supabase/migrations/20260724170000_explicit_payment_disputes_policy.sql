-- payment_disputes contains sensitive financial, provider, booking, and client
-- data. Webhooks and owner/admin dashboard actions already use server-side
-- service-role clients. Preserve that service-only boundary and make the
-- intentional direct API denial explicit.

REVOKE ALL PRIVILEGES ON TABLE public.payment_disputes
  FROM PUBLIC, anon, authenticated;

-- Production has no column ACLs today. Revoke the complete current shape as
-- defense in depth so a restored historical column grant cannot survive.
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

CREATE POLICY "deny direct API access to payment disputes"
  ON public.payment_disputes
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

DO $proof$
DECLARE
  v_oid oid := 'public.payment_disputes'::regclass;
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
      AND polname = 'deny direct API access to payment disputes'
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
    RAISE EXCEPTION 'payment_disputes boundary mismatch';
  END IF;
END
$proof$;
