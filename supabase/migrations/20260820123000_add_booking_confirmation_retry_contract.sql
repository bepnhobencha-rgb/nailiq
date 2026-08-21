-- Additive, default-inert delivery state machine for booking confirmations.
-- No scheduler or application caller is enabled by this migration. Existing
-- confirmation writers continue to use booking_notifications unchanged.

ALTER TABLE public.booking_notifications
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS attempt_token uuid,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_disposition text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS provider_name text,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS payload_fingerprint text,
  ADD COLUMN IF NOT EXISTS recipient_fingerprint text,
  ADD COLUMN IF NOT EXISTS booking_material_fingerprint text,
  ADD COLUMN IF NOT EXISTS completion_fingerprint text,
  ADD COLUMN IF NOT EXISTS reconciliation_reason text;

COMMENT ON COLUMN public.booking_notifications.attempt_token IS
  'Opaque CAS token for the current tokenized confirmation attempt; never expose to browser roles.';
COMMENT ON COLUMN public.booking_notifications.failure_disposition IS
  'Server-derived retry disposition. Callers cannot choose whether a provider failure is retryable.';
COMMENT ON COLUMN public.booking_notifications.booking_material_fingerprint IS
  'SHA-256 of authoritative booking facts at the time the tokenized claim was created.';

DO $checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.booking_notifications'::regclass
      AND conname = 'booking_notifications_retry_attempt_count_check'
  ) THEN
    ALTER TABLE public.booking_notifications
      ADD CONSTRAINT booking_notifications_retry_attempt_count_check
      CHECK (attempt_count BETWEEN 1 AND 2) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.booking_notifications'::regclass
      AND conname = 'booking_notifications_retry_disposition_check'
  ) THEN
    ALTER TABLE public.booking_notifications
      ADD CONSTRAINT booking_notifications_retry_disposition_check
      CHECK (failure_disposition IN ('none', 'retryable_pre_acceptance', 'permanent'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.booking_notifications'::regclass
      AND conname = 'booking_notifications_retry_fingerprint_check'
  ) THEN
    ALTER TABLE public.booking_notifications
      ADD CONSTRAINT booking_notifications_retry_fingerprint_check
      CHECK (
        attempt_token IS NULL
        OR (
          payload_fingerprint ~ '^[0-9a-f]{64}$'
          AND recipient_fingerprint ~ '^[0-9a-f]{64}$'
          AND booking_material_fingerprint ~ '^[0-9a-f]{64}$'
          AND (completion_fingerprint IS NULL OR completion_fingerprint ~ '^[0-9a-f]{64}$')
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.booking_notifications'::regclass
      AND conname = 'booking_notifications_retry_state_check'
  ) THEN
    ALTER TABLE public.booking_notifications
      ADD CONSTRAINT booking_notifications_retry_state_check
      CHECK (
        attempt_token IS NULL
        OR (
          notification_type = 'booking_confirmation'
          AND channel IN ('sms', 'email')
          AND claimed_at IS NOT NULL
          AND expires_at IS NOT NULL
          AND (
            (status = 'sending' AND completed_at IS NULL AND completion_fingerprint IS NULL)
            OR (status <> 'sending' AND completed_at IS NOT NULL)
          )
          AND (
            next_attempt_at IS NULL
            OR (
              status = 'failed'
              AND failure_disposition = 'retryable_pre_acceptance'
              AND attempt_count < 2
              AND next_attempt_at < expires_at
            )
          )
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.booking_notifications'::regclass
      AND conname = 'booking_notifications_retry_receipt_check'
  ) THEN
    ALTER TABLE public.booking_notifications
      ADD CONSTRAINT booking_notifications_retry_receipt_check
      CHECK (
        attempt_token IS NULL
        OR status NOT IN ('sent', 'delivered')
        OR (
          nullif(trim(coalesce(provider_message_id, '')), '') IS NOT NULL
          AND provider_message_id = twilio_message_sid
          AND (
            (channel = 'sms' AND provider_message_id ~ '^(SM|MM)[0-9A-Fa-f]{32}$')
            OR (
              channel = 'email'
              AND length(provider_message_id) <= 255
              AND provider_message_id !~ '[[:cntrl:]]'
            )
          )
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.booking_notifications'::regclass
      AND conname = 'booking_notifications_retry_reason_check'
  ) THEN
    ALTER TABLE public.booking_notifications
      ADD CONSTRAINT booking_notifications_retry_reason_check
      CHECK (
        reconciliation_reason IS NULL
        OR reconciliation_reason IN (
          'retry_exhausted',
          'retry_window_expired',
          'stale_sending_outcome_unknown',
          'booking_ineligible',
          'consent_revoked',
          'material_changed',
          'recipient_changed'
        )
      ) NOT VALID;
  END IF;
END;
$checks$;

-- Existing rows all have failure_disposition='none', so this partial index is
-- empty at rollout. The external preflight still budgets the required table scan.
CREATE INDEX IF NOT EXISTS idx_booking_notifications_confirmation_retry_due
  ON public.booking_notifications (next_attempt_at, created_at, id)
  WHERE notification_type = 'booking_confirmation'
    AND status = 'failed'
    AND failure_disposition = 'retryable_pre_acceptance'
    AND attempt_count < 2;

CREATE TABLE IF NOT EXISTS public.booking_notification_delivery_events (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.booking_notifications(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  attempt_count integer NOT NULL CHECK (attempt_count BETWEEN 1 AND 2),
  transition text NOT NULL CHECK (transition IN (
    'claimed_initial', 'retry_scheduled', 'retry_leased', 'sent',
    'suppressed', 'unknown', 'permanent_failure', 'retry_exhausted',
    'stale_sending_unknown', 'material_conflict'
  )),
  error_code text,
  receipt_present boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT booking_notification_delivery_events_error_check
    CHECK (error_code IS NULL OR (length(error_code) <= 80 AND error_code !~ '[[:cntrl:]]')),
  CONSTRAINT booking_notification_delivery_events_once
    UNIQUE (claim_id, attempt_count, transition)
);

CREATE INDEX IF NOT EXISTS idx_booking_notification_delivery_events_salon_time
  ON public.booking_notification_delivery_events (salon_id, occurred_at DESC);

ALTER TABLE public.booking_notification_delivery_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.booking_notification_delivery_events
  FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.booking_notification_delivery_events TO service_role;

DO $event_policies$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.booking_notification_delivery_events'::regclass
      AND polname = 'deny direct api access to booking notification delivery events'
  ) THEN
    CREATE POLICY "deny direct api access to booking notification delivery events"
      ON public.booking_notification_delivery_events
      AS RESTRICTIVE FOR ALL TO anon, authenticated
      USING (false) WITH CHECK (false);
  END IF;
END;
$event_policies$;

-- Preserve authenticated salon-member reads of legacy dashboard columns while
-- ensuring browser roles cannot read CAS tokens/fingerprints or mutate rows.
REVOKE ALL PRIVILEGES ON TABLE public.booking_notifications FROM anon, authenticated;
GRANT SELECT (
  id, booking_id, salon_id, notification_type, channel, status, client_phone,
  twilio_message_sid, body_preview, sent_at, delivered_at, failed_at,
  error_message, created_at, error_code
) ON public.booking_notifications TO authenticated;
GRANT ALL PRIVILEGES ON TABLE public.booking_notifications TO service_role;

DO $notification_mutation_policies$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.booking_notifications'::regclass
      AND polname = 'deny direct confirmation notification inserts'
  ) THEN
    CREATE POLICY "deny direct confirmation notification inserts"
      ON public.booking_notifications AS RESTRICTIVE
      FOR INSERT TO anon, authenticated WITH CHECK (false);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.booking_notifications'::regclass
      AND polname = 'deny direct confirmation notification updates'
  ) THEN
    CREATE POLICY "deny direct confirmation notification updates"
      ON public.booking_notifications AS RESTRICTIVE
      FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.booking_notifications'::regclass
      AND polname = 'deny direct confirmation notification deletes'
  ) THEN
    CREATE POLICY "deny direct confirmation notification deletes"
      ON public.booking_notifications AS RESTRICTIVE
      FOR DELETE TO anon, authenticated USING (false);
  END IF;
END;
$notification_mutation_policies$;

CREATE OR REPLACE FUNCTION public.claim_booking_confirmation_delivery(
  p_salon_id uuid,
  p_booking_id uuid,
  p_channel text,
  p_payload_fingerprint text,
  p_recipient_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $claim$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_claim public.booking_notifications%ROWTYPE;
  v_recipient text;
  v_expected_recipient_fingerprint text;
  v_material_fingerprint text;
  v_now timestamptz := transaction_timestamp();
  v_expires_at timestamptz;
  v_token uuid;
BEGIN
  IF p_salon_id IS NULL OR p_booking_id IS NULL
     OR p_channel NOT IN ('sms', 'email')
     OR coalesce(p_payload_fingerprint, '') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_recipient_fingerprint, '') !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_claim');
  END IF;

  SELECT b.* INTO v_booking
  FROM public.bookings b
  WHERE b.id = p_booking_id AND b.salon_id = p_salon_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'booking_not_found');
  END IF;

  IF v_booking.deleted_at IS NOT NULL OR v_booking.status <> 'confirmed' THEN
    RETURN jsonb_build_object('success', false, 'code', 'booking_ineligible');
  END IF;

  v_recipient := CASE p_channel
    WHEN 'sms' THEN nullif(regexp_replace(coalesce(v_booking.client_phone, ''), '\D', '', 'g'), '')
    ELSE nullif(lower(trim(coalesce(v_booking.client_email, ''))), '')
  END;
  IF v_recipient IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'recipient_missing');
  END IF;
  IF p_channel = 'sms' AND v_booking.sms_consent_at IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'consent_missing');
  END IF;

  v_expected_recipient_fingerprint := encode(
    extensions.digest(pg_catalog.convert_to(v_recipient, 'UTF8'), 'sha256'), 'hex'
  );
  IF p_recipient_fingerprint <> v_expected_recipient_fingerprint THEN
    RETURN jsonb_build_object('success', false, 'code', 'recipient_fingerprint_mismatch');
  END IF;

  v_material_fingerprint := encode(extensions.digest(pg_catalog.convert_to(
    jsonb_build_object(
      'booking_id', v_booking.id,
      'salon_id', v_booking.salon_id,
      'service_id', v_booking.service_id,
      'staff_id', v_booking.staff_id,
      'status', v_booking.status,
      'deleted_at_epoch', extract(epoch FROM v_booking.deleted_at),
      'start_epoch', extract(epoch FROM v_booking.start_time_utc),
      'end_epoch', extract(epoch FROM v_booking.end_time_utc),
      'client_name', v_booking.client_name,
      'client_phone', regexp_replace(coalesce(v_booking.client_phone, ''), '\D', '', 'g'),
      'client_email', nullif(lower(trim(coalesce(v_booking.client_email, ''))), ''),
      'sms_consent_epoch', extract(epoch FROM v_booking.sms_consent_at),
      'sms_consent_meta', v_booking.sms_consent_meta,
      'price_cents', v_booking.price_cents,
      'subtotal_cents', v_booking.subtotal_cents,
      'tax_amount_cents', v_booking.tax_amount_cents,
      'group_id', v_booking.group_id,
      'pricing_fingerprint', v_booking.public_booking_pricing_fingerprint,
      'pricing_snapshot', v_booking.public_booking_pricing_snapshot
    )::text, 'UTF8'), 'sha256'), 'hex');

  v_expires_at := least(
    v_now + interval '30 minutes',
    coalesce(v_booking.start_time_utc - interval '30 minutes', v_now + interval '30 minutes')
  );
  v_token := extensions.gen_random_uuid();

  INSERT INTO public.booking_notifications (
    booking_id, salon_id, notification_type, channel, status,
    client_phone, sent_at, failed_at, error_message, error_code,
    attempt_count, attempt_token, claimed_at, updated_at, completed_at,
    next_attempt_at, expires_at, failure_disposition, provider_name,
    provider_message_id, payload_fingerprint, recipient_fingerprint,
    booking_material_fingerprint, completion_fingerprint, reconciliation_reason
  ) VALUES (
    p_booking_id, p_salon_id, 'booking_confirmation', p_channel, 'sending',
    CASE WHEN p_channel = 'sms' THEN v_booking.client_phone ELSE NULL END,
    NULL, NULL, NULL, NULL,
    1, v_token, v_now, v_now, NULL,
    NULL, v_expires_at, 'none',
    CASE p_channel WHEN 'sms' THEN 'twilio' ELSE 'resend' END,
    NULL, p_payload_fingerprint, p_recipient_fingerprint,
    v_material_fingerprint, NULL, NULL
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_claim;

  IF FOUND THEN
    INSERT INTO public.booking_notification_delivery_events (
      claim_id, booking_id, salon_id, channel, attempt_count, transition
    ) VALUES (v_claim.id, p_booking_id, p_salon_id, p_channel, 1, 'claimed_initial')
    ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object(
      'success', true, 'code', 'claimed', 'claimed', true,
      'claim_id', v_claim.id, 'attempt_token', v_claim.attempt_token,
      'attempt_count', 1, 'booking_id', p_booking_id,
      'salon_id', p_salon_id, 'channel', p_channel
    );
  END IF;

  SELECT n.* INTO v_claim
  FROM public.booking_notifications n
  WHERE n.booking_id = p_booking_id
    AND n.notification_type = 'booking_confirmation'
    AND n.channel = p_channel
  FOR UPDATE;

  IF v_claim.attempt_token IS NULL OR v_claim.claimed_at IS NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', CASE WHEN v_claim.status = 'sending' THEN 'in_flight' ELSE 'duplicate_terminal' END,
      'claimed', false, 'claim_id', v_claim.id, 'status', v_claim.status,
      'legacy_claim', true
    );
  END IF;

  IF v_claim.salon_id <> p_salon_id
     OR v_claim.payload_fingerprint <> p_payload_fingerprint
     OR v_claim.recipient_fingerprint <> p_recipient_fingerprint THEN
    RETURN jsonb_build_object('success', false, 'code', 'material_conflict', 'claimed', false);
  END IF;

  IF v_claim.status = 'sending' THEN
    IF v_claim.updated_at < v_now - interval '15 minutes' THEN
      UPDATE public.booking_notifications
      SET status = 'unknown', completed_at = v_now, updated_at = v_now,
          failure_disposition = 'none', next_attempt_at = NULL,
          error_code = 'stale_sending_outcome_unknown',
          error_message = 'stale_sending_outcome_unknown',
          reconciliation_reason = 'stale_sending_outcome_unknown',
          completion_fingerprint = encode(extensions.digest(pg_catalog.convert_to(
            'unknown|stale_sending_outcome_unknown', 'UTF8'), 'sha256'), 'hex')
      WHERE id = v_claim.id;
      INSERT INTO public.booking_notification_delivery_events (
        claim_id, booking_id, salon_id, channel, attempt_count, transition, error_code
      ) VALUES (
        v_claim.id, p_booking_id, p_salon_id, p_channel, v_claim.attempt_count,
        'stale_sending_unknown', 'stale_sending_outcome_unknown'
      ) ON CONFLICT DO NOTHING;
      RETURN jsonb_build_object('success', true, 'code', 'ambiguous_no_retry', 'claimed', false);
    END IF;
    RETURN jsonb_build_object('success', true, 'code', 'in_flight', 'claimed', false);
  END IF;

  IF v_claim.status IN ('sent', 'delivered', 'suppressed') THEN
    RETURN jsonb_build_object('success', true, 'code', 'duplicate_terminal', 'claimed', false, 'status', v_claim.status);
  END IF;
  IF v_claim.status = 'unknown' THEN
    RETURN jsonb_build_object('success', true, 'code', 'ambiguous_no_retry', 'claimed', false);
  END IF;
  IF v_claim.status <> 'failed' OR v_claim.failure_disposition <> 'retryable_pre_acceptance' THEN
    RETURN jsonb_build_object('success', true, 'code', 'duplicate_terminal', 'claimed', false, 'status', v_claim.status);
  END IF;

  IF v_booking.status <> 'confirmed' OR v_booking.deleted_at IS NOT NULL THEN
    UPDATE public.booking_notifications SET
      status = 'suppressed', failure_disposition = 'permanent', next_attempt_at = NULL,
      completed_at = v_now, updated_at = v_now, error_code = 'booking_ineligible',
      error_message = 'booking_ineligible', reconciliation_reason = 'booking_ineligible'
    WHERE id = v_claim.id;
    INSERT INTO public.booking_notification_delivery_events (
      claim_id, booking_id, salon_id, channel, attempt_count, transition, error_code
    ) VALUES (v_claim.id, p_booking_id, p_salon_id, p_channel, v_claim.attempt_count,
      'suppressed', 'booking_ineligible') ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('success', true, 'code', 'booking_ineligible', 'claimed', false);
  END IF;
  IF v_claim.booking_material_fingerprint <> v_material_fingerprint THEN
    UPDATE public.booking_notifications SET
      failure_disposition = 'permanent', next_attempt_at = NULL,
      completed_at = v_now, updated_at = v_now, error_code = 'material_changed',
      error_message = 'material_changed', reconciliation_reason = 'material_changed'
    WHERE id = v_claim.id;
    INSERT INTO public.booking_notification_delivery_events (
      claim_id, booking_id, salon_id, channel, attempt_count, transition, error_code
    ) VALUES (v_claim.id, p_booking_id, p_salon_id, p_channel, v_claim.attempt_count,
      'material_conflict', 'material_changed') ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('success', false, 'code', 'material_conflict', 'claimed', false);
  END IF;
  IF v_claim.attempt_count >= 2 OR v_claim.expires_at <= v_now THEN
    UPDATE public.booking_notifications SET
      failure_disposition = 'permanent', next_attempt_at = NULL,
      completed_at = v_now, updated_at = v_now,
      error_code = CASE WHEN v_claim.attempt_count >= 2 THEN 'retry_exhausted' ELSE 'retry_window_expired' END,
      error_message = CASE WHEN v_claim.attempt_count >= 2 THEN 'retry_exhausted' ELSE 'retry_window_expired' END,
      reconciliation_reason = CASE WHEN v_claim.attempt_count >= 2 THEN 'retry_exhausted' ELSE 'retry_window_expired' END
    WHERE id = v_claim.id;
    RETURN jsonb_build_object('success', true, 'code', 'retry_exhausted', 'claimed', false);
  END IF;
  IF v_claim.next_attempt_at > v_now THEN
    RETURN jsonb_build_object('success', true, 'code', 'retry_not_due', 'claimed', false,
      'next_attempt_at', v_claim.next_attempt_at);
  END IF;

  v_token := extensions.gen_random_uuid();
  UPDATE public.booking_notifications SET
    status = 'sending', attempt_count = attempt_count + 1, attempt_token = v_token,
    claimed_at = v_now, updated_at = v_now, completed_at = NULL,
    next_attempt_at = NULL, failure_disposition = 'none', provider_message_id = NULL,
    twilio_message_sid = NULL, sent_at = NULL, failed_at = NULL,
    error_code = NULL, error_message = NULL, completion_fingerprint = NULL,
    reconciliation_reason = NULL
  WHERE id = v_claim.id
  RETURNING * INTO v_claim;
  INSERT INTO public.booking_notification_delivery_events (
    claim_id, booking_id, salon_id, channel, attempt_count, transition
  ) VALUES (v_claim.id, p_booking_id, p_salon_id, p_channel, v_claim.attempt_count, 'retry_leased')
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object(
    'success', true, 'code', 'claimed', 'claimed', true,
    'claim_id', v_claim.id, 'attempt_token', v_claim.attempt_token,
    'attempt_count', v_claim.attempt_count, 'booking_id', p_booking_id,
    'salon_id', p_salon_id, 'channel', p_channel
  );
