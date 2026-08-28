-- A desk cancellation is immediately reversible for eight seconds. Customer
-- SMS/email already waits in the staff-action outbox, but the owner email used
-- to call Resend immediately. Persist that owner intent in the existing leased
-- outbox and do not make it claimable until the undo window has safely closed.

ALTER TABLE public.owner_booking_notification_outbox
  ADD CONSTRAINT owner_booking_notification_outbox_event_type_check_v2
  CHECK (event_type IN ('new', 'reschedule', 'cancel')) NOT VALID;
ALTER TABLE public.owner_booking_notification_outbox
  VALIDATE CONSTRAINT owner_booking_notification_outbox_event_type_check_v2;
ALTER TABLE public.owner_booking_notification_outbox
  DROP CONSTRAINT owner_booking_notification_outbox_event_type_check;
ALTER TABLE public.owner_booking_notification_outbox
  RENAME CONSTRAINT owner_booking_notification_outbox_event_type_check_v2
  TO owner_booking_notification_outbox_event_type_check;

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
  v_next_attempt_at timestamptz;
  v_terminal_reason text := coalesce(
    current_setting('nailiq.v1_terminal_reason', true),
    ''
  );
BEGIN
  -- Undo and the booking restoration are one transaction. Suppress every
  -- still-dispatchable cancellation occurrence before either becomes visible.
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'cancelled'
     AND NEW.status IS DISTINCT FROM 'cancelled' THEN
    UPDATE public.owner_booking_notification_outbox o
    SET status = 'suppressed',
        attempt_token = NULL,
        claimed_at = NULL,
        lease_expires_at = NULL,
        next_attempt_at = NULL,
        last_error = 'booking_cancel_undone',
        completed_at = v_now,
        updated_at = v_now
    WHERE o.booking_id = NEW.id
      AND o.event_type = 'cancel'
      AND o.status IN ('pending', 'failed');
    RETURN NEW;
  END IF;

  -- Only the single-booking desk flow offers the eight-second undo. Its owner
  -- email must therefore be durable and delayed beyond that window. This block
  -- intentionally runs before the group-organizer and future-start filters: a
  -- receptionist may cancel one group member or an in-progress appointment.
  IF TG_OP = 'UPDATE'
     AND NEW.status = 'cancelled'
     AND OLD.status IS DISTINCT FROM 'cancelled'
     AND v_terminal_reason = 'desk_cancel' THEN
    v_event := 'cancel';
    v_changed_by := CASE lower(trim(coalesce(
      current_setting('nailiq.v1_terminal_actor_role', true),
      ''
    )))
      WHEN 'owner' THEN 'owner'
      WHEN 'admin' THEN 'admin'
      WHEN 'senior' THEN 'senior'
      WHEN 'receptionist' THEN 'receptionist'
      WHEN 'demo_cookie' THEN 'demo_cookie'
      ELSE 'system'
    END;
    v_occurrence_key := encode(extensions.digest(pg_catalog.convert_to(
      concat_ws('|', NEW.id::text, 'cancel',
        coalesce(NEW.customer_transition_version::text, ''),
        coalesce(extract(epoch FROM NEW.customer_transitioned_at)::text, ''),
        extract(epoch FROM v_now)::text),
      'UTF8'), 'sha256'), 'hex');
    v_expires_at := v_now + interval '24 hours';
    v_next_attempt_at := v_now + interval '20 seconds';
  ELSE
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

    v_expires_at := least(v_now + interval '24 hours', NEW.start_time_utc);
  END IF;

  v_group_size := CASE
    WHEN coalesce(NEW.group_size::integer, NEW.party_size, 1) > 1
      THEN least(coalesce(NEW.group_size::integer, NEW.party_size, 1), 50)
    ELSE NULL
  END;

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
    next_attempt_at, expires_at
  ) VALUES (
    NEW.salon_id, NEW.id, v_event, v_occurrence_key,
    v_previous_start, v_group_size, v_changed_by, v_changed_fields,
    v_next_attempt_at, v_expires_at
  ) ON CONFLICT (booking_id, event_type, occurrence_key) DO NOTHING;

  RETURN NEW;
END;
$trigger$;

DROP TRIGGER track_owner_booking_notification_occurrence ON public.bookings;
CREATE TRIGGER track_owner_booking_notification_occurrence
AFTER INSERT OR UPDATE OF start_time_utc, status ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.track_owner_booking_notification_occurrence();

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

  -- Defense in depth: even if an old trigger version missed an undo, a restored
  -- booking can never be leased as a cancellation email.
  UPDATE public.owner_booking_notification_outbox o
  SET status = 'suppressed',
      attempt_token = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      next_attempt_at = NULL,
      last_error = 'booking_not_cancelled',
      completed_at = v_now,
      updated_at = v_now
  FROM public.bookings b
  WHERE b.id = o.booking_id
    AND o.event_type = 'cancel'
    AND o.status IN ('pending', 'failed')
    AND b.status IS DISTINCT FROM 'cancelled';

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
