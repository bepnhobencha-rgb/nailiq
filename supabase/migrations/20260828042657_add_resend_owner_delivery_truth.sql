-- Resend delivery truth for durable owner booking notifications.
--
-- Provider acceptance (the existing `status = sent`) is not inbox delivery.
-- This migration records only a bounded, PII-free projection of signed Resend
-- webhook events, correlates them to the exact recipient claim, and suppresses
-- future owner-booking sends after a bounce, complaint, or provider suppression.

ALTER TABLE public.owner_booking_notification_claims
  ADD COLUMN delivery_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN provider_accepted_at timestamptz,
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN delivery_failed_at timestamptz,
  ADD COLUMN delivery_updated_at timestamptz;

ALTER TABLE public.owner_booking_notification_claims
  ADD CONSTRAINT owner_booking_notification_claims_delivery_status_check
  CHECK (delivery_status IN (
    'pending', 'unknown', 'provider_accepted', 'delivery_delayed',
    'delivered', 'failed', 'suppressed', 'bounced', 'complained'
  ));

UPDATE public.owner_booking_notification_claims
SET delivery_status = CASE
      WHEN status = 'sent' THEN 'provider_accepted'
      WHEN status = 'failed' THEN 'failed'
      WHEN status = 'suppressed' THEN 'suppressed'
      WHEN status = 'unknown' THEN 'unknown'
      ELSE 'pending'
    END,
    provider_accepted_at = CASE WHEN status = 'sent' THEN completed_at END,
    delivery_failed_at = CASE
      WHEN status IN ('failed', 'suppressed') THEN completed_at
    END,
    delivery_updated_at = completed_at
WHERE status <> 'sending';

