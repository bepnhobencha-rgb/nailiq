-- Restore the public salon-slug suggestion capability after the production
-- schema fold. The legacy history contains this function under a duplicate
-- migration timestamp, but the folded production snapshot does not contain
-- the function. Use the booking-safe view instead of reopening public access
-- to the tenant-owned salons table.

CREATE OR REPLACE FUNCTION public.suggest_salon_slugs_by_similarity(
  p_input text
)
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'extensions'
AS $function$
  SELECT profile.slug::text
  FROM public.public_salon_profiles AS profile
  WHERE coalesce(trim(p_input), '') <> ''
    AND length(trim(p_input)) BETWEEN 2 AND 63
    AND extensions.similarity(
      lower(trim(profile.slug::text)),
      lower(trim(p_input))
    ) > 0.12::float
  ORDER BY
    extensions.similarity(
      lower(trim(profile.slug::text)),
      lower(trim(p_input))
    ) DESC,
    length(profile.slug::text) ASC,
    profile.slug::text ASC
  LIMIT 3;
$function$;

REVOKE ALL ON FUNCTION public.suggest_salon_slugs_by_similarity(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.suggest_salon_slugs_by_similarity(text)
  TO anon, service_role;

COMMENT ON FUNCTION public.suggest_salon_slugs_by_similarity(text) IS
  'Returns at most three typo suggestions from the booking-safe public salon profile surface.';

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
