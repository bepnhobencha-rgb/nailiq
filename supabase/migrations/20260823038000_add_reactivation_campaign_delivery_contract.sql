-- MQA-0181: durable, PII-free reactivation delivery state without a sender.
--
-- This migration deliberately cannot authorize a dispatch. Candidate rows and
-- bound material hashes are evidence only. A lease additionally requires an
-- immutable row in reactivation_campaign_dispatch_authorizations, while this
-- migration grants no role and exposes no RPC that can create such a row.
-- Application code is independently hard-disabled and has no cron/API/callsite.

CREATE TABLE public.reactivation_campaign_deliveries (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  dispatch_plan_id uuid NOT NULL
    REFERENCES public.ai_campaign_dispatch_plans(id) ON DELETE CASCADE,
  preflight_id uuid NOT NULL
    REFERENCES public.ai_campaign_dispatch_preflights(id) ON DELETE CASCADE,
  manifest_id uuid NOT NULL
    REFERENCES public.ai_campaign_manifests(id) ON DELETE CASCADE,
  release_approval_id uuid NOT NULL
    REFERENCES public.approval_requests(id) ON DELETE CASCADE,
  release_execution_job_id uuid NOT NULL
    REFERENCES public.ai_execution_jobs(id) ON DELETE CASCADE,
  source_execution_job_id uuid NOT NULL
    REFERENCES public.ai_execution_jobs(id) ON DELETE CASCADE,
  client_profile_id uuid NOT NULL
    REFERENCES public.client_profiles(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  proposal_source text NOT NULL
    CHECK (proposal_source = 'reactivation_campaign_release_gate'),
  plan_fingerprint text NOT NULL CHECK (plan_fingerprint ~ '^[0-9a-f]{64}$'),
  preflight_fingerprint text NOT NULL
    CHECK (preflight_fingerprint ~ '^[0-9a-f]{64}$'),
  source_material_fingerprint text NOT NULL
    CHECK (source_material_fingerprint ~ '^[0-9a-f]{64}$'),
  material_fingerprint text
    CHECK (material_fingerprint IS NULL OR material_fingerprint ~ '^[0-9a-f]{64}$'),
  payload_fingerprint text
    CHECK (payload_fingerprint IS NULL OR payload_fingerprint ~ '^[0-9a-f]{64}$'),
  contact_fingerprint text NOT NULL
    CHECK (contact_fingerprint ~ '^[0-9a-f]{64}$'),
  preference_fingerprint text NOT NULL
    CHECK (preference_fingerprint ~ '^[0-9a-f]{64}$'),
  recipient_fingerprint text NOT NULL
    CHECK (recipient_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'awaiting_material' CHECK (status IN (
    'awaiting_material', 'awaiting_authorization', 'leased',
    'provider_accepted', 'delivered', 'failed', 'unknown', 'suppressed'
  )),
  suppression_reason text CHECK (
    suppression_reason IS NULL OR suppression_reason IN (
      'salon_unavailable', 'not_salon_client', 'profile_unavailable',
      'same_salon_consent_missing', 'marketing_consent_missing',
      'preferred_channel_disabled', 'channel_disabled', 'a2p_not_registered',
      'destination_missing', 'sms_suppressed', 'email_opted_out',
      'consent_guard_unavailable', 'source_contract_changed',
      'plan_expired', 'preflight_expired', 'release_approval_expired',
      'contact_changed', 'preference_changed', 'material_changed'
    )
  ),
  error_code text CHECK (error_code IS NULL OR error_code IN (
    'provider_rejected_pre_acceptance', 'invalid_recipient',
    'consent_revoked', 'channel_disabled', 'material_rejected',
    'provider_unavailable_pre_acceptance',
    'provider_rate_limited_pre_acceptance',
    'provider_outcome_unknown', 'transport_timeout', 'provider_exception',
    'completion_write_uncertain', 'lease_expired_outcome_unknown',
    'stale_lease_outcome_unknown'
  )),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1),
  lease_token_hash text
    CHECK (lease_token_hash IS NULL OR lease_token_hash ~ '^[0-9a-f]{64}$'),
  leased_at timestamptz,
  lease_expires_at timestamptz,
  provider_name text,
  provider_accepted_at timestamptz,
  delivered_at timestamptz,
  delivery_receipt_token_hash text CHECK (
    delivery_receipt_token_hash IS NULL
    OR delivery_receipt_token_hash ~ '^[0-9a-f]{64}$'
  ),
  completion_fingerprint text CHECK (
    completion_fingerprint IS NULL OR completion_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  plan_expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT reactivation_campaign_deliveries_manifest_profile_channel_key
    UNIQUE (manifest_id, client_profile_id, channel),
  CONSTRAINT reactivation_campaign_delivery_lease_window_check CHECK (
    lease_expires_at IS NULL OR (
      leased_at IS NOT NULL
      AND lease_expires_at > leased_at
      AND lease_expires_at <= leased_at + interval '5 minutes'
      AND lease_expires_at <= plan_expires_at
    )
  ),
  CONSTRAINT reactivation_campaign_delivery_provider_category_check CHECK (
    provider_name IS NULL
    OR (channel = 'sms' AND provider_name = 'sms_provider')
    OR (channel = 'email' AND provider_name = 'email_provider')
  ),
  CONSTRAINT reactivation_campaign_delivery_state_check CHECK (
    (status = 'awaiting_material'
      AND material_fingerprint IS NULL AND payload_fingerprint IS NULL
      AND attempt_count = 0 AND lease_token_hash IS NULL
      AND leased_at IS NULL AND lease_expires_at IS NULL
      AND completed_at IS NULL AND suppression_reason IS NULL)
    OR
    (status = 'awaiting_authorization'
      AND material_fingerprint IS NOT NULL AND payload_fingerprint IS NOT NULL
      AND attempt_count = 0 AND lease_token_hash IS NULL
      AND leased_at IS NULL AND lease_expires_at IS NULL
      AND completed_at IS NULL AND suppression_reason IS NULL)
    OR
    (status = 'leased'
      AND material_fingerprint IS NOT NULL AND payload_fingerprint IS NOT NULL
      AND attempt_count = 1 AND lease_token_hash IS NOT NULL
      AND leased_at IS NOT NULL AND lease_expires_at IS NOT NULL
      AND completed_at IS NULL AND suppression_reason IS NULL)
    OR
    (status = 'provider_accepted'
      AND material_fingerprint IS NOT NULL AND payload_fingerprint IS NOT NULL
      AND attempt_count = 1 AND lease_token_hash IS NOT NULL
      AND provider_name IS NOT NULL AND provider_accepted_at IS NOT NULL
      AND delivery_receipt_token_hash IS NOT NULL
      AND delivered_at IS NULL AND completed_at IS NOT NULL)
    OR
    (status = 'delivered'
      AND material_fingerprint IS NOT NULL AND payload_fingerprint IS NOT NULL
      AND attempt_count = 1 AND lease_token_hash IS NOT NULL
      AND provider_name IS NOT NULL AND provider_accepted_at IS NOT NULL
      AND delivery_receipt_token_hash IS NULL
      AND delivered_at IS NOT NULL AND completed_at IS NOT NULL)
    OR
    (status IN ('failed', 'unknown')
      AND attempt_count = 1 AND lease_token_hash IS NOT NULL
      AND completed_at IS NOT NULL AND delivery_receipt_token_hash IS NULL)
    OR
    (status = 'suppressed'
      AND attempt_count = 0 AND lease_token_hash IS NULL
      AND completed_at IS NOT NULL AND suppression_reason IS NOT NULL)
  )
);

CREATE TABLE public.reactivation_campaign_dispatch_authorizations (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  delivery_id uuid NOT NULL UNIQUE
    REFERENCES public.reactivation_campaign_deliveries(id) ON DELETE CASCADE,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  dispatch_plan_id uuid NOT NULL
    REFERENCES public.ai_campaign_dispatch_plans(id) ON DELETE CASCADE,
  plan_fingerprint text NOT NULL CHECK (plan_fingerprint ~ '^[0-9a-f]{64}$'),
  source_material_fingerprint text NOT NULL
    CHECK (source_material_fingerprint ~ '^[0-9a-f]{64}$'),
  material_fingerprint text NOT NULL CHECK (material_fingerprint ~ '^[0-9a-f]{64}$'),
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  contact_fingerprint text NOT NULL CHECK (contact_fingerprint ~ '^[0-9a-f]{64}$'),
  preference_fingerprint text NOT NULL
    CHECK (preference_fingerprint ~ '^[0-9a-f]{64}$'),
  recipient_fingerprint text NOT NULL
    CHECK (recipient_fingerprint ~ '^[0-9a-f]{64}$'),
  authorization_fingerprint text NOT NULL UNIQUE
    CHECK (authorization_fingerprint ~ '^[0-9a-f]{64}$'),
  authorized_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT reactivation_campaign_dispatch_authorization_window_check CHECK (
    expires_at > authorized_at
    AND expires_at <= authorized_at + interval '5 minutes'
  )
);

CREATE TABLE public.reactivation_campaign_delivery_receipts (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  delivery_id uuid NOT NULL
    REFERENCES public.reactivation_campaign_deliveries(id) ON DELETE CASCADE,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  receipt_kind text NOT NULL CHECK (receipt_kind IN ('provider_accepted', 'delivered')),
  provider_name text NOT NULL CHECK (
    provider_name IN ('sms_provider', 'email_provider')
  ),
  provider_receipt_fingerprint text NOT NULL
    CHECK (provider_receipt_fingerprint ~ '^[0-9a-f]{64}$'),
  callback_auth_fingerprint text CHECK (
    callback_auth_fingerprint IS NULL
    OR callback_auth_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  event_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT reactivation_campaign_delivery_receipts_kind_once
    UNIQUE (delivery_id, receipt_kind),
  CONSTRAINT reactivation_campaign_delivery_receipt_auth_check CHECK (
    (receipt_kind = 'provider_accepted' AND callback_auth_fingerprint IS NULL)
    OR
    (receipt_kind = 'delivered' AND callback_auth_fingerprint IS NOT NULL)
  )
);

CREATE INDEX reactivation_campaign_deliveries_plan_idx
  ON public.reactivation_campaign_deliveries(dispatch_plan_id, status, created_at, id);
CREATE INDEX reactivation_campaign_deliveries_claim_idx
  ON public.reactivation_campaign_deliveries(created_at, id)
  WHERE status = 'awaiting_authorization';
CREATE INDEX reactivation_campaign_deliveries_reconcile_idx
  ON public.reactivation_campaign_deliveries(lease_expires_at, id)
  WHERE status = 'leased';

ALTER TABLE public.reactivation_campaign_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reactivation_campaign_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.reactivation_campaign_dispatch_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reactivation_campaign_dispatch_authorizations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.reactivation_campaign_delivery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reactivation_campaign_delivery_receipts FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.reactivation_campaign_deliveries,
  public.reactivation_campaign_dispatch_authorizations,
  public.reactivation_campaign_delivery_receipts
  FROM PUBLIC, anon, authenticated, service_role;

CREATE POLICY "deny browser access to reactivation campaign deliveries"
  ON public.reactivation_campaign_deliveries AS RESTRICTIVE
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny browser access to reactivation dispatch authorizations"
  ON public.reactivation_campaign_dispatch_authorizations AS RESTRICTIVE
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny browser access to reactivation delivery receipts"
  ON public.reactivation_campaign_delivery_receipts AS RESTRICTIVE
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE FUNCTION public.reactivation_campaign_delivery_caller_is_service_role()
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

-- Returns only categorical state and HMAC/SHA-256 fingerprints. It never
-- returns or stores a phone number or email address.
CREATE FUNCTION public.evaluate_reactivation_campaign_delivery_guard(
  p_salon_id uuid,
  p_client_profile_id uuid,
  p_channel text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $guard$
DECLARE
  v_salon public.salons%ROWTYPE;
  v_profile public.client_profiles%ROWTYPE;
  v_preference public.customer_preferences%ROWTYPE;
  v_destination text;
  v_hash jsonb;
  v_suppression jsonb;
  v_hash_secret text;
  v_hash_key_id uuid;
  v_contact_fingerprint text;
  v_preference_fingerprint text;
  v_reason text;
BEGIN
  IF p_salon_id IS NULL OR p_client_profile_id IS NULL
     OR p_channel NOT IN ('sms', 'email') THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'source_contract_changed');
  END IF;

  SELECT salon.* INTO v_salon
    FROM public.salons AS salon
   WHERE salon.id = p_salon_id
   FOR SHARE;
  IF NOT FOUND OR v_salon.archived_at IS NOT NULL THEN
    v_reason := 'salon_unavailable';
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.salon_clients AS salon_client
     WHERE salon_client.salon_id = p_salon_id
       AND salon_client.client_profile_id = p_client_profile_id
  ) THEN
    v_reason := 'not_salon_client';
  END IF;

  SELECT profile.* INTO v_profile
    FROM public.client_profiles AS profile
   WHERE profile.id = p_client_profile_id
   FOR SHARE;
  IF v_reason IS NULL AND (NOT FOUND OR v_profile.deleted_at IS NOT NULL) THEN
    v_reason := 'profile_unavailable';
  END IF;

  SELECT preference.* INTO v_preference
    FROM public.customer_preferences AS preference
   WHERE preference.client_profile_id = p_client_profile_id
     AND preference.salon_id = p_salon_id
   FOR SHARE;
  IF v_reason IS NULL AND NOT FOUND THEN
    v_reason := 'same_salon_consent_missing';
  END IF;

  IF p_channel = 'sms' THEN
    v_destination := public.canonical_phone(v_profile.phone);
    IF v_reason IS NULL AND (
      v_preference.consent_marketing_sms IS NOT TRUE
      OR v_profile.marketing_consent_at IS NULL
    ) THEN
      v_reason := 'marketing_consent_missing';
    ELSIF v_reason IS NULL AND v_preference.preferred_communication_channel
      NOT IN ('sms', 'both') THEN
      v_reason := 'preferred_channel_disabled';
    ELSIF v_reason IS NULL AND v_salon.customer_channel
      NOT IN ('smart', 'sms_only', 'sms_and_email') THEN
      v_reason := 'channel_disabled';
    ELSIF v_reason IS NULL AND v_salon.sms_outbound_enabled IS NOT TRUE THEN
      v_reason := 'channel_disabled';
    ELSIF v_reason IS NULL AND v_salon.sms_a2p_registered IS NOT TRUE THEN
      v_reason := 'a2p_not_registered';
    ELSIF v_reason IS NULL AND (
      v_destination IS NULL OR v_destination !~ '^[0-9]{7,15}$'
    ) THEN
      v_reason := 'destination_missing';
    END IF;

    IF v_destination IS NOT NULL AND v_destination ~ '^[0-9]{7,15}$' THEN
      v_hash := public.hash_sms_consent_phone(v_destination);
      IF v_hash ->> 'code' = 'hashed' THEN
        v_contact_fingerprint := v_hash ->> 'phone_hash';
        v_suppression := public.load_sms_outbound_suppression(
          p_salon_id,
          v_contact_fingerprint,
          (v_hash ->> 'hash_key_id')::uuid
        );
        IF v_reason IS NULL AND (
          v_suppression ->> 'code' <> 'clear'
          OR coalesce((v_suppression ->> 'suppressed')::boolean, true)
        ) THEN
          v_reason := CASE
            WHEN v_suppression ->> 'code' IN ('suppressed', 'clear')
              THEN 'sms_suppressed'
            ELSE 'consent_guard_unavailable'
          END;
        END IF;
      ELSIF v_reason IS NULL THEN
        v_reason := 'consent_guard_unavailable';
      END IF;
    END IF;
  ELSE
    v_destination := lower(btrim(coalesce(v_profile.email, '')));
    SELECT settings.sms_consent_hash_secret, settings.sms_consent_hash_key_id
      INTO v_hash_secret, v_hash_key_id
      FROM public.platform_settings AS settings
     WHERE settings.id = 'platform';
    IF v_reason IS NULL AND (
      v_preference.consent_marketing_email IS NOT TRUE
      OR v_profile.marketing_email_consent_at IS NULL
    ) THEN
      v_reason := 'marketing_consent_missing';
    ELSIF v_reason IS NULL AND v_preference.preferred_communication_channel
      NOT IN ('email', 'both') THEN
      v_reason := 'preferred_channel_disabled';
    ELSIF v_reason IS NULL AND v_salon.customer_channel
      NOT IN ('smart', 'email_only', 'sms_and_email') THEN
      v_reason := 'channel_disabled';
    ELSIF v_reason IS NULL AND v_salon.email_outbound_enabled IS NOT TRUE THEN
      v_reason := 'channel_disabled';
    ELSIF v_reason IS NULL AND (
      char_length(v_destination) NOT BETWEEN 3 AND 320
      OR v_destination !~ '^[^[:space:]@]+@[^[:space:]@]+$'
      OR v_destination ~ '[[:cntrl:]]'
    ) THEN
      v_reason := 'destination_missing';
    ELSIF v_reason IS NULL AND EXISTS (
      SELECT 1 FROM public.client_email_optouts AS optout
       WHERE lower(btrim(optout.email)) = v_destination
    ) THEN
      v_reason := 'email_opted_out';
    ELSIF v_reason IS NULL AND (
      v_hash_key_id IS NULL OR v_hash_secret IS NULL
      OR char_length(v_hash_secret) NOT BETWEEN 32 AND 512
    ) THEN
      v_reason := 'consent_guard_unavailable';
    END IF;
    IF v_destination <> '' AND v_hash_secret IS NOT NULL
       AND char_length(v_hash_secret) BETWEEN 32 AND 512 THEN
      v_contact_fingerprint := encode(extensions.hmac(
        convert_to(concat_ws('|', 'reactivation-email-contact-v1',
          p_salon_id::text, v_destination), 'UTF8'),
        convert_to(v_hash_secret, 'UTF8'), 'sha256'
      ), 'hex');
    END IF;
  END IF;

  v_contact_fingerprint := coalesce(v_contact_fingerprint, encode(extensions.digest(
    convert_to(concat_ws('|', 'reactivation-contact-unavailable-v1',
      p_salon_id::text, p_client_profile_id::text, p_channel,
      coalesce(v_reason, 'unknown')), 'UTF8'), 'sha256'
  ), 'hex'));

  v_preference_fingerprint := encode(extensions.digest(convert_to(concat_ws('|',
    'reactivation-preference-v1', p_salon_id::text,
    p_client_profile_id::text, p_channel,
    coalesce(v_preference.salon_id::text, ''),
    coalesce(v_preference.consent_marketing_sms::text, ''),
    coalesce(v_preference.consent_marketing_email::text, ''),
    coalesce(v_preference.preferred_communication_channel, ''),
    coalesce(v_preference.updated_at::text, ''),
    coalesce(v_profile.marketing_consent_at::text, ''),
    coalesce(v_profile.marketing_email_consent_at::text, ''),
    coalesce(v_salon.customer_channel, ''),
    coalesce(v_salon.sms_outbound_enabled::text, ''),
    coalesce(v_salon.email_outbound_enabled::text, ''),
    coalesce(v_salon.sms_a2p_registered::text, ''),
    coalesce(v_hash ->> 'hash_key_id', v_hash_key_id::text, ''),
    coalesce(v_suppression ->> 'provider_state_epoch', ''),
    coalesce(v_suppression ->> 'salon_state_epoch', ''),
    coalesce(v_reason, 'allowed')
  ), 'UTF8'), 'sha256'), 'hex');

  RETURN jsonb_build_object(
    'allowed', v_reason IS NULL,
    'reason', v_reason,
    'contact_fingerprint', v_contact_fingerprint,
    'preference_fingerprint', v_preference_fingerprint
  );
END;
$guard$;

CREATE FUNCTION public.materialize_reactivation_campaign_deliveries(
  p_dispatch_plan_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $materialize$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_source record;
  v_candidate record;
  v_guard jsonb;
  v_source_material text;
  v_contact text;
  v_preference text;
  v_recipient text;
  v_status text;
  v_reason text;
  v_expected_people integer;
  v_expected_sms integer;
  v_expected_email integer;
  v_created integer := 0;
  v_existing integer := 0;
  v_suppressed integer := 0;
BEGIN
  IF NOT public.reactivation_campaign_delivery_caller_is_service_role() THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_dispatch_plan_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_plan');
  END IF;

  -- Lock immutable parent evidence before taking the validation snapshot.
  -- FOR UPDATE conflicts with the KEY SHARE lock acquired by a concurrent FK
  -- child insert; mutable provenance rows use FOR SHARE. If we waited, the
  -- following SELECT receives a fresh READ COMMITTED snapshot.
  PERFORM 1
    FROM public.ai_campaign_dispatch_plans AS plan_lock
    JOIN public.ai_campaign_dispatch_preflights AS preflight_lock
      ON preflight_lock.id = plan_lock.preflight_id
     AND preflight_lock.salon_id = plan_lock.salon_id
     AND preflight_lock.manifest_id = plan_lock.manifest_id
     AND preflight_lock.release_execution_job_id =
       plan_lock.release_execution_job_id
    JOIN public.ai_campaign_manifests AS manifest_lock
      ON manifest_lock.id = plan_lock.manifest_id
     AND manifest_lock.salon_id = plan_lock.salon_id
    JOIN public.ai_execution_jobs AS release_job_lock
      ON release_job_lock.id = plan_lock.release_execution_job_id
     AND release_job_lock.salon_id = plan_lock.salon_id
    JOIN public.approval_requests AS release_approval_lock
      ON release_approval_lock.id = release_job_lock.approval_request_id
     AND release_approval_lock.salon_id = plan_lock.salon_id
    JOIN public.ai_execution_jobs AS source_job_lock
      ON source_job_lock.id = manifest_lock.source_execution_job_id
     AND source_job_lock.salon_id = plan_lock.salon_id
    JOIN public.approval_requests AS source_approval_lock
      ON source_approval_lock.id = manifest_lock.source_approval_request_id
     AND source_approval_lock.salon_id = plan_lock.salon_id
   WHERE plan_lock.id = p_dispatch_plan_id
   FOR UPDATE OF plan_lock, preflight_lock, manifest_lock
   FOR SHARE OF release_job_lock, release_approval_lock,
     source_job_lock, source_approval_lock;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'source_contract_unavailable');
  END IF;
  v_now := clock_timestamp();

  SELECT plan.id AS plan_id, plan.salon_id, plan.manifest_id,
         plan.preflight_id, plan.release_execution_job_id,
         plan.plan_fingerprint, plan.recipient_count,
         plan.sms_recipient_count, plan.email_recipient_count,
         plan.expires_at AS plan_expires_at,
         preflight.preflight_fingerprint,
         manifest.source_execution_job_id, manifest.message_sha256,
         manifest.summary ->> 'reactivation_kind' AS reactivation_kind,
         release_approval.id AS release_approval_id
    INTO v_source
    FROM public.ai_campaign_dispatch_plans AS plan
    JOIN public.ai_campaign_dispatch_preflights AS preflight
      ON preflight.id = plan.preflight_id
     AND preflight.salon_id = plan.salon_id
     AND preflight.manifest_id = plan.manifest_id
     AND preflight.release_execution_job_id = plan.release_execution_job_id
    JOIN public.ai_campaign_manifests AS manifest
      ON manifest.id = plan.manifest_id
     AND manifest.salon_id = plan.salon_id
    JOIN public.ai_execution_jobs AS release_job
      ON release_job.id = plan.release_execution_job_id
     AND release_job.salon_id = plan.salon_id
     AND release_job.action_type = 'bulk_message'
    JOIN public.approval_requests AS release_approval
      ON release_approval.id = release_job.approval_request_id
     AND release_approval.salon_id = plan.salon_id
     AND release_approval.action_type = 'bulk_message'
     AND release_approval.release_manifest_id = plan.manifest_id
    JOIN public.ai_execution_jobs AS source_job
      ON source_job.id = manifest.source_execution_job_id
     AND source_job.salon_id = plan.salon_id
     AND source_job.approval_request_id = manifest.source_approval_request_id
     AND source_job.action_type = 'bulk_message'
    JOIN public.approval_requests AS source_approval
      ON source_approval.id = manifest.source_approval_request_id
     AND source_approval.salon_id = plan.salon_id
     AND source_approval.action_type = 'bulk_message'
    JOIN LATERAL (
      SELECT count(*)::integer AS recipient_count,
             count(DISTINCT recipient_scope.client_profile_id)::integer
               AS unique_recipient_count,
             coalesce(bool_and(
               recipient_scope.salon_id = plan.salon_id
             ), true) AS tenant_scope_valid,
             left(encode(extensions.digest(convert_to(coalesce(string_agg(
               recipient_scope.client_profile_id::text || ':' ||
               CASE WHEN recipient_scope.sms THEN 's' ELSE '' END ||
               CASE WHEN recipient_scope.email THEN 'e' ELSE '' END,
               '|' ORDER BY recipient_scope.client_profile_id::text
             ), ''), 'UTF8'), 'sha256'), 'hex'), 24) AS audience_fingerprint
       FROM public.ai_campaign_manifest_recipients AS recipient_scope
       WHERE recipient_scope.manifest_id = plan.manifest_id
    ) AS manifest_contract ON
      manifest_contract.recipient_count = manifest_contract.unique_recipient_count
      AND manifest_contract.tenant_scope_valid
      AND manifest_contract.audience_fingerprint = manifest.audience_fingerprint
    JOIN LATERAL (
      SELECT count(*)::integer AS decision_count,
             count(recipient_scope.client_profile_id)::integer
               AS matched_manifest_count,
             coalesce(bool_and(
               decision_scope.salon_id = plan.salon_id
               AND recipient_scope.salon_id = plan.salon_id
             ), true) AS tenant_scope_valid,
             count(*) FILTER (
               WHERE decision_scope.exclusion IS NULL
             )::integer AS eligible_count,
             count(*) FILTER (
               WHERE decision_scope.exclusion IS NULL AND decision_scope.sms
             )::integer AS sms_recipient_count,
             count(*) FILTER (
               WHERE decision_scope.exclusion IS NULL AND decision_scope.email
             )::integer AS email_recipient_count,
             count(*) FILTER (
               WHERE decision_scope.exclusion IS NULL
                 AND decision_scope.sms AND decision_scope.email
             )::integer AS dual_channel_count,
             count(*) FILTER (
               WHERE decision_scope.exclusion = 'recent_contact'
             )::integer AS excluded_recent_contact,
             count(*) FILTER (
               WHERE decision_scope.exclusion = 'no_consent'
             )::integer AS excluded_no_consent,
             count(*) FILTER (
               WHERE decision_scope.exclusion = 'no_channel'
             )::integer AS excluded_no_channel,
             count(*) FILTER (
               WHERE decision_scope.exclusion = 'missing_profile'
             )::integer AS excluded_missing_profile,
             count(*) FILTER (
               WHERE decision_scope.exclusion =
                 'manifest_channel_unavailable'
             )::integer AS excluded_manifest_channel_unavailable,
             coalesce(bool_and(
               recipient_scope.client_profile_id IS NOT NULL
               AND (NOT decision_scope.sms OR recipient_scope.sms)
               AND (NOT decision_scope.email OR recipient_scope.email)
             ), true) AS channel_scope_valid,
             encode(extensions.digest(convert_to(coalesce(string_agg(
               decision_scope.client_profile_id::text || ':' ||
               CASE WHEN decision_scope.sms THEN 's' ELSE '' END ||
               CASE WHEN decision_scope.email THEN 'e' ELSE '' END || ':' ||
               coalesce(decision_scope.exclusion, 'eligible'),
               '|' ORDER BY decision_scope.client_profile_id::text
             ), ''), 'UTF8'), 'sha256'), 'hex') AS decision_fingerprint
        FROM public.ai_campaign_dispatch_preflight_decisions AS decision_scope
        LEFT JOIN public.ai_campaign_manifest_recipients AS recipient_scope
          ON recipient_scope.manifest_id = plan.manifest_id
         AND recipient_scope.client_profile_id = decision_scope.client_profile_id
       WHERE decision_scope.preflight_id = plan.preflight_id
    ) AS preflight_contract ON
      preflight_contract.decision_count = manifest_contract.recipient_count
      AND preflight_contract.matched_manifest_count =
        preflight_contract.decision_count
      AND preflight_contract.tenant_scope_valid
      AND preflight_contract.channel_scope_valid
      AND preflight_contract.decision_fingerprint =
        preflight.preflight_fingerprint
      AND preflight_contract.eligible_count = plan.recipient_count
      AND preflight_contract.sms_recipient_count = plan.sms_recipient_count
      AND preflight_contract.email_recipient_count = plan.email_recipient_count
      AND preflight.summary -> 'manifest_recipient_count' =
        to_jsonb(preflight_contract.decision_count)
      AND preflight.summary -> 'eligible_count' = to_jsonb(plan.recipient_count)
      AND preflight.summary -> 'sms_recipient_count' =
        to_jsonb(plan.sms_recipient_count)
      AND preflight.summary -> 'email_recipient_count' =
        to_jsonb(plan.email_recipient_count)
      AND preflight.summary -> 'dual_channel_count' =
        to_jsonb(preflight_contract.dual_channel_count)
      AND preflight.summary -> 'excluded_recent_contact' =
        to_jsonb(preflight_contract.excluded_recent_contact)
      AND preflight.summary -> 'excluded_no_consent' =
        to_jsonb(preflight_contract.excluded_no_consent)
      AND preflight.summary -> 'excluded_no_channel' =
        to_jsonb(preflight_contract.excluded_no_channel)
      AND preflight.summary -> 'excluded_missing_profile' =
        to_jsonb(preflight_contract.excluded_missing_profile)
      AND preflight.summary -> 'excluded_manifest_channel_unavailable' =
        to_jsonb(preflight_contract.excluded_manifest_channel_unavailable)
      AND preflight.summary -> 'estimated_cost_usd_cents' =
        to_jsonb(plan.estimated_cost_usd_cents)
      AND preflight.summary ->> 'within_recipient_cap' = 'true'
      AND preflight.summary ->> 'within_cost_cap' = 'true'
   WHERE plan.id = p_dispatch_plan_id
     AND plan.status = 'sealed'
     AND plan.dispatch_enabled IS FALSE
     AND plan.no_messages_sent IS TRUE
     AND plan.expires_at > v_now
     AND public.ai_tenant_allows_autonomous_execution(plan.salon_id)
     AND preflight.status = 'ready'
     AND preflight.valid_until > v_now
     AND preflight.preflight_fingerprint = preflight.summary ->> 'preflight_fingerprint'
     AND preflight.summary ->> 'dispatch_enabled' = 'false'
     AND preflight.summary ->> 'no_messages_sent' = 'true'
     AND release_job.status = 'waiting_input'
     AND release_job.payload ->> 'proposal_source' = 'reactivation_campaign_release_gate'
     AND release_job.payload ->> 'manifest_id' = plan.manifest_id::text
     AND release_job.payload ->> 'source_execution_job_id' =
       manifest.source_execution_job_id::text
     AND release_job.payload ->> 'audience_fingerprint' = manifest.audience_fingerprint
     AND release_job.payload ->> 'message_sha256' = manifest.message_sha256
     AND release_job.payload ->> 'dispatch_enabled' = 'false'
     AND release_job.payload ->> 'no_messages_sent' = 'true'
     AND release_job.result ->> 'blocker' = 'dispatch_not_enabled'
     AND release_job.result ->> 'dispatch_plan_id' = plan.id::text
     AND release_job.result ->> 'dispatch_enabled' = 'false'
     AND release_job.result ->> 'no_messages_sent' = 'true'
     AND release_approval.status = 'approved'
     AND release_approval.decided_at IS NOT NULL
     AND release_approval.expires_at > v_now
     AND release_approval.payload ->> 'proposal_source' = 'reactivation_campaign_release_gate'
     AND release_approval.payload ->> 'manifest_id' = plan.manifest_id::text
     AND release_approval.payload ->> 'source_execution_job_id' = manifest.source_execution_job_id::text
     AND release_approval.payload ->> 'audience_fingerprint' = manifest.audience_fingerprint
     AND release_approval.payload ->> 'message_sha256' = manifest.message_sha256
     AND release_approval.payload ->> 'dispatch_enabled' = 'false'
     AND release_approval.payload ->> 'no_messages_sent' = 'true'
     AND manifest.summary ->> 'reactivation_kind' IN ('winback', 'rebook')
     AND release_approval.payload ->> 'reactivation_kind' =
       manifest.summary ->> 'reactivation_kind'
     AND release_job.payload ->> 'reactivation_kind' =
       manifest.summary ->> 'reactivation_kind'
     AND source_job.status = 'waiting_input'
     AND source_job.payload ->> 'proposal_source' = 'reactivation_campaign'
     AND source_job.payload ->> 'reactivation_kind' =
       manifest.summary ->> 'reactivation_kind'
     AND source_job.payload ->> 'dispatch_enabled' = 'false'
     AND source_job.payload ->> 'no_messages_sent' = 'true'
     AND source_job.result ->> 'dispatch_enabled' = 'false'
     AND source_job.result ->> 'no_messages_sent' = 'true'
     AND source_approval.status = 'approved'
     AND source_approval.decided_at IS NOT NULL
     AND source_approval.expires_at > v_now
     AND source_approval.payload ->> 'proposal_source' = 'reactivation_campaign'
     AND source_approval.payload ->> 'reactivation_kind' =
       manifest.summary ->> 'reactivation_kind'
     AND source_approval.payload ->> 'dispatch_enabled' = 'false'
     AND source_approval.payload ->> 'no_messages_sent' = 'true'
   FOR SHARE OF plan, preflight, manifest, release_job, release_approval,
     source_job, source_approval;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'source_contract_unavailable');
  END IF;

  SELECT count(DISTINCT decision.client_profile_id)::integer,
         count(*) FILTER (WHERE decision.sms)::integer,
         count(*) FILTER (WHERE decision.email)::integer
    INTO v_expected_people, v_expected_sms, v_expected_email
    FROM public.ai_campaign_dispatch_preflight_decisions AS decision
    JOIN public.ai_campaign_manifest_recipients AS recipient
      ON recipient.manifest_id = v_source.manifest_id
     AND recipient.salon_id = v_source.salon_id
     AND recipient.client_profile_id = decision.client_profile_id
   WHERE decision.preflight_id = v_source.preflight_id
     AND decision.salon_id = v_source.salon_id
     AND decision.exclusion IS NULL
     AND (decision.sms OR decision.email)
     AND (NOT decision.sms OR recipient.sms)
     AND (NOT decision.email OR recipient.email);

  IF v_expected_people <> v_source.recipient_count
     OR v_expected_sms <> v_source.sms_recipient_count
     OR v_expected_email <> v_source.email_recipient_count THEN
    RETURN jsonb_build_object('success', false, 'code', 'decision_count_mismatch');
  END IF;

  FOR v_candidate IN
    SELECT decision.client_profile_id, channel_row.channel
      FROM public.ai_campaign_dispatch_preflight_decisions AS decision
      JOIN public.ai_campaign_manifest_recipients AS recipient
        ON recipient.manifest_id = v_source.manifest_id
       AND recipient.salon_id = v_source.salon_id
       AND recipient.client_profile_id = decision.client_profile_id
      CROSS JOIN LATERAL (
        VALUES ('sms'::text, decision.sms AND recipient.sms),
               ('email'::text, decision.email AND recipient.email)
      ) AS channel_row(channel, selected)
     WHERE decision.preflight_id = v_source.preflight_id
       AND decision.salon_id = v_source.salon_id
       AND decision.exclusion IS NULL
       AND channel_row.selected
     ORDER BY decision.client_profile_id, channel_row.channel
  LOOP
    v_guard := public.evaluate_reactivation_campaign_delivery_guard(
      v_source.salon_id, v_candidate.client_profile_id, v_candidate.channel
    );
    v_contact := v_guard ->> 'contact_fingerprint';
    v_preference := v_guard ->> 'preference_fingerprint';
    v_reason := v_guard ->> 'reason';
    v_status := CASE WHEN coalesce((v_guard ->> 'allowed')::boolean, false)
      THEN 'awaiting_material' ELSE 'suppressed' END;
    v_source_material := encode(extensions.digest(convert_to(concat_ws('|',
      'reactivation-source-material-v1', v_source.manifest_id::text,
      v_source.message_sha256, v_candidate.channel,
      'language-policy-unresolved'), 'UTF8'), 'sha256'), 'hex');
    v_recipient := encode(extensions.digest(convert_to(concat_ws('|',
      'reactivation-recipient-v1', v_source.salon_id::text,
      v_source.manifest_id::text, v_candidate.client_profile_id::text,
      v_candidate.channel, v_contact), 'UTF8'), 'sha256'), 'hex');

    INSERT INTO public.reactivation_campaign_deliveries (
      salon_id, dispatch_plan_id, preflight_id, manifest_id,
      release_approval_id, release_execution_job_id, source_execution_job_id,
      client_profile_id, channel, proposal_source, plan_fingerprint,
      preflight_fingerprint, source_material_fingerprint,
      contact_fingerprint, preference_fingerprint, recipient_fingerprint,
      status, suppression_reason, plan_expires_at, completed_at,
      created_at, updated_at
    ) VALUES (
      v_source.salon_id, v_source.plan_id, v_source.preflight_id,
      v_source.manifest_id, v_source.release_approval_id,
      v_source.release_execution_job_id, v_source.source_execution_job_id,
      v_candidate.client_profile_id, v_candidate.channel,
      'reactivation_campaign_release_gate', v_source.plan_fingerprint,
      v_source.preflight_fingerprint, v_source_material,
      v_contact, v_preference, v_recipient, v_status,
      CASE WHEN v_status = 'suppressed' THEN v_reason ELSE NULL END,
      v_source.plan_expires_at,
      CASE WHEN v_status = 'suppressed' THEN v_now ELSE NULL END,
      v_now, v_now
    )
    ON CONFLICT ON CONSTRAINT
      reactivation_campaign_deliveries_manifest_profile_channel_key
    DO NOTHING;

    IF FOUND THEN
      v_created := v_created + 1;
      IF v_status = 'suppressed' THEN v_suppressed := v_suppressed + 1; END IF;
    ELSIF EXISTS (
      SELECT 1 FROM public.reactivation_campaign_deliveries AS existing
       WHERE existing.manifest_id = v_source.manifest_id
         AND existing.client_profile_id = v_candidate.client_profile_id
         AND existing.channel = v_candidate.channel
         AND existing.salon_id = v_source.salon_id
         AND existing.dispatch_plan_id = v_source.plan_id
         AND existing.preflight_id = v_source.preflight_id
         AND existing.plan_fingerprint = v_source.plan_fingerprint
         AND existing.preflight_fingerprint = v_source.preflight_fingerprint
         AND existing.source_material_fingerprint = v_source_material
         AND existing.contact_fingerprint = v_contact
         AND existing.preference_fingerprint = v_preference
         AND existing.recipient_fingerprint = v_recipient
    ) THEN
      v_existing := v_existing + 1;
    ELSE
      RAISE EXCEPTION 'reactivation_delivery_materialization_conflict'
        USING ERRCODE = '40001';
    END IF;
  END LOOP;

  INSERT INTO public.ai_actions_log (
    salon_id, agent, action_type, target_id, payload, created_at
  ) VALUES (
    v_source.salon_id, 'execution_worker',
    'reactivation_delivery_candidates_materialized', v_source.plan_id,
    jsonb_build_object(
      'dispatch_plan_id', v_source.plan_id,
      'created_count', v_created,
      'existing_count', v_existing,
      'suppressed_count', v_suppressed,
      'dispatch_authorized', false,
      'provider_called', false,
      'no_messages_sent', true
    ), v_now
  );

  RETURN jsonb_build_object(
    'success', true,
    'code', CASE WHEN v_created > 0 THEN 'materialized' ELSE 'unchanged' END,
    'dispatch_plan_id', v_source.plan_id,
    'created_count', v_created,
    'existing_count', v_existing,
    'suppressed_count', v_suppressed,
    'dispatch_authorized', false,
    'provider_called', false
  );
END;
$materialize$;

CREATE FUNCTION public.bind_reactivation_campaign_delivery_material(
  p_delivery_id uuid,
  p_source_material_fingerprint text,
  p_material_fingerprint text,
  p_contact_fingerprint text,
  p_preference_fingerprint text,
  p_recipient_fingerprint text,
  p_payload_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $bind$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_delivery public.reactivation_campaign_deliveries%ROWTYPE;
  v_guard jsonb;
  v_expected_payload text;
  v_reason text;
BEGIN
  IF NOT public.reactivation_campaign_delivery_caller_is_service_role() THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_delivery_id IS NULL
     OR coalesce(p_source_material_fingerprint, '') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_material_fingerprint, '') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_contact_fingerprint, '') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_preference_fingerprint, '') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_recipient_fingerprint, '') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_payload_fingerprint, '') !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_material');
  END IF;

  SELECT delivery.* INTO v_delivery
    FROM public.reactivation_campaign_deliveries AS delivery
   WHERE delivery.id = p_delivery_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'delivery_not_found');
  END IF;

  IF v_delivery.status <> 'awaiting_material' THEN
    IF v_delivery.status = 'awaiting_authorization'
       AND v_delivery.source_material_fingerprint = p_source_material_fingerprint
       AND v_delivery.material_fingerprint = p_material_fingerprint
       AND v_delivery.contact_fingerprint = p_contact_fingerprint
       AND v_delivery.preference_fingerprint = p_preference_fingerprint
       AND v_delivery.recipient_fingerprint = p_recipient_fingerprint
       AND v_delivery.payload_fingerprint = p_payload_fingerprint THEN
      RETURN jsonb_build_object('success', true, 'code', 'already_bound',
        'delivery_id', v_delivery.id, 'status', v_delivery.status,
        'dispatch_authorized', false);
    END IF;
    RETURN jsonb_build_object('success', false, 'code', 'material_conflict');
  END IF;

  IF v_delivery.plan_expires_at <= v_now THEN
    UPDATE public.reactivation_campaign_deliveries SET
      status = 'suppressed', suppression_reason = 'plan_expired',
      completed_at = v_now, updated_at = v_now
    WHERE id = v_delivery.id;
    RETURN jsonb_build_object('success', false, 'code', 'plan_expired');
  END IF;

  v_guard := public.evaluate_reactivation_campaign_delivery_guard(
    v_delivery.salon_id, v_delivery.client_profile_id, v_delivery.channel
  );
  IF coalesce((v_guard ->> 'allowed')::boolean, false) IS NOT TRUE THEN
    v_reason := coalesce(v_guard ->> 'reason', 'source_contract_changed');
    UPDATE public.reactivation_campaign_deliveries SET
      status = 'suppressed', suppression_reason = v_reason,
      completed_at = v_now, updated_at = v_now
    WHERE id = v_delivery.id;
    RETURN jsonb_build_object('success', false, 'code', 'suppressed',
      'reason', v_reason);
  END IF;

  IF v_delivery.source_material_fingerprint <> p_source_material_fingerprint
     OR v_guard ->> 'contact_fingerprint' <> p_contact_fingerprint
     OR v_guard ->> 'preference_fingerprint' <> p_preference_fingerprint
     OR v_delivery.recipient_fingerprint <> p_recipient_fingerprint THEN
    RETURN jsonb_build_object('success', false, 'code', 'fingerprint_mismatch');
  END IF;

  v_expected_payload := encode(extensions.digest(convert_to(concat_ws('|',
    'reactivation-payload-v1', v_delivery.id::text,
    v_delivery.plan_fingerprint, v_delivery.preflight_fingerprint,
    p_source_material_fingerprint, p_material_fingerprint,
    p_contact_fingerprint, p_preference_fingerprint,
    p_recipient_fingerprint), 'UTF8'), 'sha256'), 'hex');
  IF p_payload_fingerprint <> v_expected_payload THEN
    RETURN jsonb_build_object('success', false, 'code', 'payload_fingerprint_mismatch');
  END IF;

  UPDATE public.reactivation_campaign_deliveries SET
    material_fingerprint = p_material_fingerprint,
    payload_fingerprint = p_payload_fingerprint,
    status = 'awaiting_authorization', updated_at = v_now
  WHERE id = v_delivery.id;

  INSERT INTO public.ai_actions_log (
    salon_id, agent, action_type, target_id, payload, created_at
  ) VALUES (
    v_delivery.salon_id, 'execution_worker',
    'reactivation_delivery_material_bound', v_delivery.id,
    jsonb_build_object(
      'dispatch_plan_id', v_delivery.dispatch_plan_id,
      'channel', v_delivery.channel,
      'material_fingerprint', p_material_fingerprint,
      'payload_fingerprint', p_payload_fingerprint,
      'dispatch_authorized', false,
      'provider_called', false
    ), v_now
  );

  RETURN jsonb_build_object('success', true, 'code', 'bound',
    'delivery_id', v_delivery.id, 'status', 'awaiting_authorization',
    'dispatch_authorized', false, 'provider_called', false);
