-- create_public_booking v2.9 — bed auto-assign AND profile link, together.
--
-- History (why this file exists):
--   20260610130000  v2.6  14-arg, accepts p_resource_id.
--   20260610140000  v2.7  14-arg, auto-assigns a free bed. Did NOT call
--                         resolve_client_profile — that function did not exist yet.
--   20260614110000  v2.8  13-arg, adds resolve_client_profile. Created a SECOND
--                         overload rather than replacing the first: prod now had
--                         both a 13-arg and a 14-arg create_public_booking, and
--                         PostgREST resolved 13 named args to the 14-arg one. So
--                         every online booking got a bed but no client_profile_id.
--   20260622030000  HOTFIX dropped the 14-arg to stop the profile-id bleed. That
--                         restored the profile link and silently removed bed
--                         auto-assign — the two fixes were never merged.
--
-- Net effect since 2026-06-22: online bookings at Hi-Lite carry resource_id = NULL.
-- A bed only appears when a human touches the booking at the desk (the TS path in
-- resolveResource.ts). Group bookings were never wired at all (insert_group_bookings
-- still has no resource param) and are NOT addressed here.
--
-- This migration merges v2.7's resource logic into v2.8's body. Nothing else about
-- v2.8 changes: same validation order, same error codes, same 'confirmed' status,
-- same resolve_client_profile call in the same place.
--
-- Overload safety: the 13-arg is DROPped, not replaced — a 14-arg CREATE alongside
-- it is exactly the two-overload state that caused the June bug. The DO block at the
-- bottom fails the migration if more than one overload survives.
--
-- Blast radius: the resource block is gated on salons.resources_enabled. Only the two
-- Hi-Lite salons have it true; every other salon takes v_res_enabled = false and
-- behaves exactly as it does today.

DROP FUNCTION IF EXISTS public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz, text, integer, text, uuid, integer, text
);
DROP FUNCTION IF EXISTS public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz, text, integer, text, uuid, integer, text, uuid
);

