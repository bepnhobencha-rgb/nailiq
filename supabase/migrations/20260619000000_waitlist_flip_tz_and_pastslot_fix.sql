-- Two correctness fixes to the three waitlist "flip" RPCs that promote the next
-- waiting customer when a slot frees (cancel / no-show):
--
-- P0 — salon-local date. `booking_waitlist_entries.booking_date` is written in
--   the salon's LOCAL day (the day the customer picked). These RPCs matched it
--   against `(start_time_utc AT TIME ZONE 'UTC')::date`, i.e. the UTC day. Every
--   North-American salon is UTC-7/-8, so an EVENING booking (e.g. 7pm PT = next
--   day UTC) produced a date one day later than the waitlist row → the FIFO
--   match found nothing → evening-slot waitlist customers were NEVER notified.
--   Fix: compute the date in the salon timezone.
--
-- P1 — only auto-offer a CONCRETE slot when it is still in the FUTURE. A no-show
--   frees a slot whose start is already PAST; capturing it as offered_* made
--   claim_waitlist_slot call create_public_booking with a past start, which it
--   rejects ('invalid_time') — so the customer got an SMS offering a slot they
--   could never claim, then got dropped. Past freed slot → offered_* stays NULL
--   → the claim falls back to the manual "salon follows up" flow.

-- 1) Desk cancel + no-show.
CREATE OR REPLACE FUNCTION public.notify_waitlist_for_no_show(p_booking_id uuid)
 RETURNS TABLE(entry_id uuid, service_name text, salon_name text, booking_date date)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_b public.bookings%ROWTYPE;
  v_id uuid;
  v_date date;
  v_tz text;
  v_future boolean;
BEGIN
  SELECT * INTO v_b FROM public.bookings WHERE id = p_booking_id;
  IF NOT FOUND OR v_b.service_id IS NULL THEN
    RETURN;
  END IF;
  SELECT coalesce(nullif(trim(s.timezone), ''), 'America/Los_Angeles')
    INTO v_tz FROM public.salons s WHERE s.id = v_b.salon_id;
  v_tz := coalesce(v_tz, 'America/Los_Angeles');
  v_date := (v_b.start_time_utc AT TIME ZONE v_tz)::date;
  v_future := v_b.start_time_utc > now();

  UPDATE public.booking_waitlist_entries
     SET status = 'notified', notified_at = now(), claim_token = gen_random_uuid(),
         offered_staff_id  = CASE WHEN v_future THEN v_b.staff_id END,
         offered_start_utc = CASE WHEN v_future THEN v_b.start_time_utc END,
         offered_end_utc   = CASE WHEN v_future THEN v_b.end_time_utc END
   WHERE booking_waitlist_entries.id = (
     SELECT bwe.id FROM public.booking_waitlist_entries bwe
      WHERE bwe.salon_id = v_b.salon_id
        AND bwe.service_id = v_b.service_id
        AND bwe.booking_date = v_date
        AND bwe.status = 'waiting'
      ORDER BY bwe.created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
   )
   RETURNING booking_waitlist_entries.id INTO v_id;

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT v_id,
           (SELECT name FROM public.services WHERE id = v_b.service_id),
           (SELECT name FROM public.salons WHERE id = v_b.salon_id),
           v_date;
END;
$function$;

-- 2) Customer self-cancel via reminder token.
CREATE OR REPLACE FUNCTION public.cancel_booking_as_customer(p_token_id uuid)
 RETURNS TABLE(ok boolean, code text, booking_id uuid)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_token   booking_reminder_tokens%ROWTYPE;
  v_booking bookings%ROWTYPE;
  v_tz text;
  v_future boolean;
BEGIN
  SELECT * INTO v_token
  FROM   booking_reminder_tokens
  WHERE  id = p_token_id AND used_at IS NULL AND expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'token_invalid'::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT * INTO v_booking
  FROM   bookings
  WHERE  id = v_token.booking_id AND status IN ('pending','confirmed')
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'booking_not_cancellable'::text, NULL::uuid;
    RETURN;
  END IF;

  UPDATE bookings SET status = 'cancelled' WHERE id = v_booking.id;

  UPDATE booking_reminder_tokens
  SET used_at = now(), used_action = 'cancel'
  WHERE id = v_token.id;

  SELECT coalesce(nullif(trim(s.timezone), ''), 'America/Los_Angeles')
    INTO v_tz FROM salons s WHERE s.id = v_booking.salon_id;
  v_tz := coalesce(v_tz, 'America/Los_Angeles');
  v_future := v_booking.start_time_utc > now();

  UPDATE booking_waitlist_entries
  SET status = 'notified', notified_at = now(), claim_token = gen_random_uuid(),
      offered_staff_id  = CASE WHEN v_future THEN v_booking.staff_id END,
      offered_start_utc = CASE WHEN v_future THEN v_booking.start_time_utc END,
      offered_end_utc   = CASE WHEN v_future THEN v_booking.end_time_utc END
  WHERE id = (
    SELECT id FROM booking_waitlist_entries
    WHERE  salon_id = v_booking.salon_id
      AND  service_id = v_booking.service_id
      AND  booking_date = (v_booking.start_time_utc AT TIME ZONE v_tz)::date
      AND  status = 'waiting'
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  );

  RETURN QUERY SELECT true, 'ok'::text, v_booking.id;
END;
$function$;

-- 3) SMS "CANCEL" inbound (service-role only).
CREATE OR REPLACE FUNCTION public.cancel_booking_by_id(p_booking_id uuid)
 RETURNS TABLE(ok boolean, code text, booking_id uuid)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_booking bookings%ROWTYPE;
  v_tz text;
  v_future boolean;
BEGIN
  SELECT * INTO v_booking FROM bookings
  WHERE id = p_booking_id AND status IN ('pending','confirmed') FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false,'booking_not_cancellable'::text,NULL::uuid; RETURN; END IF;

  UPDATE bookings SET status = 'cancelled' WHERE id = v_booking.id;

  SELECT coalesce(nullif(trim(s.timezone), ''), 'America/Los_Angeles')
    INTO v_tz FROM salons s WHERE s.id = v_booking.salon_id;
  v_tz := coalesce(v_tz, 'America/Los_Angeles');
  v_future := v_booking.start_time_utc > now();

  UPDATE booking_waitlist_entries
  SET status = 'notified', notified_at = now(), claim_token = gen_random_uuid(),
      offered_staff_id  = CASE WHEN v_future THEN v_booking.staff_id END,
      offered_start_utc = CASE WHEN v_future THEN v_booking.start_time_utc END,
      offered_end_utc   = CASE WHEN v_future THEN v_booking.end_time_utc END
  WHERE id = (
    SELECT id FROM booking_waitlist_entries
    WHERE salon_id = v_booking.salon_id AND service_id = v_booking.service_id
      AND booking_date = (v_booking.start_time_utc AT TIME ZONE v_tz)::date AND status = 'waiting'
    ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
  );

  RETURN QUERY SELECT true,'ok'::text, v_booking.id;
END;
$function$;

-- Service-role only (CREATE OR REPLACE keeps grants; re-assert defensively).
REVOKE ALL ON FUNCTION public.cancel_booking_by_id(uuid) FROM PUBLIC, anon, authenticated;
