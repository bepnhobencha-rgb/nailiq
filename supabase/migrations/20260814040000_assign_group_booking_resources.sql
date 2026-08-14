-- Resource-mode salons require every confirmed appointment to hold a real
-- chair/bed. Individual public bookings already auto-assign inside their
-- SECURITY DEFINER write boundary; the group boundary previously delegated to
-- this private inserter without assigning resource_id, so a group could bypass
-- chair capacity while still satisfying the staff overlap constraint.
--
-- Keep the fix in the one private transaction used by both normal public group
-- booking and the Owner/Admin controlled-after-hours path. Non-resource salons
-- retain the legacy NULL resource_id behavior.

CREATE OR REPLACE FUNCTION public.insert_group_bookings_unlimited(p_bookings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_group_id uuid := gen_random_uuid();
  v_group_size smallint := jsonb_array_length(p_bookings);
  v_booking jsonb;
  v_inserted uuid[] := ARRAY[]::uuid[];
  v_new_id uuid;
  v_digits text;
  v_is_party boolean;
  v_profile_id uuid;
  v_idx integer := 0;
  v_salon_id uuid;
  v_resources_enabled boolean := false;
  v_has_active_resource boolean := false;
  v_lock_id uuid;
  v_resource_id uuid;
  v_start timestamptz;
  v_end timestamptz;
BEGIN
  IF v_group_size IS NULL OR v_group_size < 2 OR v_group_size > 20 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_group_size');
  END IF;

  BEGIN
    v_salon_id := (p_bookings->0->>'salon_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_data');
  END;

  SELECT coalesce(s.resources_enabled, false)
  INTO v_resources_enabled
  FROM public.salons s
  WHERE s.id = v_salon_id;

  -- Match create_public_booking's lock namespace and ordering: every staff
  -- lock is acquired before any resource lock. Sorting all group locks avoids
  -- reversed-member deadlocks between concurrent parties.
  FOR v_lock_id IN
    SELECT DISTINCT (entry.value->>'staff_id')::uuid
    FROM jsonb_array_elements(p_bookings) AS entry(value)
    ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_salon_id::text || chr(255) || v_lock_id::text)::bigint
    );
  END LOOP;

  IF v_resources_enabled THEN
    -- Lock all active resources in a stable order before choosing any of them.
    -- Individual writers use the same chr(254) lock namespace, so a public
    -- single booking and a group cannot both claim the same chair in a race.
    FOR v_lock_id IN
      SELECT r.id
      FROM public.salon_resources r
      WHERE r.salon_id = v_salon_id
        AND r.status = 'active'
        AND r.deleted_at IS NULL
      ORDER BY r.id
    LOOP
      v_has_active_resource := true;
      PERFORM pg_advisory_xact_lock(
        hashtext(v_salon_id::text || chr(254) || v_lock_id::text)::bigint
      );
    END LOOP;

    IF NOT v_has_active_resource THEN
      RAISE EXCEPTION 'slot_conflict' USING ERRCODE = '23P01';
    END IF;
  END IF;

  FOR v_booking IN SELECT value FROM jsonb_array_elements(p_bookings)
  LOOP
    v_start := (v_booking->>'start_time_utc')::timestamptz;
    v_end := (v_booking->>'end_time_utc')::timestamptz;
    v_resource_id := NULL;

    IF v_resources_enabled THEN
      SELECT r.id
      INTO v_resource_id
      FROM public.salon_resources r
      WHERE r.salon_id = v_salon_id
        AND r.status = 'active'
        AND r.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.bookings b
          WHERE b.salon_id = v_salon_id
            AND b.resource_id = r.id
            AND b.status NOT IN ('cancelled', 'waiting', 'no_show')
            AND b.start_time_utc < v_end
            AND b.end_time_utc > v_start
        )
      ORDER BY r.display_order ASC NULLS LAST, r.id
      LIMIT 1;

      IF v_resource_id IS NULL THEN
        -- Raising (rather than returning) is deliberate: the outer exception
        -- block rolls back any earlier member inserts before translating the
        -- capacity failure into the public slot_conflict result.
        RAISE EXCEPTION 'slot_conflict' USING ERRCODE = '23P01';
      END IF;
    END IF;

    v_digits := regexp_replace(
      coalesce(public.canonical_phone(v_booking->>'client_phone'), ''),
      '\D',
      '',
      'g'
    );
    v_is_party := length(v_digits) < 7;

    INSERT INTO public.bookings (
      salon_id, staff_id, service_id, resource_id, client_name, client_phone,
      client_email, client_notes, start_time_utc, end_time_utc, status,
      price_cents, staff_requested_by_client, group_id, group_size, wave_number,
      seat_together, idempotency_key, client_locale, is_party_member,
      is_group_organizer
    )
    VALUES (
      (v_booking->>'salon_id')::uuid,
      (v_booking->>'staff_id')::uuid,
      (v_booking->>'service_id')::uuid,
      v_resource_id,
      v_booking->>'client_name',
      CASE WHEN v_is_party THEN NULL ELSE v_digits END,
      v_booking->>'client_email',
      v_booking->>'client_notes',
      v_start,
      v_end,
      'confirmed',
      CASE
        WHEN v_booking ? 'price_cents'
          AND v_booking->>'price_cents' IS NOT NULL
        THEN (v_booking->>'price_cents')::integer
        ELSE NULL
      END,
      coalesce((v_booking->>'staff_requested_by_client')::boolean, false),
      v_group_id,
      v_group_size,
      coalesce((v_booking->>'wave_number')::smallint, 1),
      coalesce((v_booking->>'seat_together')::boolean, false),
      (v_booking->>'idempotency_key')::uuid,
      nullif(trim(coalesce(v_booking->>'client_locale', '')), ''),
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
        (v_booking->>'staff_id')::uuid
      );
      IF v_profile_id IS NOT NULL THEN
        UPDATE public.bookings
        SET client_profile_id = v_profile_id
        WHERE id = v_new_id;
      END IF;
    END IF;

    v_idx := v_idx + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'group_id', v_group_id,
    'booking_ids', to_jsonb(v_inserted)
  );
EXCEPTION
  WHEN exclusion_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'slot_conflict');
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'duplicate_submission');
END;
$function$;

REVOKE ALL ON FUNCTION public.insert_group_bookings_unlimited(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_group_bookings_unlimited(jsonb)
  TO service_role;

COMMENT ON FUNCTION public.insert_group_bookings_unlimited(jsonb) IS
  'Private atomic group inserter. Resource-mode salons auto-assign and lock one active resource per booking; non-resource salons preserve NULL resource_id.';

DO $proof$
BEGIN
  IF has_function_privilege(
    'anon',
    'public.insert_group_bookings_unlimited(jsonb)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.insert_group_bookings_unlimited(jsonb)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.insert_group_bookings_unlimited(jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'insert_group_bookings_unlimited privilege drift';
  END IF;
END;
$proof$;
