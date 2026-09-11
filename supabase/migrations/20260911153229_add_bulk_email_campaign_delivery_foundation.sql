-- Bulk marketing email foundation.
--
-- This migration creates a tenant-scoped, consent-aware campaign ledger. It
-- deliberately does not enable dispatch for any salon. Claims require BOTH a
-- later application runtime gate and the per-salon JSON flag
-- `bulk_email_campaign_dispatch_enabled = true`; the flag is absent/OFF by
-- default. Recipient email addresses are never copied into these tables.
--
-- Rollback boundary: keep every salon flag OFF, remove the application
-- callsites first, then drop the RPCs/trigger and the three tables in reverse
-- dependency order. Never drop the ledger after dispatch has been enabled
-- without exporting its immutable receipt history.

CREATE TABLE public.marketing_email_campaigns (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'prepared', 'approved', 'sending', 'completed', 'cancelled'
  )),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 150),
  preheader text NOT NULL DEFAULT '' CHECK (char_length(preheader) <= 180),
  headline text NOT NULL CHECK (char_length(headline) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  image_url text CHECK (
    image_url IS NULL OR (
      char_length(image_url) BETWEEN 8 AND 2048
      AND image_url ~ '^https://'
    )
  ),
  cta_label text NOT NULL CHECK (char_length(cta_label) BETWEEN 1 AND 60),
  cta_url text NOT NULL CHECK (
    char_length(cta_url) BETWEEN 8 AND 2048 AND cta_url ~ '^https://'
  ),
  content_fingerprint text NOT NULL CHECK (content_fingerprint ~ '^[0-9a-f]{64}$'),
  audience_fingerprint text CHECK (
    audience_fingerprint IS NULL OR audience_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  audience_count integer NOT NULL DEFAULT 0 CHECK (audience_count >= 0),
  excluded_no_consent integer NOT NULL DEFAULT 0 CHECK (excluded_no_consent >= 0),
  excluded_invalid_email integer NOT NULL DEFAULT 0 CHECK (excluded_invalid_email >= 0),
  excluded_optout integer NOT NULL DEFAULT 0 CHECK (excluded_optout >= 0),
  excluded_provider_suppression integer NOT NULL DEFAULT 0
    CHECK (excluded_provider_suppression >= 0),
  excluded_duplicate integer NOT NULL DEFAULT 0 CHECK (excluded_duplicate >= 0),
  canary_size smallint NOT NULL DEFAULT 25 CHECK (canary_size BETWEEN 1 AND 100),
  batch_size smallint NOT NULL DEFAULT 100 CHECK (batch_size BETWEEN 1 AND 100),
  send_after timestamptz,
  prepared_at timestamptz,
  approved_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT marketing_email_campaign_approval_state CHECK (
    ((approved_by IS NULL) = (approved_at IS NULL))
    AND (status NOT IN ('approved', 'sending', 'completed')
      OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
  ),
  CONSTRAINT marketing_email_campaign_prepared_state CHECK (
    (status = 'draft' AND prepared_at IS NULL AND audience_fingerprint IS NULL)
    OR
    (status IN ('prepared', 'approved', 'sending', 'completed', 'cancelled')
      AND prepared_at IS NOT NULL AND audience_fingerprint IS NOT NULL)
  )
);

CREATE TABLE public.marketing_email_campaign_recipients (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.marketing_email_campaigns(id) ON DELETE CASCADE,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  client_profile_id uuid NOT NULL REFERENCES public.client_profiles(id) ON DELETE RESTRICT,
  recipient_fingerprint text NOT NULL CHECK (recipient_fingerprint ~ '^[0-9a-f]{64}$'),
  consent_fingerprint text NOT NULL CHECK (consent_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[a-z0-9-]{20,180}$'),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN (
    'prepared', 'leased', 'simulated', 'provider_accepted', 'delivered',
    'failed', 'unknown', 'suppressed', 'bounced', 'complained'
  )),
  suppression_reason text CHECK (
    suppression_reason IS NULL OR suppression_reason IN (
      'consent_missing', 'email_changed', 'email_opted_out',
      'provider_suppressed', 'channel_disabled', 'salon_disabled',
      'campaign_changed', 'guard_unavailable'
    )
  ),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  lease_token_hash text CHECK (
    lease_token_hash IS NULL OR lease_token_hash ~ '^[0-9a-f]{64}$'
  ),
  lease_expires_at timestamptz,
  provider_message_fingerprint text CHECK (
    provider_message_fingerprint IS NULL OR provider_message_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  provider_accepted_at timestamptz,
  delivered_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (campaign_id, client_profile_id),
  UNIQUE (idempotency_key),
  CONSTRAINT marketing_email_campaign_recipient_lease CHECK (
    (status = 'leased' AND lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'leased' AND lease_expires_at IS NULL)
  )
);

CREATE TABLE public.marketing_email_campaign_events (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES public.marketing_email_campaigns(id) ON DELETE CASCADE,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'draft_created', 'audience_prepared', 'approved', 'cancelled',
    'batch_claimed', 'recipient_simulated', 'provider_accepted',
    'recipient_failed', 'recipient_unknown', 'recipient_suppressed',
    'delivery_receipt', 'campaign_completed'
  )),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX marketing_email_campaigns_salon_created_idx
  ON public.marketing_email_campaigns(salon_id, created_at DESC);
CREATE INDEX marketing_email_campaign_recipients_claim_idx
  ON public.marketing_email_campaign_recipients(campaign_id, status, created_at, id)
  WHERE status = 'prepared';
CREATE INDEX marketing_email_campaign_recipients_delivery_idx
  ON public.marketing_email_campaign_recipients(salon_id, status, updated_at DESC);
CREATE INDEX marketing_email_campaign_events_timeline_idx
  ON public.marketing_email_campaign_events(campaign_id, created_at, id);

ALTER TABLE public.marketing_email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_email_campaigns FORCE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_email_campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_email_campaign_recipients FORCE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_email_campaign_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_email_campaign_events FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.marketing_email_campaigns,
  public.marketing_email_campaign_recipients,
  public.marketing_email_campaign_events
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON SEQUENCE public.marketing_email_campaign_events_id_seq
FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL PRIVILEGES ON TABLE
  public.marketing_email_campaigns,
  public.marketing_email_campaign_recipients,
  public.marketing_email_campaign_events
TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.marketing_email_campaign_events_id_seq
TO service_role;

CREATE POLICY marketing_email_campaigns_deny_browser
  ON public.marketing_email_campaigns AS RESTRICTIVE
  FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
CREATE POLICY marketing_email_campaign_recipients_deny_browser
  ON public.marketing_email_campaign_recipients AS RESTRICTIVE
  FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
CREATE POLICY marketing_email_campaign_events_deny_browser
  ON public.marketing_email_campaign_events AS RESTRICTIVE
  FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.marketing_email_campaign_caller_is_service_role()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    nullif(current_setting('role', true), '')
  ) = 'service_role'
