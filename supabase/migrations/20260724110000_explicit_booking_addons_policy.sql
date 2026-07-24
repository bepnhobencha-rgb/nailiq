-- booking_addons is written only through the audited add_booking_addons
-- SECURITY DEFINER capability and read by server-side service-role loaders.
-- Remove ineffective legacy direct API grants, keep the RPC surface unchanged,
-- and make the intended service-only table boundary explicit.

REVOKE ALL PRIVILEGES ON TABLE public.booking_addons
  FROM PUBLIC, anon, authenticated;

-- No column ACLs exist in production today. Revoke the complete current shape
-- as defense in depth so a restored historical column grant cannot survive.
REVOKE ALL PRIVILEGES (
  id,
  booking_id,
  service_id,
  name,
  price_cents,
  duration_minutes,
  created_at
) ON TABLE public.booking_addons
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.booking_addons TO service_role;

CREATE POLICY "deny direct API access to booking addons"
  ON public.booking_addons
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

DO $proof$
DECLARE
  v_oid oid := 'public.booking_addons'::regclass;
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
      AND polname = 'deny direct API access to booking addons'
      AND NOT polpermissive
      AND polcmd = '*'
      AND cardinality(polroles) = 2
      AND polroles @> ARRAY[
        (SELECT oid FROM pg_roles WHERE rolname = 'anon'),
        (SELECT oid FROM pg_roles WHERE rolname = 'authenticated')
      ]::oid[]
      AND pg_get_expr(polqual, polrelid) = 'false'
      AND pg_get_expr(polwithcheck, polrelid) = 'false'
  ) OR NOT has_function_privilege(
    'anon', 'public.add_booking_addons(uuid,uuid[])', 'EXECUTE'
  ) OR has_function_privilege(
    'authenticated', 'public.add_booking_addons(uuid,uuid[])', 'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role', 'public.add_booking_addons(uuid,uuid[])', 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'booking_addons boundary mismatch';
  END IF;
END
$proof$;
