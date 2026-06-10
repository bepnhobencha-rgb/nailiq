-- cancel_booking_by_id: token-less cancel for the two-way SMS inbound webhook.
-- Mirrors cancel_booking_as_customer (same atomic free-slot + waitlist promotion)
-- but keyed by booking id, since an SMS reply ("CANCEL") has no reminder token.
-- Called ONLY by the service-role inbound webhook after matching the sender's
-- phone to their booking — so it is NOT granted to anon/authenticated.

CREATE OR REPLACE FUNCTION public.cancel_booking_by_id(p_booking_id uuid)
RETURNS TABLE (ok boolean, code text, booking_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_booking bookings%ROWTYPE;
BEGIN
  SELECT * INTO v_booking FROM bookings
  WHERE id = p_booking_id AND status IN ('pending','confirmed') FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false,'booking_not_cancellable'::text,NULL::uuid; RETURN; END IF;

  UPDATE bookings SET status = 'cancelled' WHERE id = v_booking.id;

  -- Promote the oldest waiting waitlist entry for the freed slot (same SQL as
  -- cancel_booking_as_customer). The email is sent separately by the caller.
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

-- Service-role only — new SECURITY DEFINER funcs default-grant EXECUTE to PUBLIC,
-- which would let anon cancel any booking by id. Revoke it.
REVOKE ALL ON FUNCTION public.cancel_booking_by_id(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_booking_by_id(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.cancel_booking_by_id(uuid) FROM authenticated;