END;
$claim$;

CREATE OR REPLACE FUNCTION public.complete_booking_confirmation_delivery(
  p_claim_id uuid,
  p_attempt_token uuid,
  p_status text,
  p_provider_message_id text,
  p_error_code text,
  p_failure_disposition text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $complete$
DECLARE
  v_claim public.booking_notifications%ROWTYPE;
  v_now timestamptz := transaction_timestamp();
  v_status text := p_status;
  v_error_code text;
  v_disposition text := 'none';
  v_receipt text := nullif(trim(coalesce(p_provider_message_id, '')), '');
  v_completion_fingerprint text;
  v_next_attempt_at timestamptz;
  v_jitter_seconds integer;
  v_transition text;
BEGIN
  IF p_claim_id IS NULL OR p_attempt_token IS NULL
     OR p_status NOT IN ('sent', 'failed', 'suppressed', 'unknown')
     OR length(coalesce(p_provider_message_id, '')) > 255
     OR length(coalesce(p_error_code, '')) > 80
     OR p_failure_disposition NOT IN ('none', 'retryable_pre_acceptance', 'permanent') THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_completion');
  END IF;

  SELECT n.* INTO v_claim FROM public.booking_notifications n
  WHERE n.id = p_claim_id FOR UPDATE;
  IF NOT FOUND OR v_claim.notification_type <> 'booking_confirmation'
     OR v_claim.attempt_token IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'claim_not_found');
  END IF;
  IF v_claim.attempt_token <> p_attempt_token THEN
    RETURN jsonb_build_object('success', false, 'code', 'stale_attempt');
  END IF;

  -- Bind idempotence to exact caller completion material, not a time-dependent
  -- classification. It stays stable across a committed response-loss replay.
  v_completion_fingerprint := encode(extensions.digest(pg_catalog.convert_to(
    concat_ws('|', p_status, coalesce(trim(p_provider_message_id), ''),
      coalesce(p_error_code, ''), p_failure_disposition),
    'UTF8'), 'sha256'), 'hex');
  IF v_claim.status <> 'sending' THEN
    IF v_claim.completion_fingerprint = v_completion_fingerprint THEN
      RETURN jsonb_build_object('success', true, 'code', 'already_completed',
        'status', v_claim.status, 'attempt_count', v_claim.attempt_count);
    END IF;
    RETURN jsonb_build_object('success', false, 'code', 'completion_conflict',
      'status', v_claim.status, 'attempt_count', v_claim.attempt_count);
  END IF;

  IF p_status = 'sent' THEN
    IF v_receipt IS NULL
       OR (v_claim.channel = 'sms' AND v_receipt !~ '^(SM|MM)[0-9A-Fa-f]{32}$')
       OR (v_claim.channel = 'email' AND (length(v_receipt) > 255 OR v_receipt ~ '[[:cntrl:]]')) THEN
      v_status := 'unknown';
      v_receipt := NULL;
      v_error_code := 'invalid_provider_receipt';
      v_transition := 'unknown';
    ELSE
      v_error_code := NULL;
      v_transition := 'sent';
    END IF;
  ELSIF p_status = 'failed' THEN
    v_receipt := NULL;
    IF (v_claim.channel = 'sms' AND p_error_code IN (
          'sms_rate_limited_pre_acceptance', 'sms_unavailable_pre_acceptance'
        ))
       OR (v_claim.channel = 'email' AND p_error_code IN (
          'email_rate_limited_pre_acceptance', 'email_unavailable_pre_acceptance'
        )) THEN
      v_error_code := p_error_code;
      IF v_claim.attempt_count < 2 AND v_claim.expires_at > v_now THEN
        v_disposition := 'retryable_pre_acceptance';
        v_jitter_seconds := (
          get_byte(extensions.digest(pg_catalog.convert_to(
            v_claim.id::text || ':' || v_claim.attempt_count::text, 'UTF8'
          ), 'sha256'), 0) * 256
          + get_byte(extensions.digest(pg_catalog.convert_to(
            v_claim.id::text || ':' || v_claim.attempt_count::text, 'UTF8'
          ), 'sha256'), 1)
        ) % 61;
        v_next_attempt_at := v_now + interval '5 minutes'
          + make_interval(secs => v_jitter_seconds);
        IF v_next_attempt_at >= v_claim.expires_at THEN
          v_disposition := 'permanent';
          v_next_attempt_at := NULL;
          v_error_code := 'retry_window_expired';
          v_transition := 'retry_exhausted';
        ELSE
          v_transition := 'retry_scheduled';
        END IF;
      ELSE
        v_disposition := 'permanent';
        v_error_code := CASE WHEN v_claim.attempt_count >= 2
          THEN 'retry_exhausted' ELSE 'retry_window_expired' END;
        v_transition := 'retry_exhausted';
      END IF;
    ELSIF p_error_code IN (
      'invalid_recipient', 'consent_revoked', 'channel_disabled',
      'provider_auth_invalid', 'provider_configuration_invalid',
      'provider_policy_rejected', 'invalid_content', 'unsupported_sender',
      'booking_ineligible', 'material_changed'
    ) THEN
      v_error_code := p_error_code;
      v_disposition := 'permanent';
      v_transition := 'permanent_failure';
    ELSE
      -- Unknown, raw, ambiguous, or caller-invented codes can never open retry.
      v_status := 'unknown';
      v_error_code := 'unclassified_provider_outcome';
      v_transition := 'unknown';
    END IF;
  ELSIF p_status = 'suppressed' THEN
    v_receipt := NULL;
    v_disposition := 'permanent';
    v_error_code := CASE WHEN p_error_code IN (
      'consent_revoked', 'channel_disabled', 'booking_ineligible', 'recipient_missing'
    ) THEN p_error_code ELSE 'suppressed_by_policy' END;
    v_transition := 'suppressed';
  ELSE
    v_receipt := NULL;
    v_error_code := CASE WHEN p_error_code IN (
      'provider_outcome_unknown', 'transport_timeout', 'provider_exception',
      'invalid_provider_receipt', 'completion_write_uncertain'
    ) THEN p_error_code ELSE 'unclassified_provider_outcome' END;
    v_transition := 'unknown';
  END IF;

  UPDATE public.booking_notifications SET
    status = v_status,
    provider_message_id = v_receipt,
    twilio_message_sid = v_receipt,
    sent_at = CASE WHEN v_status = 'sent' THEN v_now ELSE NULL END,
    failed_at = CASE WHEN v_status = 'failed' THEN v_now ELSE NULL END,
    error_code = v_error_code,
    error_message = v_error_code,
    failure_disposition = v_disposition,
    next_attempt_at = v_next_attempt_at,
    completed_at = v_now,
    updated_at = v_now,
    completion_fingerprint = v_completion_fingerprint,
    reconciliation_reason = CASE
      WHEN v_error_code = 'retry_exhausted' THEN 'retry_exhausted'
      WHEN v_error_code = 'retry_window_expired' THEN 'retry_window_expired'
      ELSE NULL
    END
  WHERE id = v_claim.id;

  INSERT INTO public.booking_notification_delivery_events (
    claim_id, booking_id, salon_id, channel, attempt_count, transition,
    error_code, receipt_present
  ) VALUES (
    v_claim.id, v_claim.booking_id, v_claim.salon_id, v_claim.channel,
    v_claim.attempt_count, v_transition, v_error_code, v_receipt IS NOT NULL
  ) ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object(
    'success', true, 'code', 'completed', 'status', v_status,
    'attempt_count', v_claim.attempt_count,
    'retry_scheduled', v_disposition = 'retryable_pre_acceptance',
    'next_attempt_at', v_next_attempt_at,
    'failure_disposition', v_disposition,
    'caller_disposition_accepted', p_failure_disposition IS NOT DISTINCT FROM v_disposition
  );
