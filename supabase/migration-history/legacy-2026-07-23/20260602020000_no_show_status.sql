-- No-show tracking. A 'no_show' booking = a confirmed/in-progress appointment whose customer
-- didn't attend. Terminal (like cancelled): it must NOT hold the slot, and it feeds the client's
-- no_show_count which drives the no-show risk engine (and the Wix smart auto-approve).

-- 1. Allow 'no_show' in the booking status enum.
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check check (
  status in ('pending', 'confirmed', 'completed', 'cancelled', 'waiting', 'in_progress', 'no_show')
);

-- 2. A no-show frees its slot — widen the overlap exclusion (was: exclude only 'cancelled').
alter table public.bookings drop constraint if exists bookings_no_overlap;
alter table public.bookings add constraint bookings_no_overlap
  exclude using gist (
    salon_id with =,
    staff_id with =,
    tstzrange(start_time_utc, end_time_utc, '[)') with &&
  ) where (status not in ('cancelled', 'no_show'));

-- 3. Atomic, RLS-safe increment of a client's lifetime no-show count (client_profiles is global).
create or replace function public.bump_client_no_show(p_phone text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.client_profiles
     set no_show_count = coalesce(no_show_count, 0) + 1,
         updated_at = now()
   where phone = p_phone;
$$;
