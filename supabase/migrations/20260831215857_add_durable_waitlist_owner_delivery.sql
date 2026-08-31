-- Durable, tenant-scoped owner notification intent for a newly joined Waitlist.
--
-- The trigger records the intent in the same transaction as the Waitlist row.
-- Provider delivery is leased and retried separately, so an email outage never
-- makes the customer retry joining the Waitlist and never creates duplicates.

CREATE TABLE public.owner_waitlist_notification_outbox (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  waitlist_entry_id uuid NOT NULL
    REFERENCES public.booking_waitlist_entries(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'suppressed')
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  attempt_token uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz,
  provider_receipt_count integer NOT NULL DEFAULT 0 CHECK (provider_receipt_count >= 0),
  last_error text CHECK (
    last_error IS NULL OR (length(last_error) <= 160 AND last_error !~ '[[:cntrl:]]')
  ),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT transaction_timestamp() + interval '24 hours',
  CONSTRAINT owner_waitlist_notification_outbox_entry_once UNIQUE (waitlist_entry_id),
  CONSTRAINT owner_waitlist_notification_outbox_state_check CHECK (
    (status = 'pending' AND attempt_token IS NULL AND claimed_at IS NULL
      AND lease_expires_at IS NULL AND completed_at IS NULL)
    OR (status = 'sending' AND attempt_count BETWEEN 1 AND 3
      AND attempt_token IS NOT NULL AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'failed' AND attempt_token IS NULL AND claimed_at IS NULL
      AND lease_expires_at IS NULL AND completed_at IS NULL
      AND next_attempt_at IS NOT NULL)
    OR (status IN ('sent', 'unknown', 'suppressed')
      AND attempt_token IS NULL AND claimed_at IS NULL
      AND lease_expires_at IS NULL AND next_attempt_at IS NULL
      AND completed_at IS NOT NULL)
  ),
  CONSTRAINT owner_waitlist_notification_outbox_sent_receipt_check CHECK (
    status <> 'sent' OR provider_receipt_count > 0
  )
);

CREATE INDEX owner_waitlist_notification_outbox_due_idx
  ON public.owner_waitlist_notification_outbox (
    coalesce(next_attempt_at, created_at), created_at, id
  ) WHERE status IN ('pending', 'failed');
CREATE INDEX owner_waitlist_notification_outbox_salon_created_idx
  ON public.owner_waitlist_notification_outbox (salon_id, created_at DESC, id);

ALTER TABLE public.owner_waitlist_notification_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.owner_waitlist_notification_outbox
  FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY "deny browser access to owner waitlist notification outbox"
  ON public.owner_waitlist_notification_outbox AS RESTRICTIVE
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.track_owner_waitlist_notification_occurrence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $trigger$
BEGIN
  INSERT INTO public.owner_waitlist_notification_outbox (
    salon_id,
    waitlist_entry_id,
    expires_at
  ) VALUES (
    NEW.salon_id,
    NEW.id,
    transaction_timestamp() + interval '24 hours'
  ) ON CONFLICT (waitlist_entry_id) DO NOTHING;
  RETURN NEW;
END;
$trigger$;

CREATE TRIGGER track_owner_waitlist_notification_occurrence
AFTER INSERT ON public.booking_waitlist_entries
FOR EACH ROW EXECUTE FUNCTION public.track_owner_waitlist_notification_occurrence();

CREATE OR REPLACE FUNCTION public.claim_owner_waitlist_notification_outbox_batch(
  p_limit integer
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $claim$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 0), 0), 25);
  v_now timestamptz := transaction_timestamp();
  v_row public.owner_waitlist_notification_outbox%ROWTYPE;
