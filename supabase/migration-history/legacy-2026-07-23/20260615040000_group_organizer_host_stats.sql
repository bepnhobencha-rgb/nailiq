-- "Người dẫn nhóm" (group host) recognition.
--
-- Mark the organizer row of each group (member 0 = the booker) so we can
-- celebrate people who BRING guests without polluting their visit count. Visit
-- count stays 1-per-booking; "guests brought" is a separate, derived stat.
-- Forward-looking: old groups (all rows sharing the organizer's phone) have no
-- organizer marker and report 0 — acceptable (mostly seed/test data).

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS is_group_organizer boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.bookings.is_group_organizer IS
  'True on the organizer (member 0) row of a group booking. Powers the "guests brought" host stat. NULL/false for solo bookings and party guests.';

-- insert_group_bookings: same body as the deployed version + stamps
-- is_group_organizer on the FIRST member (the organizer) via a loop index.
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
  v_idx INT := 0;
BEGIN
  IF v_group_size IS NULL OR v_group_size < 2 OR v_group_size > 20 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_group_size');
  END IF;

  FOR v_booking IN SELECT * FROM jsonb_array_elements(p_bookings)
  LOOP
    v_digits := regexp_replace(
      coalesce(public.canonical_phone(v_booking->>'client_phone'), ''), '\D', '', 'g');
    v_is_party := length(v_digits) < 7;

    INSERT INTO public.bookings (
      salon_id, staff_id, service_id, client_name, client_phone, client_email,
      client_notes, start_time_utc, end_time_utc, status, price_cents,
      staff_requested_by_client, group_id, group_size, wave_number,
      seat_together, idempotency_key, client_locale, is_party_member,
      is_group_organizer
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
      v_is_party,
      (v_idx = 0)
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

    v_idx := v_idx + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'group_id', v_group_id, 'booking_ids', to_jsonb(v_inserted));
EXCEPTION
  WHEN exclusion_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'slot_conflict');
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'duplicate_submission');
END;
$function$;

-- Host stats for one customer (by phone) in one salon: how many group bookings
-- they organized + how many guests they brought (sum of co-attendees). Excludes
-- cancelled. SECURITY DEFINER + service_role; the server action gates the salon.
CREATE OR REPLACE FUNCTION public.get_host_stats(p_salon_id uuid, p_phone text)
RETURNS TABLE (groups_organized int, guests_brought int)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
STABLE
AS $function$
  WITH ph AS (
    SELECT regexp_replace(coalesce(public.canonical_phone(p_phone), ''), '\D', '', 'g') AS d
  ),
  og AS (
    SELECT DISTINCT b.group_id
    FROM public.bookings b
    WHERE b.salon_id = p_salon_id
      AND b.is_group_organizer = true
      AND b.group_id IS NOT NULL
      AND b.status <> 'cancelled'
      AND (SELECT d FROM ph) <> ''
      AND regexp_replace(coalesce(b.client_phone, ''), '\D', '', 'g') = (SELECT d FROM ph)
  ),
  sizes AS (
    SELECT b.group_id, count(*) AS sz
    FROM public.bookings b
    JOIN og ON og.group_id = b.group_id
    WHERE b.status <> 'cancelled'
    GROUP BY b.group_id
  )
  SELECT
    coalesce((SELECT count(*) FROM og), 0)::int AS groups_organized,
    coalesce((SELECT sum(sz - 1) FROM sizes), 0)::int AS guests_brought;
$function$;

REVOKE ALL ON FUNCTION public.get_host_stats(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_host_stats(uuid, text) TO service_role;