END;
$complete$;

CREATE OR REPLACE FUNCTION public.lease_due_booking_confirmation_retries(
  p_limit integer
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $lease$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 0), 0), 100);
  v_claim public.booking_notifications%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_now timestamptz := transaction_timestamp();
  v_recipient text;
  v_recipient_fingerprint text;
  v_material_fingerprint text;
  v_token uuid;
  v_booking_exists boolean;
BEGIN
  IF v_limit < 1 THEN RETURN; END IF;

  FOR v_claim IN
    SELECT n.* FROM public.booking_notifications n
    WHERE n.notification_type = 'booking_confirmation'
      AND n.status = 'failed'
      AND n.failure_disposition = 'retryable_pre_acceptance'
      AND n.attempt_count < 2
      AND n.next_attempt_at <= v_now
    ORDER BY n.next_attempt_at, n.created_at, n.id
    FOR UPDATE SKIP LOCKED LIMIT v_limit
  LOOP
    SELECT b.* INTO v_booking FROM public.bookings b
    WHERE b.id = v_claim.booking_id AND b.salon_id = v_claim.salon_id;
    v_booking_exists := FOUND;

    IF NOT v_booking_exists OR v_booking.deleted_at IS NOT NULL OR v_booking.status <> 'confirmed'
       OR (v_claim.channel = 'sms' AND v_booking.sms_consent_at IS NULL) THEN
      UPDATE public.booking_notifications SET
        status = 'suppressed', failure_disposition = 'permanent', next_attempt_at = NULL,
        completed_at = v_now, updated_at = v_now,
        error_code = CASE WHEN v_booking_exists AND v_claim.channel='sms'
          AND v_booking.sms_consent_at IS NULL THEN 'consent_revoked' ELSE 'booking_ineligible' END,
        error_message = CASE WHEN v_booking_exists AND v_claim.channel='sms'
          AND v_booking.sms_consent_at IS NULL THEN 'consent_revoked' ELSE 'booking_ineligible' END,
        reconciliation_reason = CASE WHEN v_booking_exists AND v_claim.channel='sms'
          AND v_booking.sms_consent_at IS NULL THEN 'consent_revoked' ELSE 'booking_ineligible' END
      WHERE id = v_claim.id;
      INSERT INTO public.booking_notification_delivery_events (
        claim_id, booking_id, salon_id, channel, attempt_count, transition, error_code
      ) VALUES (v_claim.id, v_claim.booking_id, v_claim.salon_id, v_claim.channel,
        v_claim.attempt_count, 'suppressed',
        CASE WHEN v_booking_exists AND v_claim.channel='sms'
          AND v_booking.sms_consent_at IS NULL THEN 'consent_revoked' ELSE 'booking_ineligible' END)
        ON CONFLICT DO NOTHING;
      CONTINUE;
    END IF;

    v_recipient := CASE v_claim.channel
      WHEN 'sms' THEN nullif(regexp_replace(coalesce(v_booking.client_phone, ''), '\D', '', 'g'), '')
      ELSE nullif(lower(trim(coalesce(v_booking.client_email, ''))), '')
    END;
    v_recipient_fingerprint := CASE WHEN v_recipient IS NULL THEN NULL ELSE encode(
      extensions.digest(pg_catalog.convert_to(v_recipient, 'UTF8'), 'sha256'), 'hex'
    ) END;
    v_material_fingerprint := encode(extensions.digest(pg_catalog.convert_to(
      jsonb_build_object(
        'booking_id', v_booking.id, 'salon_id', v_booking.salon_id,
        'service_id', v_booking.service_id, 'staff_id', v_booking.staff_id,
        'status', v_booking.status, 'deleted_at_epoch', extract(epoch FROM v_booking.deleted_at),
        'start_epoch', extract(epoch FROM v_booking.start_time_utc),
        'end_epoch', extract(epoch FROM v_booking.end_time_utc),
        'client_name', v_booking.client_name,
        'client_phone', regexp_replace(coalesce(v_booking.client_phone, ''), '\D', '', 'g'),
        'client_email', nullif(lower(trim(coalesce(v_booking.client_email, ''))), ''),
        'sms_consent_epoch', extract(epoch FROM v_booking.sms_consent_at),
        'sms_consent_meta', v_booking.sms_consent_meta,
        'price_cents', v_booking.price_cents, 'subtotal_cents', v_booking.subtotal_cents,
        'tax_amount_cents', v_booking.tax_amount_cents, 'group_id', v_booking.group_id,
        'pricing_fingerprint', v_booking.public_booking_pricing_fingerprint,
        'pricing_snapshot', v_booking.public_booking_pricing_snapshot
      )::text, 'UTF8'), 'sha256'), 'hex');

    IF v_claim.expires_at <= v_now THEN
      UPDATE public.booking_notifications SET
        failure_disposition = 'permanent', next_attempt_at = NULL,
        completed_at = v_now, updated_at = v_now, error_code = 'retry_window_expired',
        error_message = 'retry_window_expired', reconciliation_reason = 'retry_window_expired'
      WHERE id = v_claim.id;
      INSERT INTO public.booking_notification_delivery_events (
        claim_id, booking_id, salon_id, channel, attempt_count, transition, error_code
      ) VALUES (v_claim.id, v_claim.booking_id, v_claim.salon_id, v_claim.channel,
        v_claim.attempt_count, 'retry_exhausted', 'retry_window_expired') ON CONFLICT DO NOTHING;
      CONTINUE;
    ELSIF v_recipient_fingerprint IS DISTINCT FROM v_claim.recipient_fingerprint
       OR v_material_fingerprint IS DISTINCT FROM v_claim.booking_material_fingerprint THEN
      UPDATE public.booking_notifications SET
        failure_disposition = 'permanent', next_attempt_at = NULL,
        completed_at = v_now, updated_at = v_now,
        error_code = CASE WHEN v_recipient_fingerprint IS DISTINCT FROM v_claim.recipient_fingerprint
          THEN 'recipient_changed' ELSE 'material_changed' END,
        error_message = CASE WHEN v_recipient_fingerprint IS DISTINCT FROM v_claim.recipient_fingerprint
          THEN 'recipient_changed' ELSE 'material_changed' END,
        reconciliation_reason = CASE WHEN v_recipient_fingerprint IS DISTINCT FROM v_claim.recipient_fingerprint
          THEN 'recipient_changed' ELSE 'material_changed' END
      WHERE id = v_claim.id;
      INSERT INTO public.booking_notification_delivery_events (
        claim_id, booking_id, salon_id, channel, attempt_count, transition, error_code
      ) VALUES (v_claim.id, v_claim.booking_id, v_claim.salon_id, v_claim.channel,
        v_claim.attempt_count, 'material_conflict',
        CASE WHEN v_recipient_fingerprint IS DISTINCT FROM v_claim.recipient_fingerprint
          THEN 'recipient_changed' ELSE 'material_changed' END) ON CONFLICT DO NOTHING;
      CONTINUE;
    END IF;

    v_token := extensions.gen_random_uuid();
    UPDATE public.booking_notifications SET
      status = 'sending', attempt_count = attempt_count + 1, attempt_token = v_token,
      claimed_at = v_now, updated_at = v_now, completed_at = NULL,
      next_attempt_at = NULL, failure_disposition = 'none', provider_message_id = NULL,
      twilio_message_sid = NULL, sent_at = NULL, failed_at = NULL,
      error_code = NULL, error_message = NULL, completion_fingerprint = NULL,
      reconciliation_reason = NULL
    WHERE id = v_claim.id RETURNING * INTO v_claim;
    INSERT INTO public.booking_notification_delivery_events (
      claim_id, booking_id, salon_id, channel, attempt_count, transition
    ) VALUES (v_claim.id, v_claim.booking_id, v_claim.salon_id, v_claim.channel,
      v_claim.attempt_count, 'retry_leased') ON CONFLICT DO NOTHING;
    RETURN NEXT jsonb_build_object(
      'success', true, 'code', 'leased', 'claim_id', v_claim.id,
      'attempt_token', v_claim.attempt_token, 'attempt_count', v_claim.attempt_count,
      'booking_id', v_claim.booking_id, 'salon_id', v_claim.salon_id,
      'channel', v_claim.channel
    );
  END LOOP;
