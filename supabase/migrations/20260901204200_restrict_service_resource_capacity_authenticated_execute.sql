-- Keep the public service-resource capacity projection on the same narrow
-- role boundary as the established public occupancy projection. Public booking
-- uses a stateless anon client; dashboard and automation callers use service
-- role paths. Authenticated browser sessions do not need this definer.

BEGIN;

REVOKE ALL ON FUNCTION public.public_booking_capacity_for_range(
  uuid,
  timestamptz,
  timestamptz
) FROM PUBLIC, authenticated;

GRANT EXECUTE ON FUNCTION public.public_booking_capacity_for_range(
  uuid,
  timestamptz,
  timestamptz
) TO anon, service_role;

COMMIT;