CREATE UNIQUE INDEX owner_booking_notification_claims_provider_message_once
  ON public.owner_booking_notification_claims (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE TABLE public.resend_owner_delivery_events (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  provider_event_id text NOT NULL UNIQUE CHECK (
    provider_event_id ~ '^[!-~]{1,255}$'
  ),
  provider_message_id text NOT NULL CHECK (
    provider_message_id ~ '^[!-~]{1,255}$'
  ),
  event_type text NOT NULL CHECK (event_type IN (
    'email.sent', 'email.delivered', 'email.delivery_delayed',
    'email.failed', 'email.suppressed', 'email.bounced', 'email.complained'
  )),
  delivery_status text NOT NULL CHECK (delivery_status IN (
    'provider_accepted', 'delivery_delayed', 'delivered',
    'failed', 'suppressed', 'bounced', 'complained'
  )),
  recipient_fingerprint text NOT NULL CHECK (
    recipient_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  occurred_at timestamptz NOT NULL,
  payload_fingerprint text NOT NULL CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  claim_id uuid REFERENCES public.owner_booking_notification_claims(id)
    ON DELETE CASCADE,
  salon_id uuid REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES public.bookings(id) ON DELETE CASCADE,
  match_error text CHECK (
    match_error IS NULL OR (
      length(match_error) <= 120 AND match_error !~ '[[:cntrl:]]'
    )
  ),
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  applied_at timestamptz,
  CONSTRAINT resend_owner_delivery_events_application_check CHECK (
    (applied_at IS NULL AND claim_id IS NULL AND salon_id IS NULL AND booking_id IS NULL)
    OR (applied_at IS NOT NULL AND claim_id IS NOT NULL
      AND salon_id IS NOT NULL AND booking_id IS NOT NULL)
  )
);

CREATE INDEX resend_owner_delivery_events_pending_message_idx
  ON public.resend_owner_delivery_events (provider_message_id, occurred_at, id)
  WHERE applied_at IS NULL AND match_error IS NULL;
CREATE INDEX resend_owner_delivery_events_salon_received_idx
  ON public.resend_owner_delivery_events (salon_id, received_at DESC, id)
  WHERE salon_id IS NOT NULL;

CREATE TABLE public.owner_email_delivery_suppressions (
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  recipient_fingerprint text NOT NULL CHECK (
    recipient_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  reason text NOT NULL CHECK (reason IN ('suppressed', 'bounced', 'complained')),
  provider_message_id text NOT NULL CHECK (
    provider_message_id ~ '^[!-~]{1,255}$'
  ),
  first_event_at timestamptz NOT NULL,
  last_event_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (salon_id, recipient_fingerprint),
  CONSTRAINT owner_email_delivery_suppressions_time_check
    CHECK (last_event_at >= first_event_at)
);

ALTER TABLE public.resend_owner_delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_email_delivery_suppressions ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.resend_owner_delivery_events
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.owner_email_delivery_suppressions
  FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY "deny browser access to resend owner delivery events"
  ON public.resend_owner_delivery_events AS RESTRICTIVE
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny browser access to owner email delivery suppressions"
  ON public.owner_email_delivery_suppressions AS RESTRICTIVE
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.reconcile_resend_owner_delivery_events(
  p_provider_message_id text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $reconcile$
DECLARE
  v_message_id text := trim(coalesce(p_provider_message_id, ''));
  v_claim public.owner_booking_notification_claims%ROWTYPE;
  v_event public.resend_owner_delivery_events%ROWTYPE;
  v_claim_fingerprint text;
  v_current_rank integer;
  v_event_rank integer;
  v_applied integer := 0;
BEGIN
  IF v_message_id !~ '^[!-~]{1,255}$' THEN RETURN 0; END IF;

  SELECT c.* INTO v_claim
  FROM public.owner_booking_notification_claims c
  WHERE c.provider_message_id = v_message_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;

  v_claim_fingerprint := encode(extensions.digest(
    pg_catalog.convert_to(lower(trim(v_claim.recipient_identity)), 'UTF8'),
    'sha256'
  ), 'hex');

  FOR v_event IN
    SELECT e.*
    FROM public.resend_owner_delivery_events e
    WHERE e.provider_message_id = v_message_id
      AND e.applied_at IS NULL
      AND e.match_error IS NULL
    ORDER BY e.occurred_at, e.received_at, e.id
    FOR UPDATE
  LOOP
    IF v_event.recipient_fingerprint <> v_claim_fingerprint THEN
      UPDATE public.resend_owner_delivery_events e
      SET match_error = 'recipient_mismatch'
      WHERE e.id = v_event.id;
      CONTINUE;
    END IF;

    v_current_rank := CASE v_claim.delivery_status
      WHEN 'pending' THEN 0 WHEN 'unknown' THEN 1
      WHEN 'provider_accepted' THEN 10 WHEN 'delivery_delayed' THEN 20
      WHEN 'delivered' THEN 50 WHEN 'failed' THEN 60
      WHEN 'suppressed' THEN 65 WHEN 'bounced' THEN 70
      WHEN 'complained' THEN 80 ELSE 0 END;
    v_event_rank := CASE v_event.delivery_status
      WHEN 'provider_accepted' THEN 10 WHEN 'delivery_delayed' THEN 20
      WHEN 'delivered' THEN 50 WHEN 'failed' THEN 60
      WHEN 'suppressed' THEN 65 WHEN 'bounced' THEN 70
      WHEN 'complained' THEN 80 ELSE 0 END;

    UPDATE public.owner_booking_notification_claims c
    SET delivery_status = CASE
          WHEN v_event_rank > v_current_rank
            OR (v_event_rank = v_current_rank
              AND v_event.occurred_at >= coalesce(c.delivery_updated_at, '-infinity'::timestamptz))
          THEN v_event.delivery_status ELSE c.delivery_status END,
        provider_accepted_at = CASE
          WHEN v_event.delivery_status = 'provider_accepted'
          THEN coalesce(c.provider_accepted_at, v_event.occurred_at)
          ELSE c.provider_accepted_at END,
        delivered_at = CASE
          WHEN v_event.delivery_status = 'delivered'
          THEN coalesce(c.delivered_at, v_event.occurred_at)
          ELSE c.delivered_at END,
        delivery_failed_at = CASE
          WHEN v_event.delivery_status IN ('failed', 'suppressed', 'bounced', 'complained')
          THEN coalesce(c.delivery_failed_at, v_event.occurred_at)
          ELSE c.delivery_failed_at END,
        delivery_updated_at = greatest(
          coalesce(c.delivery_updated_at, '-infinity'::timestamptz),
          v_event.occurred_at
        ),
        updated_at = transaction_timestamp()
    WHERE c.id = v_claim.id
    RETURNING * INTO v_claim;

    IF v_event.delivery_status IN ('suppressed', 'bounced', 'complained') THEN
      INSERT INTO public.owner_email_delivery_suppressions (
        salon_id, recipient_fingerprint, reason, provider_message_id,
        first_event_at, last_event_at
      ) VALUES (
        v_claim.salon_id, v_event.recipient_fingerprint,
        v_event.delivery_status, v_message_id,
        v_event.occurred_at, v_event.occurred_at
      )
      ON CONFLICT (salon_id, recipient_fingerprint) DO UPDATE
      SET reason = CASE
            WHEN public.owner_email_delivery_suppressions.reason = 'complained'
              OR excluded.reason = 'complained' THEN 'complained'
            WHEN public.owner_email_delivery_suppressions.reason = 'bounced'
              OR excluded.reason = 'bounced' THEN 'bounced'
            ELSE 'suppressed' END,
          provider_message_id = excluded.provider_message_id,
          first_event_at = least(
            public.owner_email_delivery_suppressions.first_event_at,
            excluded.first_event_at
          ),
          last_event_at = greatest(
            public.owner_email_delivery_suppressions.last_event_at,
            excluded.last_event_at
          ),
          updated_at = transaction_timestamp();
    END IF;

    UPDATE public.resend_owner_delivery_events e
    SET claim_id = v_claim.id,
        salon_id = v_claim.salon_id,
        booking_id = v_claim.booking_id,
        applied_at = transaction_timestamp()
    WHERE e.id = v_event.id;
    v_applied := v_applied + 1;
  END LOOP;

  RETURN v_applied;
END;
$reconcile$;

CREATE OR REPLACE FUNCTION public.record_resend_owner_delivery_event(
  p_claim_id uuid,
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
  v_event_id text := trim(coalesce(p_provider_event_id, ''));
  v_message_id text := trim(coalesce(p_provider_message_id, ''));
  v_event public.resend_owner_delivery_events%ROWTYPE;
  v_claim public.owner_booking_notification_claims%ROWTYPE;
  v_claim_fingerprint text;
  v_status text;
  v_inserted boolean := false;
  v_applied integer := 0;
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

  IF p_claim_id IS NULL
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

  INSERT INTO public.resend_owner_delivery_events (
    provider_event_id, provider_message_id, event_type, delivery_status,
    recipient_fingerprint, occurred_at, payload_fingerprint
  ) VALUES (
    v_event_id, v_message_id, p_event_type, v_status,
    p_recipient_fingerprint, p_occurred_at, p_payload_fingerprint
  )
  ON CONFLICT (provider_event_id) DO NOTHING
  RETURNING * INTO v_event;
  v_inserted := FOUND;

  IF NOT v_inserted THEN
    SELECT e.* INTO v_event
    FROM public.resend_owner_delivery_events e
    WHERE e.provider_event_id = v_event_id
    FOR UPDATE;
    IF v_event.provider_message_id <> v_message_id
       OR v_event.event_type <> p_event_type
       OR v_event.recipient_fingerprint <> p_recipient_fingerprint
       OR v_event.occurred_at <> p_occurred_at
       OR v_event.payload_fingerprint <> p_payload_fingerprint THEN
      RETURN jsonb_build_object('success', false, 'code', 'event_conflict');
    END IF;
  END IF;

  -- Every owner-booking send carries its durable claim ID in a provider tag.
  -- Locking that pre-send row removes the webhook/completion visibility race;
  -- signed delivery evidence can recover an ambiguous provider response.
  SELECT c.* INTO v_claim
  FROM public.owner_booking_notification_claims c
  WHERE c.id = p_claim_id
  FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE public.resend_owner_delivery_events e
    SET match_error = coalesce(e.match_error, 'claim_not_found')
    WHERE e.provider_event_id = v_event_id AND e.applied_at IS NULL;
    RETURN jsonb_build_object(
      'success', true, 'code', 'event_rejected',
      'provider_event_id', v_event_id, 'applied', false
    );
  END IF;

  v_claim_fingerprint := encode(extensions.digest(
    pg_catalog.convert_to(lower(trim(v_claim.recipient_identity)), 'UTF8'),
    'sha256'
  ), 'hex');
  IF v_claim_fingerprint <> p_recipient_fingerprint THEN
    UPDATE public.resend_owner_delivery_events e
    SET match_error = coalesce(e.match_error, 'recipient_mismatch')
    WHERE e.provider_event_id = v_event_id AND e.applied_at IS NULL;
    RETURN jsonb_build_object(
      'success', true, 'code', 'event_rejected',
      'provider_event_id', v_event_id, 'applied', false
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_message_id, 0)
  );
  IF EXISTS (
    SELECT 1 FROM public.owner_booking_notification_claims c
    WHERE c.provider_message_id = v_message_id AND c.id <> v_claim.id
  ) THEN
    UPDATE public.resend_owner_delivery_events e
    SET match_error = coalesce(e.match_error, 'provider_message_conflict')
    WHERE e.provider_event_id = v_event_id AND e.applied_at IS NULL;
    RETURN jsonb_build_object(
      'success', true, 'code', 'event_rejected',
      'provider_event_id', v_event_id, 'applied', false
    );
  END IF;

  IF v_claim.provider_message_id IS NOT NULL
     AND v_claim.provider_message_id <> v_message_id THEN
    UPDATE public.resend_owner_delivery_events e
    SET match_error = coalesce(e.match_error, 'provider_message_conflict')
    WHERE e.provider_event_id = v_event_id AND e.applied_at IS NULL;
    RETURN jsonb_build_object(
      'success', true, 'code', 'event_rejected',
      'provider_event_id', v_event_id, 'applied', false
    );
  END IF;

  IF v_claim.status NOT IN ('sending', 'sent', 'failed', 'unknown') THEN
    UPDATE public.resend_owner_delivery_events e
    SET match_error = coalesce(e.match_error, 'claim_not_dispatchable')
    WHERE e.provider_event_id = v_event_id AND e.applied_at IS NULL;
    RETURN jsonb_build_object(
      'success', true, 'code', 'event_rejected',
      'provider_event_id', v_event_id, 'applied', false
    );
  END IF;

  IF v_claim.provider_message_id IS NULL OR v_claim.status <> 'sent' THEN
    UPDATE public.owner_booking_notification_claims c
    SET status = 'sent',
        provider_message_id = v_message_id,
        last_error = NULL,
        provider_accepted_at = coalesce(c.provider_accepted_at, p_occurred_at),
        delivery_status = CASE
          WHEN c.delivery_status IN (
            'delivered', 'failed', 'suppressed', 'bounced', 'complained'
          ) THEN c.delivery_status
          ELSE 'provider_accepted'
        END,
        delivery_updated_at = greatest(
          coalesce(c.delivery_updated_at, '-infinity'::timestamptz),
          p_occurred_at
        ),
        completed_at = coalesce(c.completed_at, transaction_timestamp()),
        updated_at = transaction_timestamp()
    WHERE c.id = v_claim.id
    RETURNING * INTO v_claim;
  END IF;

  v_applied := public.reconcile_resend_owner_delivery_events(v_message_id);
  SELECT e.* INTO v_event
  FROM public.resend_owner_delivery_events e
  WHERE e.provider_event_id = v_event_id;

  RETURN jsonb_build_object(
    'success', true,
    'code', CASE
      WHEN v_event.match_error IS NOT NULL THEN 'event_rejected'
      WHEN v_event.applied_at IS NOT NULL THEN
        CASE WHEN v_inserted THEN 'event_applied' ELSE 'event_replay' END
      ELSE CASE WHEN v_inserted THEN 'event_pending_match' ELSE 'event_replay_pending' END
    END,
    'provider_event_id', v_event_id,
    'applied', v_event.applied_at IS NOT NULL,
    'applied_count', v_applied
  );
END;
$record$;

CREATE OR REPLACE FUNCTION public.reconcile_resend_owner_delivery_on_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $trigger$
BEGIN
  IF NEW.provider_message_id IS NOT NULL THEN
    PERFORM public.reconcile_resend_owner_delivery_events(NEW.provider_message_id);
  END IF;
  RETURN NEW;
END;
$trigger$;

CREATE TRIGGER reconcile_resend_owner_delivery_on_claim
AFTER INSERT OR UPDATE OF provider_message_id
ON public.owner_booking_notification_claims
FOR EACH ROW
WHEN (NEW.provider_message_id IS NOT NULL)
EXECUTE FUNCTION public.reconcile_resend_owner_delivery_on_claim();

-- Retain the provider-acceptance claim contract while initializing the
-- separately truthful delivery state. The trigger above closes the webhook
-- before-completion race after provider_message_id becomes visible.
CREATE OR REPLACE FUNCTION public.complete_owner_booking_notification(
  p_claim_id uuid,
  p_status text,
  p_provider_message_id text DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $complete$
DECLARE
  v_claim public.owner_booking_notification_claims%ROWTYPE;
  v_now timestamptz := transaction_timestamp();
BEGIN
  IF p_claim_id IS NULL
     OR p_status NOT IN ('sent', 'failed', 'unknown', 'suppressed')
     OR (p_status = 'sent'
       AND nullif(trim(coalesce(p_provider_message_id, '')), '') IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_completion');
  END IF;

  SELECT c.* INTO v_claim
  FROM public.owner_booking_notification_claims c
  WHERE c.id = p_claim_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'claim_not_found');
  END IF;
  IF v_claim.status <> 'sending' THEN
    RETURN jsonb_build_object(
      'success', true, 'code', 'already_completed', 'status', v_claim.status
    );
  END IF;

  UPDATE public.owner_booking_notification_claims c
  SET status = p_status,
      provider_message_id = nullif(trim(coalesce(p_provider_message_id, '')), ''),
      last_error = nullif(left(coalesce(p_error, ''), 2000), ''),
      delivery_status = CASE p_status
        WHEN 'sent' THEN 'provider_accepted'
        WHEN 'failed' THEN 'failed'
        WHEN 'suppressed' THEN 'suppressed'
        ELSE 'unknown' END,
      provider_accepted_at = CASE WHEN p_status = 'sent' THEN v_now END,
      delivery_failed_at = CASE
        WHEN p_status IN ('failed', 'suppressed') THEN v_now END,
      delivery_updated_at = v_now,
      completed_at = v_now,
      updated_at = v_now
  WHERE c.id = p_claim_id;

  RETURN jsonb_build_object('success', true, 'code', 'completed', 'status', p_status);
END;
$complete$;

-- A provider-declared suppression is checked atomically before a new claim.
CREATE OR REPLACE FUNCTION public.claim_owner_booking_notification(
  p_salon_id uuid,
  p_booking_id uuid,
  p_event_type text,
  p_recipient_identity text,
  p_event_occurrence_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $claim$
DECLARE
  v_recipient text := lower(trim(coalesce(p_recipient_identity, '')));
  v_occurrence text := lower(trim(coalesce(p_event_occurrence_key, '')));
  v_recipient_fingerprint text;
  v_claim public.owner_booking_notification_claims%ROWTYPE;
BEGIN
  IF p_salon_id IS NULL OR p_booking_id IS NULL
     OR p_event_type NOT IN ('new', 'reschedule', 'cancel', 'no_show')
     OR v_recipient = '' OR length(v_recipient) > 320
     OR v_occurrence = '' OR length(v_occurrence) > 200
     OR NOT EXISTS (
       SELECT 1 FROM public.bookings b
       WHERE b.id = p_booking_id AND b.salon_id = p_salon_id
     ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_claim');
  END IF;

  v_recipient_fingerprint := encode(extensions.digest(
    pg_catalog.convert_to(v_recipient, 'UTF8'), 'sha256'
  ), 'hex');
  IF EXISTS (
    SELECT 1 FROM public.owner_email_delivery_suppressions s
    WHERE s.salon_id = p_salon_id
      AND s.recipient_fingerprint = v_recipient_fingerprint
  ) THEN
    RETURN jsonb_build_object(
      'success', true, 'code', 'provider_suppressed',
      'claimed', false, 'status', 'suppressed'
    );
  END IF;

  INSERT INTO public.owner_booking_notification_claims (
    salon_id, booking_id, event_type, recipient_identity, event_occurrence_key
  ) VALUES (
    p_salon_id, p_booking_id, p_event_type, v_recipient, v_occurrence
  )
  ON CONFLICT (booking_id, event_type, recipient_identity, event_occurrence_key)
  DO NOTHING
  RETURNING * INTO v_claim;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true, 'code', 'claimed', 'claimed', true,
      'claim_id', v_claim.id, 'status', v_claim.status,
      'attempt_count', v_claim.attempt_count
    );
  END IF;

  SELECT c.* INTO v_claim
  FROM public.owner_booking_notification_claims c
  WHERE c.booking_id = p_booking_id
    AND c.event_type = p_event_type
    AND c.recipient_identity = v_recipient
    AND c.event_occurrence_key = v_occurrence
  FOR UPDATE;

  IF v_claim.status = 'sending'
     AND v_claim.updated_at < transaction_timestamp() - interval '15 minutes' THEN
    UPDATE public.owner_booking_notification_claims c
    SET status = 'unknown', delivery_status = 'unknown',
        completed_at = transaction_timestamp(),
        delivery_updated_at = transaction_timestamp(),
        updated_at = transaction_timestamp(),
        last_error = coalesce(c.last_error, 'stale_sending_outcome_unknown')
    WHERE c.id = v_claim.id RETURNING * INTO v_claim;
  ELSIF v_claim.status = 'failed' THEN
    UPDATE public.owner_booking_notification_claims c
    SET status = 'sending', delivery_status = 'pending',
        attempt_count = c.attempt_count + 1, provider_message_id = NULL,
        provider_accepted_at = NULL, delivered_at = NULL,
        delivery_failed_at = NULL, delivery_updated_at = NULL,
        last_error = NULL, claimed_at = transaction_timestamp(),
        completed_at = NULL, updated_at = transaction_timestamp()
    WHERE c.id = v_claim.id RETURNING * INTO v_claim;
    RETURN jsonb_build_object(
      'success', true, 'code', 'claimed', 'claimed', true,
      'claim_id', v_claim.id, 'status', v_claim.status,
      'attempt_count', v_claim.attempt_count
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'code', 'duplicate_suppressed', 'claimed', false,
    'claim_id', v_claim.id, 'status', v_claim.status,
    'attempt_count', v_claim.attempt_count
  );
END;
$claim$;

REVOKE ALL ON FUNCTION public.reconcile_resend_owner_delivery_events(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_resend_owner_delivery_event(
  uuid, text, text, text, text, timestamptz, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_resend_owner_delivery_event(
  uuid, text, text, text, text, timestamptz, text
) TO service_role;
REVOKE ALL ON FUNCTION public.reconcile_resend_owner_delivery_on_claim()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.complete_owner_booking_notification(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_owner_booking_notification(uuid, text, text, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.claim_owner_booking_notification(uuid, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_owner_booking_notification(uuid, uuid, text, text, text)
  TO service_role;
