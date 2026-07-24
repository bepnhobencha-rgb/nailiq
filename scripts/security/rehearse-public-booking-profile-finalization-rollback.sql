\set ON_ERROR_STOP on

BEGIN;

DROP FUNCTION public.finalize_public_booking_profile(uuid, uuid, boolean);

DO $check$
BEGIN
  IF to_regprocedure(
    'public.finalize_public_booking_profile(uuid,uuid,boolean)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'rollback left finalize_public_booking_profile installed';
  END IF;
END
$check$;

ROLLBACK;

\ir check-public-booking-profile-finalization.sql
