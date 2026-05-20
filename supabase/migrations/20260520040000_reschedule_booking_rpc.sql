-- Customer-facing RPCs: confirm / reschedule / cancel via reminder token

-- Atomic reschedule
CREATE OR REPLACE FUNCTION public.reschedule_booking_as_customer(
  p_token_id      uuid,
  p_new_start_utc timestamptz,
  p_new_end_utc   timestamptz
)
RETURNS TABLE (ok boolean, code text, booking_id uuid, service_name text, staff_name text, new_start_utc timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_token   booking_reminder_tokens%ROWTYPE;
  v_booking bookings%ROWTYPE;
  v_svc text; v_stf text;
BEGIN
  SELECT * INTO v_token FROM booking_reminder_tokens
  WHERE id = p_token_id AND used_at IS NULL AND expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false,'token_invalid'::text,NULL::uuid,NULL::text,NULL::text,NULL::timestamptz; RETURN;
  END IF;

  SELECT * INTO v_booking FROM bookings
  WHERE id = v_token.booking_id AND status IN ('pending','confirmed') AND start_time_utc > now()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false,'booking_not_reschedulable'::text,NULL::uuid,NULL::text,NULL::text,NULL::timestamptz; RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.id <> v_booking.id AND b.salon_id = v_booking.salon_id
      AND b.staff_id = v_booking.staff_id AND b.status NOT IN ('cancelled')
      AND b.start_time_utc < p_new_end_utc AND b.end_time_utc > p_new_start_utc
  ) THEN
    RETURN QUERY SELECT false,'slot_conflict'::text,NULL::uuid,NULL::text,NULL::text,NULL::timestamptz; RETURN;
  END IF;

  UPDATE bookings SET
    rescheduled_from_time_utc = start_time_utc,
    start_time_utc  = p_new_start_utc, end_time_utc = p_new_end_utc,
    rescheduled_at  = now(), rescheduled_by = 'customer',
    reminder_24h_sent_at = NULL, reminder_3h_sent_at = NULL,
    status = 'confirmed'
  WHERE id = v_booking.id;

  UPDATE booking_reminder_tokens SET used_at = now(), used_action = 'reschedule' WHERE id = v_token.id;

  UPDATE booking_waitlist_entries SET status = 'notified', notified_at = now(), claim_token = gen_random_uuid()
  WHERE id = (
    SELECT id FROM booking_waitlist_entries
    WHERE salon_id = v_booking.salon_id AND service_id = v_booking.service_id
      AND booking_date = (v_booking.start_time_utc AT TIME ZONE 'UTC')::date AND status = 'waiting'
    ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
  );

  SELECT name INTO v_svc FROM services WHERE id = v_booking.service_id;
  SELECT name INTO v_stf FROM staff    WHERE id = v_booking.staff_id;
  RETURN QUERY SELECT true,'ok'::text, v_booking.id, v_svc, v_stf, p_new_start_utc;
END;
$$;
GRANT EXECUTE ON FUNCTION public.reschedule_booking_as_customer(uuid,timestamptz,timestamptz) TO anon, authenticated;

-- Atomic cancel
CREATE OR REPLACE FUNCTION public.cancel_booking_as_customer(p_token_id uuid)
RETURNS TABLE (ok boolean, code text, booking_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_token booking_reminder_tokens%ROWTYPE; v_booking bookings%ROWTYPE;
BEGIN
  SELECT * INTO v_token FROM booking_reminder_tokens
  WHERE id = p_token_id AND used_at IS NULL AND expires_at > now() FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false,'token_invalid'::text,NULL::uuid; RETURN; END IF;

  SELECT * INTO v_booking FROM bookings
  WHERE id = v_token.booking_id AND status IN ('pending','confirmed') FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false,'booking_not_cancellable'::text,NULL::uuid; RETURN; END IF;

  UPDATE bookings SET status = 'cancelled' WHERE id = v_booking.id;
  UPDATE booking_reminder_tokens SET used_at = now(), used_action = 'cancel' WHERE id = v_token.id;

  UPDATE booking_waitlist_entries SET status = 'notified', notified_at = now(), claim_token = gen_random_uuid()
  WHERE id = (
    SELECT id FROM booking_waitlist_entries
    WHERE salon_id = v_booking.salon_id AND service_id = v_booking.service_id
      AND booking_date = (v_booking.start_time_utc AT TIME ZONE 'UTC')::date AND status = 'waiting'
    ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
  );

  RETURN QUERY SELECT true,'ok'::text, v_booking.id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.cancel_booking_as_customer(uuid) TO anon, authenticated;

-- Atomic confirm
CREATE OR REPLACE FUNCTION public.confirm_booking_as_customer(p_token_id uuid)
RETURNS TABLE (ok boolean, code text, booking_id uuid, service_name text, staff_name text, start_utc timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_token booking_reminder_tokens%ROWTYPE; v_booking bookings%ROWTYPE; v_svc text; v_stf text;
BEGIN
  SELECT * INTO v_token FROM booking_reminder_tokens
  WHERE id = p_token_id AND used_at IS NULL AND expires_at > now() FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false,'token_invalid'::text,NULL::uuid,NULL::text,NULL::text,NULL::timestamptz; RETURN;
  END IF;

  SELECT * INTO v_booking FROM bookings
  WHERE id = v_token.booking_id AND status IN ('pending','confirmed') FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false,'booking_not_found'::text,NULL::uuid,NULL::text,NULL::text,NULL::timestamptz; RETURN;
  END IF;

  UPDATE bookings SET status = 'confirmed', confirmed_at = now() WHERE id = v_booking.id;
  UPDATE booking_reminder_tokens SET used_at = now(), used_action = 'confirm' WHERE id = v_token.id;

  SELECT name INTO v_svc FROM services WHERE id = v_booking.service_id;
  SELECT name INTO v_stf FROM staff    WHERE id = v_booking.staff_id;
  RETURN QUERY SELECT true,'ok'::text, v_booking.id, v_svc, v_stf, v_booking.start_time_utc;
END;
$$;
GRANT EXECUTE ON FUNCTION public.confirm_booking_as_customer(uuid) TO anon, authenticated;
