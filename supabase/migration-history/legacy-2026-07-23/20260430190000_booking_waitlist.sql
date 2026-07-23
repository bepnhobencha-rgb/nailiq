-- Public booking waitlist: single table for (1) no UI slots that day and (2) server conflict on insert.
-- Both flows call `create_public_waitlist_entry` with `p_source` = 'slot_unavailable' | 'booking_conflict'.

create table if not exists public.booking_waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  staff_id uuid references public.staff (id) on delete set null,
  booking_date date not null,
  preferred_slot_label text,
  client_name text not null,
  client_phone text not null,
  source text not null
    check (source in ('slot_unavailable', 'booking_conflict')),
  created_at timestamptz not null default now()
);

create index if not exists booking_waitlist_entries_salon_date_idx
  on public.booking_waitlist_entries (salon_id, booking_date);

alter table public.booking_waitlist_entries enable row level security;

drop policy if exists "booking_waitlist_select_owner" on public.booking_waitlist_entries;
create policy "booking_waitlist_select_owner"
  on public.booking_waitlist_entries
  for select
  to authenticated
  using (
    salon_id in (
      select salon_id from public.salon_members
      where user_id = auth.uid()
    )
  );

-- No INSERT for anon on table; use SECURITY DEFINER RPC below.

create or replace function public.create_public_waitlist_entry(
  p_salon_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_booking_date date,
  p_preferred_slot_label text,
  p_client_name text,
  p_client_phone text,
  p_source text
)
returns table (id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service_salon uuid;
  v_staff_salon uuid;
  v_src text := lower(trim(coalesce(p_source, '')));
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
    v_src
  )
  returning public.booking_waitlist_entries.id;
end;
$$;

grant execute on function public.create_public_waitlist_entry(
  uuid, uuid, uuid, date, text, text, text, text
) to anon, authenticated;

comment on table public.booking_waitlist_entries is
  'Waitlist requests: slot_unavailable (no slots in UI) or booking_conflict (insert/race lost).';
