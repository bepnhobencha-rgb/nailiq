-- When a no-show frees a slot, flag the earliest matching waitlist entry
-- (same salon + service + date) as 'notified' with a fresh claim_token, and
-- return the bits the JS layer needs to send the claim email. Mirrors the
-- waitlist hand-off already used by the customer reschedule/cancel RPCs.
CREATE OR REPLACE FUNCTION public.notify_waitlist_for_no_show(p_booking_id uuid)
RETURNS TABLE (entry_id uuid, service_name text, salon_name text, booking_date date)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_b public.bookings%ROWTYPE;
  v_id uuid;
  v_date date;
BEGIN
  SELECT * INTO v_b FROM public.bookings WHERE id = p_booking_id;
  IF NOT FOUND OR v_b.service_id IS NULL THEN
    RETURN;
  END IF;
  v_date := (v_b.start_time_utc AT TIME ZONE 'UTC')::date;

  UPDATE public.booking_waitlist_entries
     SET status = 'notified', notified_at = now(), claim_token = gen_random_uuid()
   WHERE id = (
     SELECT id FROM public.booking_waitlist_entries
      WHERE salon_id = v_b.salon_id
        AND service_id = v_b.service_id
        AND booking_date = v_date
        AND status = 'waiting'
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
   )
   RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT v_id,
           (SELECT name FROM public.services WHERE id = v_b.service_id),
           (SELECT name FROM public.salons WHERE id = v_b.salon_id),
           v_date;
END;
$$;