END;
$bind$;

CREATE FUNCTION public.validate_reactivation_campaign_dispatch_authorization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $authorization$
DECLARE
  v_delivery public.reactivation_campaign_deliveries%ROWTYPE;
  v_expected text;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT delivery.* INTO v_delivery
    FROM public.reactivation_campaign_deliveries AS delivery
   WHERE delivery.id = NEW.delivery_id
   FOR SHARE;
  IF NOT FOUND OR v_delivery.status <> 'awaiting_authorization'
     OR NEW.salon_id <> v_delivery.salon_id
     OR NEW.dispatch_plan_id <> v_delivery.dispatch_plan_id
     OR NEW.plan_fingerprint <> v_delivery.plan_fingerprint
     OR NEW.source_material_fingerprint <> v_delivery.source_material_fingerprint
     OR NEW.material_fingerprint <> v_delivery.material_fingerprint
     OR NEW.payload_fingerprint <> v_delivery.payload_fingerprint
     OR NEW.contact_fingerprint <> v_delivery.contact_fingerprint
     OR NEW.preference_fingerprint <> v_delivery.preference_fingerprint
     OR NEW.recipient_fingerprint <> v_delivery.recipient_fingerprint
     OR NEW.expires_at > v_delivery.plan_expires_at
     OR NEW.expires_at <= v_now
     OR NEW.authorized_at > v_now + interval '1 minute' THEN
    RAISE EXCEPTION 'reactivation_dispatch_authorization_mismatch'
      USING ERRCODE = 'check_violation';
  END IF;

  v_expected := encode(extensions.digest(convert_to(concat_ws('|',
    'reactivation-dispatch-authorization-v1', NEW.delivery_id::text,
    NEW.salon_id::text, NEW.dispatch_plan_id::text, NEW.plan_fingerprint,
    NEW.source_material_fingerprint, NEW.material_fingerprint,
    NEW.payload_fingerprint, NEW.contact_fingerprint,
    NEW.preference_fingerprint, NEW.recipient_fingerprint,
    NEW.authorized_at::text, NEW.expires_at::text), 'UTF8'), 'sha256'), 'hex');
  IF NEW.authorization_fingerprint <> v_expected THEN
    RAISE EXCEPTION 'reactivation_dispatch_authorization_fingerprint_mismatch'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$authorization$;