CREATE FUNCTION public.create_public_booking(
  p_salon_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_client_name text,
  p_client_phone text,
  p_start_time_utc timestamptz,
  p_end_time_utc timestamptz,
  p_status text DEFAULT 'pending',
  p_price_cents integer DEFAULT NULL,
  p_client_notes text DEFAULT NULL,
  p_addon_service_id uuid DEFAULT NULL,
  p_addon_price_cents integer DEFAULT NULL,
  p_client_email text DEFAULT NULL,
  p_resource_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_booking_id uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_hours jsonb;
  v_closed_dates jsonb;
  v_tz_raw text;
  v_tz text;
  v_start_local timestamp;
  v_end_local timestamp;
  v_dow numeric;
  v_day text;
  v_day_cfg jsonb;
  v_ymd text;
  v_open time;
  v_close time;
  v_booking_time time;
  v_end_booking_time time;
  v_phone_trim text;
  v_digits text;
  v_email text;
  v_profile_id uuid;
  v_res_enabled boolean;
  v_resource_id uuid;
begin
  raise notice 'create_public_booking v2.9 (resource auto-assign + profile link)';

  v_resource_id := p_resource_id;

  if p_client_name is null or length(trim(p_client_name)) = 0 then
    raise exception 'missing_client_name' using errcode = 'P0001';
  end if;

  v_phone_trim := trim(coalesce(p_client_phone, ''));
  if v_phone_trim = '' then
    raise exception 'missing_phone' using errcode = 'P0001';
  end if;

  v_digits := regexp_replace(v_phone_trim, '\D', '', 'g');
  if length(v_digits) < 7 then
    raise exception 'missing_phone' using errcode = 'P0001';
  end if;

  v_email := nullif(trim(coalesce(p_client_email, '')), '');

  if p_start_time_utc is null or p_end_time_utc is null then
    raise exception 'invalid_time' using errcode = 'P0001';
  end if;

  if p_start_time_utc >= p_end_time_utc then
    raise exception 'invalid_time' using errcode = 'P0001';
  end if;

  if p_start_time_utc < (clock_timestamp() + interval '2 minutes') then
    raise exception 'invalid_time' using errcode = 'P0001';
  end if;

  select
    s.opening_hours,
    coalesce(s.booking_closed_dates, '[]'::jsonb),
    coalesce(nullif(trim(s.timezone), ''), 'America/Los_Angeles'),
    coalesce(s.resources_enabled, false)
  into v_hours, v_closed_dates, v_tz_raw, v_res_enabled
  from public.salons s
  where s.id = p_salon_id;

  if not found then
    raise exception 'invalid_reference' using errcode = 'P0001';
  end if;

  if exists (select 1 from pg_timezone_names n where n.name = v_tz_raw) then
    v_tz := v_tz_raw;
  else
    v_tz := 'America/Los_Angeles';
  end if;

  if v_hours is null or v_hours = '{}'::jsonb then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.services sv
    where sv.id = p_service_id and sv.salon_id = p_salon_id
  ) then
    raise exception 'invalid_reference' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.staff st
    where st.id = p_staff_id and st.salon_id = p_salon_id
  ) then
    raise exception 'invalid_reference' using errcode = 'P0001';
  end if;

  -- An explicitly passed bed must belong to this salon and still exist.
  -- Liveness is deleted_at, not status: an inactive-but-not-deleted bed the
  -- desk deliberately picked is still a valid target.
  if v_resource_id is not null then
    if not exists (
      select 1 from public.salon_resources r
      where r.id = v_resource_id and r.salon_id = p_salon_id and r.deleted_at is null
    ) then
      raise exception 'invalid_reference' using errcode = 'P0001';
    end if;
  end if;

  if p_addon_service_id is not null then
    if not exists (
      select 1 from public.services s
      where s.id = p_addon_service_id and s.salon_id = p_salon_id
    ) then
      raise exception 'invalid_reference' using errcode = 'P0001';
    end if;
  end if;

  v_start_local := p_start_time_utc at time zone v_tz;
  v_end_local := p_end_time_utc at time zone v_tz;

  if date(v_start_local) <> date(v_end_local) then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  v_ymd := to_char(v_start_local, 'YYYY-MM-DD');
  if jsonb_typeof(v_closed_dates) = 'array'
     and exists (
       select 1 from jsonb_array_elements_text(v_closed_dates) as el(t)
       where el.t = v_ymd
     ) then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  v_dow := extract(dow from v_start_local);

  case v_dow::int
    when 0 then v_day := 'sun';
    when 1 then v_day := 'mon';
    when 2 then v_day := 'tue';
    when 3 then v_day := 'wed';
    when 4 then v_day := 'thu';
    when 5 then v_day := 'fri';
    when 6 then v_day := 'sat';
    else raise exception 'outside_hours' using errcode = 'P0001';
  end case;

  if (v_hours -> v_day) is null then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  if jsonb_typeof(v_hours -> v_day) <> 'object' then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  v_day_cfg := v_hours -> v_day;

  if (v_day_cfg -> 'closed') is not null and (v_day_cfg -> 'closed')::text = 'true' then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  if v_day_cfg->>'open' is null or v_day_cfg->>'close' is null
    or trim(v_day_cfg->>'open') = '' or trim(v_day_cfg->>'close') = '' then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  v_open := (v_day_cfg->>'open')::time;
  v_close := (v_day_cfg->>'close')::time;

  if v_close <= v_open then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  v_booking_time := (p_start_time_utc at time zone v_tz)::time;
  v_end_booking_time := (p_end_time_utc at time zone v_tz)::time;

  if v_booking_time < v_open or v_booking_time >= v_close then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  if v_end_booking_time > v_close or v_end_booking_time <= v_booking_time then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(
    hashtext(p_salon_id::text || chr(255) || p_staff_id::text)::bigint
  );

  if exists (
    select 1 from public.bookings b
    where b.salon_id = p_salon_id
      and b.staff_id = p_staff_id
      and b.status not in ('cancelled', 'waiting')
      and b.start_time_utc < p_end_time_utc
      and b.end_time_utc > p_start_time_utc
    limit 1
  ) then
    raise exception 'slot_conflict' using errcode = '23P01';
  end if;

  -- Resource mode: pick the lowest-ordered free bed when the caller didn't name one.
  -- SECURITY DEFINER is what makes this possible on the public path — anon cannot
  -- read bookings under RLS, so the pick has to happen inside the function.
  -- Bed order is display_order, so "Bed 1" fills before "Bed 2" and the room fills
  -- predictably rather than scattering guests.
  if v_resource_id is null and v_res_enabled then
    select r.id into v_resource_id
    from public.salon_resources r
    where r.salon_id = p_salon_id
      and r.status = 'active'
      and r.deleted_at is null
      and not exists (
        select 1 from public.bookings b
        where b.salon_id = p_salon_id
          and b.resource_id = r.id
          and b.status not in ('cancelled', 'waiting', 'no_show')
          and b.start_time_utc < p_end_time_utc
          and b.end_time_utc > p_start_time_utc
      )
    order by r.display_order asc
    limit 1;

    -- resources_enabled means a bed is required to serve the guest, so no free bed
    -- is a real conflict, not a booking we should accept and sort out later.
    if v_resource_id is null then
      raise exception 'slot_conflict' using errcode = '23P01';
    end if;
  end if;

  -- Bed overlap pre-check, covering both an explicit and an auto-picked bed.
  -- chr(254) keeps this lock namespace distinct from the staff lock's chr(255).
  -- Always taken AFTER the staff lock so every caller orders the two the same way.
  if v_resource_id is not null then
    perform pg_advisory_xact_lock(
      hashtext(p_salon_id::text || chr(254) || v_resource_id::text)::bigint
    );

    if exists (
      select 1 from public.bookings b
      where b.salon_id = p_salon_id
        and b.resource_id = v_resource_id
        and b.status not in ('cancelled', 'waiting', 'no_show')
        and b.start_time_utc < p_end_time_utc
        and b.end_time_utc > p_start_time_utc
      limit 1
    ) then
      raise exception 'slot_conflict' using errcode = '23P01';
    end if;
  end if;

  begin
    insert into public.bookings (
      salon_id, service_id, staff_id, resource_id, client_name, client_phone, client_email,
      start_time_utc, end_time_utc, status, price_cents, client_notes,
      addon_service_id, addon_price_cents
    )
    values (
      p_salon_id, p_service_id, p_staff_id, v_resource_id, trim(p_client_name), v_digits, v_email,
      p_start_time_utc, p_end_time_utc, 'confirmed', p_price_cents,
      nullif(trim(p_client_notes), ''), p_addon_service_id, p_addon_price_cents
    )
    returning public.bookings.id, public.bookings.start_time_utc, public.bookings.end_time_utc
    into v_booking_id, v_start, v_end;
  exception
    when exclusion_violation then
      return jsonb_build_object('success', false, 'code', 'slot_conflict');
    when unique_violation then
      return jsonb_build_object('success', false, 'code', 'duplicate_booking');
    when check_violation then
      return jsonb_build_object('success', false, 'code', 'invalid_email');
  end;

  -- Resolve/refresh the customer identity and stamp the durable FK. Runs only
  -- on a successful insert, so a conflicting booking never bumps visit_count.
  v_profile_id := public.resolve_client_profile(v_digits, p_client_name, v_email, p_staff_id);
  if v_profile_id is not null then
    update public.bookings set client_profile_id = v_profile_id where id = v_booking_id;
  end if;

  return jsonb_build_object(
    'success', true,
    'booking_id', v_booking_id,
    'start_time_utc', v_start,
    'end_time_utc', v_end
  );

