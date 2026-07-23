-- Prompt #26: prevent double-booking on same slot + price snapshot column.
-- Apply via Supabase SQL Editor or `supabase db push`.

alter table public.bookings
  add column if not exists price_cents integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'bookings_unique_slot'
  ) then
    alter table public.bookings
      add constraint bookings_unique_slot
      unique (salon_id, staff_id, start_time_utc);
  end if;
end $$;

drop function if exists public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz, text);

create or replace function public.create_public_booking(
  p_salon_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_client_name text,
  p_client_phone text,
  p_start_time_utc timestamptz,
  p_end_time_utc timestamptz,
  p_status text default 'pending',
  p_price_cents integer default null
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
    status,
    price_cents
  )
  values (
    p_salon_id,
    p_service_id,
    p_staff_id,
    p_client_name,
    p_client_phone,
    p_start_time_utc,
    p_end_time_utc,
    coalesce(nullif(trim(p_status), ''), 'pending'),
    p_price_cents
  )
  returning public.bookings.id, public.bookings.status;
end;
$$;

grant execute on function public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz, text, integer
) to anon, authenticated;

comment on function public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz, text, integer
) is 'Public booking insert with return payload; stores optional price_cents snapshot; bypasses RLS inside a controlled DEFINER function.';
