-- Public booking RLS: catalog readable by anon; bookings insert-only via table + RPC (see below).
-- Run in Supabase SQL Editor (or: supabase db push).

-- -----------------------------------------------------------------------------
-- Catalog: public read (anonymous + logged-in clients)
-- -----------------------------------------------------------------------------
alter table public.salons enable row level security;
alter table public.services enable row level security;
alter table public.staff enable row level security;

drop policy if exists "salons_select_public" on public.salons;
create policy "salons_select_public"
  on public.salons
  for select
  to anon, authenticated
  using (true);

drop policy if exists "services_select_public" on public.services;
create policy "services_select_public"
  on public.services
  for select
  to anon, authenticated
  using (true);

drop policy if exists "staff_select_public" on public.staff;
create policy "staff_select_public"
  on public.staff
  for select
  to anon, authenticated
  using (true);

-- -----------------------------------------------------------------------------
-- Bookings: anon may INSERT only; no SELECT / UPDATE / DELETE for anon
-- (Dashboard / admin should use a privileged role or separate policies for staff.)
-- -----------------------------------------------------------------------------
alter table public.bookings enable row level security;

drop policy if exists "bookings_insert_anon" on public.bookings;
create policy "bookings_insert_anon"
  on public.bookings
  for insert
  to anon
  with check (true);

-- Note: PostgREST `insert().select()` requires SELECT on the returned row. With no SELECT
-- policy for anon, use `create_public_booking` below instead of insert+select from the client.

-- Optional hard deny (explicit; default is already deny when no policy matches)
drop policy if exists "bookings_select_anon" on public.bookings;
create policy "bookings_select_anon"
  on public.bookings
  for select
  to anon
  using (false);

drop policy if exists "bookings_update_anon" on public.bookings;
create policy "bookings_update_anon"
  on public.bookings
  for update
  to anon
  using (false)
  with check (false);

drop policy if exists "bookings_delete_anon" on public.bookings;
create policy "bookings_delete_anon"
  on public.bookings
  for delete
  to anon
  using (false);

-- -----------------------------------------------------------------------------
-- RPC: insert a booking and return id + status without granting SELECT on the table
-- -----------------------------------------------------------------------------
create or replace function public.create_public_booking(
  p_salon_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_client_name text,
  p_client_phone text,
  p_start_time_utc timestamptz,
  p_end_time_utc timestamptz,
  p_status text default 'pending'
)
returns table (id uuid, status text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  insert into public.bookings (
    salon_id,
    service_id,
    staff_id,
    client_name,
    client_phone,
    start_time_utc,
    end_time_utc,
    status
  )
  values (
    p_salon_id,
    p_service_id,
    p_staff_id,
    p_client_name,
    p_client_phone,
    p_start_time_utc,
    p_end_time_utc,
    coalesce(nullif(trim(p_status), ''), 'pending')
  )
  returning public.bookings.id, public.bookings.status;
end;
$$;

grant execute on function public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz, text
) to anon, authenticated;

comment on function public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz, text
) is 'Public booking insert with return payload; bypasses RLS inside a controlled DEFINER function.';
