-- Fix: include 'in_progress' bookings in the public occupancy filter.
--
-- Without this, slots that a receptionist has marked "Start" (status flips
-- pending|confirmed → in_progress) disappear from the public occupancy list
-- and the public booking page renders them as available. The subsequent
-- INSERT trips the conflict trigger (23P01).
--
-- No signature change; callers and grants are unaffected.
CREATE OR REPLACE FUNCTION public.public_booking_occupancy_for_range(
  p_salon_id uuid,
  p_start timestamptz,
  p_end timestamptz
)
RETURNS TABLE (
  staff_id uuid,
  start_time_utc timestamptz,
  end_time_utc timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select b.staff_id, b.start_time_utc, b.end_time_utc
  from public.bookings b
  where b.salon_id = p_salon_id
    and b.start_time_utc < p_end
    and b.end_time_utc > p_start
    and b.status in ('pending', 'confirmed', 'in_progress')
$function$;
