-- Public booking: expose minimal occupancy for slot conflict checks without granting SELECT on bookings to anon.
-- SECURITY DEFINER returns only staff_id + interval (no client PII).

create or replace function public.public_booking_occupancy_for_range(
  p_salon_id uuid,
  p_start timestamptz,
  p_end timestamptz
)
returns table (
  staff_id uuid,
  start_time_utc timestamptz,
  end_time_utc timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    b.staff_id,
    b.start_time_utc,
    b.end_time_utc
  from public.bookings b
  where b.salon_id = p_salon_id
    and b.start_time_utc < p_end
    and b.end_time_utc > p_start
    and b.status in ('pending', 'confirmed');
$$;

grant execute on function public.public_booking_occupancy_for_range(
  uuid,
  timestamptz,
  timestamptz
) to anon, authenticated;

comment on function public.public_booking_occupancy_for_range(
  uuid,
  timestamptz,
  timestamptz
) is 'Returns booked intervals per staff for overlap checks in public booking UI; no client fields.';
