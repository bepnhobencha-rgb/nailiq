-- Verification decisions expose customer risk signals and are called only by
-- NailIQ's server-side API. The legacy OTP confirmer is also server-only.
alter function public.determine_booking_verification(uuid, text, uuid[], integer)
  set search_path = public, pg_catalog;
alter function public.determine_booking_verification(uuid, text, uuid[], integer, boolean)
  set search_path = public, pg_catalog;
alter function public.confirm_booking_with_otp(uuid, uuid)
  set search_path = public, pg_catalog;

revoke execute on function public.determine_booking_verification(uuid, text, uuid[], integer)
  from public, anon, authenticated;
revoke execute on function public.determine_booking_verification(uuid, text, uuid[], integer, boolean)
  from public, anon, authenticated;
revoke execute on function public.confirm_booking_with_otp(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.determine_booking_verification(uuid, text, uuid[], integer)
  to service_role;
grant execute on function public.determine_booking_verification(uuid, text, uuid[], integer, boolean)
  to service_role;
grant execute on function public.confirm_booking_with_otp(uuid, uuid)
  to service_role;
