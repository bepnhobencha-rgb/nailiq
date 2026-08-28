-- Signed Resend delivery truth for every transactional customer-booking email.
--
-- The three existing delivery state machines remain authoritative for provider
-- dispatch/idempotency. This additive projection records only provider IDs,
-- claim IDs, timestamps and SHA-256 recipient/payload fingerprints. It never
-- stores recipient addresses or email content.

ALTER TABLE public.booking_notifications
  ADD COLUMN email_delivery_status text,
  ADD COLUMN email_provider_accepted_at timestamptz,
  ADD COLUMN email_delivered_at timestamptz,
  ADD COLUMN email_delivery_failed_at timestamptz,
  ADD COLUMN email_delivery_updated_at timestamptz;

ALTER TABLE public.booking_reminder_delivery_claims
  ADD COLUMN recipient_fingerprint text,
  ADD COLUMN email_delivery_status text,
  ADD COLUMN email_provider_accepted_at timestamptz,
  ADD COLUMN email_delivered_at timestamptz,
  ADD COLUMN email_delivery_failed_at timestamptz,
  ADD COLUMN email_delivery_updated_at timestamptz;

ALTER TABLE public.customer_booking_transition_email_outbox
  ADD COLUMN email_delivery_status text,
  ADD COLUMN email_provider_accepted_at timestamptz,
  ADD COLUMN email_delivered_at timestamptz,
  ADD COLUMN email_delivery_failed_at timestamptz,
  ADD COLUMN email_delivery_updated_at timestamptz;

DO $delivery_checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.booking_notifications'::regclass
      AND conname = 'booking_notifications_email_delivery_status_check'
  ) THEN
    ALTER TABLE public.booking_notifications
      ADD CONSTRAINT booking_notifications_email_delivery_status_check
      CHECK (email_delivery_status IS NULL OR email_delivery_status IN (
        'provider_accepted', 'delivery_delayed', 'delivered', 'failed',
        'suppressed', 'bounced', 'complained'
      )) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.booking_reminder_delivery_claims'::regclass
      AND conname = 'booking_reminder_claims_email_delivery_status_check'
  ) THEN
    ALTER TABLE public.booking_reminder_delivery_claims
      ADD CONSTRAINT booking_reminder_claims_email_delivery_status_check
      CHECK (email_delivery_status IS NULL OR email_delivery_status IN (
        'provider_accepted', 'delivery_delayed', 'delivered', 'failed',
        'suppressed', 'bounced', 'complained'
      )) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.customer_booking_transition_email_outbox'::regclass
      AND conname = 'customer_transition_email_delivery_status_check'
  ) THEN
    ALTER TABLE public.customer_booking_transition_email_outbox
      ADD CONSTRAINT customer_transition_email_delivery_status_check
      CHECK (email_delivery_status IS NULL OR email_delivery_status IN (
        'provider_accepted', 'delivery_delayed', 'delivered', 'failed',
        'suppressed', 'bounced', 'complained'
      )) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.booking_reminder_delivery_claims'::regclass
      AND conname = 'booking_reminder_claims_recipient_fingerprint_check'
  ) THEN
    ALTER TABLE public.booking_reminder_delivery_claims
      ADD CONSTRAINT booking_reminder_claims_recipient_fingerprint_check
      CHECK (recipient_fingerprint IS NULL OR recipient_fingerprint ~ '^[0-9a-f]{64}$')
      NOT VALID;
  END IF;
END;
$delivery_checks$;

UPDATE public.booking_notifications
SET email_delivery_status = CASE status
      WHEN 'delivered' THEN 'delivered'
      WHEN 'failed' THEN 'failed'
      WHEN 'undelivered' THEN 'failed'
      WHEN 'sent' THEN 'provider_accepted'
      ELSE NULL END,
    email_provider_accepted_at = CASE
      WHEN status IN ('sent', 'delivered') THEN sent_at END,
    email_delivered_at = CASE WHEN status = 'delivered' THEN delivered_at END,
    email_delivery_failed_at = CASE
      WHEN status IN ('failed', 'undelivered') THEN failed_at END,
    email_delivery_updated_at = coalesce(delivered_at, failed_at, sent_at, updated_at, created_at)
WHERE channel = 'email' AND email_delivery_status IS NULL;

