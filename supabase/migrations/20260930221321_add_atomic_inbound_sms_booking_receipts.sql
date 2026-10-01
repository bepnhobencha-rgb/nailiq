-- Local foundation for signed inbound cancellation. No existing route is
-- rewired by this migration. Deploy only with explicit migration approval.
-- The server must verify the Twilio HMAC before invoking this service-only RPC.
-- Receipts retain opaque IDs after tenant deletion so an old SID cannot select
-- a newly created booking. No raw phone, SMS body or provider credential stored.
CREATE TABLE public.sms_inbound_booking_receipts (
  account_sid text NOT NULL CHECK (account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  message_sid text NOT NULL CHECK (message_sid ~ '^SM[0-9a-fA-F]{32}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  salon_id uuid,
  booking_id uuid,
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (account_sid, message_sid),
  CHECK ((salon_id IS NULL) = (booking_id IS NULL))
);
CREATE INDEX sms_inbound_booking_receipts_salon_created_idx
  ON public.sms_inbound_booking_receipts(salon_id, created_at DESC)
  WHERE salon_id IS NOT NULL;
ALTER TABLE public.sms_inbound_booking_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_inbound_booking_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sms_inbound_booking_receipts FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.reject_sms_inbound_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $immutable$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Inbound SMS receipts are immutable';
END;
$immutable$;
REVOKE ALL ON FUNCTION public.reject_sms_inbound_receipt_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER sms_inbound_receipts_immutable
  BEFORE UPDATE OR DELETE ON public.sms_inbound_booking_receipts
  FOR EACH ROW EXECUTE FUNCTION public.reject_sms_inbound_receipt_mutation();

-- Internal to the opt-in signed-SMS adapter. Do not replace the legacy public
-- cancellation/promotion functions: their deployed callers keep their contract.
-- An offer is not a reservation; the existing claim path must recheck capacity.
CREATE FUNCTION public.cancel_booking_with_verified_sms_waitlist(p_booking_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path TO ''
AS $verified_offer$
DECLARE
  v_booking public.bookings%ROWTYPE; v_entry public.booking_waitlist_entries%ROWTYPE;
  v_tz text; v_date date; v_local timestamp; v_label text; v_duration integer;
  v_buffer integer; v_outcome text; v_cap jsonb; v_offer jsonb; v_occurrence text;
  v_now timestamptz := transaction_timestamp(); v_customer_end timestamptz;
  v_expiry timestamptz; v_receipt public.waitlist_offer_promotion_receipts%ROWTYPE;
  v_prep integer; v_occupied_start timestamptz; v_occupied_end timestamptz;
  v_resources_enabled boolean; v_resource_mode text; v_required_kinds text[]; v_day text;
BEGIN
  IF coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;
  IF p_booking_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'invalid_request'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('waitlist-booking-promotion:' || p_booking_id::text, 0));
  SELECT * INTO v_booking FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'booking_not_found'); END IF;
  IF v_booking.status NOT IN ('pending', 'confirmed', 'cancelled') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'booking_not_cancellable');
  END IF;
  IF v_booking.status <> 'cancelled' THEN
    UPDATE public.bookings SET status = 'cancelled' WHERE id = v_booking.id RETURNING * INTO v_booking;
  END IF;
  -- Different pipeline fingerprint cannot replay an unverified legacy offer.
  v_occurrence := encode(extensions.digest(convert_to(jsonb_build_object(
    'pipeline', 'verified_signed_sms_v1', 'booking_id', v_booking.id,
    'status', v_booking.status, 'start_time_utc', v_booking.start_time_utc,
    'end_time_utc', v_booking.end_time_utc, 'waitlist_offer_version', v_booking.waitlist_offer_version,
    'customer_transition_version', v_booking.customer_transition_version)::text, 'UTF8'), 'sha256'), 'hex');
  SELECT * INTO v_receipt FROM public.waitlist_offer_promotion_receipts
    WHERE source_booking_id = v_booking.id AND occurrence_fingerprint = v_occurrence;
  IF FOUND THEN v_offer := v_receipt.result_json;
  ELSE
    v_offer := jsonb_build_object('ok', true, 'code', 'availability_unverified');
    SELECT nullif(trim(s.timezone), ''), coalesce(s.resources_enabled, false)
      INTO v_tz, v_resources_enabled FROM public.salons s WHERE s.id = v_booking.salon_id FOR SHARE;
    IF v_tz IS NOT NULL AND EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = v_tz)
      AND v_booking.staff_id IS NOT NULL AND v_booking.start_time_utc > v_now
      AND v_booking.end_time_utc > v_booking.start_time_utc THEN
      v_local := v_booking.start_time_utc AT TIME ZONE v_tz;
      v_date := v_local::date;
      v_label := to_char(v_local, 'FMHH12:MI AM');
      v_day := (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[extract(dow FROM v_date)::integer + 1];
      -- The evaluator accepts minute labels; never silently round seconds or
      -- select the other occurrence of an ambiguous daylight-saving time.
      IF date_trunc('minute', v_local) = v_local
        AND (v_local AT TIME ZONE v_tz) = v_booking.start_time_utc THEN
        SELECT s.duration_minutes, coalesce(s.buffer_minutes, 0), coalesce(s.prep_minutes, 0),
          coalesce(s.resource_requirement_mode, 'salon_default'), coalesce(s.required_resource_kinds, '{}'::text[])
          INTO v_duration, v_buffer, v_prep, v_resource_mode, v_required_kinds
          FROM public.services s WHERE s.id = v_booking.service_id AND s.salon_id = v_booking.salon_id
            AND s.deleted_at IS NULL AND NOT s.is_addon FOR SHARE;
        IF FOUND AND v_duration > 0 AND v_buffer >= 0 AND v_prep >= 0 THEN
          v_customer_end := v_booking.start_time_utc + make_interval(mins => v_duration);
          v_occupied_start := v_booking.start_time_utc - make_interval(mins => v_prep);
          v_occupied_end := v_customer_end + make_interval(mins => v_buffer);
          IF v_customer_end <= v_booking.end_time_utc THEN
            PERFORM pg_advisory_xact_lock(hashtextextended('waitlist-offer:' || v_booking.salon_id::text
              || ':' || v_booking.service_id::text || ':' || v_date::text, 0));
            v_offer := jsonb_build_object('ok', true, 'code', 'no_eligible_waiter');
            FOR v_entry IN SELECT w.* FROM public.booking_waitlist_entries w
              WHERE w.salon_id = v_booking.salon_id AND w.service_id = v_booking.service_id
                AND w.booking_date = v_date AND w.status = 'waiting'
              ORDER BY w.created_at, w.id FOR UPDATE SKIP LOCKED
            LOOP
              IF v_entry.staff_id IS NOT NULL AND v_entry.staff_id <> v_booking.staff_id THEN CONTINUE; END IF;
              -- Only a verified one-service individual intent can use this
              -- evaluator. Unknown/group/add-on intent remains waiting.
              IF v_entry.request_kind <> 'individual' OR v_entry.party_size <> 1 THEN CONTINUE; END IF;
              IF v_entry.intent_json <> '{}'::jsonb AND (
                v_entry.intent_json - ARRAY['serviceIds', 'staffPreference', 'source'] <> '{}'::jsonb
                OR v_entry.intent_json -> 'serviceIds' IS DISTINCT FROM jsonb_build_array(v_booking.service_id::text)
                OR (v_entry.intent_json ? 'staffPreference' AND v_entry.intent_json ->> 'staffPreference'
                  IS DISTINCT FROM coalesce(v_entry.staff_id::text, 'any'))
              ) THEN CONTINUE; END IF;
              IF nullif(trim(v_entry.preferred_slot_label), '') IS NOT NULL
                AND upper(regexp_replace(trim(v_entry.preferred_slot_label), '[[:space:]]+', ' ', 'g')) <> v_label
                THEN CONTINUE; END IF;
              -- Evaluate the offered technician, not Any Staff: an unrelated
              -- free technician cannot justify a bound claim for a busy one.
              SELECT c.outcome INTO v_outcome FROM public.evaluate_individual_waitlist_capacity(
                v_booking.salon_id, v_booking.service_id, v_booking.staff_id, v_date, v_label) c;
              IF v_outcome IS DISTINCT FROM 'slot_available' THEN
                v_offer := jsonb_build_object('ok', true, 'code',
                  CASE WHEN v_outcome = 'slot_unavailable' THEN 'slot_unavailable' ELSE 'availability_unverified' END);
                EXIT;
              END IF;
              -- Canonical individual availability covers customer time and
              -- trailing buffer. Add the prep interval; otherwise a catalog
              -- prep change could collide with an earlier appointment.
              IF (v_occupied_start AT TIME ZONE v_tz)::date <> v_date
                OR (v_occupied_end AT TIME ZONE v_tz)::date <> v_date
                OR EXISTS (SELECT 1 FROM public.bookings b WHERE b.salon_id = v_booking.salon_id
                  AND b.staff_id = v_booking.staff_id AND b.deleted_at IS NULL
                  AND b.status NOT IN ('cancelled','waiting','no_show','completed')
                  AND b.start_time_utc < v_occupied_end AND b.end_time_utc > v_occupied_start)
                OR EXISTS (SELECT 1 FROM public.booking_service_segments seg WHERE seg.salon_id = v_booking.salon_id
                  AND seg.staff_id = v_booking.staff_id AND seg.reservation_status NOT IN ('cancelled','no_show','completed')
                  AND seg.occupied_start_utc < v_occupied_end AND seg.occupied_end_utc > v_occupied_start)
                OR (EXISTS (SELECT 1 FROM public.staff_shifts s WHERE s.salon_id = v_booking.salon_id
                    AND s.staff_id = v_booking.staff_id AND s.day_of_week = v_day AND s.is_active)
                  AND NOT EXISTS (SELECT 1 FROM public.staff_shifts s WHERE s.salon_id = v_booking.salon_id
                    AND s.staff_id = v_booking.staff_id AND s.day_of_week = v_day AND s.is_active
                    AND s.start_time::time <= (v_occupied_start AT TIME ZONE v_tz)::time
                    AND s.end_time::time >= (v_occupied_end AT TIME ZONE v_tz)::time
                    AND NOT (s.break_start_time IS NOT NULL AND s.break_end_time IS NOT NULL
                      AND (v_occupied_start AT TIME ZONE v_tz)::time < s.break_end_time
                      AND (v_occupied_end AT TIME ZONE v_tz)::time > s.break_start_time)))
                OR (v_resources_enabled AND v_resource_mode <> 'none' AND NOT EXISTS (
                  SELECT 1 FROM public.salon_resources r WHERE r.salon_id = v_booking.salon_id
                    AND r.status = 'active' AND r.deleted_at IS NULL
                    AND (v_resource_mode <> 'specific' OR r.kind = ANY(v_required_kinds))
                    AND NOT EXISTS (SELECT 1 FROM public.bookings b WHERE b.salon_id = v_booking.salon_id
                      AND b.resource_id = r.id AND b.deleted_at IS NULL
                      AND b.status NOT IN ('cancelled','waiting','no_show','completed')
                      AND b.start_time_utc < v_occupied_end AND b.end_time_utc > v_occupied_start)
                    AND NOT EXISTS (SELECT 1 FROM public.booking_service_segments seg WHERE seg.salon_id = v_booking.salon_id
                      AND seg.resource_id = r.id AND seg.reservation_status NOT IN ('cancelled','no_show','completed')
                      AND seg.occupied_start_utc < v_occupied_end AND seg.occupied_end_utc > v_occupied_start))) THEN
                v_offer := jsonb_build_object('ok', true, 'code', 'slot_unavailable');
                EXIT;
              END IF;
              UPDATE public.booking_waitlist_entries SET status = 'notified', notified_at = v_now,
                claim_token = extensions.gen_random_uuid(), offered_staff_id = v_booking.staff_id,
                offered_start_utc = v_booking.start_time_utc, offered_end_utc = v_customer_end
                WHERE id = v_entry.id;
              v_expiry := least(v_now + interval '20 minutes', v_booking.start_time_utc);
              BEGIN
                v_cap := public.mint_waitlist_claim_capability(v_booking.salon_id, v_entry.id, v_expiry);
              EXCEPTION WHEN OTHERS THEN
                v_cap := jsonb_build_object('ok', false, 'code', 'mint_exception');
              END;
              IF v_cap ->> 'ok' IS DISTINCT FROM 'true' THEN
                UPDATE public.booking_waitlist_entries SET status = 'waiting', notified_at = NULL,
                  claim_token = NULL, offered_staff_id = NULL, offered_start_utc = NULL, offered_end_utc = NULL
                  WHERE id = v_entry.id AND status = 'notified' AND claimed_at IS NULL;
                v_offer := jsonb_build_object('ok', true, 'code', 'promotion_skipped');
              ELSE
                v_offer := jsonb_build_object('ok', true, 'code', 'promoted', 'waitlist_entry_id', v_entry.id,
                  'claim_capability_token', v_cap ->> 'token_id', 'offer_epoch', (v_cap ->> 'epoch')::bigint,
                  'expires_at', v_cap ->> 'expires_at');
              END IF;
              EXIT;
            END LOOP;
          ELSE v_offer := jsonb_build_object('ok', true, 'code', 'slot_unavailable');
          END IF;
        END IF;
      END IF;
    END IF;
    v_offer := v_offer || jsonb_build_object('booking_id', v_booking.id, 'salon_id', v_booking.salon_id, 'idempotent', false);
    -- Persist skips as well as offers. A replay must not choose a new waiter.
    INSERT INTO public.waitlist_offer_promotion_receipts(salon_id, source_booking_id, occurrence_fingerprint, result_json)
      VALUES(v_booking.salon_id, v_booking.id, v_occurrence, v_offer);
  END IF;
  RETURN jsonb_build_object('ok', true, 'code', 'ok', 'booking_id', v_booking.id,
    'promoted_waitlist', CASE WHEN v_offer ->> 'code' = 'promoted' THEN v_offer END,
    'waitlist_result_code', v_offer ->> 'code');
END;
$verified_offer$;
REVOKE ALL ON FUNCTION public.cancel_booking_with_verified_sms_waitlist(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.cancel_booking_from_signed_sms(
  p_account_sid text, p_message_sid text, p_from_phone text,
  p_to_phone text, p_body_sha256 text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $inbound_cancel$
DECLARE
  v_from text; v_to text; v_account text; v_sender text;
  v_fingerprint text; v_receipt public.sms_inbound_booking_receipts%ROWTYPE;
  v_booking public.bookings%ROWTYPE; v_selected public.bookings%ROWTYPE;
  v_salon_count integer; v_result jsonb;
  v_cancel jsonb; v_now timestamptz;
BEGIN
  -- EXECUTE is denied to browser roles; JWT role is an additional backstop.
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
    'version', 1, 'action', 'booking_cancel', 'account', p_account_sid,
    'from', v_from, 'to', v_to, 'body_sha256', p_body_sha256)::text, 'UTF8'), 'sha256'), 'hex');
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
  -- Serialize distinct commands from one phone; each SID independently retains
  -- its first result. This does not claim the caller meant the next salon.
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
    -- Preserve the existing five-booking reminder preference within one salon.
    SELECT b.* INTO v_booking FROM public.bookings b JOIN (
      SELECT q.id, q.start_time_utc, q.reminder_24h_sent_at, q.reminder_3h_sent_at
      FROM public.bookings q WHERE q.client_phone = v_from
        AND q.status IN ('pending', 'confirmed') AND q.deleted_at IS NULL
        AND q.start_time_utc >= v_now ORDER BY q.start_time_utc, q.id LIMIT 5
    ) c ON c.id = b.id
    ORDER BY (c.reminder_24h_sent_at IS NOT NULL OR c.reminder_3h_sent_at IS NOT NULL) DESC,
      c.start_time_utc, c.id LIMIT 1;
    IF v_booking.id IS NULL THEN
      -- A committed no-target receipt must not later pick a new appointment.
      v_result := jsonb_build_object('ok', true, 'code', 'not_found', 'idempotent', false);
    ELSE
    v_selected := v_booking;
    -- Use the cancellation RPC's lock order: advisory lock BEFORE booking row.
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
      OR v_booking.deleted_at IS NOT NULL
      OR v_booking.start_time_utc < clock_timestamp()
      OR v_booking.status NOT IN ('pending', 'confirmed', 'cancelled') THEN
      -- Pin the original opaque IDs even if the row moved or disappeared.
      -- A 40001 here loses the target; a provider retry could cancel the next
      -- booking. A durable no-mutation result prevents that retargeting.
      v_booking := v_selected;
      v_result := jsonb_build_object('ok', true, 'code', 'booking_changed', 'idempotent', false,
        'booking_id', v_selected.id, 'salon_id', v_selected.salon_id);
    ELSIF v_booking.status = 'cancelled' THEN
      v_result := jsonb_build_object('ok', true, 'code', 'already_cancelled', 'idempotent', false,
        'booking_id', v_selected.id, 'salon_id', v_selected.salon_id);
    ELSE
    -- Revalidate the global ambiguity gate after obtaining the booking lock.
    IF EXISTS (SELECT 1 FROM public.bookings b WHERE b.client_phone = v_from
      AND b.salon_id <> v_booking.salon_id AND b.status IN ('pending', 'confirmed')
      AND b.deleted_at IS NULL AND b.start_time_utc >= clock_timestamp()) THEN
      v_booking.id := NULL; v_booking.salon_id := NULL;
      v_result := jsonb_build_object('ok', true, 'code', 'ambiguous_salon', 'idempotent', false);
    ELSE
      v_cancel := public.cancel_booking_with_verified_sms_waitlist(v_booking.id);
      IF v_cancel ->> 'ok' IS DISTINCT FROM 'true' OR v_cancel ->> 'code' IS DISTINCT FROM 'ok'
        OR v_cancel ->> 'booking_id' IS DISTINCT FROM v_booking.id::text THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Inbound cancellation not committed';
      END IF;
      v_result := jsonb_build_object('ok', true, 'code', 'applied', 'idempotent', false,
        'booking_id', v_booking.id, 'salon_id', v_booking.salon_id,
        'promoted_waitlist', v_cancel -> 'promoted_waitlist',
        'waitlist_result_code', v_cancel ->> 'waitlist_result_code');
      INSERT INTO public.booking_events(booking_id, salon_id, actor_role, event_type, payload)
      VALUES(v_booking.id, v_booking.salon_id, 'public_guest', 'booking_cancelled',
        jsonb_build_object('reason', 'sms_cancel', 'command_fingerprint', v_fingerprint));
      INSERT INTO public.booking_notifications(booking_id, salon_id, notification_type,
        channel, status, twilio_message_sid, body_preview, sent_at)
      VALUES(v_booking.id, v_booking.salon_id, 'inbound_cancel', 'sms', 'sent',
        p_message_sid, 'Inbound cancellation processed', transaction_timestamp());
    END IF;
    END IF;
    END IF;
  END IF;
  INSERT INTO public.sms_inbound_booking_receipts(account_sid, message_sid, request_fingerprint,
    salon_id, booking_id, result_json)
  VALUES(p_account_sid, p_message_sid, v_fingerprint, v_booking.salon_id, v_booking.id, v_result);
  RETURN v_result;
END;
$inbound_cancel$;
REVOKE ALL ON FUNCTION public.cancel_booking_from_signed_sms(text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_booking_from_signed_sms(text,text,text,text,text) TO service_role;
COMMENT ON FUNCTION public.cancel_booking_from_signed_sms(text,text,text,text,text) IS
  'Server-only signed inbound cancellation; replay receipt, domain change and promotion commit atomically. No provider calls.';

-- Rollback boundary: disable the new route adapter first (not yet wired).
-- With separately approved rollback, remove RPC/trigger/table only after
-- exporting private receipts. Never drop populated receipts blindly: removing
-- them would let a retried historical SID choose a different booking.
