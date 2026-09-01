-- Bounded, PII-free issue projection for the Front Desk Delivery Truth card.
--
-- Booking and waitlist mutations remain authoritative even when notification
-- delivery is delayed or fails. This function is read-only and never retries a
-- provider call. It gives the server-rendered receptionist surface enough
-- metadata to open the affected booking/waitlist and explain the safe next
-- action without exposing a recipient, message body, or provider receipt.

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
  v_issues jsonb := '[]'::jsonb;
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
      OR (a.status = 'sending'
        AND a.started_at < transaction_timestamp() - interval '5 minutes')
      OR (a.status = 'accepted'
        AND a.started_at < transaction_timestamp() - interval '30 minutes')
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

  WITH delivery_issues AS (
    SELECT
      concat('sms:', a.id::text) AS issue_key,
      'sms'::text AS channel,
      'booking'::text AS destination,
      a.booking_id,
      NULL::uuid AS waitlist_entry_id,
      a.notification_type AS notification_kind,
      a.status,
      CASE
        WHEN a.status IN ('unknown', 'sending', 'accepted')
          THEN 'reconcile_required'
        ELSE 'manual_follow_up'
      END::text AS resolution,
      CASE
        WHEN a.status IN ('unknown', 'sending', 'accepted')
          THEN 'outcome_not_confirmed'
        ELSE 'delivery_failed'
      END::text AS reason_code,
      a.started_at AS occurred_at,
      b.start_time_utc AS booking_start_time_utc,
      NULL::date AS waitlist_booking_date
    FROM public.sms_delivery_attempts a
    LEFT JOIN public.bookings b
      ON b.id = a.booking_id AND b.salon_id = a.salon_id
    WHERE a.salon_id = p_salon_id
      AND a.started_at >= v_since
      AND (
        a.status IN ('failed', 'undelivered', 'unknown')
        OR (a.status = 'sending'
          AND a.started_at < transaction_timestamp() - interval '5 minutes')
        OR (a.status = 'accepted'
          AND a.started_at < transaction_timestamp() - interval '30 minutes')
      )

    UNION ALL

    SELECT
      concat('owner-booking-email:', o.id::text),
      'email',
      'booking',
      o.booking_id,
      NULL::uuid,
      concat('owner_booking_', o.event_type),
      o.status,
      CASE
        WHEN o.status = 'unknown' THEN 'reconcile_required'
        WHEN o.next_attempt_at IS NOT NULL THEN 'auto_retry_scheduled'
        ELSE 'manual_follow_up'
      END,
      CASE
        WHEN o.status = 'unknown' THEN 'outcome_not_confirmed'
        WHEN o.next_attempt_at IS NOT NULL THEN 'retry_scheduled'
        ELSE 'delivery_failed'
      END,
      o.created_at,
      b.start_time_utc,
      NULL::date
    FROM public.owner_booking_notification_outbox o
    JOIN public.bookings b
      ON b.id = o.booking_id AND b.salon_id = o.salon_id
    WHERE o.salon_id = p_salon_id
      AND o.created_at >= v_since
      AND o.status IN ('failed', 'unknown')

    UNION ALL

    SELECT
      concat('customer-booking-email:', o.id::text),
      'email',
      'booking',
      o.booking_id,
      NULL::uuid,
      concat('customer_booking_', o.event_type),
      o.status,
      CASE
        WHEN o.status = 'unknown' THEN 'reconcile_required'
        WHEN o.next_attempt_at IS NOT NULL THEN 'auto_retry_scheduled'
        ELSE 'manual_follow_up'
      END,
      CASE
        WHEN o.status = 'unknown' THEN 'outcome_not_confirmed'
        WHEN o.next_attempt_at IS NOT NULL THEN 'retry_scheduled'
        ELSE 'delivery_failed'
      END,
      o.created_at,
      b.start_time_utc,
      NULL::date
    FROM public.customer_booking_transition_email_outbox o
    JOIN public.bookings b
      ON b.id = o.booking_id AND b.salon_id = o.salon_id
    WHERE o.salon_id = p_salon_id
      AND o.created_at >= v_since
      AND o.status IN ('failed', 'unknown')

    UNION ALL

    SELECT
      concat('owner-waitlist-email:', o.id::text),
      'email',
      'waitlist',
      NULL::uuid,
      o.waitlist_entry_id,
      'owner_waitlist_joined',
      o.status,
      CASE
        WHEN o.status = 'unknown' THEN 'reconcile_required'
        WHEN o.status = 'pending' OR o.next_attempt_at IS NOT NULL
          THEN 'auto_retry_scheduled'
        ELSE 'manual_follow_up'
      END,
      CASE
        WHEN o.status = 'unknown' THEN 'outcome_not_confirmed'
        WHEN o.status = 'pending' OR o.next_attempt_at IS NOT NULL
          THEN 'retry_scheduled'
        ELSE 'delivery_failed'
      END,
      o.created_at,
      NULL::timestamptz,
      w.booking_date
    FROM public.owner_waitlist_notification_outbox o
    JOIN public.booking_waitlist_entries w
      ON w.id = o.waitlist_entry_id AND w.salon_id = o.salon_id
    WHERE o.salon_id = p_salon_id
      AND o.created_at >= v_since
      AND o.status IN ('pending', 'failed', 'unknown')
      AND NOT (o.status = 'pending'
        AND o.created_at >= transaction_timestamp() - interval '5 minutes')

    UNION ALL

    SELECT
      concat('waitlist-offer:', o.id::text),
      o.channel,
      'waitlist',
      NULL::uuid,
      o.waitlist_entry_id,
      'customer_waitlist_offer',
      o.status,
      CASE
        WHEN o.status = 'unknown' THEN 'reconcile_required'
        ELSE 'manual_follow_up'
      END,
      CASE
        WHEN o.status = 'unknown' THEN 'outcome_not_confirmed'
        ELSE 'delivery_failed'
      END,
      o.created_at,
      NULL::timestamptz,
      w.booking_date
    FROM public.waitlist_offer_delivery_outbox o
    JOIN public.booking_waitlist_entries w
      ON w.id = o.waitlist_entry_id AND w.salon_id = o.salon_id
    WHERE o.salon_id = p_salon_id
      AND o.created_at >= v_since
      AND o.status IN ('failed', 'unknown')
  ), bounded AS (
    SELECT *
    FROM delivery_issues
    ORDER BY occurred_at DESC, issue_key
    LIMIT 10
  )
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'issue_key', issue_key,
        'channel', channel,
        'destination', destination,
        'booking_id', booking_id,
        'waitlist_entry_id', waitlist_entry_id,
        'notification_kind', notification_kind,
        'status', status,
        'resolution', resolution,
        'reason_code', reason_code,
        'occurred_at', occurred_at,
        'booking_start_time_utc', booking_start_time_utc,
        'waitlist_booking_date', waitlist_booking_date
      ) ORDER BY occurred_at DESC, issue_key
    ),
    '[]'::jsonb
  ) INTO v_issues
  FROM bounded;

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
    'waitlist_attention_count', v_waitlist_attention,
    'issues', v_issues
  );
END;
$rescue$;

REVOKE ALL ON FUNCTION public.load_notification_delivery_rescue_summary(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_notification_delivery_rescue_summary(uuid, timestamptz)
  TO service_role;