CREATE TRIGGER validate_reactivation_dispatch_authorization
  BEFORE INSERT ON public.reactivation_campaign_dispatch_authorizations
  FOR EACH ROW EXECUTE FUNCTION
    public.validate_reactivation_campaign_dispatch_authorization();

CREATE FUNCTION public.reject_reactivation_campaign_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'reactivation_campaign_evidence_is_immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER reactivation_campaign_dispatch_authorizations_immutable
  BEFORE UPDATE OR DELETE ON public.reactivation_campaign_dispatch_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.reject_reactivation_campaign_evidence_mutation();
CREATE TRIGGER reactivation_campaign_delivery_receipts_immutable
  BEFORE UPDATE OR DELETE ON public.reactivation_campaign_delivery_receipts
  FOR EACH ROW EXECUTE FUNCTION public.reject_reactivation_campaign_evidence_mutation();

CREATE FUNCTION public.claim_reactivation_campaign_deliveries(p_limit integer)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $claim$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 0), 0), 100);
  v_now timestamptz := clock_timestamp();
  v_delivery public.reactivation_campaign_deliveries%ROWTYPE;
  v_guard jsonb;
  v_authorization public.reactivation_campaign_dispatch_authorizations%ROWTYPE;
  v_expected_payload text;
  v_expected_authorization text;
  v_reason text;
  v_token uuid;
