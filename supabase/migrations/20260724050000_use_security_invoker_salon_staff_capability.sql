-- This read-only capability probe does not need to bypass RLS:
-- authenticated callers can see staff only for salons they belong to, while
-- service_role callers retain their existing RLS bypass.

ALTER FUNCTION public.salon_has_staff_services(uuid)
  SECURITY INVOKER;

DO $proof$
DECLARE
  v_oid oid :=
    to_regprocedure('public.salon_has_staff_services(uuid)')::oid;
  v_public_execute boolean;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'salon_has_staff_services(uuid) is missing';
  END IF;

  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'salon_has_staff_services(uuid) is still SECURITY DEFINER';
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
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION
      'salon staff-capability grants are not PUBLIC=false, anon=false, authenticated=true, service_role=true';
  END IF;
END
$proof$;

COMMENT ON FUNCTION public.salon_has_staff_services(uuid) IS
  'Returns whether a salon uses the staff/service capability whitelist. SECURITY INVOKER preserves authenticated tenant RLS; service_role retains its explicit bypass.';
