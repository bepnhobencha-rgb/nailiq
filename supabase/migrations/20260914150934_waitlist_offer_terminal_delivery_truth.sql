-- P1-01: expose terminal provider truth for the current waitlist offer without
-- leaking recipients, fingerprints, provider receipts, or cross-tenant rows.
--
-- The domain outbox records provider acceptance. Twilio's universal attempt
-- ledger and Resend's registered-event ledger record the later delivery
-- callback. This service-role-only projection combines them for the existing
-- receptionist UI and never retries either provider.

CREATE OR REPLACE FUNCTION public.load_waitlist_offer_delivery_truth(
  p_salon_id uuid,
  p_waitlist_entry_ids uuid[]
)
RETURNS TABLE (
  waitlist_entry_id uuid,
  offer_epoch bigint,
  channel text,
  status text,
  error_code text,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $truth$
  SELECT
    outbox.waitlist_entry_id,
    outbox.offer_epoch,
    outbox.channel,
    CASE
      WHEN outbox.status <> 'sent' THEN outbox.status
      WHEN outbox.channel = 'sms' THEN
        CASE coalesce(sms_attempt.status, 'accepted')
          WHEN 'delivered' THEN 'delivered'
          WHEN 'accepted' THEN 'accepted'
          WHEN 'sending' THEN 'sending'
          WHEN 'undelivered' THEN 'failed'
          WHEN 'failed' THEN 'failed'
          WHEN 'suppressed' THEN 'suppressed'
          WHEN 'unknown' THEN 'unknown'
          ELSE 'unknown'
        END
      ELSE
        CASE coalesce(email_event.delivery_status, 'provider_accepted')
          WHEN 'provider_accepted' THEN 'accepted'
          WHEN 'delivered' THEN 'delivered'
          WHEN 'delivery_delayed' THEN 'sending'
          WHEN 'failed' THEN 'failed'
          WHEN 'bounced' THEN 'failed'
          WHEN 'complained' THEN 'failed'
          WHEN 'suppressed' THEN 'suppressed'
          ELSE 'unknown'
        END
    END AS status,
    CASE
      WHEN outbox.status <> 'sent' THEN outbox.error_code
      WHEN outbox.channel = 'sms' AND sms_attempt.status IN ('undelivered', 'failed')
        THEN 'provider_rejected'
      WHEN outbox.channel = 'sms' AND sms_attempt.status = 'suppressed'
        THEN 'recipient_suppressed'
      WHEN outbox.channel = 'sms' AND sms_attempt.status = 'unknown'
        THEN 'provider_exception'
      WHEN outbox.channel = 'email'
        AND email_event.delivery_status IN ('failed', 'bounced', 'complained')
        THEN 'provider_rejected'
      WHEN outbox.channel = 'email' AND email_event.delivery_status = 'suppressed'
        THEN 'recipient_suppressed'
      ELSE NULL
    END AS error_code,
    greatest(
      outbox.updated_at,
      coalesce(sms_attempt.updated_at, '-infinity'::timestamptz),
      coalesce(email_event.occurred_at, '-infinity'::timestamptz)
    ) AS updated_at
  FROM public.waitlist_offer_delivery_outbox AS outbox
  LEFT JOIN public.sms_delivery_attempts AS sms_attempt
    ON outbox.channel = 'sms'
   AND sms_attempt.salon_id = outbox.salon_id
   AND sms_attempt.notification_type = 'waitlist_offer'
   AND sms_attempt.provider_message_sid = outbox.provider_receipt
   AND sms_attempt.recipient_fingerprint = outbox.recipient_fingerprint
  LEFT JOIN LATERAL (
    SELECT event.delivery_status, event.occurred_at, event.id
    FROM public.registered_email_delivery_events AS event
    WHERE outbox.channel = 'email'
      AND event.provider_message_id = outbox.provider_receipt
      AND event.email_key = 'waitlist_offer'
      AND event.audience = 'customer'
      AND event.recipient_count = 1
      AND event.recipient_fingerprint = outbox.recipient_fingerprint
    -- A delayed/reordered provider callback must never downgrade terminal
    -- truth back to "accepted". For equally terminal outcomes, provider time
    -- still decides which receipt is current (for example delivered -> bounced).
    ORDER BY
      CASE event.delivery_status
        WHEN 'failed' THEN 3
        WHEN 'suppressed' THEN 3
        WHEN 'bounced' THEN 3
        WHEN 'complained' THEN 3
        WHEN 'delivered' THEN 2
        WHEN 'delivery_delayed' THEN 1
        WHEN 'provider_accepted' THEN 0
        ELSE -1
      END DESC,
      event.occurred_at DESC,
      event.id DESC
    LIMIT 1
  ) AS email_event ON true
  WHERE p_salon_id IS NOT NULL
    AND p_waitlist_entry_ids IS NOT NULL
    AND cardinality(p_waitlist_entry_ids) BETWEEN 1 AND 100
    AND outbox.salon_id = p_salon_id
    AND outbox.waitlist_entry_id = ANY (p_waitlist_entry_ids);
$truth$;

REVOKE ALL ON FUNCTION public.load_waitlist_offer_delivery_truth(uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_waitlist_offer_delivery_truth(uuid, uuid[])
  TO service_role;

COMMENT ON FUNCTION public.load_waitlist_offer_delivery_truth(uuid, uuid[]) IS
  'Tenant-scoped, PII-free waitlist offer status combined with terminal Twilio/Resend delivery callbacks.';
