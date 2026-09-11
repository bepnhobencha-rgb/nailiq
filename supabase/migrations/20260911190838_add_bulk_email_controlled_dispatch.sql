-- Controlled delivery stages for bulk salon marketing email.
--
-- The prior foundation can freeze and approve an audience, but it intentionally
-- has no send control. This migration adds a database-enforced canary ceiling,
-- an explicit owner/admin bulk release, and a pause/resume boundary. Nothing is
-- enabled for any salon and the application/provider gates remain independent.

ALTER TABLE public.marketing_email_campaigns
  ADD COLUMN dispatch_stage text NOT NULL DEFAULT 'locked',
  ADD COLUMN canary_claimed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN bulk_release_approved_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN bulk_release_approved_at timestamptz,
  ADD COLUMN paused_at timestamptz,
  ADD COLUMN paused_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN paused_from_stage text;

ALTER TABLE public.marketing_email_campaigns
  ADD CONSTRAINT marketing_email_campaign_dispatch_stage_check
    CHECK (dispatch_stage IN ('locked', 'canary', 'canary_complete', 'bulk', 'paused', 'completed')),
  ADD CONSTRAINT marketing_email_campaign_canary_claimed_count_check
    CHECK (canary_claimed_count >= 0 AND canary_claimed_count <= audience_count),
  ADD CONSTRAINT marketing_email_campaign_bulk_release_state_check
    CHECK ((bulk_release_approved_by IS NULL) = (bulk_release_approved_at IS NULL)),
  ADD CONSTRAINT marketing_email_campaign_pause_state_check
    CHECK (
      (dispatch_stage = 'paused'
        AND paused_at IS NOT NULL
        AND paused_by IS NOT NULL
        AND paused_from_stage IN ('canary', 'bulk'))
      OR
      (dispatch_stage <> 'paused'
        AND paused_at IS NULL
        AND paused_by IS NULL
        AND paused_from_stage IS NULL)
    );

UPDATE public.marketing_email_campaigns
SET dispatch_stage = 'completed'
WHERE status = 'completed';

ALTER TABLE public.marketing_email_campaign_recipients
  ADD COLUMN dispatch_cohort text NOT NULL DEFAULT 'pending'
    CHECK (dispatch_cohort IN ('pending', 'canary', 'bulk'));

ALTER TABLE public.marketing_email_campaign_events
  DROP CONSTRAINT IF EXISTS marketing_email_campaign_events_event_type_check;
ALTER TABLE public.marketing_email_campaign_events
  ADD CONSTRAINT marketing_email_campaign_events_event_type_check CHECK (event_type IN (
    'draft_created', 'audience_prepared', 'approved', 'cancelled',
    'canary_started', 'canary_completed', 'bulk_released',
    'dispatch_paused', 'dispatch_resumed',
    'batch_claimed', 'recipient_simulated', 'provider_accepted',
    'recipient_failed', 'recipient_unknown', 'recipient_suppressed',
    'delivery_receipt', 'campaign_completed'
  ));

CREATE INDEX marketing_email_campaigns_bulk_release_approved_by_idx
  ON public.marketing_email_campaigns(bulk_release_approved_by);
CREATE INDEX marketing_email_campaigns_paused_by_idx
  ON public.marketing_email_campaigns(paused_by);
CREATE INDEX marketing_email_campaign_recipients_cohort_status_idx
  ON public.marketing_email_campaign_recipients(campaign_id, dispatch_cohort, status);

