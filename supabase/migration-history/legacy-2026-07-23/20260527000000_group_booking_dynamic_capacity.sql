-- Group booking — dynamic capacity (cap raised 8 → 20).
--
-- Previous cap of 8 (migration 20260512300000) was arbitrary.
-- The real constraint is how many active staff a salon has: a 10-staff
-- salon should be able to accommodate a 10-person group. The absolute
-- ceiling of 20 acts as a safety valve for very large salons without
-- imposing an artificial business limit.
--
-- All three client-side layers are updated in lock-step:
--   • GROUP_MAX_SIZE (constants.ts) : 6 → 20
--   • submitGroupBooking.ts          : params.members.length > 8 → > 20
--   • this RPC                       : v_group_size > 8 → > 20
--
-- UI effective cap remains Math.min(activeStaffCount, 20), so a
-- 3-staff salon is still limited to 3-person groups. The cap change
-- only unlocks capacity for salons that actually have the staff.

CREATE OR REPLACE FUNCTION public.insert_group_bookings(
  p_bookings JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group_id UUID := gen_random_uuid();
  v_group_size SMALLINT := jsonb_array_length(p_bookings);
  v_booking JSONB;
  v_inserted UUID[] := ARRAY[]::UUID[];
  v_new_id UUID;
BEGIN
  IF v_group_size IS NULL OR v_group_size < 2 OR v_group_size > 20 THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'invalid_group_size'
    );
  END IF;

  FOR v_booking IN SELECT * FROM jsonb_array_elements(p_bookings)
  LOOP
    INSERT INTO public.bookings (
      salon_id,
      staff_id,
      service_id,
      client_name,
      client_phone,
      client_email,
      client_notes,
      start_time_utc,
      end_time_utc,
      status,
      price_cents,
      staff_requested_by_client,
      group_id,
      group_size,
      idempotency_key
    )
    VALUES (
      (v_booking->>'salon_id')::UUID,
      (v_booking->>'staff_id')::UUID,
      (v_booking->>'service_id')::UUID,
      v_booking->>'client_name',
      v_booking->>'client_phone',
      v_booking->>'client_email',
      v_booking->>'client_notes',
      (v_booking->>'start_time_utc')::TIMESTAMPTZ,
      (v_booking->>'end_time_utc')::TIMESTAMPTZ,
      'confirmed',
      CASE
        WHEN v_booking ? 'price_cents'
          AND v_booking->>'price_cents' IS NOT NULL
        THEN (v_booking->>'price_cents')::INTEGER
        ELSE NULL
      END,
      COALESCE((v_booking->>'staff_requested_by_client')::BOOLEAN, false),
      v_group_id,
      v_group_size,
      (v_booking->>'idempotency_key')::UUID
    )
    RETURNING id INTO v_new_id;
    v_inserted := array_append(v_inserted, v_new_id);
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'group_id', v_group_id,
    'booking_ids', to_jsonb(v_inserted)
  );
EXCEPTION
  WHEN exclusion_violation THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'slot_conflict'
    );
  WHEN unique_violation THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'duplicate_submission'
    );
END;
$$;
