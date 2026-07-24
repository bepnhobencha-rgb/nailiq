\set ON_ERROR_STOP on

DO $check$
DECLARE
  v_oid oid :=
    to_regprocedure('public.salon_has_staff_services(uuid)')::oid;
  v_public_execute boolean;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'salon_has_staff_services(uuid) is missing';
  END IF;

  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'salon_has_staff_services(uuid) must be SECURITY INVOKER';
  END IF;

  IF (SELECT provolatile FROM pg_proc WHERE oid = v_oid) <> 's' THEN
    RAISE EXCEPTION 'salon_has_staff_services(uuid) must remain STABLE';
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
    RAISE EXCEPTION 'salon staff-capability role matrix mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'staff'
      AND policyname = 'members read staff for own salon'
      AND 'authenticated' = ANY(roles)
  ) THEN
    RAISE EXCEPTION
      'authenticated staff visibility is not protected by the salon-membership policy';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.staff', 'SELECT')
     OR NOT has_table_privilege(
       'authenticated',
       'public.staff_services',
       'SELECT'
     )
     OR NOT has_table_privilege(
       'service_role',
       'public.staff_services',
       'SELECT'
     ) THEN
    RAISE EXCEPTION 'invoker roles lack required SELECT privileges';
  END IF;
END
$check$;