END;
$lease$;

CREATE OR REPLACE FUNCTION public.reconcile_stale_booking_confirmation_claims(
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $reconcile$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 0), 0), 1000);
  v_claim public.booking_notifications%ROWTYPE;
  v_now timestamptz := transaction_timestamp();
  v_count integer := 0;
BEGIN
  IF v_limit < 1 THEN
    RETURN jsonb_build_object('success', true, 'reconciled', 0);
  END IF;
  FOR v_claim IN
    SELECT n.* FROM public.booking_notifications n
    WHERE n.notification_type = 'booking_confirmation'
      AND n.status = 'sending'
      AND n.attempt_token IS NOT NULL
      AND n.updated_at < v_now - interval '15 minutes'
    ORDER BY n.updated_at, n.id
    FOR UPDATE SKIP LOCKED LIMIT v_limit
  LOOP
    UPDATE public.booking_notifications SET
      status = 'unknown', completed_at = v_now, updated_at = v_now,
      failure_disposition = 'none', next_attempt_at = NULL,
      error_code = 'stale_sending_outcome_unknown',
      error_message = 'stale_sending_outcome_unknown',
      reconciliation_reason = 'stale_sending_outcome_unknown',
      completion_fingerprint = encode(extensions.digest(pg_catalog.convert_to(
        'unknown|stale_sending_outcome_unknown', 'UTF8'), 'sha256'), 'hex')
    WHERE id = v_claim.id;
    INSERT INTO public.booking_notification_delivery_events (
      claim_id, booking_id, salon_id, channel, attempt_count, transition, error_code
    ) VALUES (v_claim.id, v_claim.booking_id, v_claim.salon_id, v_claim.channel,
      v_claim.attempt_count, 'stale_sending_unknown', 'stale_sending_outcome_unknown')
    ON CONFLICT DO NOTHING;
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'reconciled', v_count);
END;
$reconcile$;

REVOKE ALL ON FUNCTION public.claim_booking_confirmation_delivery(uuid, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_booking_confirmation_delivery(uuid, uuid, text, text, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.complete_booking_confirmation_delivery(uuid, uuid, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_booking_confirmation_delivery(uuid, uuid, text, text, text, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.lease_due_booking_confirmation_retries(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lease_due_booking_confirmation_retries(integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.reconcile_stale_booking_confirmation_claims(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_booking_confirmation_claims(integer)
  TO service_role;
