-- MQA-0176: VIP recognition is a salon-local relationship attribute.
-- The legacy public.client_profiles.is_vip column remains for rollback/data
-- archaeology only; runtime decisions must use salon_clients.is_vip or this
-- salon's configured spend/visit thresholds.

ALTER TABLE public.salon_clients
  ADD COLUMN IF NOT EXISTS is_vip boolean NOT NULL DEFAULT false;

ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS vip_visit_threshold integer NOT NULL DEFAULT 5;

ALTER TABLE public.salons
  DROP CONSTRAINT IF EXISTS salons_vip_visit_threshold_check;
ALTER TABLE public.salons
  ADD CONSTRAINT salons_vip_visit_threshold_check
  CHECK (vip_visit_threshold BETWEEN 1 AND 1000);

COMMENT ON COLUMN public.salon_clients.is_vip IS
  'Salon-local explicit VIP recognition. Never grants queue, price, cancellation, no-show, availability, or booking priority.';
COMMENT ON COLUMN public.salons.vip_visit_threshold IS
  'Completed salon visits required for VIP Care eligibility. Manual salon VIP or configured bronze spend can also qualify.';
COMMENT ON COLUMN public.client_profiles.is_vip IS
  'Legacy global field retained for rollback only. Not authoritative for runtime VIP decisions after 20260822220330.';

-- These customer-intelligence rows remain server-only. RLS was already
-- enabled by the folded baseline; repeat the boundary so this migration is
-- independently safe on environments with schema drift.
ALTER TABLE public.salon_clients ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.salon_clients
  FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.salon_clients TO service_role;

DROP POLICY IF EXISTS "deny direct API access to salon clients"
  ON public.salon_clients;
CREATE POLICY "deny direct API access to salon clients"
  ON public.salon_clients
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

DO $proof$
DECLARE
  v_oid oid := 'public.salon_clients'::regclass;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = v_oid
      AND attname = 'is_vip'
      AND NOT attisdropped
      AND attnotnull
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE oid = v_oid
      AND relrowsecurity
  ) OR has_table_privilege(
    'anon', v_oid,
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR has_table_privilege(
    'authenticated', v_oid,
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR NOT has_table_privilege(
    'service_role', v_oid,
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_policy
    WHERE polrelid = v_oid
      AND polname = 'deny direct API access to salon clients'
      AND NOT polpermissive
      AND polroles @> ARRAY[
        (SELECT oid FROM pg_roles WHERE rolname = 'anon'),
        (SELECT oid FROM pg_roles WHERE rolname = 'authenticated')
      ]::oid[]
      AND pg_get_expr(polqual, polrelid) = 'false'
      AND pg_get_expr(polwithcheck, polrelid) = 'false'
  ) THEN
    RAISE EXCEPTION 'salon-scoped VIP boundary mismatch';
  END IF;
END
$proof$;
