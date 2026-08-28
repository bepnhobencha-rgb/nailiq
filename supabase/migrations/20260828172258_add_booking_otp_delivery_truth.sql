-- Durable delivery truth for booking OTP messages.
--
-- This ledger deliberately stores no phone numbers, email addresses, OTP codes,
-- subjects, or message bodies. The application writes only an irreversible
-- recipient fingerprint plus provider correlation IDs. Browser roles and even
-- direct service_role table access are denied; narrowly scoped RPCs are the
-- only mutation surface.

CREATE TABLE public.booking_otp_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  provider_name text NOT NULL CHECK (provider_name IN ('twilio_verify', 'resend')),
  recipient_fingerprint text NOT NULL
    CHECK (recipient_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'sending' CHECK (status IN (
    'sending', 'provider_accepted', 'delivery_delayed', 'delivered',
    'failed', 'undelivered', 'suppressed', 'bounced', 'complained', 'unknown'
  )),
  provider_request_id text CHECK (
    provider_request_id IS NULL OR provider_request_id ~ '^[!-~]{1,255}$'
  ),
  provider_attempt_id text CHECK (
    provider_attempt_id IS NULL OR provider_attempt_id ~ '^[!-~]{1,255}$'
  ),
  error_code text CHECK (
    error_code IS NULL OR (
      length(error_code) BETWEEN 1 AND 120
      AND error_code !~ '[[:cntrl:]]'
      AND error_code !~ '@'
    )
  ),
  accepted_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT booking_otp_delivery_provider_check CHECK (
    (channel = 'sms' AND provider_name = 'twilio_verify')
    OR (channel = 'email' AND provider_name = 'resend')
  ),
  CONSTRAINT booking_otp_delivery_timestamp_check CHECK (
    (accepted_at IS NULL OR accepted_at >= created_at)
    AND (delivered_at IS NULL OR delivered_at >= created_at)
    AND (failed_at IS NULL OR failed_at >= created_at)
    AND (verified_at IS NULL OR verified_at >= created_at)
    AND updated_at >= created_at
  )
);

CREATE UNIQUE INDEX booking_otp_delivery_provider_request_once
  ON public.booking_otp_delivery_attempts (provider_name, provider_request_id)
  WHERE provider_request_id IS NOT NULL;
CREATE UNIQUE INDEX booking_otp_delivery_provider_attempt_once
  ON public.booking_otp_delivery_attempts (provider_name, provider_attempt_id)
  WHERE provider_attempt_id IS NOT NULL;
CREATE INDEX booking_otp_delivery_identity_recent_idx
  ON public.booking_otp_delivery_attempts (
    salon_id, channel, recipient_fingerprint, created_at DESC, id
  );
CREATE INDEX booking_otp_delivery_unresolved_idx
  ON public.booking_otp_delivery_attempts (created_at, id)
  WHERE status IN ('sending', 'provider_accepted', 'delivery_delayed', 'unknown');

ALTER TABLE public.email_otp_codes
  ADD COLUMN delivery_attempt_id uuid
  REFERENCES public.booking_otp_delivery_attempts(id) ON DELETE SET NULL;
CREATE INDEX email_otp_codes_delivery_attempt_idx
  ON public.email_otp_codes (delivery_attempt_id)
  WHERE delivery_attempt_id IS NOT NULL;