BEGIN
  IF v_limit < 1 THEN RETURN; END IF;

  -- A timed-out provider request has an ambiguous outcome. The worker uses a
  -- stable Resend idempotency key for the full 24-hour window before retrying.
  UPDATE public.owner_waitlist_notification_outbox o
  SET status = CASE
        WHEN o.expires_at <= v_now OR o.attempt_count >= 3 THEN 'unknown'
        ELSE 'failed'
      END,
      attempt_token = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      next_attempt_at = CASE
        WHEN o.expires_at <= v_now OR o.attempt_count >= 3 THEN NULL
        ELSE least(v_now + interval '5 minutes', o.expires_at - interval '1 second')
      END,
      last_error = 'stale_sending_outcome_unknown',
      completed_at = CASE
        WHEN o.expires_at <= v_now OR o.attempt_count >= 3 THEN v_now
        ELSE NULL
      END,
      updated_at = v_now
  WHERE o.status = 'sending' AND o.lease_expires_at <= v_now;

  UPDATE public.owner_waitlist_notification_outbox o
  SET status = 'suppressed',
      next_attempt_at = NULL,
      completed_at = v_now,
      last_error = CASE
        WHEN o.attempt_count >= 3 THEN 'retry_exhausted'
        ELSE 'delivery_window_expired'
      END,
      updated_at = v_now
  WHERE o.status IN ('pending', 'failed')
    AND (o.expires_at <= v_now OR o.attempt_count >= 3);

  FOR v_row IN
    SELECT o.*
    FROM public.owner_waitlist_notification_outbox o
    WHERE o.status IN ('pending', 'failed')
      AND o.expires_at > v_now
      AND o.attempt_count < 3
      AND coalesce(o.next_attempt_at, o.created_at) <= v_now
    ORDER BY coalesce(o.next_attempt_at, o.created_at), o.created_at, o.id
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  LOOP
    UPDATE public.owner_waitlist_notification_outbox o
    SET status = 'sending',
        attempt_count = o.attempt_count + 1,
        attempt_token = extensions.gen_random_uuid(),
        claimed_at = v_now,
        lease_expires_at = v_now + interval '2 minutes',
        next_attempt_at = NULL,
        completed_at = NULL,
        last_error = NULL,
        updated_at = v_now
    WHERE o.id = v_row.id
    RETURNING * INTO v_row;

    RETURN NEXT jsonb_build_object(
      'success', true,
      'code', 'leased',
      'outbox_id', v_row.id,
      'attempt_token', v_row.attempt_token,
      'salon_id', v_row.salon_id,
      'waitlist_entry_id', v_row.waitlist_entry_id
    );
  END LOOP;
END;
$claim$;

CREATE OR REPLACE FUNCTION public.complete_owner_waitlist_notification_outbox(
  p_outbox_id uuid,
  p_attempt_token uuid,
  p_outcome text,
  p_provider_receipt_count integer DEFAULT 0,
  p_error_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $complete$
DECLARE
  v_row public.owner_waitlist_notification_outbox%ROWTYPE;
  v_now timestamptz := transaction_timestamp();
  v_next timestamptz;
  v_receipts integer := greatest(coalesce(p_provider_receipt_count, 0), 0);
BEGIN
  IF p_outbox_id IS NULL OR p_attempt_token IS NULL
     OR p_outcome NOT IN ('sent', 'failed', 'unknown', 'suppressed')
     OR p_provider_receipt_count IS NULL OR p_provider_receipt_count < 0
     OR (p_error_code IS NOT NULL AND (
       length(p_error_code) > 160 OR p_error_code ~ '[[:cntrl:]]'
     )) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_completion');
  END IF;

  SELECT o.* INTO v_row
  FROM public.owner_waitlist_notification_outbox o
  WHERE o.id = p_outbox_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'outbox_not_found');
  END IF;
  IF v_row.status <> 'sending' OR v_row.attempt_token <> p_attempt_token THEN
    RETURN jsonb_build_object('success', false, 'code', 'claim_mismatch');
  END IF;
  IF p_outcome = 'sent' AND v_receipts < 1 THEN
    RETURN jsonb_build_object('success', false, 'code', 'provider_receipt_missing');
  END IF;

  IF p_outcome = 'failed' AND v_row.attempt_count < 3
     AND v_row.expires_at > v_now + interval '1 minute' THEN
    v_next := least(
      v_now + CASE WHEN v_row.attempt_count = 1
        THEN interval '1 minute' ELSE interval '5 minutes' END,
      v_row.expires_at - interval '1 second'
    );
    UPDATE public.owner_waitlist_notification_outbox o
    SET status = 'failed',
        attempt_token = NULL,
        claimed_at = NULL,
        lease_expires_at = NULL,
        next_attempt_at = v_next,
        provider_receipt_count = greatest(o.provider_receipt_count, v_receipts),
        last_error = coalesce(p_error_code, 'retryable_pre_acceptance'),
        completed_at = NULL,
        updated_at = v_now
    WHERE o.id = v_row.id;
    RETURN jsonb_build_object(
      'success', true,
      'code', 'retry_scheduled',
      'status', 'failed',
      'next_attempt_at', v_next
    );
  END IF;

  UPDATE public.owner_waitlist_notification_outbox o
  SET status = CASE WHEN p_outcome = 'failed' THEN 'suppressed' ELSE p_outcome END,
      attempt_token = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      next_attempt_at = NULL,
      provider_receipt_count = greatest(o.provider_receipt_count, v_receipts),
      last_error = CASE WHEN p_outcome = 'failed'
        THEN coalesce(p_error_code, 'retry_exhausted') ELSE p_error_code END,
      completed_at = v_now,
      updated_at = v_now
  WHERE o.id = v_row.id;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'completed',
    'status', CASE WHEN p_outcome = 'failed' THEN 'suppressed' ELSE p_outcome END,
    'provider_receipt_count', greatest(v_row.provider_receipt_count, v_receipts)
  );
