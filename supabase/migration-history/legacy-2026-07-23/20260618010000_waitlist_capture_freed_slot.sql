-- Capture the freed slot {staff, start, end} on the promoted waitlist entry at
-- every flip site. The flip already matches the SAME service_id as the freed
-- booking, so the freed window fits the waitlisted service exactly. Only the
-- three new SET lines are added; the rest mirrors the live functions.

-- 1) Desk cancel + no-show (app calls this after cancelling/marking a booking).
CREATE OR REPLACE FUNCTION public.notify_waitlist_for_no_show(p_booking_id uuid)
 RETURNS TABLE(entry_id uuid, service_name text, salon_name text, booking_date date)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
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

  -- NB: this function's RETURNS TABLE has an OUT param named `booking_date`,
  -- so the subquery must alias the table and qualify columns — an unqualified
  -- `booking_date` is ambiguous (OUT var vs column) and errors at runtime.
  UPDATE public.booking_waitlist_entries
     SET status = 'notified', notified_at = now(), claim_token = gen_random_uuid(),
         offered_staff_id  = v_b.staff_id,
         offered_start_utc = v_b.start_time_utc,
         offered_end_utc   = v_b.end_time_utc
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

-- 2) Customer self-cancel via reminder token (the public cancel link).
CREATE OR REPLACE FUNCTION public.cancel_booking_as_customer(p_token_id uuid)
 RETURNS TABLE(ok boolean, code text, booking_id uuid)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_token   booking_reminder_tokens%ROWTYPE;
  v_booking bookings%ROWTYPE;
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

  UPDATE booking_waitlist_entries
  SET status = 'notified', notified_at = now(), claim_token = gen_random_uuid(),
      offered_staff_id  = v_booking.staff_id,
      offered_start_utc = v_booking.start_time_utc,
      offered_end_utc   = v_booking.end_time_utc
  WHERE id = (
    SELECT id FROM booking_waitlist_entries
    WHERE  salon_id = v_booking.salon_id
      AND  service_id = v_booking.service_id
      AND  booking_date = (v_booking.start_time_utc AT TIME ZONE 'UTC')::date
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
 RETURNS TABLE (ok boolean, code text, booking_id uuid)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE v_booking bookings%ROWTYPE;
BEGIN
  SELECT * INTO v_booking FROM bookings
  WHERE id = p_booking_id AND status IN ('pending','confirmed') FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false,'booking_not_cancellable'::text,NULL::uuid; RETURN; END IF;

  UPDATE bookings SET status = 'cancelled' WHERE id = v_booking.id;

  UPDATE booking_waitlist_entries
  SET status = 'notified', notified_at = now(), claim_token = gen_random_uuid(),
      offered_staff_id  = v_booking.staff_id,
      offered_start_utc = v_booking.start_time_utc,
      offered_end_utc   = v_booking.end_time_utc
  WHERE id = (
    SELECT id FROM booking_waitlist_entries
    WHERE salon_id = v_booking.salon_id AND service_id = v_booking.service_id
      AND booking_date = (v_booking.start_time_utc AT TIME ZONE 'UTC')::date AND status = 'waiting'
    ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
  );

  RETURN QUERY SELECT true,'ok'::text, v_booking.id;
END;
$function$;

-- cancel_booking_by_id stays service-role only (CREATE OR REPLACE keeps grants,
-- but re-assert defensively).
REVOKE ALL ON FUNCTION public.cancel_booking_by_id(uuid) FROM PUBLIC, anon, authenticated;