$$;

CREATE OR REPLACE FUNCTION public.reject_marketing_email_campaign_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'marketing_email_campaign_events are append-only';
END;
$$;

CREATE TRIGGER marketing_email_campaign_events_immutable
BEFORE UPDATE OR DELETE ON public.marketing_email_campaign_events
FOR EACH ROW EXECUTE FUNCTION public.reject_marketing_email_campaign_event_mutation();

CREATE OR REPLACE FUNCTION public.create_marketing_email_campaign_draft(
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_name text,
  p_subject text,
  p_preheader text,
  p_headline text,
  p_body text,
  p_image_url text,
  p_cta_label text,
  p_cta_url text,
  p_content_fingerprint text,
  p_canary_size integer DEFAULT 25,
  p_batch_size integer DEFAULT 100,
  p_send_after timestamptz DEFAULT NULL
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
  IF NOT EXISTS (
    SELECT 1 FROM public.salon_members AS member
    WHERE member.salon_id = p_salon_id
      AND member.user_id = p_actor_user_id
      AND member.role IN ('owner', 'admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'forbidden');
  END IF;

  INSERT INTO public.marketing_email_campaigns (
    salon_id, created_by, name, subject, preheader, headline, body,
    image_url, cta_label, cta_url, content_fingerprint,
    canary_size, batch_size, send_after, created_at, updated_at
  ) VALUES (
    p_salon_id, p_actor_user_id, btrim(p_name), btrim(p_subject),
    btrim(coalesce(p_preheader, '')), btrim(p_headline), btrim(p_body),
    nullif(btrim(coalesce(p_image_url, '')), ''), btrim(p_cta_label),
    btrim(p_cta_url), lower(p_content_fingerprint),
    least(greatest(coalesce(p_canary_size, 25), 1), 100),
    least(greatest(coalesce(p_batch_size, 100), 1), 100),
    p_send_after, v_now, v_now
  ) RETURNING * INTO v_campaign;

  INSERT INTO public.marketing_email_campaign_events (
    campaign_id, salon_id, actor_user_id, event_type, details, created_at
  ) VALUES (
    v_campaign.id, v_campaign.salon_id, p_actor_user_id, 'draft_created',
    jsonb_build_object(
      'content_fingerprint', v_campaign.content_fingerprint,
      'provider_called', false,
      'no_messages_sent', true
    ), v_now
  );

  RETURN jsonb_build_object(
    'success', true, 'code', 'draft_created',
    'campaign_id', v_campaign.id,
    'provider_called', false, 'no_messages_sent', true
  );
EXCEPTION
  WHEN check_violation OR invalid_text_representation THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_input');
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_marketing_email_campaign(
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
  v_audience_count integer := 0;
  v_no_consent integer := 0;
  v_invalid_email integer := 0;
  v_optout integer := 0;
  v_provider_suppression integer := 0;
  v_duplicate integer := 0;
  v_audience_fingerprint text;
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
  IF v_campaign.status <> 'draft' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_state');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.salon_members AS member
    WHERE member.salon_id = v_campaign.salon_id
      AND member.user_id = p_actor_user_id
      AND member.role IN ('owner', 'admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'forbidden');
  END IF;

  WITH base AS (
    SELECT DISTINCT ON (profile.id)
      profile.id AS client_profile_id,
      lower(btrim(coalesce(profile.email, ''))) AS email_key,
      profile.marketing_email_consent_at,
      preference.client_profile_id IS NOT NULL AS has_preference,
      preference.consent_marketing_email,
      preference.preferred_communication_channel,
      preference.updated_at AS preference_updated_at
    FROM public.salon_clients AS link
    JOIN public.client_profiles AS profile ON profile.id = link.client_profile_id
    LEFT JOIN public.customer_preferences AS preference
      ON preference.salon_id = link.salon_id
     AND preference.client_profile_id = profile.id
    WHERE link.salon_id = v_campaign.salon_id
      AND profile.deleted_at IS NULL
    ORDER BY profile.id
  ), classified AS (
    SELECT base.*,
      CASE
        WHEN char_length(email_key) NOT BETWEEN 3 AND 320
          OR email_key !~ '^[^[:space:]@]+@[^[:space:]@]+$'
          OR email_key ~ '[[:cntrl:]]' THEN 'invalid_email'
        WHEN NOT (
          CASE WHEN has_preference
            THEN consent_marketing_email IS TRUE
            ELSE marketing_email_consent_at IS NOT NULL
          END
        ) THEN 'no_consent'
        WHEN has_preference
          AND preferred_communication_channel IS NOT NULL
          AND preferred_communication_channel NOT IN ('email', 'both')
          THEN 'no_consent'
        WHEN EXISTS (
          SELECT 1 FROM public.client_email_optouts AS optout
          WHERE lower(btrim(optout.email)) = email_key
        ) THEN 'optout'
        WHEN EXISTS (
          SELECT 1 FROM public.customer_email_delivery_suppressions AS suppression
          WHERE suppression.salon_id = v_campaign.salon_id
            AND suppression.recipient_fingerprint = encode(
              extensions.digest(convert_to(email_key, 'UTF8'), 'sha256'), 'hex'
            )
        ) THEN 'provider_suppression'
        ELSE 'eligible'
      END AS classification
    FROM base
  ), eligible AS (
    SELECT classified.*,
      row_number() OVER (
        PARTITION BY email_key ORDER BY client_profile_id::text
      ) AS email_rank
    FROM classified
    WHERE classification = 'eligible'
  )
  INSERT INTO public.marketing_email_campaign_recipients (
    campaign_id, salon_id, client_profile_id, recipient_fingerprint,
    consent_fingerprint, idempotency_key, status, created_at, updated_at
  )
  SELECT
    v_campaign.id,
    v_campaign.salon_id,
    eligible.client_profile_id,
    encode(extensions.digest(convert_to(eligible.email_key, 'UTF8'), 'sha256'), 'hex'),
    encode(extensions.digest(convert_to(concat_ws('|',
      'bulk-email-consent-v1', v_campaign.salon_id::text,
      eligible.client_profile_id::text,
      coalesce(eligible.marketing_email_consent_at::text, ''),
      coalesce(eligible.has_preference::text, ''),
      coalesce(eligible.consent_marketing_email::text, ''),
      coalesce(eligible.preferred_communication_channel, ''),
      coalesce(eligible.preference_updated_at::text, '')
    ), 'UTF8'), 'sha256'), 'hex'),
    lower('bulk-email-' || replace(v_campaign.id::text, '-', '') || '-' ||
      replace(eligible.client_profile_id::text, '-', '')),
    'prepared', v_now, v_now
  FROM eligible
  WHERE eligible.email_rank = 1
  ORDER BY eligible.client_profile_id;

  GET DIAGNOSTICS v_audience_count = ROW_COUNT;

  WITH base AS (
    SELECT DISTINCT ON (profile.id)
      profile.id AS client_profile_id,
      lower(btrim(coalesce(profile.email, ''))) AS email_key,
      profile.marketing_email_consent_at,
      preference.client_profile_id IS NOT NULL AS has_preference,
      preference.consent_marketing_email,
      preference.preferred_communication_channel
    FROM public.salon_clients AS link
    JOIN public.client_profiles AS profile ON profile.id = link.client_profile_id
    LEFT JOIN public.customer_preferences AS preference
      ON preference.salon_id = link.salon_id
     AND preference.client_profile_id = profile.id
    WHERE link.salon_id = v_campaign.salon_id
      AND profile.deleted_at IS NULL
    ORDER BY profile.id
  ), classified AS (
    SELECT base.*,
      CASE
        WHEN char_length(email_key) NOT BETWEEN 3 AND 320
          OR email_key !~ '^[^[:space:]@]+@[^[:space:]@]+$'
          OR email_key ~ '[[:cntrl:]]' THEN 'invalid_email'
        WHEN NOT (
          CASE WHEN has_preference
            THEN consent_marketing_email IS TRUE
            ELSE marketing_email_consent_at IS NOT NULL
          END
        ) THEN 'no_consent'
        WHEN has_preference
          AND preferred_communication_channel IS NOT NULL
          AND preferred_communication_channel NOT IN ('email', 'both')
          THEN 'no_consent'
        WHEN EXISTS (
          SELECT 1 FROM public.client_email_optouts AS optout
          WHERE lower(btrim(optout.email)) = email_key
        ) THEN 'optout'
        WHEN EXISTS (
          SELECT 1 FROM public.customer_email_delivery_suppressions AS suppression
          WHERE suppression.salon_id = v_campaign.salon_id
            AND suppression.recipient_fingerprint = encode(
              extensions.digest(convert_to(email_key, 'UTF8'), 'sha256'), 'hex'
            )
        ) THEN 'provider_suppression'
        ELSE 'eligible'
      END AS classification
    FROM base
  )
  SELECT
    count(*) FILTER (WHERE classification = 'no_consent')::integer,
    count(*) FILTER (WHERE classification = 'invalid_email')::integer,
    count(*) FILTER (WHERE classification = 'optout')::integer,
    count(*) FILTER (WHERE classification = 'provider_suppression')::integer,
    greatest(
      count(*) FILTER (WHERE classification = 'eligible') -
      count(DISTINCT email_key) FILTER (WHERE classification = 'eligible'),
      0
    )::integer
  INTO v_no_consent, v_invalid_email, v_optout, v_provider_suppression, v_duplicate
  FROM classified;

  SELECT encode(extensions.digest(convert_to(coalesce(string_agg(
    recipient.client_profile_id::text || ':' || recipient.recipient_fingerprint || ':' ||
    recipient.consent_fingerprint,
    '|' ORDER BY recipient.client_profile_id::text
  ), ''), 'UTF8'), 'sha256'), 'hex')
  INTO v_audience_fingerprint
  FROM public.marketing_email_campaign_recipients AS recipient
  WHERE recipient.campaign_id = v_campaign.id;

  UPDATE public.marketing_email_campaigns SET
    status = 'prepared',
    audience_fingerprint = v_audience_fingerprint,
    audience_count = v_audience_count,
    excluded_no_consent = v_no_consent,
    excluded_invalid_email = v_invalid_email,
    excluded_optout = v_optout,
    excluded_provider_suppression = v_provider_suppression,
    excluded_duplicate = v_duplicate,
    prepared_at = v_now,
    updated_at = v_now
  WHERE id = v_campaign.id;

  INSERT INTO public.marketing_email_campaign_events (
    campaign_id, salon_id, actor_user_id, event_type, details, created_at
  ) VALUES (
    v_campaign.id, v_campaign.salon_id, p_actor_user_id, 'audience_prepared',
    jsonb_build_object(
      'audience_count', v_audience_count,
      'excluded_no_consent', v_no_consent,
      'excluded_invalid_email', v_invalid_email,
      'excluded_optout', v_optout,
      'excluded_provider_suppression', v_provider_suppression,
      'excluded_duplicate', v_duplicate,
      'audience_fingerprint', v_audience_fingerprint,
      'provider_called', false,
      'no_messages_sent', true
    ), v_now
  );

  RETURN jsonb_build_object(
    'success', true,
    'code', 'prepared',
    'campaign_id', v_campaign.id,
    'audience_count', v_audience_count,
    'excluded_no_consent', v_no_consent,
    'excluded_invalid_email', v_invalid_email,
    'excluded_optout', v_optout,
    'excluded_provider_suppression', v_provider_suppression,
    'excluded_duplicate', v_duplicate,
    'audience_fingerprint', v_audience_fingerprint,
    'provider_called', false,
    'no_messages_sent', true
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_marketing_email_campaign(
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
  IF v_campaign.status <> 'prepared' OR v_campaign.audience_count < 1 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_state');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.salon_members AS member
    WHERE member.salon_id = v_campaign.salon_id
      AND member.user_id = p_actor_user_id
      AND member.role IN ('owner', 'admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'forbidden');
  END IF;

  UPDATE public.marketing_email_campaigns SET
    status = 'approved', approved_by = p_actor_user_id,
    approved_at = v_now, updated_at = v_now
  WHERE id = v_campaign.id;
  INSERT INTO public.marketing_email_campaign_events (
    campaign_id, salon_id, actor_user_id, event_type, details, created_at
  ) VALUES (
    v_campaign.id, v_campaign.salon_id, p_actor_user_id, 'approved',
    jsonb_build_object(
      'audience_count', v_campaign.audience_count,
      'audience_fingerprint', v_campaign.audience_fingerprint,
      'content_fingerprint', v_campaign.content_fingerprint,
      'provider_called', false,
      'no_messages_sent', true
    ), v_now
  );
  RETURN jsonb_build_object(
    'success', true, 'code', 'approved', 'campaign_id', v_campaign.id,
    'provider_called', false, 'no_messages_sent', true
  );
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
BEGIN
  IF NOT public.marketing_email_campaign_caller_is_service_role() THEN
    RETURN;
  END IF;

  SELECT campaign.* INTO v_campaign
  FROM public.marketing_email_campaigns AS campaign
  JOIN public.salons AS salon ON salon.id = campaign.salon_id
  WHERE campaign.id = p_campaign_id
    AND campaign.status IN ('approved', 'sending')
    AND (campaign.send_after IS NULL OR campaign.send_after <= v_now)
    AND salon.archived_at IS NULL
    AND salon.email_outbound_enabled IS TRUE
    AND salon.feature_flags ->> 'bulk_email_campaign_dispatch_enabled' = 'true'
  FOR UPDATE OF campaign;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.marketing_email_campaigns SET status = 'sending', updated_at = v_now
  WHERE id = v_campaign.id AND status = 'approved';

  FOR v_row IN
    SELECT recipient.*
    FROM public.marketing_email_campaign_recipients AS recipient
    WHERE recipient.campaign_id = v_campaign.id
      AND recipient.salon_id = v_campaign.salon_id
      AND recipient.status = 'prepared'
      AND recipient.attempt_count < 3
    ORDER BY recipient.created_at, recipient.id
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  LOOP
    v_token := extensions.gen_random_uuid();
    UPDATE public.marketing_email_campaign_recipients SET
      status = 'leased',
      attempt_count = attempt_count + 1,
      lease_token_hash = encode(extensions.digest(
        convert_to(v_token::text, 'UTF8'), 'sha256'
      ), 'hex'),
      lease_expires_at = v_now + interval '5 minutes',
      updated_at = v_now
    WHERE id = v_row.id;

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
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_marketing_email_campaign_recipient(
  p_recipient_id uuid,
  p_attempt_token uuid,
  p_outcome text,
  p_provider_message_fingerprint text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recipient public.marketing_email_campaign_recipients%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_token_hash text;
  v_remaining integer;
BEGIN
  IF NOT public.marketing_email_campaign_caller_is_service_role() THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_outcome NOT IN ('simulated', 'provider_accepted', 'failed_pre_acceptance', 'unknown') THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_outcome');
  END IF;
  IF p_outcome = 'provider_accepted' AND (
    p_provider_message_fingerprint IS NULL
    OR p_provider_message_fingerprint !~ '^[0-9a-f]{64}$'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_receipt');
  END IF;

  v_token_hash := encode(extensions.digest(
    convert_to(p_attempt_token::text, 'UTF8'), 'sha256'
  ), 'hex');
  SELECT recipient.* INTO v_recipient
  FROM public.marketing_email_campaign_recipients AS recipient
  WHERE recipient.id = p_recipient_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_found');
  END IF;
  IF v_recipient.status <> 'leased'
    OR v_recipient.lease_token_hash <> v_token_hash
    OR v_recipient.lease_expires_at <= v_now
  THEN
    RETURN jsonb_build_object('success', false, 'code', 'lease_invalid');
  END IF;

  UPDATE public.marketing_email_campaign_recipients SET
    status = CASE p_outcome
      WHEN 'simulated' THEN 'simulated'
      WHEN 'provider_accepted' THEN 'provider_accepted'
      WHEN 'unknown' THEN 'unknown'
      WHEN 'failed_pre_acceptance' THEN
        CASE WHEN attempt_count < 3 THEN 'prepared' ELSE 'failed' END
    END,
    provider_message_fingerprint = CASE
      WHEN p_outcome = 'provider_accepted' THEN p_provider_message_fingerprint
      ELSE NULL
    END,
    provider_accepted_at = CASE
      WHEN p_outcome = 'provider_accepted' THEN v_now ELSE NULL
    END,
    completed_at = CASE
      WHEN p_outcome IN ('simulated', 'provider_accepted', 'unknown')
        OR (p_outcome = 'failed_pre_acceptance' AND attempt_count >= 3)
      THEN v_now ELSE NULL
    END,
    lease_token_hash = NULL,
    lease_expires_at = NULL,
    updated_at = v_now
  WHERE id = v_recipient.id;

  INSERT INTO public.marketing_email_campaign_events (
    campaign_id, salon_id, actor_user_id, event_type, details, created_at
  ) VALUES (
    v_recipient.campaign_id, v_recipient.salon_id, NULL,
    CASE p_outcome
      WHEN 'simulated' THEN 'recipient_simulated'
      WHEN 'provider_accepted' THEN 'provider_accepted'
      WHEN 'unknown' THEN 'recipient_unknown'
      ELSE 'recipient_failed'
    END,
    jsonb_build_object(
      'recipient_id', v_recipient.id,
      'attempt_count', v_recipient.attempt_count,
      'provider_called', p_outcome <> 'simulated'
    ), v_now
  );

  SELECT count(*)::integer INTO v_remaining
  FROM public.marketing_email_campaign_recipients AS recipient
  WHERE recipient.campaign_id = v_recipient.campaign_id
    AND recipient.status IN ('prepared', 'leased');
  IF v_remaining = 0 THEN
    UPDATE public.marketing_email_campaigns SET
      status = 'completed', completed_at = v_now, updated_at = v_now
    WHERE id = v_recipient.campaign_id AND status = 'sending';
    IF FOUND THEN
      INSERT INTO public.marketing_email_campaign_events (
        campaign_id, salon_id, actor_user_id, event_type, details, created_at
      ) VALUES (
        v_recipient.campaign_id, v_recipient.salon_id, NULL,
        'campaign_completed', jsonb_build_object('remaining_count', 0), v_now
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'code', CASE p_outcome
      WHEN 'simulated' THEN 'simulated'
      WHEN 'provider_accepted' THEN 'provider_accepted'
      WHEN 'unknown' THEN 'unknown'
      ELSE CASE WHEN v_recipient.attempt_count < 3 THEN 'retryable' ELSE 'failed' END
    END,
    'recipient_id', v_recipient.id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.load_marketing_email_campaign_delivery_material(
  p_recipient_id uuid,
  p_attempt_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recipient public.marketing_email_campaign_recipients%ROWTYPE;
  v_campaign public.marketing_email_campaigns%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_token_hash text;
  v_email text;
  v_client_name text;
  v_marketing_email_consent_at timestamptz;
  v_has_preference boolean;
  v_consent_marketing_email boolean;
  v_preferred_channel text;
  v_preference_updated_at timestamptz;
  v_salon_name text;
  v_salon_slug text;
  v_salon_address text;
  v_salon_email text;
  v_salon_archived_at timestamptz;
  v_email_outbound_enabled boolean;
  v_dispatch_enabled boolean;
  v_current_recipient_fingerprint text;
  v_current_consent_fingerprint text;
  v_suppression_reason text;
  v_remaining integer;
BEGIN
  IF NOT public.marketing_email_campaign_caller_is_service_role() THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;

  v_token_hash := encode(extensions.digest(
    convert_to(p_attempt_token::text, 'UTF8'), 'sha256'
  ), 'hex');
  SELECT recipient.* INTO v_recipient
  FROM public.marketing_email_campaign_recipients AS recipient
  WHERE recipient.id = p_recipient_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_found');
  END IF;
  IF v_recipient.status <> 'leased'
    OR v_recipient.lease_token_hash <> v_token_hash
    OR v_recipient.lease_expires_at <= v_now
  THEN
    RETURN jsonb_build_object('success', false, 'code', 'lease_invalid');
  END IF;

  SELECT campaign.* INTO v_campaign
  FROM public.marketing_email_campaigns AS campaign
  WHERE campaign.id = v_recipient.campaign_id
  FOR UPDATE;
  IF NOT FOUND OR v_campaign.status <> 'sending' THEN
    v_suppression_reason := 'campaign_changed';
  END IF;

  SELECT
    lower(btrim(coalesce(profile.email, ''))), profile.name,
    profile.marketing_email_consent_at,
    preference.client_profile_id IS NOT NULL,
    preference.consent_marketing_email,
    preference.preferred_communication_channel,
    preference.updated_at,
    salon.name, salon.slug, salon.address, coalesce(salon.contact_email, salon.email),
    salon.archived_at, salon.email_outbound_enabled,
    salon.feature_flags ->> 'bulk_email_campaign_dispatch_enabled' = 'true'
  INTO
    v_email, v_client_name, v_marketing_email_consent_at,
    v_has_preference, v_consent_marketing_email, v_preferred_channel,
    v_preference_updated_at, v_salon_name, v_salon_slug, v_salon_address,
    v_salon_email, v_salon_archived_at, v_email_outbound_enabled,
    v_dispatch_enabled
  FROM public.client_profiles AS profile
  JOIN public.salons AS salon ON salon.id = v_recipient.salon_id
  LEFT JOIN public.customer_preferences AS preference
    ON preference.salon_id = v_recipient.salon_id
   AND preference.client_profile_id = profile.id
  WHERE profile.id = v_recipient.client_profile_id
    AND profile.deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.salon_clients AS link
      WHERE link.salon_id = v_recipient.salon_id
        AND link.client_profile_id = profile.id
    );

  IF NOT FOUND THEN
    v_suppression_reason := coalesce(v_suppression_reason, 'consent_missing');
  ELSE
    v_current_recipient_fingerprint := encode(extensions.digest(
      convert_to(v_email, 'UTF8'), 'sha256'
    ), 'hex');
    v_current_consent_fingerprint := encode(extensions.digest(convert_to(concat_ws('|',
      'bulk-email-consent-v1', v_recipient.salon_id::text,
      v_recipient.client_profile_id::text,
      coalesce(v_marketing_email_consent_at::text, ''),
      coalesce(v_has_preference::text, ''),
      coalesce(v_consent_marketing_email::text, ''),
      coalesce(v_preferred_channel, ''),
      coalesce(v_preference_updated_at::text, '')
    ), 'UTF8'), 'sha256'), 'hex');

    IF v_salon_archived_at IS NOT NULL THEN
      v_suppression_reason := coalesce(v_suppression_reason, 'salon_disabled');
    ELSIF v_email_outbound_enabled IS NOT TRUE OR v_dispatch_enabled IS NOT TRUE THEN
      v_suppression_reason := coalesce(v_suppression_reason, 'channel_disabled');
    ELSIF char_length(v_email) NOT BETWEEN 3 AND 320
      OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
      OR v_email ~ '[[:cntrl:]]'
    THEN
      v_suppression_reason := coalesce(v_suppression_reason, 'email_changed');
    ELSIF v_current_recipient_fingerprint <> v_recipient.recipient_fingerprint THEN
      v_suppression_reason := coalesce(v_suppression_reason, 'email_changed');
    ELSIF NOT (
      CASE WHEN v_has_preference
        THEN v_consent_marketing_email IS TRUE
        ELSE v_marketing_email_consent_at IS NOT NULL
      END
    ) OR (
      v_has_preference
      AND v_preferred_channel IS NOT NULL
      AND v_preferred_channel NOT IN ('email', 'both')
    ) THEN
      v_suppression_reason := coalesce(v_suppression_reason, 'consent_missing');
    ELSIF v_current_consent_fingerprint <> v_recipient.consent_fingerprint THEN
      v_suppression_reason := coalesce(v_suppression_reason, 'consent_missing');
    ELSIF EXISTS (
      SELECT 1 FROM public.client_email_optouts AS optout
      WHERE lower(btrim(optout.email)) = v_email
    ) THEN
      v_suppression_reason := coalesce(v_suppression_reason, 'email_opted_out');
    ELSIF EXISTS (
      SELECT 1 FROM public.customer_email_delivery_suppressions AS suppression
      WHERE suppression.salon_id = v_recipient.salon_id
        AND suppression.recipient_fingerprint = v_current_recipient_fingerprint
    ) THEN
      v_suppression_reason := coalesce(v_suppression_reason, 'provider_suppressed');
    END IF;
  END IF;

  IF v_suppression_reason IS NOT NULL THEN
    UPDATE public.marketing_email_campaign_recipients SET
      status = 'suppressed', suppression_reason = v_suppression_reason,
      completed_at = v_now, lease_token_hash = NULL,
      lease_expires_at = NULL, updated_at = v_now
    WHERE id = v_recipient.id;
    INSERT INTO public.marketing_email_campaign_events (
      campaign_id, salon_id, actor_user_id, event_type, details, created_at
    ) VALUES (
      v_recipient.campaign_id, v_recipient.salon_id, NULL,
      'recipient_suppressed',
      jsonb_build_object(
        'recipient_id', v_recipient.id,
        'reason', v_suppression_reason,
        'provider_called', false
      ), v_now
    );

    SELECT count(*)::integer INTO v_remaining
    FROM public.marketing_email_campaign_recipients AS recipient
    WHERE recipient.campaign_id = v_recipient.campaign_id
      AND recipient.status IN ('prepared', 'leased');
    IF v_remaining = 0 THEN
      UPDATE public.marketing_email_campaigns SET
        status = 'completed', completed_at = v_now, updated_at = v_now
      WHERE id = v_recipient.campaign_id AND status = 'sending';
      IF FOUND THEN
        INSERT INTO public.marketing_email_campaign_events (
          campaign_id, salon_id, actor_user_id, event_type, details, created_at
        ) VALUES (
          v_recipient.campaign_id, v_recipient.salon_id, NULL,
          'campaign_completed', jsonb_build_object('remaining_count', 0), v_now
        );
      END IF;
    END IF;

    RETURN jsonb_build_object(
      'success', false, 'code', 'suppressed',
      'reason', v_suppression_reason, 'provider_called', false
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'authorized',
    'recipient_id', v_recipient.id,
    'campaign_id', v_campaign.id,
    'idempotency_key', v_recipient.idempotency_key,
    'recipient_fingerprint', v_recipient.recipient_fingerprint,
    'consent_fingerprint', v_recipient.consent_fingerprint,
    'content_fingerprint', v_campaign.content_fingerprint,
    'destination_email', v_email,
    'client_name', coalesce(nullif(btrim(v_client_name), ''), 'Guest'),
    'salon_name', v_salon_name,
    'salon_slug', v_salon_slug,
    'salon_address', v_salon_address,
    'salon_email', v_salon_email,
    'subject', v_campaign.subject,
    'preheader', v_campaign.preheader,
    'headline', v_campaign.headline,
    'body', v_campaign.body,
    'image_url', v_campaign.image_url,
    'cta_label', v_campaign.cta_label,
    'cta_url', v_campaign.cta_url
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_marketing_email_campaign_delivery_event(
  p_provider_message_id text,
  p_recipient_fingerprint text,
  p_event_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recipient public.marketing_email_campaign_recipients%ROWTYPE;
  v_provider_fingerprint text;
  v_next_status text;
  v_now timestamptz := clock_timestamp();
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
$$;

REVOKE ALL ON FUNCTION public.marketing_email_campaign_caller_is_service_role()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_marketing_email_campaign_event_mutation()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_marketing_email_campaign_draft(
  uuid, uuid, text, text, text, text, text, text, text, text, text,
  integer, integer, timestamptz
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_marketing_email_campaign(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_marketing_email_campaign(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_marketing_email_campaign_recipients(uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_marketing_email_campaign_recipient(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_marketing_email_campaign_delivery_material(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_marketing_email_campaign_delivery_event(text, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.marketing_email_campaign_caller_is_service_role()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.create_marketing_email_campaign_draft(
  uuid, uuid, text, text, text, text, text, text, text, text, text,
  integer, integer, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_marketing_email_campaign(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_marketing_email_campaign(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_marketing_email_campaign_recipients(uuid, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_marketing_email_campaign_recipient(uuid, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.load_marketing_email_campaign_delivery_material(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_marketing_email_campaign_delivery_event(text, text, text)
  TO service_role;

COMMENT ON TABLE public.marketing_email_campaigns IS
  'Tenant-scoped marketing email content and aggregate audience evidence; dispatch flag defaults OFF.';
COMMENT ON TABLE public.marketing_email_campaign_recipients IS
  'PII-free per-recipient marketing email claims. Destination email is loaded transiently after a final consent check.';
COMMENT ON TABLE public.marketing_email_campaign_events IS
  'Append-only, PII-free lifecycle evidence for bulk marketing email campaigns.';