BEGIN
  IF NOT public.reactivation_campaign_delivery_caller_is_service_role()
     OR v_limit < 1 THEN RETURN; END IF;

  FOR v_delivery IN
    SELECT delivery.*
      FROM public.reactivation_campaign_deliveries AS delivery
     WHERE delivery.status = 'awaiting_authorization'
     ORDER BY delivery.created_at, delivery.id
     FOR UPDATE SKIP LOCKED
     LIMIT v_limit
  LOOP
    -- A claim batch may outlive an authorization boundary. Re-sample wall-clock
    -- time for each locked delivery so a later row cannot inherit stale expiry
    -- or lease timing from the beginning of the RPC.
    v_now := clock_timestamp();
    v_reason := NULL;
    PERFORM 1
      FROM public.ai_campaign_dispatch_plans AS plan_lock
      JOIN public.ai_campaign_dispatch_preflights AS preflight_lock
        ON preflight_lock.id = plan_lock.preflight_id
       AND preflight_lock.salon_id = plan_lock.salon_id
       AND preflight_lock.manifest_id = plan_lock.manifest_id
       AND preflight_lock.release_execution_job_id =
         plan_lock.release_execution_job_id
      JOIN public.ai_campaign_manifests AS manifest_lock
        ON manifest_lock.id = plan_lock.manifest_id
       AND manifest_lock.salon_id = plan_lock.salon_id
      JOIN public.ai_execution_jobs AS release_job_lock
        ON release_job_lock.id = plan_lock.release_execution_job_id
       AND release_job_lock.salon_id = plan_lock.salon_id
      JOIN public.approval_requests AS release_approval_lock
        ON release_approval_lock.id = release_job_lock.approval_request_id
       AND release_approval_lock.salon_id = plan_lock.salon_id
      JOIN public.ai_execution_jobs AS source_job_lock
        ON source_job_lock.id = manifest_lock.source_execution_job_id
       AND source_job_lock.salon_id = plan_lock.salon_id
      JOIN public.approval_requests AS source_approval_lock
        ON source_approval_lock.id = manifest_lock.source_approval_request_id
       AND source_approval_lock.salon_id = plan_lock.salon_id
     WHERE plan_lock.id = v_delivery.dispatch_plan_id
       AND plan_lock.salon_id = v_delivery.salon_id
       AND plan_lock.preflight_id = v_delivery.preflight_id
       AND plan_lock.manifest_id = v_delivery.manifest_id
       AND plan_lock.release_execution_job_id =
         v_delivery.release_execution_job_id
       AND manifest_lock.source_execution_job_id =
         v_delivery.source_execution_job_id
       AND release_approval_lock.id = v_delivery.release_approval_id
     FOR UPDATE OF plan_lock, preflight_lock, manifest_lock
     FOR SHARE OF release_job_lock, release_approval_lock,
       source_job_lock, source_approval_lock;
    IF NOT FOUND THEN
      v_now := clock_timestamp();
      UPDATE public.reactivation_campaign_deliveries SET
        status = 'suppressed', suppression_reason = 'source_contract_changed',
        completed_at = v_now, updated_at = v_now
      WHERE id = v_delivery.id;
      RETURN NEXT jsonb_build_object('success', false, 'code', 'suppressed',
        'delivery_id', v_delivery.id, 'reason', 'source_contract_changed');
      CONTINUE;
    END IF;
    -- Refresh after any FK or provenance writer we waited on committed.
    v_now := clock_timestamp();
    IF v_delivery.plan_expires_at <= v_now THEN
      UPDATE public.reactivation_campaign_deliveries SET
        status = 'suppressed', suppression_reason = 'plan_expired',
        completed_at = v_now, updated_at = v_now
      WHERE id = v_delivery.id;
      RETURN NEXT jsonb_build_object('success', false, 'code', 'suppressed',
        'delivery_id', v_delivery.id, 'reason', 'plan_expired');
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.ai_campaign_dispatch_plans AS plan
        JOIN public.ai_campaign_dispatch_preflights AS preflight
          ON preflight.id = plan.preflight_id
         AND preflight.salon_id = plan.salon_id
         AND preflight.manifest_id = plan.manifest_id
         AND preflight.release_execution_job_id = plan.release_execution_job_id
        JOIN public.ai_campaign_manifests AS manifest
          ON manifest.id = plan.manifest_id AND manifest.salon_id = plan.salon_id
        JOIN public.ai_campaign_dispatch_preflight_decisions AS decision
          ON decision.preflight_id = plan.preflight_id
         AND decision.salon_id = plan.salon_id
         AND decision.client_profile_id = v_delivery.client_profile_id
         AND decision.exclusion IS NULL
        JOIN public.ai_campaign_manifest_recipients AS recipient
          ON recipient.manifest_id = plan.manifest_id
         AND recipient.salon_id = plan.salon_id
         AND recipient.client_profile_id = decision.client_profile_id
        JOIN public.ai_execution_jobs AS release_job
          ON release_job.id = plan.release_execution_job_id
         AND release_job.salon_id = plan.salon_id
         AND release_job.action_type = 'bulk_message'
        JOIN public.approval_requests AS release_approval
          ON release_approval.id = release_job.approval_request_id
         AND release_approval.salon_id = plan.salon_id
         AND release_approval.action_type = 'bulk_message'
         AND release_approval.release_manifest_id = plan.manifest_id
        JOIN public.ai_execution_jobs AS source_job
          ON source_job.id = manifest.source_execution_job_id
         AND source_job.salon_id = plan.salon_id
         AND source_job.approval_request_id = manifest.source_approval_request_id
         AND source_job.action_type = 'bulk_message'
        JOIN public.approval_requests AS source_approval
          ON source_approval.id = manifest.source_approval_request_id
         AND source_approval.salon_id = plan.salon_id
         AND source_approval.action_type = 'bulk_message'
        JOIN LATERAL (
          SELECT count(*)::integer AS recipient_count,
                 count(DISTINCT recipient_scope.client_profile_id)::integer
                   AS unique_recipient_count,
                 coalesce(bool_and(
                   recipient_scope.salon_id = plan.salon_id
                 ), true) AS tenant_scope_valid,
                 left(encode(extensions.digest(convert_to(coalesce(string_agg(
                   recipient_scope.client_profile_id::text || ':' ||
                   CASE WHEN recipient_scope.sms THEN 's' ELSE '' END ||
                   CASE WHEN recipient_scope.email THEN 'e' ELSE '' END,
                   '|' ORDER BY recipient_scope.client_profile_id::text
                 ), ''), 'UTF8'), 'sha256'), 'hex'), 24)
                   AS audience_fingerprint
            FROM public.ai_campaign_manifest_recipients AS recipient_scope
           WHERE recipient_scope.manifest_id = plan.manifest_id
        ) AS manifest_contract ON
          manifest_contract.recipient_count =
            manifest_contract.unique_recipient_count
          AND manifest_contract.tenant_scope_valid
          AND manifest_contract.audience_fingerprint =
            manifest.audience_fingerprint
        JOIN LATERAL (
          SELECT count(*)::integer AS decision_count,
                 count(recipient_scope.client_profile_id)::integer
                   AS matched_manifest_count,
                 coalesce(bool_and(
                   decision_scope.salon_id = plan.salon_id
                   AND recipient_scope.salon_id = plan.salon_id
                 ), true) AS tenant_scope_valid,
                 count(*) FILTER (
                   WHERE decision_scope.exclusion IS NULL
                 )::integer AS eligible_count,
                 count(*) FILTER (
                   WHERE decision_scope.exclusion IS NULL AND decision_scope.sms
                 )::integer AS sms_recipient_count,
                 count(*) FILTER (
                   WHERE decision_scope.exclusion IS NULL AND decision_scope.email
                 )::integer AS email_recipient_count,
                 count(*) FILTER (
                   WHERE decision_scope.exclusion IS NULL
                     AND decision_scope.sms AND decision_scope.email
                 )::integer AS dual_channel_count,
                 count(*) FILTER (
                   WHERE decision_scope.exclusion = 'recent_contact'
                 )::integer AS excluded_recent_contact,
                 count(*) FILTER (
                   WHERE decision_scope.exclusion = 'no_consent'
                 )::integer AS excluded_no_consent,
                 count(*) FILTER (
                   WHERE decision_scope.exclusion = 'no_channel'
                 )::integer AS excluded_no_channel,
                 count(*) FILTER (
                   WHERE decision_scope.exclusion = 'missing_profile'
                 )::integer AS excluded_missing_profile,
                 count(*) FILTER (
                   WHERE decision_scope.exclusion =
                     'manifest_channel_unavailable'
                 )::integer AS excluded_manifest_channel_unavailable,
                 coalesce(bool_and(
                   recipient_scope.client_profile_id IS NOT NULL
                   AND (NOT decision_scope.sms OR recipient_scope.sms)
                   AND (NOT decision_scope.email OR recipient_scope.email)
                 ), true) AS channel_scope_valid,
                 encode(extensions.digest(convert_to(coalesce(string_agg(
                   decision_scope.client_profile_id::text || ':' ||
                   CASE WHEN decision_scope.sms THEN 's' ELSE '' END ||
                   CASE WHEN decision_scope.email THEN 'e' ELSE '' END || ':' ||
                   coalesce(decision_scope.exclusion, 'eligible'),
                   '|' ORDER BY decision_scope.client_profile_id::text
                 ), ''), 'UTF8'), 'sha256'), 'hex') AS decision_fingerprint
            FROM public.ai_campaign_dispatch_preflight_decisions AS decision_scope
            LEFT JOIN public.ai_campaign_manifest_recipients AS recipient_scope
              ON recipient_scope.manifest_id = plan.manifest_id
             AND recipient_scope.client_profile_id =
               decision_scope.client_profile_id
           WHERE decision_scope.preflight_id = plan.preflight_id
        ) AS preflight_contract ON
          preflight_contract.decision_count = manifest_contract.recipient_count
          AND preflight_contract.matched_manifest_count =
            preflight_contract.decision_count
          AND preflight_contract.tenant_scope_valid
          AND preflight_contract.channel_scope_valid
          AND preflight_contract.decision_fingerprint =
            preflight.preflight_fingerprint
          AND preflight_contract.eligible_count = plan.recipient_count
          AND preflight_contract.sms_recipient_count = plan.sms_recipient_count
          AND preflight_contract.email_recipient_count =
            plan.email_recipient_count
          AND preflight.summary -> 'manifest_recipient_count' =
            to_jsonb(preflight_contract.decision_count)
          AND preflight.summary -> 'eligible_count' =
            to_jsonb(plan.recipient_count)
          AND preflight.summary -> 'sms_recipient_count' =
            to_jsonb(plan.sms_recipient_count)
          AND preflight.summary -> 'email_recipient_count' =
            to_jsonb(plan.email_recipient_count)
          AND preflight.summary -> 'dual_channel_count' =
            to_jsonb(preflight_contract.dual_channel_count)
          AND preflight.summary -> 'excluded_recent_contact' =
            to_jsonb(preflight_contract.excluded_recent_contact)
          AND preflight.summary -> 'excluded_no_consent' =
            to_jsonb(preflight_contract.excluded_no_consent)
          AND preflight.summary -> 'excluded_no_channel' =
            to_jsonb(preflight_contract.excluded_no_channel)
          AND preflight.summary -> 'excluded_missing_profile' =
            to_jsonb(preflight_contract.excluded_missing_profile)
          AND preflight.summary ->
            'excluded_manifest_channel_unavailable' =
            to_jsonb(preflight_contract.excluded_manifest_channel_unavailable)
          AND preflight.summary -> 'estimated_cost_usd_cents' =
            to_jsonb(plan.estimated_cost_usd_cents)
          AND preflight.summary ->> 'within_recipient_cap' = 'true'
          AND preflight.summary ->> 'within_cost_cap' = 'true'
       WHERE plan.id = v_delivery.dispatch_plan_id
         AND plan.salon_id = v_delivery.salon_id
         AND plan.manifest_id = v_delivery.manifest_id
         AND plan.preflight_id = v_delivery.preflight_id
         AND plan.release_execution_job_id = v_delivery.release_execution_job_id
         AND plan.plan_fingerprint = v_delivery.plan_fingerprint
         AND plan.status = 'sealed' AND plan.dispatch_enabled IS FALSE
         AND plan.no_messages_sent IS TRUE AND plan.expires_at > v_now
         AND public.ai_tenant_allows_autonomous_execution(plan.salon_id)
         AND preflight.status = 'ready' AND preflight.valid_until > v_now
         AND preflight.preflight_fingerprint = v_delivery.preflight_fingerprint
         AND preflight.preflight_fingerprint =
           preflight.summary ->> 'preflight_fingerprint'
         AND preflight.summary ->> 'dispatch_enabled' = 'false'
         AND preflight.summary ->> 'no_messages_sent' = 'true'
         AND manifest.source_execution_job_id = v_delivery.source_execution_job_id
         AND manifest.summary ->> 'reactivation_kind' IN ('winback', 'rebook')
         AND release_job.status = 'waiting_input'
         AND release_job.payload ->> 'proposal_source' = 'reactivation_campaign_release_gate'
         AND release_job.payload ->> 'reactivation_kind' =
           manifest.summary ->> 'reactivation_kind'
         AND release_job.payload ->> 'manifest_id' = manifest.id::text
         AND release_job.payload ->> 'source_execution_job_id' =
           manifest.source_execution_job_id::text
         AND release_job.payload ->> 'audience_fingerprint' =
           manifest.audience_fingerprint
         AND release_job.payload ->> 'message_sha256' = manifest.message_sha256
         AND release_job.payload ->> 'dispatch_enabled' = 'false'
         AND release_job.payload ->> 'no_messages_sent' = 'true'
         AND release_job.result ->> 'blocker' = 'dispatch_not_enabled'
         AND release_job.result ->> 'dispatch_plan_id' = plan.id::text
         AND release_job.result ->> 'dispatch_enabled' = 'false'
         AND release_job.result ->> 'no_messages_sent' = 'true'
         AND release_approval.id = v_delivery.release_approval_id
         AND release_approval.status = 'approved'
         AND release_approval.decided_at IS NOT NULL
         AND release_approval.expires_at > v_now
         AND release_approval.payload ->> 'proposal_source' = 'reactivation_campaign_release_gate'
         AND release_approval.payload ->> 'reactivation_kind' =
           manifest.summary ->> 'reactivation_kind'
         AND release_approval.payload ->> 'manifest_id' = manifest.id::text
         AND release_approval.payload ->> 'source_execution_job_id' =
           manifest.source_execution_job_id::text
         AND release_approval.payload ->> 'audience_fingerprint' =
           manifest.audience_fingerprint
         AND release_approval.payload ->> 'message_sha256' = manifest.message_sha256
         AND release_approval.payload ->> 'dispatch_enabled' = 'false'
         AND release_approval.payload ->> 'no_messages_sent' = 'true'
         AND source_job.status = 'waiting_input'
         AND source_job.payload ->> 'proposal_source' = 'reactivation_campaign'
         AND source_job.payload ->> 'reactivation_kind' =
           manifest.summary ->> 'reactivation_kind'
         AND source_job.payload ->> 'dispatch_enabled' = 'false'
         AND source_job.payload ->> 'no_messages_sent' = 'true'
         AND source_job.result ->> 'dispatch_enabled' = 'false'
         AND source_job.result ->> 'no_messages_sent' = 'true'
         AND source_approval.status = 'approved'
         AND source_approval.decided_at IS NOT NULL
         AND source_approval.expires_at > v_now
         AND source_approval.payload ->> 'proposal_source' = 'reactivation_campaign'
         AND source_approval.payload ->> 'reactivation_kind' =
           manifest.summary ->> 'reactivation_kind'
         AND source_approval.payload ->> 'dispatch_enabled' = 'false'
         AND source_approval.payload ->> 'no_messages_sent' = 'true'
         AND ((v_delivery.channel = 'sms' AND decision.sms AND recipient.sms)
           OR (v_delivery.channel = 'email' AND decision.email AND recipient.email))
    ) THEN
      UPDATE public.reactivation_campaign_deliveries SET
        status = 'suppressed', suppression_reason = 'source_contract_changed',
        completed_at = v_now, updated_at = v_now
      WHERE id = v_delivery.id;
      RETURN NEXT jsonb_build_object('success', false, 'code', 'suppressed',
        'delivery_id', v_delivery.id, 'reason', 'source_contract_changed');
      CONTINUE;
    END IF;

    v_guard := public.evaluate_reactivation_campaign_delivery_guard(
      v_delivery.salon_id, v_delivery.client_profile_id, v_delivery.channel
    );
    IF coalesce((v_guard ->> 'allowed')::boolean, false) IS NOT TRUE THEN
      v_reason := coalesce(v_guard ->> 'reason', 'source_contract_changed');
      UPDATE public.reactivation_campaign_deliveries SET
        status = 'suppressed', suppression_reason = v_reason,
        completed_at = v_now, updated_at = v_now
      WHERE id = v_delivery.id;
      RETURN NEXT jsonb_build_object('success', false, 'code', 'suppressed',
        'delivery_id', v_delivery.id, 'reason', v_reason);
      CONTINUE;
    END IF;

    IF v_guard ->> 'contact_fingerprint' <> v_delivery.contact_fingerprint THEN
      v_reason := 'contact_changed';
    ELSIF v_guard ->> 'preference_fingerprint' <> v_delivery.preference_fingerprint THEN
      v_reason := 'preference_changed';
    ELSE
      v_expected_payload := encode(extensions.digest(convert_to(concat_ws('|',
        'reactivation-payload-v1', v_delivery.id::text,
        v_delivery.plan_fingerprint, v_delivery.preflight_fingerprint,
        v_delivery.source_material_fingerprint, v_delivery.material_fingerprint,
        v_delivery.contact_fingerprint, v_delivery.preference_fingerprint,
        v_delivery.recipient_fingerprint), 'UTF8'), 'sha256'), 'hex');
      IF v_expected_payload <> v_delivery.payload_fingerprint THEN
        v_reason := 'material_changed';
      END IF;
    END IF;
    IF v_reason IS NOT NULL THEN
      UPDATE public.reactivation_campaign_deliveries SET
        status = 'suppressed', suppression_reason = v_reason,
        completed_at = v_now, updated_at = v_now
      WHERE id = v_delivery.id;
      RETURN NEXT jsonb_build_object('success', false, 'code', 'suppressed',
        'delivery_id', v_delivery.id, 'reason', v_reason);
      CONTINUE;
    END IF;

    SELECT auth_row.* INTO v_authorization
      FROM public.reactivation_campaign_dispatch_authorizations AS auth_row
     WHERE auth_row.delivery_id = v_delivery.id
       AND auth_row.salon_id = v_delivery.salon_id
       AND auth_row.dispatch_plan_id = v_delivery.dispatch_plan_id
       AND auth_row.plan_fingerprint = v_delivery.plan_fingerprint
       AND auth_row.source_material_fingerprint = v_delivery.source_material_fingerprint
       AND auth_row.material_fingerprint = v_delivery.material_fingerprint
       AND auth_row.payload_fingerprint = v_delivery.payload_fingerprint
       AND auth_row.contact_fingerprint = v_delivery.contact_fingerprint
       AND auth_row.preference_fingerprint = v_delivery.preference_fingerprint
       AND auth_row.recipient_fingerprint = v_delivery.recipient_fingerprint
       AND auth_row.authorized_at <= v_now
       AND auth_row.expires_at > v_now
       AND auth_row.expires_at <= v_delivery.plan_expires_at;
    IF NOT FOUND THEN
      RETURN NEXT jsonb_build_object('success', false,
        'code', 'dispatch_not_authorized', 'delivery_id', v_delivery.id,
        'provider_ready', false);
      CONTINUE;
    END IF;

    v_expected_authorization := encode(extensions.digest(convert_to(concat_ws('|',
      'reactivation-dispatch-authorization-v1', v_authorization.delivery_id::text,
      v_authorization.salon_id::text, v_authorization.dispatch_plan_id::text,
      v_authorization.plan_fingerprint,
      v_authorization.source_material_fingerprint,
      v_authorization.material_fingerprint, v_authorization.payload_fingerprint,
      v_authorization.contact_fingerprint,
      v_authorization.preference_fingerprint,
      v_authorization.recipient_fingerprint,
      v_authorization.authorized_at::text, v_authorization.expires_at::text
    ), 'UTF8'), 'sha256'), 'hex');
    IF v_authorization.authorization_fingerprint <> v_expected_authorization THEN
      RETURN NEXT jsonb_build_object('success', false,
        'code', 'dispatch_not_authorized', 'delivery_id', v_delivery.id,
        'provider_ready', false);
      CONTINUE;
    END IF;

    v_token := extensions.gen_random_uuid();
    UPDATE public.reactivation_campaign_deliveries SET
      status = 'leased', attempt_count = 1,
      lease_token_hash = encode(extensions.digest(
        convert_to(v_token::text, 'UTF8'), 'sha256'), 'hex'),
      leased_at = v_now,
      lease_expires_at = least(v_now + interval '5 minutes',
        v_authorization.expires_at, plan_expires_at),
      updated_at = v_now
    WHERE id = v_delivery.id;

    INSERT INTO public.ai_actions_log (
      salon_id, agent, action_type, target_id, payload, created_at
    ) VALUES (
      v_delivery.salon_id, 'execution_worker',
      'reactivation_delivery_claimed', v_delivery.id,
      jsonb_build_object(
        'dispatch_plan_id', v_delivery.dispatch_plan_id,
        'channel', v_delivery.channel,
        'attempt_count', 1,
        'payload_fingerprint', v_delivery.payload_fingerprint,
        'recipient_fingerprint', v_delivery.recipient_fingerprint,
        'provider_ready', false
      ), v_now
    );

    -- No destination or message material is returned. Parent evidence locks
    -- end with this RPC transaction, so a future sender must add an immutable
    -- evidence freeze plus a final under-lock recheck before loading transient
    -- material. That enablement surface deliberately does not exist here.
    RETURN NEXT jsonb_build_object(
      'success', true, 'code', 'delivery_claimed',
      'delivery_id', v_delivery.id, 'attempt_token', v_token,
      'attempt_count', 1, 'salon_id', v_delivery.salon_id,
      'channel', v_delivery.channel,
      'material_fingerprint', v_delivery.material_fingerprint,
      'payload_fingerprint', v_delivery.payload_fingerprint,
      'recipient_fingerprint', v_delivery.recipient_fingerprint,
      'lease_expires_at', least(v_now + interval '5 minutes',
        v_authorization.expires_at, v_delivery.plan_expires_at),
      'provider_ready', false
    );
  END LOOP;
