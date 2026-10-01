-- Additive, service-only signed SMS confirmation. Shares the immutable receipt
-- ledger with cancellation: one provider SID cannot become a different action.
-- The HTTP adapter MUST authenticate Twilio's HMAC before invoking this RPC.
-- No provider call, waitlist promotion, payment or new booking is performed.
CREATE FUNCTION public.confirm_booking_from_signed_sms(
  p_account_sid text, p_message_sid text, p_from_phone text,
  p_to_phone text, p_body_sha256 text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $inbound_confirm$
DECLARE
  v_from text; v_to text; v_account text; v_sender text; v_fingerprint text;
  v_receipt public.sms_inbound_booking_receipts%ROWTYPE;
  v_booking public.bookings%ROWTYPE; v_selected public.bookings%ROWTYPE;
  v_salon_count integer; v_result jsonb; v_now timestamptz;
BEGIN
  IF coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;
  v_from := public.canonical_phone(p_from_phone);
  v_to := public.canonical_phone(p_to_phone);
  IF p_account_sid IS NULL OR p_account_sid !~ '^AC[0-9a-fA-F]{32}$'
    OR p_message_sid IS NULL OR p_message_sid !~ '^SM[0-9a-fA-F]{32}$'
    OR p_body_sha256 IS NULL OR p_body_sha256 !~ '^[0-9a-f]{64}$'
    OR v_from IS NULL OR v_from !~ '^[1-9][0-9]{9,14}$'
    OR v_to IS NULL OR v_to !~ '^[1-9][0-9]{9,14}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_request');
  END IF;
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'version', 1, 'action', 'booking_confirm', 'account', p_account_sid,
    'from', v_from, 'to', v_to, 'body_sha256', p_body_sha256)::text, 'UTF8'), 'sha256'), 'hex');
  -- Same lock order as cancellation: SID, phone, booking advisory, booking row.
  PERFORM pg_advisory_xact_lock(hashtextextended('inbound-sms:' || p_account_sid || ':' || p_message_sid, 0));
  SELECT * INTO v_receipt FROM public.sms_inbound_booking_receipts
    WHERE account_sid = p_account_sid AND message_sid = p_message_sid;
  IF FOUND THEN
    IF v_receipt.request_fingerprint <> v_fingerprint THEN
      RETURN jsonb_build_object('ok', false, 'code', 'idempotency_mismatch');
    END IF;
    RETURN v_receipt.result_json || jsonb_build_object('idempotent', true);
  END IF;
  SELECT trim(s.twilio_account_sid), public.canonical_phone(s.twilio_phone_number)
    INTO v_account, v_sender FROM public.platform_settings s WHERE s.id = 'platform';
  IF v_account IS DISTINCT FROM p_account_sid OR v_sender IS DISTINCT FROM v_to THEN
    RETURN jsonb_build_object('ok', false, 'code', 'sender_unverified');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('inbound-sms-phone:' || p_account_sid || ':' || v_from, 0));
  v_now := clock_timestamp();
  SELECT count(DISTINCT b.salon_id) INTO v_salon_count FROM public.bookings b
    WHERE b.client_phone = v_from AND b.status IN ('pending', 'confirmed')
      AND b.deleted_at IS NULL AND b.start_time_utc >= v_now;
  IF v_salon_count > 1 THEN
    v_result := jsonb_build_object('ok', true, 'code', 'ambiguous_salon', 'idempotent', false);
  ELSIF v_salon_count = 0 THEN
    v_result := jsonb_build_object('ok', true, 'code', 'not_found', 'idempotent', false);
  ELSE
    -- Preserve the existing reminder preference; confirmation timestamps must
    -- not silently alter the target selection policy.
    SELECT b.* INTO v_selected FROM public.bookings b JOIN (
      SELECT q.id, q.start_time_utc, q.reminder_24h_sent_at, q.reminder_3h_sent_at
      FROM public.bookings q WHERE q.client_phone = v_from
        AND q.status IN ('pending', 'confirmed') AND q.deleted_at IS NULL
        AND q.start_time_utc >= v_now ORDER BY q.start_time_utc, q.id LIMIT 5
    ) c ON c.id = b.id
    ORDER BY (c.reminder_24h_sent_at IS NOT NULL OR c.reminder_3h_sent_at IS NOT NULL) DESC,
      c.start_time_utc, c.id LIMIT 1;
    IF v_selected.id IS NULL THEN
      v_result := jsonb_build_object('ok', true, 'code', 'not_found', 'idempotent', false);
    ELSE
      PERFORM pg_advisory_xact_lock(hashtextextended('waitlist-booking-promotion:' || v_selected.id::text, 0));
      SELECT b.* INTO v_booking FROM public.bookings b WHERE b.id = v_selected.id FOR UPDATE;
      IF NOT FOUND OR v_booking.salon_id IS DISTINCT FROM v_selected.salon_id
        OR v_booking.client_phone IS DISTINCT FROM v_from
        OR v_booking.service_id IS DISTINCT FROM v_selected.service_id
        OR v_booking.staff_id IS DISTINCT FROM v_selected.staff_id
        OR v_booking.resource_id IS DISTINCT FROM v_selected.resource_id
        OR v_booking.start_time_utc IS DISTINCT FROM v_selected.start_time_utc
        OR v_booking.end_time_utc IS DISTINCT FROM v_selected.end_time_utc
        OR v_booking.price_cents IS DISTINCT FROM v_selected.price_cents
        OR v_booking.deleted_at IS NOT NULL OR v_booking.start_time_utc < clock_timestamp()
        OR v_booking.status NOT IN ('pending', 'confirmed') THEN
        -- Pin the originally selected IDs on drift; do not let retries retarget.
        v_booking := v_selected;
        v_result := jsonb_build_object('ok', true, 'code', 'booking_changed', 'idempotent', false,
          'booking_id', v_selected.id, 'salon_id', v_selected.salon_id);
      ELSIF EXISTS (SELECT 1 FROM public.bookings b WHERE b.client_phone = v_from
        AND b.salon_id <> v_booking.salon_id AND b.status IN ('pending', 'confirmed')
        AND b.deleted_at IS NULL AND b.start_time_utc >= clock_timestamp()) THEN
        v_booking.id := NULL; v_booking.salon_id := NULL;
        v_result := jsonb_build_object('ok', true, 'code', 'ambiguous_salon', 'idempotent', false);
      ELSIF v_booking.status = 'confirmed' THEN
        v_result := jsonb_build_object('ok', true, 'code', 'already_confirmed', 'idempotent', false,
          'booking_id', v_booking.id, 'salon_id', v_booking.salon_id);
      ELSE
        UPDATE public.bookings SET status = 'confirmed', confirmed_at = coalesce(confirmed_at, transaction_timestamp())
          WHERE id = v_booking.id AND salon_id = v_booking.salon_id AND status = 'pending';
        IF NOT FOUND THEN
          RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Inbound confirmation not committed';
        END IF;
        INSERT INTO public.booking_events(booking_id, salon_id, actor_role, event_type, payload)
          VALUES(v_booking.id, v_booking.salon_id, 'public_guest', 'booking_confirmed',
            jsonb_build_object('reason', 'sms_confirm', 'command_fingerprint', v_fingerprint));
        INSERT INTO public.booking_notifications(booking_id, salon_id, notification_type,
          channel, status, twilio_message_sid, body_preview, sent_at)
          VALUES(v_booking.id, v_booking.salon_id, 'inbound_confirm', 'sms', 'sent',
            p_message_sid, 'Inbound confirmation processed', transaction_timestamp());
        v_result := jsonb_build_object('ok', true, 'code', 'applied', 'idempotent', false,
          'booking_id', v_booking.id, 'salon_id', v_booking.salon_id);
      END IF;
    END IF;
  END IF;
  INSERT INTO public.sms_inbound_booking_receipts(account_sid, message_sid, request_fingerprint,
    salon_id, booking_id, result_json)
    VALUES(p_account_sid, p_message_sid, v_fingerprint, v_booking.salon_id, v_booking.id, v_result);
  RETURN v_result;
END;
$inbound_confirm$;
REVOKE ALL ON FUNCTION public.confirm_booking_from_signed_sms(text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_booking_from_signed_sms(text,text,text,text,text) TO service_role;
COMMENT ON FUNCTION public.confirm_booking_from_signed_sms(text,text,text,text,text) IS
  'Service-only signed inbound confirmation. Immutable SID receipt, booking transition and audit commit atomically. No provider calls.';
-- Rollback: set NAILIQ_ATOMIC_INBOUND_SMS_CONFIRM OFF first. Separately approved
-- removal may drop this function, never the shared populated receipt ledger.
-- This migration does not enable the adapter or change any live salon policy.