UPDATE public.booking_reminder_delivery_claims c
SET recipient_fingerprint = encode(extensions.digest(
      pg_catalog.convert_to(lower(trim(b.client_email)), 'UTF8'), 'sha256'
    ), 'hex'),
    email_delivery_status = CASE c.status
      WHEN 'sent' THEN 'provider_accepted'
      WHEN 'failed' THEN 'failed'
      WHEN 'suppressed' THEN 'suppressed'
      ELSE NULL END,
    email_provider_accepted_at = CASE WHEN c.status = 'sent' THEN c.completed_at END,
    email_delivery_failed_at = CASE
      WHEN c.status IN ('failed', 'suppressed') THEN c.completed_at END,
    email_delivery_updated_at = c.completed_at
FROM public.bookings b
WHERE c.booking_id = b.id AND c.channel = 'email'
  AND nullif(trim(b.client_email), '') IS NOT NULL;

UPDATE public.customer_booking_transition_email_outbox o
SET email_delivery_status = CASE o.status
      WHEN 'sent' THEN 'provider_accepted'
      WHEN 'failed' THEN 'failed'
      WHEN 'suppressed' THEN 'suppressed'
      ELSE NULL END,
    email_provider_accepted_at = CASE WHEN o.status = 'sent' THEN o.completed_at END,
    email_delivery_failed_at = CASE
      WHEN o.status IN ('failed', 'suppressed') THEN o.completed_at END,
    email_delivery_updated_at = o.completed_at
WHERE o.status IN ('sent', 'failed', 'suppressed');

CREATE OR REPLACE FUNCTION public.capture_booking_reminder_email_recipient()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $capture$
DECLARE
  v_email text;
BEGIN
  IF NEW.channel <> 'email' THEN RETURN NEW; END IF;
  SELECT lower(trim(b.client_email)) INTO v_email
  FROM public.bookings b
  WHERE b.id = NEW.booking_id AND b.salon_id = NEW.salon_id;
  IF nullif(v_email, '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'email recipient unavailable';
  END IF;
  NEW.recipient_fingerprint := encode(extensions.digest(
    pg_catalog.convert_to(v_email, 'UTF8'), 'sha256'
  ), 'hex');
  RETURN NEW;
END;
$capture$;

CREATE TRIGGER capture_booking_reminder_email_recipient
BEFORE INSERT ON public.booking_reminder_delivery_claims
FOR EACH ROW EXECUTE FUNCTION public.capture_booking_reminder_email_recipient();

CREATE UNIQUE INDEX booking_notifications_resend_message_once
  ON public.booking_notifications (provider_message_id)
  WHERE channel = 'email' AND provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX booking_reminder_claims_resend_message_once
  ON public.booking_reminder_delivery_claims (provider_message_id)
  WHERE channel = 'email' AND provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX customer_transition_resend_message_once
  ON public.customer_booking_transition_email_outbox (provider_message_id)
  WHERE provider_name = 'resend' AND provider_message_id IS NOT NULL;

CREATE TABLE public.resend_customer_delivery_events (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  provider_event_id text NOT NULL UNIQUE CHECK (provider_event_id ~ '^[!-~]{1,255}$'),
  provider_message_id text NOT NULL CHECK (provider_message_id ~ '^[!-~]{1,255}$'),
  claim_kind text NOT NULL CHECK (claim_kind IN ('confirmation', 'reminder', 'transition')),
  claim_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'email.sent', 'email.delivered', 'email.delivery_delayed',
    'email.failed', 'email.suppressed', 'email.bounced', 'email.complained'
  )),
  delivery_status text NOT NULL CHECK (delivery_status IN (
    'provider_accepted', 'delivery_delayed', 'delivered',
    'failed', 'suppressed', 'bounced', 'complained'
  )),
  recipient_fingerprint text NOT NULL CHECK (recipient_fingerprint ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  salon_id uuid REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES public.bookings(id) ON DELETE CASCADE,
  match_error text CHECK (
    match_error IS NULL OR (length(match_error) <= 120 AND match_error !~ '[[:cntrl:]]')
  ),
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  applied_at timestamptz,
  CONSTRAINT resend_customer_delivery_events_application_check CHECK (
    (applied_at IS NULL AND salon_id IS NULL AND booking_id IS NULL)
    OR (applied_at IS NOT NULL AND salon_id IS NOT NULL AND booking_id IS NOT NULL)
  )
);

