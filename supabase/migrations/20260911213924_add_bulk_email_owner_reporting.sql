-- Owner-facing aggregate delivery truth for bulk email campaigns.
--
-- This migration does not enable campaign dispatch, does not contact a
-- provider, and does not expose recipient PII. It repairs the durable
-- suppression boundary for provider adverse events and adds one service-only,
-- owner/admin-authorized aggregate report RPC.
--
-- Rollback boundary: keep existing suppression rows because they protect
-- customers from repeat sends. Revoke/drop the report RPC, then restore the
-- prior delivery-event function body from 20260911153229 if required.

CREATE OR REPLACE FUNCTION public.record_marketing_email_campaign_delivery_event(
  p_provider_message_id text,
  p_recipient_fingerprint text,
  p_event_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_recipient public.marketing_email_campaign_recipients%ROWTYPE;
  v_provider_fingerprint text;
  v_next_status text;
  v_now timestamptz := clock_timestamp();
  v_suppression_reason text;
BEGIN
  IF NOT public.marketing_email_campaign_caller_is_service_role() THEN
    RETURN jsonb_build_object('success', false, 'code', 'event_rejected');
  END IF;
  IF p_provider_message_id IS NULL
    OR p_provider_message_id !~ '^[!-~]{1,255}$'
    OR p_recipient_fingerprint IS NULL
    OR p_recipient_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_event_type NOT IN (
      'email.sent', 'email.delivered', 'email.delivery_delayed',
      'email.failed', 'email.suppressed', 'email.bounced', 'email.complained'
    )
  THEN
    RETURN jsonb_build_object('success', false, 'code', 'event_rejected');
  END IF;

  v_provider_fingerprint := encode(extensions.digest(
    convert_to(p_provider_message_id, 'UTF8'), 'sha256'
  ), 'hex');
  SELECT recipient.* INTO v_recipient
  FROM public.marketing_email_campaign_recipients AS recipient
  WHERE recipient.provider_message_fingerprint = v_provider_fingerprint
    AND recipient.recipient_fingerprint = p_recipient_fingerprint
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'code', 'event_pending_match');
  END IF;

  v_next_status := CASE p_event_type
    WHEN 'email.delivered' THEN CASE
      WHEN v_recipient.status IN ('suppressed', 'bounced', 'complained')
      THEN v_recipient.status ELSE 'delivered' END
    WHEN 'email.failed' THEN CASE
      WHEN v_recipient.status IN ('delivered', 'suppressed', 'bounced', 'complained')
      THEN v_recipient.status ELSE 'failed' END
    WHEN 'email.suppressed' THEN 'suppressed'
    WHEN 'email.bounced' THEN 'bounced'
    WHEN 'email.complained' THEN 'complained'
    ELSE v_recipient.status
  END;

  -- Persist provider suppressions even on an event replay. This makes the
  -- repair idempotent when a prior webhook updated the campaign receipt but
  -- did not yet create the cross-campaign safety suppression.
  v_suppression_reason := CASE p_event_type
    WHEN 'email.suppressed' THEN 'suppressed'
    WHEN 'email.bounced' THEN 'bounced'
    WHEN 'email.complained' THEN 'complained'
    ELSE NULL
  END;
  IF v_suppression_reason IS NOT NULL THEN
    INSERT INTO public.customer_email_delivery_suppressions (
      salon_id, recipient_fingerprint, reason, provider_message_id,
      first_event_at, last_event_at
    ) VALUES (
      v_recipient.salon_id, v_recipient.recipient_fingerprint,
      v_suppression_reason, p_provider_message_id, v_now, v_now
    ) ON CONFLICT (salon_id, recipient_fingerprint) DO UPDATE SET
      reason = CASE
        WHEN public.customer_email_delivery_suppressions.reason = 'complained'
          OR excluded.reason = 'complained' THEN 'complained'
        WHEN public.customer_email_delivery_suppressions.reason = 'bounced'
          OR excluded.reason = 'bounced' THEN 'bounced'
        ELSE 'suppressed' END,
      provider_message_id = excluded.provider_message_id,
      first_event_at = least(
        public.customer_email_delivery_suppressions.first_event_at,
        excluded.first_event_at
      ),
      last_event_at = greatest(
        public.customer_email_delivery_suppressions.last_event_at,
        excluded.last_event_at
      ),
      updated_at = transaction_timestamp();
  END IF;

  IF v_recipient.status = v_next_status THEN
    RETURN jsonb_build_object('success', true, 'code', 'event_replay');
  END IF;

  UPDATE public.marketing_email_campaign_recipients SET
    status = v_next_status,
    suppression_reason = CASE
      WHEN p_event_type IN ('email.suppressed', 'email.bounced', 'email.complained')
      THEN 'provider_suppressed'
      ELSE suppression_reason
    END,
    delivered_at = CASE WHEN p_event_type = 'email.delivered' THEN v_now ELSE delivered_at END,
    completed_at = CASE
      WHEN p_event_type IN (
        'email.delivered', 'email.failed', 'email.suppressed',
        'email.bounced', 'email.complained'
      ) THEN v_now ELSE completed_at
    END,
    updated_at = v_now
  WHERE id = v_recipient.id;

  INSERT INTO public.marketing_email_campaign_events (
    campaign_id, salon_id, actor_user_id, event_type, details, created_at
  ) VALUES (
    v_recipient.campaign_id, v_recipient.salon_id, NULL,
    'delivery_receipt',
    jsonb_build_object(
      'recipient_id', v_recipient.id,
      'event_type', p_event_type,
      'delivery_status', v_next_status
    ), v_now
  );
  RETURN jsonb_build_object('success', true, 'code', 'event_applied');
