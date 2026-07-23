-- Public booking: RPC used by the app + INSERT for authenticated users when RPC is unavailable from cache.
-- Apply via Supabase SQL Editor or `supabase db push`.

-- -----------------------------------------------------------------------------
-- Authenticated clients (e.g. owners testing booking while logged in) need INSERT;
-- legacy migrations only granted INSERT to `anon`.
-- -----------------------------------------------------------------------------
drop policy if exists "bookings_insert_authenticated" on public.bookings;
create policy "bookings_insert_authenticated"
  on public.bookings
  for insert
  to authenticated
  with check (true);

-- -----------------------------------------------------------------------------
-- RPC: insert + return id/status (SECURITY DEFINER). Safe if already applied.
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
