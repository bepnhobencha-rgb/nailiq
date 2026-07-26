-- P1 fix (already applied live 2026-06-15): online "any staff" bookings failed
-- with "slot just taken" (create_public_booking → slot_conflict) at salons with
-- completed bookings (e.g., Hi-Lite, Square-synced history).
--
-- ROOT CAUSE: public_booking_occupancy_for_range (drives the client's free-staff
-- resolution) counted only ('pending','confirmed','in_progress') as occupied —
-- it treated 'completed' as FREE. But create_public_booking's overlap check
-- blocks 'completed' (status NOT IN ('cancelled','waiting')). So the client
-- picked a staff whose completed booking overlapped the slot; create then
-- rejected it → slot_conflict → bounced back to "select time".
--
-- FIX: occupancy counts 'completed' too, matching create. Past completed
-- bookings don't overlap future slots, so no legitimate availability is lost;
-- this only stops the client from picking a staff who is genuinely occupied.
CREATE OR REPLACE FUNCTION public.public_booking_occupancy_for_range(p_salon_id uuid, p_start timestamptz, p_end timestamptz)
 RETURNS TABLE(staff_id uuid, start_time_utc timestamptz, end_time_utc timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select b.staff_id, b.start_time_utc, b.end_time_utc
  from public.bookings b
  where b.salon_id = p_salon_id
    and b.start_time_utc < p_end
    and b.end_time_utc > p_start
    and b.status in ('pending', 'confirmed', 'in_progress', 'completed')
$function$;