END;
$complete$;

-- PII-free delivery-health projection for the Receptionist Center Rescue Card.
-- Only the server-side service role can request a tenant-scoped summary.
CREATE OR REPLACE FUNCTION public.load_notification_delivery_rescue_summary(
  p_salon_id uuid,
  p_since timestamptz DEFAULT transaction_timestamp() - interval '24 hours'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $rescue$
DECLARE
  v_since timestamptz := greatest(
    coalesce(p_since, transaction_timestamp() - interval '24 hours'),
    transaction_timestamp() - interval '7 days'
  );
  v_salon public.salons%ROWTYPE;
  v_sms_attention integer;
  v_sms_suppressed integer;
  v_email_attention integer;
  v_waitlist_attention integer;
BEGIN
  IF p_salon_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_salon');
  END IF;

  SELECT s.* INTO v_salon
  FROM public.salons s
  WHERE s.id = p_salon_id AND s.archived_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'salon_not_found');
  END IF;

  SELECT count(*)::integer INTO v_sms_attention
  FROM public.sms_delivery_attempts a
  WHERE a.salon_id = p_salon_id
    AND a.started_at >= v_since
    AND (
      a.status IN ('failed', 'undelivered', 'unknown')
      OR (a.status = 'sending' AND a.started_at < transaction_timestamp() - interval '5 minutes')
      OR (a.status = 'accepted' AND a.started_at < transaction_timestamp() - interval '30 minutes')
    );

  SELECT count(*)::integer INTO v_sms_suppressed
  FROM public.sms_delivery_attempts a
  WHERE a.salon_id = p_salon_id
    AND a.started_at >= v_since
    AND a.status = 'suppressed';

  SELECT (
    (SELECT count(*) FROM public.owner_booking_notification_outbox o
      WHERE o.salon_id = p_salon_id AND o.created_at >= v_since
        AND o.status IN ('failed', 'unknown'))
    +
    (SELECT count(*) FROM public.customer_booking_transition_email_outbox o
      WHERE o.salon_id = p_salon_id AND o.created_at >= v_since
        AND o.status IN ('failed', 'unknown'))
  )::integer INTO v_email_attention;

  SELECT (
    (SELECT count(*) FROM public.owner_waitlist_notification_outbox o
      WHERE o.salon_id = p_salon_id AND o.created_at >= v_since
        AND o.status IN ('pending', 'failed', 'unknown')
        AND NOT (o.status = 'pending'
          AND o.created_at >= transaction_timestamp() - interval '5 minutes'))
    +
    (SELECT count(*) FROM public.waitlist_offer_delivery_outbox o
      WHERE o.salon_id = p_salon_id AND o.created_at >= v_since
        AND o.status IN ('failed', 'unknown'))
  )::integer INTO v_waitlist_attention;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'loaded',
    'since', v_since,
    'sms_outbound_enabled', v_salon.sms_outbound_enabled IS TRUE,
    'email_outbound_enabled', v_salon.email_outbound_enabled IS TRUE,
    'sms_a2p_registered', v_salon.sms_a2p_registered IS TRUE,
    'sms_attention_count', v_sms_attention,
    'sms_suppressed_count', v_sms_suppressed,
    'email_attention_count', v_email_attention,
    'waitlist_attention_count', v_waitlist_attention
  );
END;
$rescue$;

REVOKE ALL ON FUNCTION public.track_owner_waitlist_notification_occurrence()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_owner_waitlist_notification_outbox_batch(integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_owner_waitlist_notification_outbox(uuid, uuid, text, integer, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_notification_delivery_rescue_summary(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_owner_waitlist_notification_outbox_batch(integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_owner_waitlist_notification_outbox(uuid, uuid, text, integer, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.load_notification_delivery_rescue_summary(uuid, timestamptz)
  TO service_role;
