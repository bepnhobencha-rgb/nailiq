-- Phase 6: Wave Booking MVP.
--
-- When a group is larger than the salon can serve simultaneously, the scheduler
-- splits it into multiple time "waves" instead of returning no availability.
-- All waves still share one group_id + Party Link; wave_number records which
-- wave each booking row belongs to.
--
--   Normal group booking  → every row wave_number = 1
--   Wave booking          → wave 1 rows = 1, wave 2 rows = 2, wave 3 rows = 3 …
--
-- Additive + backward compatible: existing rows and all current callers default
-- to wave_number = 1, so non-wave behaviour is unchanged.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS wave_number smallint NOT NULL DEFAULT 1;

-- insert_group_bookings: accept an optional per-row wave_number (default 1) so a
-- split group stores the correct wave per booking. Callers that omit it (normal
-- groups, the web booking flow) get wave_number = 1 for every row.
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
      wave_number,
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
      COALESCE((v_booking->>'wave_number')::SMALLINT, 1),
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