END;
$function$;

-- Repair historical adverse campaign receipts without storing raw email or a
-- raw provider identifier. The synthetic identifier is deliberately derived
-- from the existing irreversible provider fingerprint.
INSERT INTO public.customer_email_delivery_suppressions (
  salon_id, recipient_fingerprint, reason, provider_message_id,
  first_event_at, last_event_at
)
SELECT
  recipient.salon_id,
  recipient.recipient_fingerprint,
  CASE recipient.status
    WHEN 'complained' THEN 'complained'
    WHEN 'bounced' THEN 'bounced'
    ELSE 'suppressed'
  END,
  'campaign-backfill:' || coalesce(
    recipient.provider_message_fingerprint,
    encode(extensions.digest(convert_to(recipient.id::text, 'UTF8'), 'sha256'), 'hex')
  ),
  coalesce(recipient.completed_at, recipient.updated_at, recipient.created_at),
  coalesce(recipient.completed_at, recipient.updated_at, recipient.created_at)
FROM public.marketing_email_campaign_recipients AS recipient
WHERE recipient.status IN ('suppressed', 'bounced', 'complained')
ON CONFLICT (salon_id, recipient_fingerprint) DO UPDATE SET
  reason = CASE
    WHEN public.customer_email_delivery_suppressions.reason = 'complained'
      OR excluded.reason = 'complained' THEN 'complained'
    WHEN public.customer_email_delivery_suppressions.reason = 'bounced'
      OR excluded.reason = 'bounced' THEN 'bounced'
    ELSE 'suppressed' END,
  first_event_at = least(
    public.customer_email_delivery_suppressions.first_event_at,
    excluded.first_event_at
  ),
  last_event_at = greatest(
    public.customer_email_delivery_suppressions.last_event_at,
    excluded.last_event_at
  ),
  updated_at = transaction_timestamp();

CREATE OR REPLACE FUNCTION public.get_marketing_email_campaign_report(
  p_campaign_id uuid,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_campaign public.marketing_email_campaigns%ROWTYPE;
  v_counts jsonb;
  v_global_suppression_count integer;
  v_receipt_count integer;
  v_last_delivery_event_at timestamptz;
BEGIN
  IF NOT public.marketing_email_campaign_caller_is_service_role() THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;

  SELECT campaign.* INTO v_campaign
  FROM public.marketing_email_campaigns AS campaign
  WHERE campaign.id = p_campaign_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_found');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.salon_members AS member
    WHERE member.salon_id = v_campaign.salon_id
      AND member.user_id = p_actor_user_id
      AND member.role IN ('owner', 'admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'forbidden');
  END IF;

  SELECT jsonb_build_object(
    'prepared', count(*) FILTER (WHERE recipient.status = 'prepared'),
    'leased', count(*) FILTER (WHERE recipient.status = 'leased'),
    'simulated', count(*) FILTER (WHERE recipient.status = 'simulated'),
    'provider_accepted', count(*) FILTER (WHERE recipient.status = 'provider_accepted'),
    'delivered', count(*) FILTER (WHERE recipient.status = 'delivered'),
    'failed', count(*) FILTER (WHERE recipient.status = 'failed'),
    'unknown', count(*) FILTER (WHERE recipient.status = 'unknown'),
    'suppressed', count(*) FILTER (WHERE recipient.status = 'suppressed'),
    'bounced', count(*) FILTER (WHERE recipient.status = 'bounced'),
    'complained', count(*) FILTER (WHERE recipient.status = 'complained')
  ) INTO v_counts
  FROM public.marketing_email_campaign_recipients AS recipient
  WHERE recipient.campaign_id = v_campaign.id
    AND recipient.salon_id = v_campaign.salon_id;

  SELECT count(*)::integer INTO v_global_suppression_count
  FROM public.marketing_email_campaign_recipients AS recipient
  JOIN public.customer_email_delivery_suppressions AS suppression
    ON suppression.salon_id = recipient.salon_id
   AND suppression.recipient_fingerprint = recipient.recipient_fingerprint
  WHERE recipient.campaign_id = v_campaign.id
    AND recipient.salon_id = v_campaign.salon_id;

  SELECT count(*)::integer, max(event.created_at)
  INTO v_receipt_count, v_last_delivery_event_at
  FROM public.marketing_email_campaign_events AS event
  WHERE event.campaign_id = v_campaign.id
    AND event.salon_id = v_campaign.salon_id
    AND event.event_type = 'delivery_receipt';

  RETURN jsonb_build_object(
    'success', true,
    'code', 'report_ready',
    'campaign_id', v_campaign.id,
    'salon_id', v_campaign.salon_id,
    'audience_count', v_campaign.audience_count,
    'counts', coalesce(v_counts, '{}'::jsonb),
    'global_suppression_count', coalesce(v_global_suppression_count, 0),
    'delivery_receipt_count', coalesce(v_receipt_count, 0),
    'last_delivery_event_at', v_last_delivery_event_at,
    'generated_at', transaction_timestamp()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.record_marketing_email_campaign_delivery_event(text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_marketing_email_campaign_delivery_event(text, text, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.get_marketing_email_campaign_report(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_marketing_email_campaign_report(uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public.get_marketing_email_campaign_report(uuid, uuid) IS
  'Service-only, owner/admin-authorized aggregate delivery report. Returns no recipient PII.';
