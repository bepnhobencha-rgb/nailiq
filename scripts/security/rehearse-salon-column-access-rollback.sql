\set ON_ERROR_STOP on
BEGIN;

DROP FUNCTION public.load_salon_owner_admin_settings(uuid);
DROP FUNCTION public.load_salon_member_operational_profile(uuid);
DROP VIEW public.salon_member_operational_profiles;
GRANT SELECT ON TABLE public.salons TO authenticated;

DO $$
BEGIN
  IF NOT has_table_privilege('authenticated', 'public.salons', 'SELECT')
     OR to_regprocedure(
       'public.load_salon_member_operational_profile(uuid)'
     ) IS NOT NULL
     OR to_regprocedure(
       'public.load_salon_owner_admin_settings(uuid)'
     ) IS NOT NULL
     OR to_regclass(
       'public.salon_member_operational_profiles'
     ) IS NOT NULL
  THEN
    RAISE EXCEPTION 'salon column access down rehearsal did not restore legacy shape';
  END IF;
END $$;

ROLLBACK;

DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.salons', 'SELECT')
     OR to_regprocedure(
       'public.load_salon_member_operational_profile(uuid)'
     ) IS NULL
     OR to_regprocedure(
       'public.load_salon_owner_admin_settings(uuid)'
     ) IS NULL
     OR to_regclass(
       'public.salon_member_operational_profiles'
     ) IS NULL
  THEN
    RAISE EXCEPTION 'salon column access rollback did not restore hardened state';
  END IF;
END $$;

SELECT 'salon column access rollback passed' AS result;