CREATE TABLE public.resend_booking_otp_delivery_events (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  provider_event_id text NOT NULL UNIQUE
    CHECK (provider_event_id ~ '^[!-~]{1,255}$'),
  delivery_attempt_id uuid NOT NULL,
  provider_message_id text NOT NULL
    CHECK (provider_message_id ~ '^[!-~]{1,255}$'),
  event_type text NOT NULL CHECK (event_type IN (
    'email.sent', 'email.delivered', 'email.delivery_delayed',
    'email.failed', 'email.suppressed', 'email.bounced', 'email.complained'
  )),
  delivery_status text NOT NULL CHECK (delivery_status IN (
    'provider_accepted', 'delivery_delayed', 'delivered',
    'failed', 'suppressed', 'bounced', 'complained'
  )),
  recipient_fingerprint text NOT NULL
    CHECK (recipient_fingerprint ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  payload_fingerprint text NOT NULL
    CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  salon_id uuid REFERENCES public.salons(id) ON DELETE CASCADE,
  match_error text CHECK (
    match_error IS NULL OR (
      length(match_error) BETWEEN 1 AND 120 AND match_error !~ '[[:cntrl:]]'
    )
  ),
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  applied_at timestamptz,
  CONSTRAINT resend_booking_otp_event_application_check CHECK (
    (applied_at IS NULL AND salon_id IS NULL)
    OR (applied_at IS NOT NULL AND salon_id IS NOT NULL)
  )
);

CREATE INDEX resend_booking_otp_events_pending_idx
  ON public.resend_booking_otp_delivery_events (
    delivery_attempt_id, occurred_at, received_at, id
  ) WHERE applied_at IS NULL AND match_error IS NULL;
CREATE INDEX resend_booking_otp_events_salon_received_idx
  ON public.resend_booking_otp_delivery_events (salon_id, received_at DESC, id)
  WHERE salon_id IS NOT NULL;

ALTER TABLE public.booking_otp_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_otp_delivery_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.resend_booking_otp_delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resend_booking_otp_delivery_events FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.booking_otp_delivery_attempts
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.resend_booking_otp_delivery_events
  FROM PUBLIC, anon, authenticated, service_role;

CREATE POLICY "deny browser access to booking OTP delivery attempts"
  ON public.booking_otp_delivery_attempts AS RESTRICTIVE
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny browser access to Resend booking OTP delivery events"
  ON public.resend_booking_otp_delivery_events AS RESTRICTIVE
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.create_booking_otp_delivery_attempt(
  p_salon_id uuid,
  p_channel text,
  p_recipient_fingerprint text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $create$
DECLARE
  v_id uuid;
BEGIN
  IF p_salon_id IS NULL
     OR p_channel NOT IN ('sms', 'email')
     OR p_recipient_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.booking_otp_delivery_attempts (
    salon_id, channel, provider_name, recipient_fingerprint
  ) VALUES (
    p_salon_id,
    p_channel,
    CASE p_channel WHEN 'sms' THEN 'twilio_verify' ELSE 'resend' END,
    p_recipient_fingerprint
  ) RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION
  WHEN foreign_key_violation THEN RETURN NULL;
END;
$create$;

CREATE OR REPLACE FUNCTION public.complete_booking_otp_delivery_attempt(
  p_attempt_id uuid,
  p_status text,
  p_provider_request_id text DEFAULT NULL,
  p_provider_attempt_id text DEFAULT NULL,
  p_error_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $complete$
DECLARE
  v_attempt public.booking_otp_delivery_attempts%ROWTYPE;
  v_request_id text := nullif(trim(coalesce(p_provider_request_id, '')), '');
  v_provider_attempt_id text := nullif(trim(coalesce(p_provider_attempt_id, '')), '');
  v_error text := nullif(trim(coalesce(p_error_code, '')), '');
  v_status text;
BEGIN
  IF p_attempt_id IS NULL
     OR p_status NOT IN ('provider_accepted', 'failed', 'suppressed', 'unknown')
     OR (v_request_id IS NOT NULL AND v_request_id !~ '^[!-~]{1,255}$')
     OR (v_provider_attempt_id IS NOT NULL AND v_provider_attempt_id !~ '^[!-~]{1,255}$')
     OR (v_error IS NOT NULL AND (
       length(v_error) > 120 OR v_error ~ '[[:cntrl:]]' OR v_error ~ '@'
     )) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_completion');
  END IF;

  SELECT a.* INTO v_attempt
  FROM public.booking_otp_delivery_attempts a
  WHERE a.id = p_attempt_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'attempt_not_found');
  END IF;

  IF (v_attempt.provider_request_id IS NOT NULL
        AND v_request_id IS NOT NULL
        AND v_attempt.provider_request_id <> v_request_id)
     OR (v_attempt.provider_attempt_id IS NOT NULL
        AND v_provider_attempt_id IS NOT NULL
        AND v_attempt.provider_attempt_id <> v_provider_attempt_id) THEN
    RETURN jsonb_build_object('success', false, 'code', 'provider_identity_conflict');
  END IF;

  -- A signed provider receipt or a customer-entered code can win the race with
  -- request completion. Never downgrade that stronger evidence.
  v_status := CASE
    WHEN v_attempt.verified_at IS NOT NULL THEN 'delivered'
    WHEN v_attempt.status IN (
      'delivered', 'failed', 'undelivered', 'suppressed', 'bounced', 'complained'
    ) THEN v_attempt.status
    ELSE p_status
  END;

  UPDATE public.booking_otp_delivery_attempts a
  SET status = v_status,
      provider_request_id = coalesce(a.provider_request_id, v_request_id),
      provider_attempt_id = coalesce(a.provider_attempt_id, v_provider_attempt_id),
      error_code = CASE
        WHEN v_status IN ('failed', 'suppressed', 'unknown')
          THEN coalesce(v_error, a.error_code)
        ELSE a.error_code END,
      accepted_at = CASE
        WHEN p_status = 'provider_accepted'
          THEN coalesce(a.accepted_at, transaction_timestamp())
        ELSE a.accepted_at END,
      failed_at = CASE
        WHEN v_status IN ('failed', 'suppressed')
          THEN coalesce(a.failed_at, transaction_timestamp())
        ELSE a.failed_at END,
      updated_at = transaction_timestamp()
  WHERE a.id = p_attempt_id;

  RETURN jsonb_build_object(
    'success', true,
    'code', CASE WHEN v_status = p_status THEN 'completed' ELSE 'stronger_state_preserved' END,
    'status', v_status
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'provider_identity_conflict');
END;
$complete$;

CREATE OR REPLACE FUNCTION public.mark_booking_otp_delivery_verified(
  p_salon_id uuid,
  p_channel text,
  p_recipient_fingerprint text,
  p_attempt_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $verified$
DECLARE
  v_id uuid;
BEGIN
  IF p_salon_id IS NULL
     OR p_channel NOT IN ('sms', 'email')
     OR p_recipient_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_attempt_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT a.id INTO v_id
  FROM public.booking_otp_delivery_attempts a
  WHERE a.salon_id = p_salon_id
    AND a.channel = p_channel
    AND a.recipient_fingerprint = p_recipient_fingerprint
    AND a.id = p_attempt_id
    AND a.created_at >= transaction_timestamp() - interval '15 minutes'
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE public.booking_otp_delivery_attempts a
  SET status = 'delivered',
      delivered_at = coalesce(a.delivered_at, transaction_timestamp()),
      verified_at = coalesce(a.verified_at, transaction_timestamp()),
      updated_at = transaction_timestamp()
  WHERE a.id = v_id;
  RETURN v_id;
END;
$verified$;

CREATE OR REPLACE FUNCTION public.record_resend_booking_otp_delivery_event(
  p_delivery_attempt_id uuid,
  p_provider_event_id text,
  p_provider_message_id text,
  p_event_type text,
  p_recipient_fingerprint text,
  p_occurred_at timestamptz,
  p_payload_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $record$
DECLARE
  v_event public.resend_booking_otp_delivery_events%ROWTYPE;
  v_attempt public.booking_otp_delivery_attempts%ROWTYPE;
  v_event_id text := trim(coalesce(p_provider_event_id, ''));
  v_message_id text := trim(coalesce(p_provider_message_id, ''));
  v_status text;
  v_inserted boolean := false;
BEGIN
  v_status := CASE p_event_type
    WHEN 'email.sent' THEN 'provider_accepted'
    WHEN 'email.delivery_delayed' THEN 'delivery_delayed'
    WHEN 'email.delivered' THEN 'delivered'
    WHEN 'email.failed' THEN 'failed'
    WHEN 'email.suppressed' THEN 'suppressed'
    WHEN 'email.bounced' THEN 'bounced'
    WHEN 'email.complained' THEN 'complained'
    ELSE NULL END;

  IF p_delivery_attempt_id IS NULL
     OR v_event_id !~ '^[!-~]{1,255}$'
     OR v_message_id !~ '^[!-~]{1,255}$'
     OR v_status IS NULL
     OR p_recipient_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_occurred_at IS NULL
     OR p_occurred_at > transaction_timestamp() + interval '5 minutes'
     OR p_occurred_at < transaction_timestamp() - interval '30 days'
     OR p_payload_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_event');
  END IF;

  INSERT INTO public.resend_booking_otp_delivery_events (
    provider_event_id, delivery_attempt_id, provider_message_id,
    event_type, delivery_status, recipient_fingerprint,
    occurred_at, payload_fingerprint
  ) VALUES (
    v_event_id, p_delivery_attempt_id, v_message_id,
    p_event_type, v_status, p_recipient_fingerprint,
    p_occurred_at, p_payload_fingerprint
  )
  ON CONFLICT (provider_event_id) DO NOTHING
  RETURNING * INTO v_event;
  v_inserted := FOUND;

  IF NOT v_inserted THEN
    SELECT e.* INTO v_event
    FROM public.resend_booking_otp_delivery_events e
    WHERE e.provider_event_id = v_event_id
    FOR UPDATE;
    IF v_event.delivery_attempt_id <> p_delivery_attempt_id
       OR v_event.provider_message_id <> v_message_id
       OR v_event.event_type <> p_event_type
       OR v_event.recipient_fingerprint <> p_recipient_fingerprint
       OR v_event.occurred_at <> p_occurred_at
       OR v_event.payload_fingerprint <> p_payload_fingerprint THEN
      RETURN jsonb_build_object('success', false, 'code', 'event_conflict');
    END IF;
    IF v_event.applied_at IS NOT NULL OR v_event.match_error IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', true,
        'code', CASE WHEN v_event.applied_at IS NOT NULL
          THEN 'event_replay' ELSE 'event_rejected' END
      );
    END IF;
  END IF;

  SELECT a.* INTO v_attempt
  FROM public.booking_otp_delivery_attempts a
  WHERE a.id = p_delivery_attempt_id AND a.channel = 'email'
  FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE public.resend_booking_otp_delivery_events
    SET match_error = 'attempt_not_found'
    WHERE provider_event_id = v_event_id;
    RETURN jsonb_build_object('success', true, 'code', 'event_rejected');
  END IF;

  IF v_attempt.recipient_fingerprint <> p_recipient_fingerprint THEN
    UPDATE public.resend_booking_otp_delivery_events
    SET match_error = 'recipient_mismatch'
    WHERE provider_event_id = v_event_id;
    RETURN jsonb_build_object('success', true, 'code', 'event_rejected');
  END IF;
  IF v_attempt.provider_request_id IS NOT NULL
     AND v_attempt.provider_request_id <> v_message_id THEN
    UPDATE public.resend_booking_otp_delivery_events
    SET match_error = 'provider_message_conflict'
    WHERE provider_event_id = v_event_id;
    RETURN jsonb_build_object('success', true, 'code', 'event_rejected');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_message_id, 913407)
  );
  IF EXISTS (
    SELECT 1 FROM public.booking_otp_delivery_attempts a
    WHERE a.provider_name = 'resend'
      AND a.provider_request_id = v_message_id
      AND a.id <> p_delivery_attempt_id
  ) THEN
    UPDATE public.resend_booking_otp_delivery_events
    SET match_error = 'provider_message_conflict'
    WHERE provider_event_id = v_event_id;
    RETURN jsonb_build_object('success', true, 'code', 'event_rejected');
  END IF;

  UPDATE public.booking_otp_delivery_attempts a
  SET provider_request_id = coalesce(a.provider_request_id, v_message_id),
      status = CASE
        WHEN a.verified_at IS NOT NULL THEN 'delivered'
        WHEN v_status IN ('failed', 'suppressed', 'bounced', 'complained')
          THEN v_status
        WHEN a.status IN ('failed', 'suppressed', 'bounced', 'complained')
          THEN a.status
        WHEN v_status = 'delivered' THEN 'delivered'
        WHEN a.status = 'delivered' THEN 'delivered'
        WHEN v_status = 'delivery_delayed' THEN 'delivery_delayed'
        ELSE 'provider_accepted' END,
      accepted_at = CASE WHEN v_status = 'provider_accepted'
        THEN coalesce(a.accepted_at, greatest(p_occurred_at, a.created_at))
        ELSE a.accepted_at END,
      delivered_at = CASE WHEN v_status = 'delivered'
        THEN coalesce(a.delivered_at, greatest(p_occurred_at, a.created_at))
        ELSE a.delivered_at END,
      failed_at = CASE WHEN v_status IN (
        'failed', 'suppressed', 'bounced', 'complained'
      ) THEN coalesce(a.failed_at, greatest(p_occurred_at, a.created_at))
        ELSE a.failed_at END,
      error_code = CASE WHEN v_status IN (
        'failed', 'suppressed', 'bounced', 'complained'
      ) THEN v_status ELSE a.error_code END,
      updated_at = greatest(a.updated_at, p_occurred_at)
  WHERE a.id = p_delivery_attempt_id;

  UPDATE public.resend_booking_otp_delivery_events e
  SET salon_id = v_attempt.salon_id,
      applied_at = transaction_timestamp()
  WHERE e.provider_event_id = v_event_id;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'event_applied',
    'delivery_attempt_id', p_delivery_attempt_id
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'event_conflict');
END;
$record$;

REVOKE ALL ON FUNCTION public.create_booking_otp_delivery_attempt(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_booking_otp_delivery_attempt(uuid, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_booking_otp_delivery_verified(uuid, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_resend_booking_otp_delivery_event(
  uuid, text, text, text, text, timestamptz, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_booking_otp_delivery_attempt(uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_booking_otp_delivery_attempt(uuid, text, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_booking_otp_delivery_verified(uuid, text, text, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_resend_booking_otp_delivery_event(
  uuid, text, text, text, text, timestamptz, text
) TO service_role;

COMMENT ON TABLE public.booking_otp_delivery_attempts IS
  'PII-free server-only truth for booking OTP provider acceptance, delivery and customer verification.';
COMMENT ON TABLE public.resend_booking_otp_delivery_events IS
  'Signed, replay-safe Resend receipts for booking OTP email attempts; no recipient address or content.';
