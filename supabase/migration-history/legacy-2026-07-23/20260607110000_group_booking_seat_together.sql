-- Thread the "seat together" / couple preference through the atomic
-- group-insert RPC.
--
-- The public booking flow runs with the anon client, so a post-insert
-- UPDATE on `bookings` is blocked by RLS. insert_group_bookings is
-- SECURITY DEFINER, so the correct place to persist seat_together is
-- inside the same atomic insert. Purely additive: the column is read
-- from each member's JSONB with COALESCE(..., false), so older callers
-- that don't send the field keep the previous behaviour (false).
--
-- Body is identical to the version in 20260530000000_wave_booking.sql
-- plus the seat_together column/value.
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
BEGIN
  IF v_group_size IS NULL OR v_group_size < 2 OR v_group_size > 20 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_group_size');
  END IF;

  FOR v_booking IN SELECT * FROM jsonb_array_elements(p_bookings)
  LOOP
    INSERT INTO public.bookings (
      salon_id, staff_id, service_id, client_name, client_phone, client_email,
      client_notes, start_time_utc, end_time_utc, status, price_cents,
      staff_requested_by_client, group_id, group_size, wave_number,
      seat_together, idempotency_key
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
      CASE WHEN v_booking ? 'price_cents' AND v_booking->>'price_cents' IS NOT NULL
        THEN (v_booking->>'price_cents')::INTEGER ELSE NULL END,
      COALESCE((v_booking->>'staff_requested_by_client')::BOOLEAN, false),
      v_group_id,
      v_group_size,
      COALESCE((v_booking->>'wave_number')::SMALLINT, 1),
      COALESCE((v_booking->>'seat_together')::BOOLEAN, false),
      (v_booking->>'idempotency_key')::UUID
    )
    RETURNING id INTO v_new_id;
    v_inserted := array_append(v_inserted, v_new_id);
  END LOOP;

  RETURN jsonb_build_object('success', true, 'group_id', v_group_id, 'booking_ids', to_jsonb(v_inserted));
EXCEPTION
  WHEN exclusion_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'slot_conflict');
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'duplicate_submission');
END;
$function$;