CREATE OR REPLACE FUNCTION public.start_marketing_email_campaign_canary(
  p_campaign_id uuid,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.marketing_email_campaigns%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NOT public.marketing_email_campaign_caller_is_service_role() THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;

  SELECT campaign.* INTO v_campaign
  FROM public.marketing_email_campaigns AS campaign
  WHERE campaign.id = p_campaign_id
  FOR UPDATE;
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
  IF v_campaign.dispatch_stage = 'canary'
    AND v_campaign.status IN ('approved', 'sending')
  THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'canary_active',
      'campaign_id', v_campaign.id,
      'canary_limit', least(v_campaign.canary_size::integer, v_campaign.audience_count)
    );
  END IF;
  IF v_campaign.status <> 'approved' OR v_campaign.dispatch_stage <> 'locked' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_state');
  END IF;
  IF v_campaign.audience_count < 1 THEN
    RETURN jsonb_build_object('success', false, 'code', 'empty_audience');
  END IF;

  UPDATE public.marketing_email_campaigns SET
    dispatch_stage = 'canary',
    updated_at = v_now
  WHERE id = v_campaign.id;

  INSERT INTO public.marketing_email_campaign_events (
    campaign_id, salon_id, actor_user_id, event_type, details, created_at
  ) VALUES (
    v_campaign.id, v_campaign.salon_id, p_actor_user_id, 'canary_started',
    jsonb_build_object(
      'canary_limit', least(v_campaign.canary_size::integer, v_campaign.audience_count),
      'provider_called', false,
      'no_messages_sent', true
    ), v_now
  );

  RETURN jsonb_build_object(
    'success', true,
    'code', 'canary_started',
    'campaign_id', v_campaign.id,
    'canary_limit', least(v_campaign.canary_size::integer, v_campaign.audience_count)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.pause_marketing_email_campaign_dispatch(
  p_campaign_id uuid,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.marketing_email_campaigns%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NOT public.marketing_email_campaign_caller_is_service_role() THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  SELECT campaign.* INTO v_campaign
  FROM public.marketing_email_campaigns AS campaign
  WHERE campaign.id = p_campaign_id
  FOR UPDATE;
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
  IF v_campaign.dispatch_stage = 'paused' THEN
    RETURN jsonb_build_object('success', true, 'code', 'already_paused');
  END IF;
  IF v_campaign.dispatch_stage NOT IN ('canary', 'bulk') THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_state');
  END IF;

  UPDATE public.marketing_email_campaigns SET
    dispatch_stage = 'paused',
    paused_at = v_now,
    paused_by = p_actor_user_id,
    paused_from_stage = v_campaign.dispatch_stage,
    updated_at = v_now
  WHERE id = v_campaign.id;

  INSERT INTO public.marketing_email_campaign_events (
    campaign_id, salon_id, actor_user_id, event_type, details, created_at
  ) VALUES (
    v_campaign.id, v_campaign.salon_id, p_actor_user_id, 'dispatch_paused',
    jsonb_build_object(
      'paused_from_stage', v_campaign.dispatch_stage,
      'leased_count', (
        SELECT count(*) FROM public.marketing_email_campaign_recipients AS recipient
        WHERE recipient.campaign_id = v_campaign.id AND recipient.status = 'leased'
      )
    ), v_now
  );

  RETURN jsonb_build_object('success', true, 'code', 'dispatch_paused');
END;
$$;

CREATE OR REPLACE FUNCTION public.resume_marketing_email_campaign_dispatch(
  p_campaign_id uuid,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.marketing_email_campaigns%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_stage text;
  v_canary_limit integer;
  v_remaining integer;
BEGIN
  IF NOT public.marketing_email_campaign_caller_is_service_role() THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  SELECT campaign.* INTO v_campaign
  FROM public.marketing_email_campaigns AS campaign
  WHERE campaign.id = p_campaign_id
  FOR UPDATE;
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
  IF v_campaign.dispatch_stage IN ('canary', 'bulk', 'canary_complete', 'completed') THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'already_active',
      'stage', v_campaign.dispatch_stage
    );
  END IF;
  IF v_campaign.dispatch_stage <> 'paused' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_state');
  END IF;

  v_stage := v_campaign.paused_from_stage;
  v_canary_limit := least(v_campaign.canary_size::integer, v_campaign.audience_count);
  SELECT count(*)::integer INTO v_remaining
  FROM public.marketing_email_campaign_recipients AS recipient
  WHERE recipient.campaign_id = v_campaign.id
    AND recipient.status IN ('prepared', 'leased');
  IF v_remaining = 0 THEN
    v_stage := 'completed';
  END IF;
  IF v_stage = 'canary'
    AND v_campaign.canary_claimed_count >= v_canary_limit
    AND NOT EXISTS (
      SELECT 1 FROM public.marketing_email_campaign_recipients AS recipient
      WHERE recipient.campaign_id = v_campaign.id
        AND recipient.dispatch_cohort = 'canary'
        AND recipient.status = 'leased'
    )
  THEN
    v_stage := 'canary_complete';
  END IF;

  UPDATE public.marketing_email_campaigns SET
    dispatch_stage = v_stage,
    paused_at = NULL,
    paused_by = NULL,
    paused_from_stage = NULL,
    status = CASE
      WHEN v_stage = 'completed' THEN 'completed'
      WHEN v_stage = 'canary_complete' THEN 'approved'
      ELSE status
    END,
    completed_at = CASE WHEN v_stage = 'completed' THEN v_now ELSE completed_at END,
    updated_at = v_now
  WHERE id = v_campaign.id;

  INSERT INTO public.marketing_email_campaign_events (
    campaign_id, salon_id, actor_user_id, event_type, details, created_at
  ) VALUES (
    v_campaign.id, v_campaign.salon_id, p_actor_user_id, 'dispatch_resumed',
    jsonb_build_object('resumed_stage', v_stage), v_now
  );

  IF v_stage = 'completed' THEN
    INSERT INTO public.marketing_email_campaign_events (
      campaign_id, salon_id, actor_user_id, event_type, details, created_at
    ) VALUES (
      v_campaign.id, v_campaign.salon_id, p_actor_user_id, 'campaign_completed',
      jsonb_build_object('remaining_count', 0, 'completed_after', 'resume'), v_now
    );
  END IF;

  RETURN jsonb_build_object('success', true, 'code', 'dispatch_resumed', 'stage', v_stage);
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_marketing_email_campaign_bulk_release(
  p_campaign_id uuid,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.marketing_email_campaigns%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_adverse integer;
BEGIN
  IF NOT public.marketing_email_campaign_caller_is_service_role() THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  SELECT campaign.* INTO v_campaign
  FROM public.marketing_email_campaigns AS campaign
  WHERE campaign.id = p_campaign_id
  FOR UPDATE;
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
  IF v_campaign.dispatch_stage IN ('bulk', 'completed')
    AND v_campaign.bulk_release_approved_at IS NOT NULL
  THEN
    RETURN jsonb_build_object('success', true, 'code', 'already_released');
  END IF;
  IF v_campaign.status <> 'approved' OR v_campaign.dispatch_stage <> 'canary_complete' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_state');
  END IF;

  SELECT count(*)::integer INTO v_adverse
  FROM public.marketing_email_campaign_recipients AS recipient
  WHERE recipient.campaign_id = v_campaign.id
    AND recipient.dispatch_cohort = 'canary'
    AND recipient.status IN ('failed', 'unknown', 'bounced', 'complained');
  IF v_adverse > 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'canary_needs_review');
  END IF;

  UPDATE public.marketing_email_campaigns SET
    dispatch_stage = 'bulk',
    bulk_release_approved_by = p_actor_user_id,
    bulk_release_approved_at = v_now,
    updated_at = v_now
  WHERE id = v_campaign.id;

  INSERT INTO public.marketing_email_campaign_events (
    campaign_id, salon_id, actor_user_id, event_type, details, created_at
  ) VALUES (
    v_campaign.id, v_campaign.salon_id, p_actor_user_id, 'bulk_released',
    jsonb_build_object(
      'canary_claimed_count', v_campaign.canary_claimed_count,
      'adverse_count', v_adverse,
      'provider_called', false,
      'no_messages_sent', true
    ), v_now
  );

  RETURN jsonb_build_object('success', true, 'code', 'bulk_released');
END;
$$;

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

CREATE OR REPLACE FUNCTION public.mark_marketing_email_canary_complete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.marketing_email_campaigns%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_canary_limit integer;
  v_remaining integer;
BEGIN
  IF OLD.status <> 'leased' OR NEW.status = 'leased' THEN
    RETURN NEW;
  END IF;

  SELECT campaign.* INTO v_campaign
  FROM public.marketing_email_campaigns AS campaign
  WHERE campaign.id = NEW.campaign_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_campaign.dispatch_stage = 'bulk' THEN
    SELECT count(*)::integer INTO v_remaining
    FROM public.marketing_email_campaign_recipients AS recipient
    WHERE recipient.campaign_id = NEW.campaign_id
      AND recipient.status IN ('prepared', 'leased');
    IF v_remaining = 0 THEN
      UPDATE public.marketing_email_campaigns SET
        dispatch_stage = 'completed', status = 'completed',
        completed_at = v_now, updated_at = v_now
      WHERE id = NEW.campaign_id;
      INSERT INTO public.marketing_email_campaign_events (
        campaign_id, salon_id, actor_user_id, event_type, details, created_at
      ) VALUES (
        v_campaign.id, v_campaign.salon_id, NULL, 'campaign_completed',
        jsonb_build_object('remaining_count', 0, 'completed_after', 'bulk'), v_now
      );
    END IF;
    RETURN NEW;
  END IF;

  IF v_campaign.dispatch_stage <> 'canary' OR NEW.dispatch_cohort <> 'canary' THEN
    RETURN NEW;
  END IF;

  v_canary_limit := least(v_campaign.canary_size::integer, v_campaign.audience_count);
  IF v_campaign.canary_claimed_count < v_canary_limit OR EXISTS (
    SELECT 1 FROM public.marketing_email_campaign_recipients AS recipient
    WHERE recipient.campaign_id = NEW.campaign_id
      AND recipient.dispatch_cohort = 'canary'
      AND recipient.status IN ('prepared', 'leased')
  ) THEN
    RETURN NEW;
  END IF;

  SELECT count(*)::integer INTO v_remaining
  FROM public.marketing_email_campaign_recipients AS recipient
  WHERE recipient.campaign_id = NEW.campaign_id
    AND recipient.status = 'prepared';

  UPDATE public.marketing_email_campaigns SET
    dispatch_stage = CASE WHEN v_remaining = 0 THEN 'completed' ELSE 'canary_complete' END,
    status = CASE WHEN v_remaining = 0 THEN 'completed' ELSE 'approved' END,
    completed_at = CASE WHEN v_remaining = 0 THEN v_now ELSE completed_at END,
    updated_at = v_now
  WHERE id = NEW.campaign_id;

  INSERT INTO public.marketing_email_campaign_events (
    campaign_id, salon_id, actor_user_id, event_type, details, created_at
  ) VALUES (
    v_campaign.id, v_campaign.salon_id, NULL, 'canary_completed',
    jsonb_build_object(
      'canary_claimed_count', v_campaign.canary_claimed_count,
      'provider_accepted_count', (
        SELECT count(*) FROM public.marketing_email_campaign_recipients AS recipient
        WHERE recipient.campaign_id = v_campaign.id
          AND recipient.dispatch_cohort = 'canary'
          AND recipient.status IN ('provider_accepted', 'delivered')
      ),
      'simulated_count', (
        SELECT count(*) FROM public.marketing_email_campaign_recipients AS recipient
        WHERE recipient.campaign_id = v_campaign.id
          AND recipient.dispatch_cohort = 'canary'
          AND recipient.status = 'simulated'
      ),
      'adverse_count', (
        SELECT count(*) FROM public.marketing_email_campaign_recipients AS recipient
        WHERE recipient.campaign_id = v_campaign.id
          AND recipient.dispatch_cohort = 'canary'
          AND recipient.status IN ('failed', 'unknown', 'bounced', 'complained')
      )
    ), v_now
  );

  IF v_remaining = 0 THEN
    INSERT INTO public.marketing_email_campaign_events (
      campaign_id, salon_id, actor_user_id, event_type, details, created_at
    ) VALUES (
      v_campaign.id, v_campaign.salon_id, NULL, 'campaign_completed',
      jsonb_build_object('remaining_count', 0, 'completed_after', 'canary'), v_now
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER marketing_email_campaign_canary_completion
AFTER UPDATE OF status ON public.marketing_email_campaign_recipients
FOR EACH ROW EXECUTE FUNCTION public.mark_marketing_email_canary_complete();

REVOKE ALL ON FUNCTION public.start_marketing_email_campaign_canary(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pause_marketing_email_campaign_dispatch(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resume_marketing_email_campaign_dispatch(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_marketing_email_campaign_bulk_release(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_marketing_email_canary_complete()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.start_marketing_email_campaign_canary(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.pause_marketing_email_campaign_dispatch(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.resume_marketing_email_campaign_dispatch(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_marketing_email_campaign_bulk_release(uuid, uuid)
  TO service_role;

COMMENT ON COLUMN public.marketing_email_campaigns.dispatch_stage IS
  'Database-enforced delivery stage. Defaults locked; canary must finish before explicit bulk release.';
COMMENT ON COLUMN public.marketing_email_campaign_recipients.dispatch_cohort IS
  'PII-free evidence that a recipient was claimed in the canary or bulk stage.';

-- Rollback boundary: leave recipient/campaign evidence intact, revoke the four
-- control RPCs, set every campaign dispatch_stage to locked, and disable the
-- independent salon plus environment dispatch gates before removing columns.