exception
  when exclusion_violation then
    return jsonb_build_object('success', false, 'code', 'slot_conflict');
  when sqlstate 'P0001' then
    if sqlerrm = 'invalid_time' then
      return jsonb_build_object('success', false, 'code', 'invalid_time');
    elsif sqlerrm = 'missing_phone' then
      return jsonb_build_object('success', false, 'code', 'missing_phone');
    elsif sqlerrm = 'invalid_reference' then
      return jsonb_build_object('success', false, 'code', 'invalid_reference');
    elsif sqlerrm = 'outside_hours' then
      return jsonb_build_object('success', false, 'code', 'outside_hours');
    elsif sqlerrm = 'missing_client_name' then
      return jsonb_build_object('success', false, 'code', 'missing_client_name');
    else
      return jsonb_build_object('success', false, 'code', 'unknown_error');
    end if;
  when others then
    return jsonb_build_object('success', false, 'code', 'unknown_error');
end;
$function$;

-- Grants for the new 14-arg signature (mirrors 20260622030000).
REVOKE ALL ON FUNCTION public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz, text, integer, text, uuid, integer, text, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz, text, integer, text, uuid, integer, text, uuid
) TO anon, authenticated, service_role;

-- Exactly one overload must survive. Two is what broke this in June: PostgREST
-- resolved a 13-arg call to the 14-arg function and the profile link vanished.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'create_public_booking') <> 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 create_public_booking overload, found %',
      (SELECT count(*) FROM pg_proc WHERE proname = 'create_public_booking');
  END IF;
END;
$$;
