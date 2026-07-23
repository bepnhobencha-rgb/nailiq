-- Legacy queue insertion is no longer used by NailIQ. Keep it available to the
-- backend for rollback compatibility, but remove the public PostgREST surface.
revoke execute on function public.add_queue_entry(uuid, text, text, uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.add_queue_entry(uuid, text, text, uuid, uuid, text, integer)
  to service_role;

-- The public booking flow attaches add-ons immediately after creating a
-- cryptographically-random booking UUID. Keep that capability while preventing
-- replay, late modification, duplicate rows, and oversized payloads.
create or replace function public.add_booking_addons(
  p_booking_id uuid,
  p_service_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_salon_id uuid;
  v_created_at timestamptz;
  v_status text;
  v_count integer := 0;
begin
  if p_service_ids is null or cardinality(p_service_ids) = 0 then
    return 0;
  end if;

  if cardinality(p_service_ids) > 8 then
    raise exception 'Too many booking add-ons' using errcode = '22023';
  end if;

  -- The row lock serializes repeated calls for the same booking so the
  -- NOT EXISTS guard below cannot race and create duplicates.
  select b.salon_id, b.created_at, b.status
    into v_salon_id, v_created_at, v_status
  from public.bookings b
  where b.id = p_booking_id
  for update;

  if v_salon_id is null
     or v_created_at < now() - interval '15 minutes'
     or v_status in ('cancelled', 'completed', 'no_show') then
    return 0;
  end if;

  insert into public.booking_addons (
    booking_id,
    service_id,
    name,
    price_cents,
    duration_minutes
  )
  select
    p_booking_id,
    s.id,
    s.name,
    s.price_cents,
    coalesce(s.duration_minutes, 0) + coalesce(s.buffer_minutes, 0)
  from public.services s
  join (
    select requested.service_id, min(requested.ord) as ord
    from unnest(p_service_ids) with ordinality as requested(service_id, ord)
    group by requested.service_id
  ) requested on requested.service_id = s.id
  where s.salon_id = v_salon_id
    and s.is_addon = true
    and s.deleted_at is null
    and not exists (
      select 1
      from public.booking_addons existing
      where existing.booking_id = p_booking_id
        and existing.service_id = s.id
    )
  order by requested.ord;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.add_booking_addons(uuid, uuid[]) from public;
grant execute on function public.add_booking_addons(uuid, uuid[])
  to anon, authenticated, service_role;
