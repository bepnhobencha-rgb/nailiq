-- P1-01: a provider-accepted callback creates booking_notifications for a
-- reminder/transition. Its later terminal callback must recognize that exact
-- same-salon, same-booking, same-type, same-provider projection as its own.
-- All other claim kinds, bookings, tenants, and provider message IDs remain
-- conflicts. No existing delivery rows are rewritten by this migration.
-- Rollback: restore the previous function body from
-- 20260828070918_add_customer_email_delivery_truth.sql after reviewing
-- pending callbacks; doing so reintroduces the accepted->terminal defect.

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
           AND NOT (
             (p_claim_kind = 'confirmation' AND n.id = p_claim_id)
             OR (
               p_claim_kind IN ('reminder', 'transition')
               AND n.salon_id = v_salon_id
               AND n.booking_id = v_booking_id
               AND n.notification_type = v_notification_type
               AND n.provider_name = 'resend'
               AND n.twilio_message_sid = v_event.provider_message_id
             )
           )
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
