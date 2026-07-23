-- Add optional client_email to create_public_waitlist_entry RPC.
-- The column already exists (added in 20260520020000); this updates
-- the function signature so the public booking flow can pass an email
-- for waitlist notification when a slot opens.

drop function if exists public.create_public_waitlist_entry(
  uuid, uuid, uuid, date, text, text, text, text
);

create or replace function public.create_public_waitlist_entry(
  p_salon_id            uuid,
  p_service_id          uuid,
  p_staff_id            uuid,
  p_booking_date        date,
  p_preferred_slot_label text,
  p_client_name         text,
  p_client_phone        text,
  p_source              text,
  p_client_email        text default null
)
returns table (id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service_salon uuid;
  v_staff_salon   uuid;
  v_src           text := lower(trim(coalesce(p_source, '')));
begin
  if v_src not in ('slot_unavailable', 'booking_conflict') then
    raise exception 'invalid_waitlist_source';
  end if;

  select s.salon_id into v_service_salon
  from public.services s
  where s.id = p_service_id;

  if v_service_salon is null or v_service_salon <> p_salon_id then
    raise exception 'invalid_service_for_salon';
  end if;

  if p_staff_id is not null then
    select st.salon_id into v_staff_salon
    from public.staff st
    where st.id = p_staff_id;

    if v_staff_salon is null or v_staff_salon <> p_salon_id then
      raise exception 'invalid_staff_for_salon';
    end if;
  end if;

  return query
  insert into public.booking_waitlist_entries (
    salon_id,
    service_id,
    staff_id,
    booking_date,
    preferred_slot_label,
    client_name,
    client_phone,
    client_email,
    source
  )
  values (
    p_salon_id,
    p_service_id,
    p_staff_id,
    p_booking_date,
    nullif(trim(p_preferred_slot_label), ''),
    trim(p_client_name),
    trim(p_client_phone),
    nullif(trim(coalesce(p_client_email, '')), ''),
    v_src
  )
  returning public.booking_waitlist_entries.id;
end;
$$;

grant execute on function public.create_public_waitlist_entry(
  uuid, uuid, uuid, date, text, text, text, text, text
) to anon, authenticated;
