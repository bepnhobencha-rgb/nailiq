-- Prompt #31: overlap exclusion for bookings (replaces unique-on-start-only).
-- Run in Supabase SQL Editor or via `supabase db push`.

create extension if not exists btree_gist;

alter table public.bookings
  drop constraint if exists bookings_unique_slot;

alter table public.bookings
  add constraint bookings_no_overlap
  exclude using gist (
    salon_id with =,
    staff_id with =,
    tstzrange (start_time_utc, end_time_utc, '[)') with &&
  )
  where (status not in ('cancelled'));
