-- A salon UUID plus a phone number is enumerable public data. Requiring the
-- newly-created, random booking UUID turns this post-booking lookup into a
-- capability-bound read instead of a phone-to-customer-profile oracle.

CREATE FUNCTION public.get_booking_client_snapshot(
  p_salon_id uuid,
  p_phone text,
  p_booking_id uuid
)
RETURNS TABLE(
  visit_count integer,
  name text,
  no_show_count integer,
  is_vip boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT cp.visit_count, cp.name, cp.no_show_count, cp.is_vip
  FROM public.bookings b
  JOIN public.client_profiles cp
    ON cp.deleted_at IS NULL
   AND (b.client_profile_id = cp.id OR b.client_phone = cp.phone)
  WHERE b.id = p_booking_id
    AND b.salon_id = p_salon_id
    AND b.created_at >= now() - interval '10 minutes'
    AND public.canonical_phone(b.client_phone)
        = public.canonical_phone(p_phone)
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.get_booking_client_snapshot(uuid, text, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_booking_client_snapshot(uuid, text, uuid)
  TO anon, authenticated, service_role;

-- Keep the legacy overload only for trusted server operations. Public clients
-- must present the unguessable booking capability to read a snapshot.
REVOKE ALL ON FUNCTION public.get_booking_client_snapshot(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_booking_client_snapshot(uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.get_booking_client_snapshot(uuid, text, uuid) IS
  'Capability-bound recent-booking customer snapshot; prevents public phone enumeration.';