CREATE INDEX resend_customer_delivery_events_claim_idx
  ON public.resend_customer_delivery_events (claim_kind, claim_id, occurred_at, id)
  WHERE applied_at IS NULL AND match_error IS NULL;
CREATE INDEX resend_customer_delivery_events_salon_received_idx
  ON public.resend_customer_delivery_events (salon_id, received_at DESC, id)
  WHERE salon_id IS NOT NULL;

CREATE TABLE public.customer_email_delivery_suppressions (
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  recipient_fingerprint text NOT NULL CHECK (recipient_fingerprint ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (reason IN ('suppressed', 'bounced', 'complained')),
  provider_message_id text NOT NULL CHECK (provider_message_id ~ '^[!-~]{1,255}$'),
  first_event_at timestamptz NOT NULL,
  last_event_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (salon_id, recipient_fingerprint),
  CONSTRAINT customer_email_delivery_suppressions_time_check
    CHECK (last_event_at >= first_event_at)
);

ALTER TABLE public.resend_customer_delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resend_customer_delivery_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.customer_email_delivery_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_email_delivery_suppressions FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.resend_customer_delivery_events
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.customer_email_delivery_suppressions
  FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY "deny browser access to resend customer delivery events"
  ON public.resend_customer_delivery_events AS RESTRICTIVE
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny browser access to customer email delivery suppressions"
  ON public.customer_email_delivery_suppressions AS RESTRICTIVE
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.customer_email_delivery_suppression_reason(
  p_salon_id uuid,
  p_recipient_fingerprint text
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $reason$
  SELECT s.reason
  FROM public.customer_email_delivery_suppressions s
  WHERE s.salon_id = p_salon_id
    AND s.recipient_fingerprint = p_recipient_fingerprint
    AND p_recipient_fingerprint ~ '^[0-9a-f]{64}$'
$reason$;

CREATE OR REPLACE FUNCTION public.reconcile_resend_customer_delivery_events(
  p_claim_kind text,
  p_claim_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $reconcile$
DECLARE
  v_event public.resend_customer_delivery_events%ROWTYPE;
  v_notification public.booking_notifications%ROWTYPE;
  v_reminder public.booking_reminder_delivery_claims%ROWTYPE;
  v_transition public.customer_booking_transition_email_outbox%ROWTYPE;
  v_salon_id uuid;
  v_booking_id uuid;
  v_recipient_fingerprint text;
  v_message_id text;
  v_current_status text;
  v_current_rank integer;
  v_event_rank integer;
  v_notification_type text;
  v_body_preview text;
  v_projected_status text;
  v_applied integer := 0;
BEGIN
  IF p_claim_kind NOT IN ('confirmation', 'reminder', 'transition')
     OR p_claim_id IS NULL THEN RETURN 0; END IF;

  IF p_claim_kind = 'confirmation' THEN
    SELECT n.* INTO v_notification FROM public.booking_notifications n
    WHERE n.id = p_claim_id AND n.channel = 'email'
      AND n.notification_type = 'booking_confirmation' FOR UPDATE;
    IF NOT FOUND THEN RETURN 0; END IF;
    v_salon_id := v_notification.salon_id;
    v_booking_id := v_notification.booking_id;
    v_recipient_fingerprint := v_notification.recipient_fingerprint;
    v_message_id := v_notification.provider_message_id;
    v_current_status := v_notification.email_delivery_status;
    v_notification_type := 'booking_confirmation';
    v_body_preview := 'Email booking confirmation';
  ELSIF p_claim_kind = 'reminder' THEN
    SELECT c.* INTO v_reminder FROM public.booking_reminder_delivery_claims c
    WHERE c.id = p_claim_id AND c.channel = 'email' FOR UPDATE;
    IF NOT FOUND THEN RETURN 0; END IF;
    v_salon_id := v_reminder.salon_id;
    v_booking_id := v_reminder.booking_id;
    v_recipient_fingerprint := v_reminder.recipient_fingerprint;
    v_message_id := v_reminder.provider_message_id;
    v_current_status := v_reminder.email_delivery_status;
    v_notification_type := CASE v_reminder.reminder_type
      WHEN '24h' THEN 'reminder_24h' ELSE 'reminder_3h' END;
    v_body_preview := CASE v_reminder.reminder_type
      WHEN '24h' THEN 'Email reminder 24h' ELSE 'Email reminder 3h' END;
  ELSE
    SELECT o.* INTO v_transition FROM public.customer_booking_transition_email_outbox o
    WHERE o.id = p_claim_id AND o.provider_name = 'resend' FOR UPDATE;
    IF NOT FOUND THEN RETURN 0; END IF;
    v_salon_id := v_transition.salon_id;
    v_booking_id := v_transition.booking_id;
    v_recipient_fingerprint := v_transition.recipient_fingerprint;
    v_message_id := v_transition.provider_message_id;
    v_current_status := v_transition.email_delivery_status;
    v_notification_type := 'staff_action';
    v_body_preview := CASE v_transition.event_type
      WHEN 'cancel' THEN 'Email booking cancellation'
      ELSE 'Email booking reschedule' END;
  END IF;

  IF v_booking_id IS NULL OR v_recipient_fingerprint !~ '^[0-9a-f]{64}$' THEN
    UPDATE public.resend_customer_delivery_events e
    SET match_error = coalesce(e.match_error, 'claim_material_missing')
    WHERE e.claim_kind = p_claim_kind AND e.claim_id = p_claim_id
      AND e.applied_at IS NULL;
    RETURN 0;
  END IF;

  FOR v_event IN
    SELECT e.* FROM public.resend_customer_delivery_events e
    WHERE e.claim_kind = p_claim_kind AND e.claim_id = p_claim_id
      AND e.applied_at IS NULL AND e.match_error IS NULL
    ORDER BY e.occurred_at, e.received_at, e.id
    FOR UPDATE
  LOOP
    IF v_event.recipient_fingerprint <> v_recipient_fingerprint THEN
      UPDATE public.resend_customer_delivery_events e
      SET match_error = 'recipient_mismatch' WHERE e.id = v_event.id;
      CONTINUE;
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_event.provider_message_id, 824719)
    );
    IF (v_message_id IS NOT NULL AND v_message_id <> v_event.provider_message_id)
       OR EXISTS (
         SELECT 1 FROM public.booking_notifications n
         WHERE n.channel = 'email' AND n.provider_message_id = v_event.provider_message_id
           AND NOT (p_claim_kind = 'confirmation' AND n.id = p_claim_id)
       ) OR EXISTS (
         SELECT 1 FROM public.booking_reminder_delivery_claims c
         WHERE c.channel = 'email' AND c.provider_message_id = v_event.provider_message_id
           AND NOT (p_claim_kind = 'reminder' AND c.id = p_claim_id)
       ) OR EXISTS (
         SELECT 1 FROM public.customer_booking_transition_email_outbox o
         WHERE o.provider_name = 'resend' AND o.provider_message_id = v_event.provider_message_id
           AND NOT (p_claim_kind = 'transition' AND o.id = p_claim_id)
       ) THEN
      UPDATE public.resend_customer_delivery_events e
      SET match_error = 'provider_message_conflict' WHERE e.id = v_event.id;
      CONTINUE;
    END IF;
    v_message_id := v_event.provider_message_id;

    v_current_rank := CASE coalesce(v_current_status, '')
      WHEN 'provider_accepted' THEN 10 WHEN 'delivery_delayed' THEN 20
      WHEN 'delivered' THEN 50 WHEN 'failed' THEN 60
      WHEN 'suppressed' THEN 65 WHEN 'bounced' THEN 70
      WHEN 'complained' THEN 80 ELSE 0 END;
    v_event_rank := CASE v_event.delivery_status
      WHEN 'provider_accepted' THEN 10 WHEN 'delivery_delayed' THEN 20
      WHEN 'delivered' THEN 50 WHEN 'failed' THEN 60
      WHEN 'suppressed' THEN 65 WHEN 'bounced' THEN 70
      WHEN 'complained' THEN 80 ELSE 0 END;
    IF v_event_rank >= v_current_rank THEN
      v_current_status := v_event.delivery_status;
    END IF;

    IF p_claim_kind = 'confirmation' THEN
      UPDATE public.booking_notifications n SET
        status = CASE
          WHEN v_current_status = 'delivered' THEN 'delivered'
          WHEN v_current_status IN ('failed','suppressed','bounced','complained') THEN 'failed'
          ELSE 'sent' END,
        provider_name = 'resend', provider_message_id = v_message_id,
        twilio_message_sid = v_message_id,
        sent_at = coalesce(n.sent_at, v_event.occurred_at),
        delivered_at = CASE WHEN v_current_status = 'delivered'
          THEN coalesce(n.delivered_at, v_event.occurred_at) ELSE n.delivered_at END,
        failed_at = CASE WHEN v_current_status IN ('failed','suppressed','bounced','complained')
          THEN coalesce(n.failed_at, v_event.occurred_at) ELSE n.failed_at END,
        completed_at = coalesce(n.completed_at, transaction_timestamp()),
        failure_disposition = CASE WHEN v_current_status IN ('failed','suppressed','bounced','complained')
          THEN 'permanent' ELSE n.failure_disposition END,
        email_delivery_status = v_current_status,
        email_provider_accepted_at = CASE WHEN v_event.delivery_status = 'provider_accepted'
          THEN coalesce(n.email_provider_accepted_at, v_event.occurred_at)
          ELSE n.email_provider_accepted_at END,
        email_delivered_at = CASE WHEN v_event.delivery_status = 'delivered'
          THEN coalesce(n.email_delivered_at, v_event.occurred_at) ELSE n.email_delivered_at END,
        email_delivery_failed_at = CASE WHEN v_event.delivery_status IN ('failed','suppressed','bounced','complained')
          THEN coalesce(n.email_delivery_failed_at, v_event.occurred_at) ELSE n.email_delivery_failed_at END,
        email_delivery_updated_at = greatest(coalesce(n.email_delivery_updated_at, '-infinity'::timestamptz), v_event.occurred_at),
        updated_at = transaction_timestamp()
      WHERE n.id = p_claim_id;
    ELSIF p_claim_kind = 'reminder' THEN
      UPDATE public.booking_reminder_delivery_claims c SET
        status = CASE WHEN c.status = 'sending' THEN 'sent' ELSE c.status END,
        provider_message_id = coalesce(c.provider_message_id, v_message_id),
        completed_at = CASE WHEN c.status = 'sending' THEN transaction_timestamp() ELSE c.completed_at END,
        email_delivery_status = v_current_status,
        email_provider_accepted_at = CASE WHEN v_event.delivery_status = 'provider_accepted'
          THEN coalesce(c.email_provider_accepted_at, v_event.occurred_at) ELSE c.email_provider_accepted_at END,
        email_delivered_at = CASE WHEN v_event.delivery_status = 'delivered'
          THEN coalesce(c.email_delivered_at, v_event.occurred_at) ELSE c.email_delivered_at END,
        email_delivery_failed_at = CASE WHEN v_event.delivery_status IN ('failed','suppressed','bounced','complained')
          THEN coalesce(c.email_delivery_failed_at, v_event.occurred_at) ELSE c.email_delivery_failed_at END,
        email_delivery_updated_at = greatest(coalesce(c.email_delivery_updated_at, '-infinity'::timestamptz), v_event.occurred_at),
        updated_at = transaction_timestamp()
      WHERE c.id = p_claim_id;
    ELSE
      UPDATE public.customer_booking_transition_email_outbox o SET
        status = CASE WHEN o.status = 'sending' THEN 'sent' ELSE o.status END,
        provider_message_id = coalesce(o.provider_message_id, v_message_id),
        completed_at = CASE WHEN o.status = 'sending' THEN transaction_timestamp() ELSE o.completed_at END,
        email_delivery_status = v_current_status,
        email_provider_accepted_at = CASE WHEN v_event.delivery_status = 'provider_accepted'
          THEN coalesce(o.email_provider_accepted_at, v_event.occurred_at) ELSE o.email_provider_accepted_at END,
        email_delivered_at = CASE WHEN v_event.delivery_status = 'delivered'
          THEN coalesce(o.email_delivered_at, v_event.occurred_at) ELSE o.email_delivered_at END,
        email_delivery_failed_at = CASE WHEN v_event.delivery_status IN ('failed','suppressed','bounced','complained')
          THEN coalesce(o.email_delivery_failed_at, v_event.occurred_at) ELSE o.email_delivery_failed_at END,
        email_delivery_updated_at = greatest(coalesce(o.email_delivery_updated_at, '-infinity'::timestamptz), v_event.occurred_at),
        updated_at = transaction_timestamp()
      WHERE o.id = p_claim_id;
    END IF;

    IF v_event.delivery_status IN ('suppressed', 'bounced', 'complained') THEN
      INSERT INTO public.customer_email_delivery_suppressions (
        salon_id, recipient_fingerprint, reason, provider_message_id,
        first_event_at, last_event_at
      ) VALUES (
        v_salon_id, v_recipient_fingerprint, v_event.delivery_status,
        v_message_id, v_event.occurred_at, v_event.occurred_at
      ) ON CONFLICT (salon_id, recipient_fingerprint) DO UPDATE SET
        reason = CASE
          WHEN public.customer_email_delivery_suppressions.reason = 'complained'
            OR excluded.reason = 'complained' THEN 'complained'
          WHEN public.customer_email_delivery_suppressions.reason = 'bounced'
            OR excluded.reason = 'bounced' THEN 'bounced'
          ELSE 'suppressed' END,
        provider_message_id = excluded.provider_message_id,
        first_event_at = least(public.customer_email_delivery_suppressions.first_event_at, excluded.first_event_at),
        last_event_at = greatest(public.customer_email_delivery_suppressions.last_event_at, excluded.last_event_at),
        updated_at = transaction_timestamp();
    END IF;

    v_projected_status := CASE
      WHEN v_current_status = 'delivered' THEN 'delivered'
      WHEN v_current_status IN ('failed','suppressed','bounced','complained') THEN 'failed'
      ELSE 'sent' END;
    IF p_claim_kind <> 'confirmation' THEN
      SELECT n.* INTO v_notification FROM public.booking_notifications n
      WHERE n.twilio_message_sid = v_message_id FOR UPDATE;
      IF FOUND AND (v_notification.salon_id <> v_salon_id
          OR v_notification.booking_id <> v_booking_id
          OR v_notification.channel <> 'email') THEN
        UPDATE public.resend_customer_delivery_events e
        SET match_error = 'notification_projection_conflict' WHERE e.id = v_event.id;
        CONTINUE;
      END IF;
      INSERT INTO public.booking_notifications (
        booking_id, salon_id, notification_type, channel, status, client_phone,
        twilio_message_sid, provider_name, provider_message_id, body_preview,
        sent_at, delivered_at, failed_at, error_code, created_at,
        email_delivery_status, email_provider_accepted_at, email_delivered_at,
        email_delivery_failed_at, email_delivery_updated_at
      ) SELECT
        v_booking_id, v_salon_id, v_notification_type, 'email', v_projected_status,
        b.client_phone, v_message_id, 'resend', v_message_id, v_body_preview,
        v_event.occurred_at,
        CASE WHEN v_projected_status = 'delivered' THEN v_event.occurred_at END,
        CASE WHEN v_projected_status = 'failed' THEN v_event.occurred_at END,
        CASE WHEN v_projected_status = 'failed' THEN 'email_' || v_current_status END,
        transaction_timestamp(), v_current_status,
        CASE WHEN v_event.delivery_status = 'provider_accepted' THEN v_event.occurred_at END,
        CASE WHEN v_event.delivery_status = 'delivered' THEN v_event.occurred_at END,
        CASE WHEN v_event.delivery_status IN ('failed','suppressed','bounced','complained') THEN v_event.occurred_at END,
        v_event.occurred_at
      FROM public.bookings b WHERE b.id = v_booking_id
      ON CONFLICT (twilio_message_sid) DO UPDATE SET
        status = excluded.status,
        delivered_at = coalesce(public.booking_notifications.delivered_at, excluded.delivered_at),
        failed_at = coalesce(public.booking_notifications.failed_at, excluded.failed_at),
        error_code = excluded.error_code,
        email_delivery_status = excluded.email_delivery_status,
        email_provider_accepted_at = coalesce(public.booking_notifications.email_provider_accepted_at, excluded.email_provider_accepted_at),
        email_delivered_at = coalesce(public.booking_notifications.email_delivered_at, excluded.email_delivered_at),
        email_delivery_failed_at = coalesce(public.booking_notifications.email_delivery_failed_at, excluded.email_delivery_failed_at),
        email_delivery_updated_at = greatest(
          coalesce(public.booking_notifications.email_delivery_updated_at, '-infinity'::timestamptz),
          excluded.email_delivery_updated_at
        );
    END IF;

    UPDATE public.resend_customer_delivery_events e
    SET salon_id = v_salon_id, booking_id = v_booking_id,
        applied_at = transaction_timestamp()
    WHERE e.id = v_event.id;
    v_applied := v_applied + 1;
  END LOOP;
  RETURN v_applied;
END;
$reconcile$;

CREATE OR REPLACE FUNCTION public.record_resend_customer_delivery_event(
  p_claim_kind text,
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
  v_event public.resend_customer_delivery_events%ROWTYPE;
  v_status text;
  v_inserted boolean := false;
  v_applied integer;
BEGIN
  v_status := CASE p_event_type
    WHEN 'email.sent' THEN 'provider_accepted'
    WHEN 'email.delivery_delayed' THEN 'delivery_delayed'
    WHEN 'email.delivered' THEN 'delivered'
    WHEN 'email.failed' THEN 'failed'
    WHEN 'email.suppressed' THEN 'suppressed'
    WHEN 'email.bounced' THEN 'bounced'
    WHEN 'email.complained' THEN 'complained' END;
  IF p_claim_kind NOT IN ('confirmation','reminder','transition')
     OR p_claim_id IS NULL
     OR trim(coalesce(p_provider_event_id,'')) !~ '^[!-~]{1,255}$'
     OR trim(coalesce(p_provider_message_id,'')) !~ '^[!-~]{1,255}$'
     OR v_status IS NULL OR p_recipient_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_occurred_at IS NULL
     OR p_occurred_at > transaction_timestamp() + interval '5 minutes'
     OR p_occurred_at < transaction_timestamp() - interval '30 days'
     OR p_payload_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_event');
  END IF;

  INSERT INTO public.resend_customer_delivery_events (
    provider_event_id, provider_message_id, claim_kind, claim_id, event_type,
    delivery_status, recipient_fingerprint, occurred_at, payload_fingerprint
  ) VALUES (
    trim(p_provider_event_id), trim(p_provider_message_id), p_claim_kind, p_claim_id,
    p_event_type, v_status, p_recipient_fingerprint, p_occurred_at, p_payload_fingerprint
  ) ON CONFLICT (provider_event_id) DO NOTHING RETURNING * INTO v_event;
  v_inserted := FOUND;
  IF NOT v_inserted THEN
    SELECT e.* INTO v_event FROM public.resend_customer_delivery_events e
    WHERE e.provider_event_id = trim(p_provider_event_id) FOR UPDATE;
    IF v_event.provider_message_id <> trim(p_provider_message_id)
       OR v_event.claim_kind <> p_claim_kind OR v_event.claim_id <> p_claim_id
       OR v_event.event_type <> p_event_type
       OR v_event.recipient_fingerprint <> p_recipient_fingerprint
       OR v_event.occurred_at <> p_occurred_at
       OR v_event.payload_fingerprint <> p_payload_fingerprint THEN
      RETURN jsonb_build_object('success', false, 'code', 'event_conflict');
    END IF;
  END IF;

  v_applied := public.reconcile_resend_customer_delivery_events(p_claim_kind, p_claim_id);
  SELECT e.* INTO v_event FROM public.resend_customer_delivery_events e
  WHERE e.provider_event_id = trim(p_provider_event_id);
  RETURN jsonb_build_object(
    'success', true,
    'code', CASE
      WHEN v_event.match_error IS NOT NULL THEN 'event_rejected'
      WHEN v_event.applied_at IS NOT NULL THEN
        CASE WHEN v_inserted THEN 'event_applied' ELSE 'event_replay' END
      ELSE CASE WHEN v_inserted THEN 'event_pending_match' ELSE 'event_replay_pending' END
    END,
    'applied', v_event.applied_at IS NOT NULL,
    'applied_count', v_applied
  );
END;
$record$;

REVOKE ALL ON FUNCTION public.capture_booking_reminder_email_recipient()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.customer_email_delivery_suppression_reason(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_email_delivery_suppression_reason(uuid, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.reconcile_resend_customer_delivery_events(text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_resend_customer_delivery_event(
  text, uuid, text, text, text, text, timestamptz, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_resend_customer_delivery_event(
  text, uuid, text, text, text, text, timestamptz, text
) TO service_role;
