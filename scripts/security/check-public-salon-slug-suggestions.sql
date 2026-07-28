\set ON_ERROR_STOP on

DO $proof$
DECLARE
  v_oid oid := to_regprocedure(
    'public.suggest_salon_slugs_by_similarity(text)'
  );
  v_definition text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'suggest_salon_slugs_by_similarity(text) is missing';
  END IF;

  SELECT pg_get_functiondef(v_oid) INTO v_definition;

  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
    OR position('public.public_salon_profiles' IN v_definition) = 0
    OR position('extensions.similarity' IN v_definition) = 0
    OR position('LIMIT 3' IN v_definition) = 0
    OR EXISTS (
      SELECT 1
      FROM aclexplode(
        coalesce(
          (SELECT proacl FROM pg_proc WHERE oid = v_oid),
          acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
        )
      )
      WHERE grantee = 0
        AND privilege_type = 'EXECUTE'
    )
    OR NOT has_function_privilege('anon', v_oid, 'EXECUTE')
    OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
    OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'public salon slug suggestion boundary mismatch';
  END IF;
END
$proof$;
