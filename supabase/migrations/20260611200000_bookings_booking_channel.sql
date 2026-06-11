-- Booking source granularity: distinguish online / square / wix / voice /
-- walkin / desk. The existing `bookings.source` (appointment | walkin | voice)
-- is locked by a CHECK constraint and branched on across the app, so we add a
-- separate `booking_channel` column instead of widening `source`.
alter table public.bookings
  add column if not exists booking_channel text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_booking_channel_check'
  ) then
    alter table public.bookings
      add constraint bookings_booking_channel_check
      check (
        booking_channel is null
        or booking_channel = any (
          array['online', 'square', 'wix', 'voice', 'walkin', 'desk']
        )
      );
  end if;
end $$;

-- Backfill from the strongest available signal. Historical 'appointment' rows
-- without an external id can't be split into online vs desk after the fact, so
-- they default to 'online' (the dominant appointment channel). New bookings are
-- tagged accurately at every write path going forward (desk → 'desk').
update public.bookings
set booking_channel = case
  when square_booking_id is not null then 'square'
  when wix_booking_id is not null then 'wix'
  when source = 'voice' then 'voice'
  when source = 'walkin' then 'walkin'
  else 'online'
end
where booking_channel is null;
