-- Resource-mode salons require every confirmed appointment to hold a real
-- chair/bed. Individual public bookings already auto-assign inside their
-- SECURITY DEFINER write boundary; the group boundary previously delegated to
-- this private inserter without assigning resource_id, so a group could bypass
-- chair capacity while still satisfying the staff overlap constraint.
--
-- Keep the fix in the one private transaction used by both normal public group
-- booking and the Owner/Admin controlled-after-hours path. Non-resource salons
-- retain the legacy NULL resource_id behavior. Because this function is the
-- privileged shared boundary, validate the complete payload before taking any
-- advisory lock or writing a row; a mixed/stale service-role payload must not
-- cross tenant boundaries.

CREATE OR REPLACE FUNCTION public.insert_group_bookings_unlimited(p_bookings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_group_id uuid;
  v_group_size smallint;
  v_booking jsonb;
  v_inserted uuid[] := ARRAY[]::uuid[];
  v_new_id uuid;
  v_digits text;
  v_is_party boolean;
  v_profile_id uuid;
  v_idx integer := 0;
  v_salon_id uuid;
  v_row_salon_id uuid;
  v_staff_id uuid;
  v_service_id uuid;
  v_idempotency_key uuid;
  v_resources_enabled boolean := false;
  v_has_capability_whitelist boolean := false;
  v_has_active_resource boolean := false;
  v_lock_id uuid;
  v_resource_id uuid;
  v_start timestamptz;
  v_end timestamptz;
BEGIN
  IF p_bookings IS NULL OR jsonb_typeof(p_bookings) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_group_size');
  END IF;

  v_group_size := jsonb_array_length(p_bookings);
  IF v_group_size < 2 OR v_group_size > 20 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_group_size');
  END IF;

  -- Parse and validate every member before the first advisory lock. The public
  -- wrapper performs equivalent checks, but the controlled after-hours path
  -- and direct service-role calls also converge here, so this boundary cannot
  -- trust the first member's tenant or defer casts until the insert loop.
  FOR v_booking IN SELECT value FROM jsonb_array_elements(p_bookings)
  LOOP
    IF jsonb_typeof(v_booking) <> 'object' THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_data');
    END IF;

    BEGIN
      v_row_salon_id := nullif(v_booking->>'salon_id', '')::uuid;
      v_staff_id := nullif(v_booking->>'staff_id', '')::uuid;
      v_service_id := nullif(v_booking->>'service_id', '')::uuid;
      v_start := nullif(v_booking->>'start_time_utc', '')::timestamptz;
      v_end := nullif(v_booking->>'end_time_utc', '')::timestamptz;
      v_idempotency_key := nullif(v_booking->>'idempotency_key', '')::uuid;

      -- Validate every later insert cast now so malformed member N cannot take
      -- locks or begin inserting members 1..N-1 first.
      IF v_booking ? 'price_cents'
         AND v_booking->>'price_cents' IS NOT NULL THEN
        PERFORM (v_booking->>'price_cents')::integer;
      END IF;
      PERFORM coalesce(
        (v_booking->>'staff_requested_by_client')::boolean,
        false
      );
      PERFORM coalesce((v_booking->>'wave_number')::smallint, 1);
      PERFORM coalesce((v_booking->>'seat_together')::boolean, false);
    EXCEPTION
      WHEN invalid_text_representation
        OR invalid_datetime_format
        OR datetime_field_overflow
        OR numeric_value_out_of_range THEN
        RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_data');
    END;

    IF v_row_salon_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_salon');
    END IF;

    IF v_salon_id IS NULL THEN
      v_salon_id := v_row_salon_id;

      SELECT coalesce(s.resources_enabled, false)
      INTO v_resources_enabled
      FROM public.salons s
      WHERE s.id = v_salon_id;

      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'invalid_salon');
      END IF;

      SELECT EXISTS (
        SELECT 1
        FROM public.staff_services configured
        JOIN public.staff configured_staff
          ON configured_staff.id = configured.staff_id
         AND configured_staff.salon_id = v_salon_id
         AND configured_staff.deleted_at IS NULL
         AND configured_staff.status = 'active'
        JOIN public.services configured_service
          ON configured_service.id = configured.service_id
         AND configured_service.salon_id = v_salon_id
         AND configured_service.deleted_at IS NULL
      )
      INTO v_has_capability_whitelist;
    ELSIF v_row_salon_id <> v_salon_id THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_salon');
    END IF;

    IF v_service_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.services sv
      WHERE sv.id = v_service_id
        AND sv.salon_id = v_salon_id
        AND sv.deleted_at IS NULL
        AND NOT sv.is_addon
        AND greatest(coalesce(sv.duration_minutes, 0), 0) >= 1
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_service');
    END IF;

    IF v_staff_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.staff st
      WHERE st.id = v_staff_id
        AND st.salon_id = v_salon_id
        AND st.deleted_at IS NULL
        AND st.status = 'active'
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_staff');
    END IF;

    -- staff_services is a whitelist once a salon has any live capability row;
    -- a legacy salon with zero rows remains all-capable. Both sides of the
    -- requested pair were validated above, and the configured-row probe joins
    -- back through live same-tenant staff/services so stale soft-deleted rows
    -- cannot accidentally switch the legacy fallback off.
    IF v_has_capability_whitelist AND NOT EXISTS (
      SELECT 1
      FROM public.staff_services requested
      WHERE requested.staff_id = v_staff_id
        AND requested.service_id = v_service_id
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_staff');
    END IF;

    IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start
       OR v_end - v_start > interval '12 hours'
       OR v_start < now() - interval '15 minutes'
       OR v_start > now() + interval '1 year' THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_time');
    END IF;

    IF length(trim(coalesce(v_booking->>'client_name', ''))) NOT BETWEEN 1 AND 120 THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_client_name');
    END IF;

    -- A real group intentionally shares one UUID across every member. The
    -- unique index combines it with staff/start, so validate shape/presence
    -- here without incorrectly requiring per-member uniqueness.
    IF v_idempotency_key IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_data');
    END IF;
  END LOOP;

  -- Add-on IDs are deliberately not consumed or persisted by this private row
  -- inserter. The public group boundary validates each ID as a live same-salon
  -- add-on before forwarding, and add_booking_addons later re-derives the
  -- booking salon and catalog data. Therefore success here proves the booking
  -- rows only; it must not be cited as itemized add-on persistence evidence.
  v_group_id := gen_random_uuid();

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
  'Private atomic group inserter. Preflights one tenant and valid members before locking; resource-mode salons auto-assign one active resource per booking; non-resource salons preserve NULL resource_id.';

DO $proof$
DECLARE
  v_is_definer boolean;
  v_config text[];
BEGIN
  SELECT p.prosecdef, p.proconfig
  INTO v_is_definer, v_config
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'insert_group_bookings_unlimited'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_bookings jsonb';

  IF v_is_definer IS DISTINCT FROM true
     OR NOT ('search_path=""' = ANY(coalesce(v_config, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'insert_group_bookings_unlimited security configuration drift';
  END IF;

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
