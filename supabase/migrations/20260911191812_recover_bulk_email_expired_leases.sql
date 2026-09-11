-- Recover crashed bulk-email workers without widening the canary or silently
-- resending an ambiguous third attempt. The stable idempotency key lets a
-- retry reuse the provider request safely. A third expired lease becomes
-- unknown and must be reviewed before bulk release can proceed.

CREATE OR REPLACE FUNCTION public.claim_marketing_email_campaign_recipients(
  p_campaign_id uuid,
  p_batch_size integer DEFAULT 25
)
RETURNS TABLE (
  recipient_id uuid,
  salon_id uuid,
  client_profile_id uuid,
  attempt_token uuid,
  idempotency_key text,
  recipient_fingerprint text,
  consent_fingerprint text,
  content_fingerprint text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.marketing_email_campaigns%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_limit integer := least(greatest(coalesce(p_batch_size, 25), 1), 100);
  v_token uuid;
  v_row public.marketing_email_campaign_recipients%ROWTYPE;
  v_claimed integer := 0;
  v_new_claimed integer := 0;
  v_canary_remaining integer;
BEGIN
  IF NOT public.marketing_email_campaign_caller_is_service_role() THEN
    RETURN;
  END IF;

  SELECT campaign.* INTO v_campaign
  FROM public.marketing_email_campaigns AS campaign
  JOIN public.salons AS salon ON salon.id = campaign.salon_id
  WHERE campaign.id = p_campaign_id
    AND campaign.status IN ('approved', 'sending')
    AND campaign.dispatch_stage IN ('canary', 'bulk')
    AND (campaign.send_after IS NULL OR campaign.send_after <= v_now)
    AND salon.archived_at IS NULL
    AND salon.email_outbound_enabled IS TRUE
    AND salon.feature_flags ->> 'bulk_email_campaign_dispatch_enabled' = 'true'
  FOR UPDATE OF campaign;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  WITH recovered AS (
    UPDATE public.marketing_email_campaign_recipients AS recipient SET
      status = CASE WHEN recipient.attempt_count < 3 THEN 'prepared' ELSE 'unknown' END,
      completed_at = CASE WHEN recipient.attempt_count < 3 THEN NULL ELSE v_now END,
      lease_token_hash = NULL,
      lease_expires_at = NULL,
      updated_at = v_now
    WHERE recipient.campaign_id = v_campaign.id
      AND recipient.salon_id = v_campaign.salon_id
      AND recipient.status = 'leased'
      AND recipient.lease_expires_at <= v_now
    RETURNING recipient.id, recipient.attempt_count, recipient.status
  )
  INSERT INTO public.marketing_email_campaign_events (
    campaign_id, salon_id, actor_user_id, event_type, details, created_at
  )
  SELECT
    v_campaign.id,
    v_campaign.salon_id,
    NULL,
    CASE WHEN recovered.status = 'unknown' THEN 'recipient_unknown' ELSE 'recipient_failed' END,
    jsonb_build_object(
      'recipient_id', recovered.id,
      'attempt_count', recovered.attempt_count,
      'reason', 'lease_expired',
      'disposition', CASE WHEN recovered.status = 'unknown' THEN 'manual_review' ELSE 'retryable' END,
      'provider_call_state', 'unknown'
    ),
    v_now
  FROM recovered;

  -- A terminal canary recovery may have advanced the stage through the
  -- completion trigger. Refresh under the same campaign lock before claiming.
  SELECT campaign.* INTO v_campaign
  FROM public.marketing_email_campaigns AS campaign
  WHERE campaign.id = p_campaign_id
  FOR UPDATE;
  IF v_campaign.status NOT IN ('approved', 'sending')
    OR v_campaign.dispatch_stage NOT IN ('canary', 'bulk')
  THEN
    RETURN;
  END IF;

  v_limit := least(v_limit, v_campaign.batch_size::integer);

  IF v_campaign.dispatch_stage = 'canary' THEN
    v_canary_remaining := least(v_campaign.canary_size::integer, v_campaign.audience_count)
      - v_campaign.canary_claimed_count;
  ELSE
    v_canary_remaining := 0;
  END IF;

  UPDATE public.marketing_email_campaigns SET status = 'sending', updated_at = v_now
  WHERE id = v_campaign.id AND status = 'approved';

  FOR v_row IN
    WITH candidates AS (
      SELECT
        recipient.*,
        count(*) FILTER (WHERE recipient.dispatch_cohort = 'pending') OVER (
          ORDER BY
            CASE WHEN recipient.dispatch_cohort = v_campaign.dispatch_stage THEN 0 ELSE 1 END,
            recipient.created_at,
            recipient.id
        ) AS pending_rank
      FROM public.marketing_email_campaign_recipients AS recipient
      WHERE recipient.campaign_id = v_campaign.id
        AND recipient.salon_id = v_campaign.salon_id
        AND recipient.status = 'prepared'
        AND recipient.attempt_count < 3
        AND recipient.dispatch_cohort IN ('pending', v_campaign.dispatch_stage)
    ), selected AS (
      SELECT candidate.id
      FROM candidates AS candidate
      WHERE candidate.dispatch_cohort = v_campaign.dispatch_stage
        OR v_campaign.dispatch_stage = 'bulk'
        OR candidate.pending_rank <= greatest(v_canary_remaining, 0)
      ORDER BY
        CASE WHEN candidate.dispatch_cohort = v_campaign.dispatch_stage THEN 0 ELSE 1 END,
        candidate.created_at,
        candidate.id
      LIMIT v_limit
    )
    SELECT recipient.*
    FROM public.marketing_email_campaign_recipients AS recipient
    JOIN selected ON selected.id = recipient.id
    ORDER BY
      CASE WHEN recipient.dispatch_cohort = v_campaign.dispatch_stage THEN 0 ELSE 1 END,
      recipient.created_at,
      recipient.id
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  LOOP
    v_token := extensions.gen_random_uuid();
    UPDATE public.marketing_email_campaign_recipients SET
      status = 'leased',
      dispatch_cohort = v_campaign.dispatch_stage,
      attempt_count = attempt_count + 1,
      lease_token_hash = encode(extensions.digest(
        convert_to(v_token::text, 'UTF8'), 'sha256'
      ), 'hex'),
      lease_expires_at = v_now + interval '5 minutes',
      updated_at = v_now
    WHERE id = v_row.id;

    v_claimed := v_claimed + 1;
    IF v_campaign.dispatch_stage = 'canary' AND v_row.dispatch_cohort = 'pending' THEN
      v_new_claimed := v_new_claimed + 1;
    END IF;
    recipient_id := v_row.id;
    salon_id := v_row.salon_id;
    client_profile_id := v_row.client_profile_id;
    attempt_token := v_token;
    idempotency_key := v_row.idempotency_key;
    recipient_fingerprint := v_row.recipient_fingerprint;
    consent_fingerprint := v_row.consent_fingerprint;
    content_fingerprint := v_campaign.content_fingerprint;
    RETURN NEXT;
  END LOOP;

  IF v_claimed > 0 THEN
    UPDATE public.marketing_email_campaigns SET
      canary_claimed_count = canary_claimed_count +
        CASE WHEN v_campaign.dispatch_stage = 'canary' THEN v_new_claimed ELSE 0 END,
      updated_at = v_now
    WHERE id = v_campaign.id;

    INSERT INTO public.marketing_email_campaign_events (
      campaign_id, salon_id, actor_user_id, event_type, details, created_at
    ) VALUES (
      v_campaign.id, v_campaign.salon_id, NULL, 'batch_claimed',
      jsonb_build_object(
        'dispatch_stage', v_campaign.dispatch_stage,
        'claimed_count', v_claimed,
        'provider_called', false
      ), v_now
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_marketing_email_campaign_recipients(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_marketing_email_campaign_recipients(uuid, integer)
  TO service_role;

COMMENT ON FUNCTION public.claim_marketing_email_campaign_recipients(uuid, integer) IS
  'Service-only controlled claim with database canary cap, stable idempotency, and bounded expired-lease recovery.';

-- Rollback boundary: keep dispatch gates OFF, then restore the prior claim
-- function body from 20260911190838. No recipient evidence needs deletion.
