-- Durable owner/manager booking-alert intent.
--
-- The booking mutation owns occurrence creation.  Provider delivery remains a
-- separate, leased worker so a committed booking never depends on email.  No
-- historical row is backfilled and a newer reschedule suppresses older unsent
-- material instead of mailing stale appointment details.

CREATE TABLE public.owner_booking_notification_outbox (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('new', 'reschedule')),
  occurrence_key text NOT NULL CHECK (occurrence_key ~ '^[0-9a-f]{64}$'),
  previous_start_time_utc timestamptz,
  group_size integer CHECK (group_size IS NULL OR group_size BETWEEN 2 AND 50),
  changed_by text CHECK (
    changed_by IS NULL OR changed_by IN (
      'customer', 'public_guest', 'owner', 'admin', 'manager', 'senior',
      'receptionist', 'nail_tech', 'trainee', 'viewer', 'accounting',
      'voice_ai', 'demo_cookie', 'system'
    )
  ),
  changed_fields jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(changed_fields) = 'array'
    AND changed_fields <@ '["time", "staff", "service", "addon"]'::jsonb
  ),
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
  expires_at timestamptz NOT NULL,
  CONSTRAINT owner_booking_notification_outbox_occurrence_once
    UNIQUE (booking_id, event_type, occurrence_key),
  CONSTRAINT owner_booking_notification_outbox_state_check CHECK (
    (status = 'pending' AND attempt_token IS NULL AND claimed_at IS NULL
      AND lease_expires_at IS NULL AND completed_at IS NULL)
    OR (status = 'sending' AND attempt_count BETWEEN 1 AND 3
      AND attempt_token IS NOT NULL AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'failed' AND attempt_token IS NULL AND lease_expires_at IS NULL
      AND completed_at IS NULL AND next_attempt_at IS NOT NULL)
    OR (status IN ('sent', 'unknown', 'suppressed')
      AND attempt_token IS NULL AND lease_expires_at IS NULL
      AND next_attempt_at IS NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT owner_booking_notification_outbox_sent_receipt_check CHECK (
    status <> 'sent' OR provider_receipt_count > 0
  )
);

CREATE INDEX owner_booking_notification_outbox_due_idx
  ON public.owner_booking_notification_outbox (
    coalesce(next_attempt_at, created_at), created_at, id
  ) WHERE status IN ('pending', 'failed');
CREATE INDEX owner_booking_notification_outbox_salon_created_idx
  ON public.owner_booking_notification_outbox (salon_id, created_at DESC, id);

ALTER TABLE public.owner_booking_notification_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.owner_booking_notification_outbox
  FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY "deny browser access to owner booking notification outbox"
  ON public.owner_booking_notification_outbox AS RESTRICTIVE
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.track_owner_booking_notification_occurrence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $trigger$
DECLARE
  v_event text;
  v_now timestamptz := clock_timestamp();
  v_occurrence_key text;
  v_previous_start timestamptz;
  v_group_size integer;
  v_changed_by text;
  v_changed_fields jsonb := '[]'::jsonb;
  v_expires_at timestamptz;
BEGIN
  -- Group rows share one customer intent. Only the organizer represents the
  -- party so a two-person group never creates two manager emails.
  IF NEW.group_id IS NOT NULL AND NEW.is_group_organizer IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- External provider syncs intentionally retain their existing per-run caps.
  -- Turning a bulk Wix/Square import into an unbounded durable email backlog
  -- would create a salon notification storm.
  IF NEW.wix_booking_id IS NOT NULL OR NEW.square_booking_id IS NOT NULL
     OR NEW.booking_channel IN ('wix', 'square') THEN
    RETURN NEW;
  END IF;

  -- Past imports, terminal rows, and immediate queue rows are not replayed as
  -- manager booking alerts. Existing synchronous paths may still handle them.
  IF NEW.start_time_utc IS NULL
     OR NEW.start_time_utc <= v_now + interval '1 minute'
     OR NEW.status IN ('cancelled', 'no_show', 'completed', 'waiting') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_event := 'new';
    v_occurrence_key := encode(extensions.digest(pg_catalog.convert_to(
      concat_ws('|', NEW.id::text, 'new',
        coalesce(extract(epoch FROM NEW.created_at)::text, '')),
      'UTF8'), 'sha256'), 'hex');
  ELSIF NEW.start_time_utc IS DISTINCT FROM OLD.start_time_utc THEN
    v_event := 'reschedule';
    v_previous_start := OLD.start_time_utc;
    v_changed_fields := '["time"]'::jsonb;
    v_changed_by := CASE lower(trim(coalesce(NEW.rescheduled_by, '')))
      WHEN 'customer' THEN 'customer'
      WHEN 'public_guest' THEN 'public_guest'
      WHEN 'owner' THEN 'owner'
      WHEN 'admin' THEN 'admin'
      WHEN 'manager' THEN 'manager'
      WHEN 'senior' THEN 'senior'
      WHEN 'receptionist' THEN 'receptionist'
      WHEN 'nail_tech' THEN 'nail_tech'
      WHEN 'trainee' THEN 'trainee'
      WHEN 'viewer' THEN 'viewer'
      WHEN 'accounting' THEN 'accounting'
      WHEN 'voice_ai' THEN 'voice_ai'
      WHEN 'demo_cookie' THEN 'demo_cookie'
      ELSE 'system'
    END;
    v_occurrence_key := encode(extensions.digest(pg_catalog.convert_to(
      concat_ws('|', NEW.id::text, 'reschedule',
        coalesce(extract(epoch FROM OLD.start_time_utc)::text, ''),
        coalesce(extract(epoch FROM NEW.start_time_utc)::text, ''),
        extract(epoch FROM v_now)::text),
      'UTF8'), 'sha256'), 'hex');
  ELSE
    RETURN NEW;
  END IF;

  v_group_size := CASE
    WHEN coalesce(NEW.group_size::integer, NEW.party_size, 1) > 1
      THEN least(coalesce(NEW.group_size::integer, NEW.party_size, 1), 50)
    ELSE NULL
  END;
  v_expires_at := least(v_now + interval '24 hours', NEW.start_time_utc);

  -- Only unsent work is superseded. A sending row owns an in-flight provider
  -- outcome and must settle through its lease/recipient claim.
  UPDATE public.owner_booking_notification_outbox o
  SET status = 'suppressed',
      attempt_token = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      next_attempt_at = NULL,
      last_error = 'superseded_by_newer_occurrence',
      completed_at = v_now,
      updated_at = v_now
  WHERE o.booking_id = NEW.id
    AND o.status IN ('pending', 'failed');

  INSERT INTO public.owner_booking_notification_outbox (
    salon_id, booking_id, event_type, occurrence_key,
    previous_start_time_utc, group_size, changed_by, changed_fields,
    expires_at
  ) VALUES (
    NEW.salon_id, NEW.id, v_event, v_occurrence_key,
    v_previous_start, v_group_size, v_changed_by, v_changed_fields,
    v_expires_at
  ) ON CONFLICT (booking_id, event_type, occurrence_key) DO NOTHING;

  RETURN NEW;
END;
$trigger$;

CREATE TRIGGER track_owner_booking_notification_occurrence
AFTER INSERT OR UPDATE OF start_time_utc ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.track_owner_booking_notification_occurrence();

CREATE OR REPLACE FUNCTION public.resolve_owner_booking_notification_occurrence(
  p_salon_id uuid,
  p_booking_id uuid,
  p_event_type text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $resolve$
  SELECT CASE
    WHEN p_salon_id IS NULL OR p_booking_id IS NULL
      OR p_event_type NOT IN ('new', 'reschedule')
      THEN jsonb_build_object('success', false, 'code', 'invalid_input')
    ELSE coalesce((
      SELECT jsonb_build_object(
        'success', true,
        'code', 'resolved',
        'occurrence_key', o.occurrence_key
      )
      FROM public.owner_booking_notification_outbox o
      WHERE o.salon_id = p_salon_id
        AND o.booking_id = p_booking_id
        AND o.event_type = p_event_type
        AND o.status <> 'suppressed'
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT 1
    ), jsonb_build_object('success', false, 'code', 'not_found'))
  END;
$resolve$;

CREATE OR REPLACE FUNCTION public.claim_owner_booking_notification_outbox_batch(
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
  v_row public.owner_booking_notification_outbox%ROWTYPE;
BEGIN
  IF v_limit < 1 THEN RETURN; END IF;

  -- The recipient claim is the provider idempotency barrier. A stale outbox
  -- lease can therefore be retried after that claim has reconciled without
  -- risking a second accepted provider request.
  UPDATE public.owner_booking_notification_outbox o
  SET status = CASE WHEN o.expires_at <= v_now THEN 'unknown' ELSE 'failed' END,
      attempt_token = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      next_attempt_at = CASE
        WHEN o.expires_at <= v_now THEN NULL
        ELSE least(v_now + interval '15 minutes', o.expires_at - interval '1 second')
      END,
      last_error = 'stale_sending_outcome_unknown',
      completed_at = CASE WHEN o.expires_at <= v_now THEN v_now ELSE NULL END,
      updated_at = v_now
  WHERE o.status = 'sending' AND o.lease_expires_at <= v_now;

  UPDATE public.owner_booking_notification_outbox o
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
    FROM public.owner_booking_notification_outbox o
    WHERE o.status IN ('pending', 'failed')
      AND o.expires_at > v_now
      AND o.attempt_count < 3
      AND coalesce(o.next_attempt_at, o.created_at) <= v_now
    ORDER BY coalesce(o.next_attempt_at, o.created_at), o.created_at, o.id
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  LOOP
    UPDATE public.owner_booking_notification_outbox o
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
      'success', true, 'code', 'leased',
      'outbox_id', v_row.id, 'attempt_token', v_row.attempt_token,
      'attempt_count', v_row.attempt_count,
      'salon_id', v_row.salon_id, 'booking_id', v_row.booking_id,
      'event_type', v_row.event_type,
      'occurrence_key', v_row.occurrence_key,
      'previous_start_time_utc', v_row.previous_start_time_utc,
      'group_size', v_row.group_size, 'changed_by', v_row.changed_by,
      'changed_fields', v_row.changed_fields
    );
  END LOOP;
END;
$claim$;

CREATE OR REPLACE FUNCTION public.complete_owner_booking_notification_outbox(
  p_outbox_id uuid,
  p_attempt_token uuid,
  p_outcome text,
  p_error_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $complete$
DECLARE
  v_row public.owner_booking_notification_outbox%ROWTYPE;
  v_now timestamptz := transaction_timestamp();
  v_receipts integer := 0;
  v_next timestamptz;
BEGIN
  IF p_outbox_id IS NULL OR p_attempt_token IS NULL
     OR p_outcome NOT IN ('sent', 'failed', 'unknown', 'suppressed')
     OR (p_error_code IS NOT NULL AND (
       length(p_error_code) > 160 OR p_error_code ~ '[[:cntrl:]]'
     )) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_completion');
  END IF;

  SELECT o.* INTO v_row
  FROM public.owner_booking_notification_outbox o
  WHERE o.id = p_outbox_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'outbox_not_found');
  END IF;
  IF v_row.status <> 'sending' OR v_row.attempt_token <> p_attempt_token THEN
    RETURN jsonb_build_object('success', false, 'code', 'claim_mismatch');
  END IF;

  SELECT count(*)::integer INTO v_receipts
  FROM public.owner_booking_notification_claims c
  WHERE c.booking_id = v_row.booking_id
    AND c.event_type = v_row.event_type
    AND c.event_occurrence_key = v_row.occurrence_key
    AND c.status = 'sent'
    AND nullif(trim(coalesce(c.provider_message_id, '')), '') IS NOT NULL;

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
    UPDATE public.owner_booking_notification_outbox o
    SET status = 'failed', attempt_token = NULL, claimed_at = NULL,
        lease_expires_at = NULL, next_attempt_at = v_next,
        provider_receipt_count = v_receipts,
        last_error = coalesce(p_error_code, 'retryable_pre_acceptance'),
        completed_at = NULL, updated_at = v_now
    WHERE o.id = v_row.id;
    RETURN jsonb_build_object(
      'success', true, 'code', 'retry_scheduled', 'status', 'failed',
      'next_attempt_at', v_next, 'provider_receipt_count', v_receipts
    );
  END IF;

  UPDATE public.owner_booking_notification_outbox o
  SET status = CASE WHEN p_outcome = 'failed' THEN 'suppressed' ELSE p_outcome END,
      attempt_token = NULL, claimed_at = NULL, lease_expires_at = NULL,
      next_attempt_at = NULL, provider_receipt_count = v_receipts,
      last_error = CASE WHEN p_outcome = 'failed'
        THEN coalesce(p_error_code, 'retry_exhausted') ELSE p_error_code END,
      completed_at = v_now, updated_at = v_now
  WHERE o.id = v_row.id;

  RETURN jsonb_build_object(
    'success', true, 'code', 'completed',
    'status', CASE WHEN p_outcome = 'failed' THEN 'suppressed' ELSE p_outcome END,
    'provider_receipt_count', v_receipts
  );
END;
$complete$;

REVOKE ALL ON FUNCTION public.track_owner_booking_notification_occurrence()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.resolve_owner_booking_notification_occurrence(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_owner_booking_notification_outbox_batch(integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_owner_booking_notification_outbox(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_owner_booking_notification_outbox_batch(integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_owner_booking_notification_occurrence(uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_owner_booking_notification_outbox(uuid, uuid, text, text)
  TO service_role;
