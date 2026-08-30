-- PII-free delivery-health projection for the Receptionist Center Rescue Card.
-- The browser never reads private attempt/outbox tables directly. Only the
-- server-side service role may request tenant-scoped counts.

CREATE OR REPLACE FUNCTION public.load_notification_delivery_rescue_summary(
  p_salon_id uuid,
  p_since timestamptz DEFAULT transaction_timestamp() - interval '24 hours'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
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
        AND NOT (o.status = 'pending' AND o.created_at >= transaction_timestamp() - interval '5 minutes'))
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
$function$;

REVOKE ALL ON FUNCTION public.load_notification_delivery_rescue_summary(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_notification_delivery_rescue_summary(uuid, timestamptz)
  TO service_role;
