-- Flowchart: guest notes + optional add-on on the same booking row.

alter table public.bookings
  add column if not exists client_notes text;

alter table public.bookings
  add column if not exists addon_service_id uuid references public.services (id);

alter table public.bookings
  add column if not exists addon_price_cents integer;

drop function if exists public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz, text, integer
);

create or replace function public.create_public_booking(
  p_salon_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_client_name text,
  p_client_phone text,
  p_start_time_utc timestamptz,
  p_end_time_utc timestamptz,
  p_status text default 'pending',
  p_price_cents integer default null,
  p_client_notes text default null,
  p_addon_service_id uuid default null,
  p_addon_price_cents integer default null
)
returns table (id uuid, status text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_addon_service_id is not null then
    if not exists (
      select 1
      from public.services s
      where s.id = p_addon_service_id
        and s.salon_id = p_salon_id
    ) then
      raise exception 'invalid_addon_service' using errcode = '23514';
    end if;
  end if;

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
    price_cents,
    client_notes,
    addon_service_id,
    addon_price_cents
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
    p_price_cents,
    nullif(trim(p_client_notes), ''),
    p_addon_service_id,
    p_addon_price_cents
  )
  returning public.bookings.id, public.bookings.status;
end;
$$;

grant execute on function public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz, text, integer, text, uuid, integer
) to anon, authenticated;

comment on function public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz, text, integer, text, uuid, integer
) is 'Public booking insert with optional client_notes and single add-on service; validates add-on belongs to salon.';
