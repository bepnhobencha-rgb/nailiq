-- The group-slot pre-submit probe belongs to the public booking flow.
-- Its server action now uses the stateless anon client, so an authenticated
-- dashboard session no longer needs (or receives) direct EXECUTE access.

REVOKE ALL ON FUNCTION public.check_group_slots_available(jsonb)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_group_slots_available(jsonb)
  FROM authenticated;

GRANT EXECUTE ON FUNCTION public.check_group_slots_available(jsonb)
  TO anon, service_role;

DO $proof$
DECLARE
  v_oid regprocedure :=
    to_regprocedure('public.check_group_slots_available(jsonb)');
  v_public_execute boolean;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'check_group_slots_available(jsonb) is missing';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM aclexplode(
      COALESCE(
        (SELECT proacl FROM pg_proc WHERE oid = v_oid),
        acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
      )
    )
    WHERE grantee = 0
      AND privilege_type = 'EXECUTE'
  ) INTO v_public_execute;

  IF v_public_execute
     OR NOT has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION
      'group-slot probe grants are not PUBLIC=false, anon=true, authenticated=false, service_role=true';
  END IF;
END
$proof$;

COMMENT ON FUNCTION public.check_group_slots_available(jsonb) IS
  'Public group-booking availability probe. Direct EXECUTE is limited to anon and service_role; authenticated browser sessions use the stateless anon client.';
