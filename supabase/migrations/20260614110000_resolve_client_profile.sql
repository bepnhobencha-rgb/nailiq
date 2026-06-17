-- Customer Identity Layer — M2 (resolver + stamp FK).
--
-- ONE server-authoritative place that turns (phone, name, email) into a
-- client_profiles row id, used by every booking write path. Replaces the
-- best-effort browser-side upsert (which RLS could silently drop) with an
-- atomic SECURITY DEFINER resolve that runs ONLY after a booking row is
-- actually created — so a failed/conflicting booking never bumps visit_count.
--
-- Rules baked in:
--   * No valid phone  -> returns NULL (the caller marks the row is_party_member;
--     a group guest with no contact gets NO profile and is NOT counted as a
--     visit of the booker — this is the core "lung tung" fix).
--   * Placeholder names ("Guest 3" / "Khách 3") never overwrite a real name.
--   * An existing real name is preserved (identity reconciliation/merge is M6).
--   * visit_count += 1 per successful booking (matches prior behaviour, but now
--     atomic + once, instead of per-browser best-effort).

CREATE OR REPLACE FUNCTION public.resolve_client_profile(
  p_phone text,
  p_name text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_preferred_staff_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_digits text;
  v_name text;
  v_email text;
  v_is_placeholder boolean;
  v_id uuid;
BEGIN
  -- Canonicalize; no real phone => no identity (party member).
  v_digits := regexp_replace(coalesce(public.canonical_phone(p_phone), ''), '\D', '', 'g');
  IF length(v_digits) < 7 THEN
    RETURN NULL;
  END IF;

  v_name  := nullif(trim(coalesce(p_name, '')), '');
  v_email := nullif(lower(trim(coalesce(p_email, ''))), '');
  -- "Guest 3" / "Khách 3" / "Khach 3" are placeholders, not real identities.
  v_is_placeholder := v_name IS NULL OR v_name ~* '^(guest|kh[aá]ch)\s*[0-9]+$';

  INSERT INTO public.client_profiles (phone, name, email, preferred_staff_id, last_service_date, visit_count)
  VALUES (
    v_digits,
    CASE WHEN v_is_placeholder THEN NULL ELSE v_name END,
    v_email,
    p_preferred_staff_id,
    now(),
    1
  )
  ON CONFLICT (phone) DO UPDATE SET
    name = CASE
             WHEN v_is_placeholder THEN public.client_profiles.name
             WHEN public.client_profiles.name IS NULL OR public.client_profiles.name = ''
               THEN excluded.name
             ELSE public.client_profiles.name
           END,
    email = COALESCE(public.client_profiles.email, excluded.email),
    preferred_staff_id = COALESCE(excluded.preferred_staff_id, public.client_profiles.preferred_staff_id),
    last_service_date = now(),
    visit_count = COALESCE(public.client_profiles.visit_count, 0) + 1,
    updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_client_profile(text, text, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_client_profile(text, text, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- create_public_booking: stamp client_profile_id after a successful insert.
-- Signature unchanged. Only delta vs. 20260506004817: resolve + UPDATE the new
-- row's client_profile_id (and the profile upsert now lives here, not browser).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_public_booking(
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
  p_client_email text DEFAULT NULL
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
begin
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
    coalesce(nullif(trim(s.timezone), ''), 'America/Los_Angeles')
  into v_hours, v_closed_dates, v_tz_raw
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

  begin
    insert into public.bookings (
      salon_id, service_id, staff_id, client_name, client_phone, client_email,
      start_time_utc, end_time_utc, status, price_cents, client_notes,
      addon_service_id, addon_price_cents
    )
    values (
      p_salon_id, p_service_id, p_staff_id, trim(p_client_name), v_digits, v_email,
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

-- ---------------------------------------------------------------------------
-- insert_group_bookings: per-member canonical phone + party-member flag + FK.
-- Signature unchanged (p_bookings jsonb). A member with no valid phone of their
-- own is stored with client_phone = NULL + is_party_member = true and gets NO
-- profile (so the booker's identity is never polluted). Members WITH a real
-- phone resolve to their own profile and get the FK stamped.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.insert_group_bookings(p_bookings jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group_id UUID := gen_random_uuid();
  v_group_size SMALLINT := jsonb_array_length(p_bookings);
  v_booking JSONB;
  v_inserted UUID[] := ARRAY[]::UUID[];
  v_new_id UUID;
  v_digits TEXT;
  v_is_party BOOLEAN;
  v_profile_id UUID;
BEGIN
  IF v_group_size IS NULL OR v_group_size < 2 OR v_group_size > 20 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_group_size');
  END IF;

  FOR v_booking IN SELECT * FROM jsonb_array_elements(p_bookings)
  LOOP
    v_digits := regexp_replace(
      coalesce(public.canonical_phone(v_booking->>'client_phone'), ''), '\D', '', 'g');
    v_is_party := length(v_digits) < 7;  -- no own contact => party member

    INSERT INTO public.bookings (
      salon_id, staff_id, service_id, client_name, client_phone, client_email,
      client_notes, start_time_utc, end_time_utc, status, price_cents,
      staff_requested_by_client, group_id, group_size, wave_number,
      seat_together, idempotency_key, client_locale, is_party_member
    )
    VALUES (
      (v_booking->>'salon_id')::UUID,
      (v_booking->>'staff_id')::UUID,
      (v_booking->>'service_id')::UUID,
      v_booking->>'client_name',
      CASE WHEN v_is_party THEN NULL ELSE v_digits END,
      v_booking->>'client_email',
      v_booking->>'client_notes',
      (v_booking->>'start_time_utc')::TIMESTAMPTZ,
      (v_booking->>'end_time_utc')::TIMESTAMPTZ,
      'confirmed',
      CASE WHEN v_booking ? 'price_cents' AND v_booking->>'price_cents' IS NOT NULL
        THEN (v_booking->>'price_cents')::INTEGER ELSE NULL END,
      COALESCE((v_booking->>'staff_requested_by_client')::BOOLEAN, false),
      v_group_id,
      v_group_size,
      COALESCE((v_booking->>'wave_number')::SMALLINT, 1),
      COALESCE((v_booking->>'seat_together')::BOOLEAN, false),
      (v_booking->>'idempotency_key')::UUID,
      NULLIF(TRIM(COALESCE(v_booking->>'client_locale', '')), ''),
      v_is_party
    )
    RETURNING id INTO v_new_id;
    v_inserted := array_append(v_inserted, v_new_id);

    IF NOT v_is_party THEN
      v_profile_id := public.resolve_client_profile(
        v_digits,
        v_booking->>'client_name',
        v_booking->>'client_email',
        (v_booking->>'staff_id')::UUID
      );
      IF v_profile_id IS NOT NULL THEN
        UPDATE public.bookings SET client_profile_id = v_profile_id WHERE id = v_new_id;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'group_id', v_group_id, 'booking_ids', to_jsonb(v_inserted));
EXCEPTION
  WHEN exclusion_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'slot_conflict');
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'duplicate_submission');
END;
$function$;
