-- H1 (HIGH): get_booking_client_snapshot(text) was an anon, cross-tenant
-- phone→PII oracle (returns name/visit/no-show/VIP for any phone, no salon
-- scope). Add a salon-scoped overload that only recognizes a phone which has
-- actually booked at THIS salon. The public booking flow (submitPublicBooking)
-- is updated to call this overload. The legacy (text) overload is dropped in a
-- follow-up migration AFTER the app deploys (RPC → deploy → drop), so there's
-- no window where booking auto-fill/risk breaks.
CREATE OR REPLACE FUNCTION public.get_booking_client_snapshot(
  p_salon_id uuid,
  p_phone text
)
RETURNS TABLE(visit_count integer, name text, no_show_count integer, is_vip boolean)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select cp.visit_count, cp.name, cp.no_show_count, cp.is_vip
  from public.client_profiles cp
  where cp.phone = p_phone
    and cp.deleted_at is null
    and exists (
      select 1 from public.bookings b
      where b.salon_id = p_salon_id
        and (b.client_profile_id = cp.id or b.client_phone = cp.phone)
    )
  limit 1;
$function$;

REVOKE ALL ON FUNCTION public.get_booking_client_snapshot(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_booking_client_snapshot(uuid, text)
  TO anon, authenticated, service_role;