END;
$claim$;

CREATE FUNCTION public.complete_reactivation_campaign_delivery(
  p_delivery_id uuid,
  p_attempt_token uuid,
  p_outcome text,
  p_provider_name text,
  p_provider_receipt_fingerprint text,
  p_error_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $complete$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_delivery public.reactivation_campaign_deliveries%ROWTYPE;
  v_token_hash text;
  v_completion text;
  v_receipt_hex text;
  v_receipt_token uuid;
BEGIN
  IF NOT public.reactivation_campaign_delivery_caller_is_service_role() THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_delivery_id IS NULL OR p_attempt_token IS NULL
     OR p_outcome NOT IN ('provider_accepted', 'failed_pre_acceptance', 'unknown')
     OR (p_provider_name IS NOT NULL
       AND p_provider_name NOT IN ('sms_provider', 'email_provider'))
     OR (p_provider_receipt_fingerprint IS NOT NULL
       AND p_provider_receipt_fingerprint !~ '^[0-9a-f]{64}$')
     OR (p_error_code IS NOT NULL AND p_error_code NOT IN (
       'provider_rejected_pre_acceptance', 'invalid_recipient',
       'consent_revoked', 'channel_disabled', 'material_rejected',
       'provider_unavailable_pre_acceptance',
       'provider_rate_limited_pre_acceptance',
       'provider_outcome_unknown', 'transport_timeout', 'provider_exception',
       'completion_write_uncertain'
     )) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_completion');
  END IF;
  IF p_outcome = 'provider_accepted' AND (
    p_provider_name IS NULL OR p_provider_receipt_fingerprint IS NULL
    OR p_error_code IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_acceptance_receipt');
  END IF;
  IF p_outcome <> 'provider_accepted' AND (
    p_provider_receipt_fingerprint IS NOT NULL OR p_error_code IS NULL
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_terminal_outcome');
  END IF;
  IF p_outcome = 'failed_pre_acceptance' AND p_error_code NOT IN (
    'provider_rejected_pre_acceptance', 'invalid_recipient',
    'consent_revoked', 'channel_disabled', 'material_rejected',
    'provider_unavailable_pre_acceptance',
    'provider_rate_limited_pre_acceptance'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_failure_code');
  END IF;
  IF p_outcome = 'unknown' AND p_error_code NOT IN (
    'provider_outcome_unknown', 'transport_timeout', 'provider_exception',
    'completion_write_uncertain'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_unknown_code');
  END IF;

  SELECT delivery.* INTO v_delivery
    FROM public.reactivation_campaign_deliveries AS delivery
   WHERE delivery.id = p_delivery_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'delivery_not_found');
  END IF;
  IF p_provider_name IS NOT NULL AND (
    (v_delivery.channel = 'sms' AND p_provider_name <> 'sms_provider')
    OR (v_delivery.channel = 'email' AND p_provider_name <> 'email_provider')
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_completion');
  END IF;
  v_token_hash := encode(extensions.digest(
    convert_to(p_attempt_token::text, 'UTF8'), 'sha256'), 'hex');
  IF v_delivery.lease_token_hash <> v_token_hash THEN
    RETURN jsonb_build_object('success', false, 'code', 'stale_attempt');
  END IF;

  v_completion := encode(extensions.digest(convert_to(concat_ws('|',
    'reactivation-completion-v1', p_outcome,
    coalesce(p_provider_name, ''),
    coalesce(p_provider_receipt_fingerprint, ''),
    coalesce(p_error_code, '')), 'UTF8'), 'sha256'), 'hex');
  v_receipt_hex := encode(extensions.digest(convert_to(
    'reactivation-delivery-receipt-v1|' || p_attempt_token::text,
    'UTF8'), 'sha256'), 'hex');
  v_receipt_token := (
    substr(v_receipt_hex, 1, 8) || '-' || substr(v_receipt_hex, 9, 4) || '-' ||
    substr(v_receipt_hex, 13, 4) || '-' || substr(v_receipt_hex, 17, 4) || '-' ||
    substr(v_receipt_hex, 21, 12)
  )::uuid;

  IF v_delivery.status <> 'leased' THEN
    IF v_delivery.completion_fingerprint = v_completion THEN
      RETURN jsonb_build_object('success', true, 'code', 'already_completed',
        'delivery_id', v_delivery.id, 'status', v_delivery.status,
        'delivery_receipt_token',
          CASE WHEN v_delivery.status = 'provider_accepted'
            THEN v_receipt_token ELSE NULL END);
    END IF;
    RETURN jsonb_build_object('success', false, 'code', 'completion_conflict');
  END IF;

  IF v_delivery.lease_expires_at <= v_now THEN
    UPDATE public.reactivation_campaign_deliveries SET
      status = 'unknown', error_code = 'lease_expired_outcome_unknown',
      completion_fingerprint = encode(extensions.digest(convert_to(
        'reactivation-completion-v1|unknown|||lease_expired_outcome_unknown',
        'UTF8'), 'sha256'), 'hex'),
      completed_at = v_now, updated_at = v_now
    WHERE id = v_delivery.id;
    RETURN jsonb_build_object('success', false, 'code', 'lease_expired_unknown',
      'retry_allowed', false);
  END IF;

  IF p_outcome = 'provider_accepted' THEN
    INSERT INTO public.reactivation_campaign_delivery_receipts (
      delivery_id, salon_id, receipt_kind, provider_name,
      provider_receipt_fingerprint, callback_auth_fingerprint,
      event_at, created_at
    ) VALUES (
      v_delivery.id, v_delivery.salon_id, 'provider_accepted', p_provider_name,
      p_provider_receipt_fingerprint, NULL, v_now, v_now
    ) ON CONFLICT ON CONSTRAINT
      reactivation_campaign_delivery_receipts_kind_once DO NOTHING;

    UPDATE public.reactivation_campaign_deliveries SET
      status = 'provider_accepted', provider_name = p_provider_name,
      provider_accepted_at = v_now,
      delivery_receipt_token_hash = encode(extensions.digest(
        convert_to(v_receipt_token::text, 'UTF8'), 'sha256'), 'hex'),
      completion_fingerprint = v_completion,
      completed_at = v_now, updated_at = v_now
    WHERE id = v_delivery.id;
  ELSIF p_outcome = 'failed_pre_acceptance' THEN
    UPDATE public.reactivation_campaign_deliveries SET
      status = 'failed', error_code = p_error_code,
      completion_fingerprint = v_completion,
      completed_at = v_now, updated_at = v_now
    WHERE id = v_delivery.id;
  ELSE
    UPDATE public.reactivation_campaign_deliveries SET
      status = 'unknown', error_code = p_error_code,
      completion_fingerprint = v_completion,
      completed_at = v_now, updated_at = v_now
    WHERE id = v_delivery.id;
  END IF;

  INSERT INTO public.ai_actions_log (
    salon_id, agent, action_type, target_id, payload, created_at
  ) VALUES (
    v_delivery.salon_id, 'execution_worker',
    'reactivation_delivery_completed', v_delivery.id,
    jsonb_build_object(
      'outcome', p_outcome,
      'provider_name', p_provider_name,
      'provider_receipt_fingerprint', p_provider_receipt_fingerprint,
      'error_code', p_error_code,
      'retry_allowed', false
    ), v_now
  );

  RETURN jsonb_build_object('success', true, 'code', 'completed',
    'delivery_id', v_delivery.id,
    'status', CASE p_outcome WHEN 'failed_pre_acceptance' THEN 'failed'
      ELSE p_outcome END,
    'delivery_receipt_token', CASE WHEN p_outcome = 'provider_accepted'
      THEN v_receipt_token ELSE NULL END,
    'retry_allowed', false);
END;
$complete$;

CREATE FUNCTION public.record_reactivation_campaign_delivery_receipt(
  p_delivery_id uuid,
  p_delivery_receipt_token uuid,
  p_provider_name text,
  p_provider_receipt_fingerprint text,
  p_delivered_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $receipt$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_delivery public.reactivation_campaign_deliveries%ROWTYPE;
  v_callback_fingerprint text;
BEGIN
  IF NOT public.reactivation_campaign_delivery_caller_is_service_role() THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_delivery_id IS NULL OR p_delivery_receipt_token IS NULL
     OR p_provider_name NOT IN ('sms_provider', 'email_provider')
     OR coalesce(p_provider_receipt_fingerprint, '') !~ '^[0-9a-f]{64}$'
     OR p_delivered_at IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_receipt');
  END IF;

  SELECT delivery.* INTO v_delivery
    FROM public.reactivation_campaign_deliveries AS delivery
   WHERE delivery.id = p_delivery_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'delivery_not_found');
  END IF;
  v_callback_fingerprint := encode(extensions.digest(
    convert_to(p_delivery_receipt_token::text, 'UTF8'), 'sha256'), 'hex');
  IF v_delivery.status = 'delivered' THEN
    IF EXISTS (
      SELECT 1 FROM public.reactivation_campaign_delivery_receipts AS receipt
       WHERE receipt.delivery_id = v_delivery.id
         AND receipt.receipt_kind = 'delivered'
         AND receipt.provider_name = p_provider_name
         AND receipt.provider_receipt_fingerprint = p_provider_receipt_fingerprint
         AND receipt.callback_auth_fingerprint = v_callback_fingerprint
         AND receipt.event_at = p_delivered_at
    ) THEN
      RETURN jsonb_build_object('success', true, 'code', 'already_recorded',
        'delivery_id', v_delivery.id, 'status', 'delivered');
    END IF;
    RETURN jsonb_build_object('success', false, 'code', 'receipt_conflict');
  END IF;
  IF v_delivery.status <> 'provider_accepted'
     OR v_delivery.provider_name <> p_provider_name
     OR v_delivery.delivery_receipt_token_hash <> v_callback_fingerprint THEN
    RETURN jsonb_build_object('success', false, 'code', 'receipt_not_authorized');
  END IF;
  IF p_delivered_at < v_delivery.provider_accepted_at
     OR p_delivered_at > v_delivery.provider_accepted_at + interval '7 days'
     OR p_delivered_at > v_now + interval '5 minutes'
     OR v_now > v_delivery.provider_accepted_at + interval '7 days 5 minutes' THEN
    RETURN jsonb_build_object('success', false, 'code', 'receipt_out_of_window');
  END IF;

  INSERT INTO public.reactivation_campaign_delivery_receipts (
    delivery_id, salon_id, receipt_kind, provider_name,
    provider_receipt_fingerprint, callback_auth_fingerprint,
    event_at, created_at
  ) VALUES (
    v_delivery.id, v_delivery.salon_id, 'delivered', p_provider_name,
    p_provider_receipt_fingerprint, v_callback_fingerprint,
    p_delivered_at, v_now
  ) ON CONFLICT ON CONSTRAINT
    reactivation_campaign_delivery_receipts_kind_once DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'receipt_conflict');
  END IF;

  UPDATE public.reactivation_campaign_deliveries SET
    status = 'delivered', delivered_at = p_delivered_at,
    delivery_receipt_token_hash = NULL,
    completed_at = p_delivered_at, updated_at = v_now
  WHERE id = v_delivery.id;

  INSERT INTO public.ai_actions_log (
    salon_id, agent, action_type, target_id, payload, created_at
  ) VALUES (
    v_delivery.salon_id, 'provider_receipt',
    'reactivation_delivery_receipt_recorded', v_delivery.id,
    jsonb_build_object(
      'provider_name', p_provider_name,
      'provider_receipt_fingerprint', p_provider_receipt_fingerprint,
      'callback_auth_fingerprint', v_callback_fingerprint,
      'receipt_kind', 'delivered'
    ), v_now
  );

  RETURN jsonb_build_object('success', true, 'code', 'recorded',
    'delivery_id', v_delivery.id, 'status', 'delivered');
END;
$receipt$;

CREATE FUNCTION public.reconcile_stale_reactivation_campaign_deliveries(
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $reconcile$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_limit integer := least(greatest(coalesce(p_limit, 0), 0), 500);
  v_unknown integer := 0;
  v_suppressed integer := 0;
BEGIN
  IF NOT public.reactivation_campaign_delivery_caller_is_service_role() THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF v_limit < 1 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_limit');
  END IF;

  WITH stale AS (
    SELECT delivery.id
      FROM public.reactivation_campaign_deliveries AS delivery
     WHERE delivery.status = 'leased'
       AND delivery.lease_expires_at <= v_now
     ORDER BY delivery.lease_expires_at, delivery.id
     FOR UPDATE SKIP LOCKED
     LIMIT v_limit
  ), updated AS (
    UPDATE public.reactivation_campaign_deliveries AS delivery SET
      status = 'unknown', error_code = 'stale_lease_outcome_unknown',
      completion_fingerprint = encode(extensions.digest(convert_to(
        'reactivation-completion-v1|unknown|||stale_lease_outcome_unknown',
        'UTF8'), 'sha256'), 'hex'),
      completed_at = v_now, updated_at = v_now
    FROM stale WHERE delivery.id = stale.id
    RETURNING delivery.id
  ) SELECT count(*)::integer INTO v_unknown FROM updated;

  WITH expired AS (
    SELECT delivery.id
      FROM public.reactivation_campaign_deliveries AS delivery
     WHERE delivery.status IN ('awaiting_material', 'awaiting_authorization')
       AND delivery.plan_expires_at <= v_now
     ORDER BY delivery.plan_expires_at, delivery.id
     FOR UPDATE SKIP LOCKED
     LIMIT greatest(v_limit - v_unknown, 0)
  ), updated AS (
    UPDATE public.reactivation_campaign_deliveries AS delivery SET
      status = 'suppressed', suppression_reason = 'plan_expired',
      completed_at = v_now, updated_at = v_now
    FROM expired WHERE delivery.id = expired.id
    RETURNING delivery.id
  ) SELECT count(*)::integer INTO v_suppressed FROM updated;

  RETURN jsonb_build_object('success', true, 'code', 'reconciled',
    'unknown_count', v_unknown, 'suppressed_count', v_suppressed,
    'retry_allowed', false);
END;
$reconcile$;

REVOKE ALL ON FUNCTION public.reactivation_campaign_delivery_caller_is_service_role()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.evaluate_reactivation_campaign_delivery_guard(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.validate_reactivation_campaign_dispatch_authorization()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reject_reactivation_campaign_evidence_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.materialize_reactivation_campaign_deliveries(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bind_reactivation_campaign_delivery_material(
  uuid, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_reactivation_campaign_deliveries(integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.complete_reactivation_campaign_delivery(
  uuid, uuid, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_reactivation_campaign_delivery_receipt(
  uuid, uuid, text, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reconcile_stale_reactivation_campaign_deliveries(integer)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.materialize_reactivation_campaign_deliveries(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_reactivation_campaign_delivery_material(
  uuid, text, text, text, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_reactivation_campaign_deliveries(integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_reactivation_campaign_delivery(
  uuid, uuid, text, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_reactivation_campaign_delivery_receipt(
  uuid, uuid, text, text, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_reactivation_campaign_deliveries(integer)
  TO service_role;

COMMENT ON TABLE public.reactivation_campaign_deliveries IS
  'PII-free reactivation delivery state. Candidate/material rows are not dispatch authorization.';
COMMENT ON TABLE public.reactivation_campaign_dispatch_authorizations IS
  'Immutable exact dispatch authorization. No service-role/browser grant or creation RPC exists in this migration.';
COMMENT ON TABLE public.reactivation_campaign_delivery_receipts IS
  'Immutable hash-only provider acceptance and separately authenticated delivery evidence.';
COMMENT ON FUNCTION public.claim_reactivation_campaign_deliveries(integer) IS
  'Rechecks exact source, tenant, consent, destination and control-plane state; without external DB-owner authorization it cannot lease.';
