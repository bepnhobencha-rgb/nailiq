-- MQA-0102 durable NailIQ-side SMS STOP/START suppression.
--
-- Twilio's carrier/provider block list remains authoritative for delivery, but
-- NailIQ must also remember the same consent transition so every outbound path
-- can suppress before provider dispatch. Raw customer phone numbers and inbound
-- message bodies are never persisted here. The only customer key is a keyed
-- HMAC of the canonical phone number.

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS sms_consent_hash_secret text,
  ADD COLUMN IF NOT EXISTS sms_consent_hash_key_id uuid;

ALTER TABLE public.platform_settings
  DROP CONSTRAINT IF EXISTS platform_settings_sms_consent_hash_key_check;
ALTER TABLE public.platform_settings
  ADD CONSTRAINT platform_settings_sms_consent_hash_key_check CHECK (
    (sms_consent_hash_secret IS NULL AND sms_consent_hash_key_id IS NULL)
    OR (
      sms_consent_hash_secret IS NOT NULL
      AND sms_consent_hash_key_id IS NOT NULL
      AND length(sms_consent_hash_secret) BETWEEN 32 AND 512
    )
  ) NOT VALID;

COMMENT ON COLUMN public.platform_settings.sms_consent_hash_secret IS
  'Service-only stable HMAC key for canonical SMS recipient hashes; provision outside migrations and rotate only through an explicit rehash rollout.';
COMMENT ON COLUMN public.platform_settings.sms_consent_hash_key_id IS
  'Non-secret identifier for the active SMS consent HMAC key.';

-- The folded baseline historically granted broad table privileges and relied
-- on a deny-all RLS policy. New columns inherit those table privileges, so do
-- not leave the HMAC credential dependent on RLS as its only boundary.
REVOKE ALL ON TABLE public.platform_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.platform_settings TO service_role;

CREATE TABLE public.sms_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  scope_kind text NOT NULL CHECK (
    scope_kind IN ('provider_sender', 'salon')
  ),
  event_kind text NOT NULL CHECK (
    event_kind IN ('provider_stop', 'provider_start',
                   'salon_suppress', 'salon_restore')
  ),
  source text NOT NULL CHECK (
    source IN ('twilio_webhook', 'twilio_event_stream', 'salon_service')
  ),
  origin_salon_id uuid REFERENCES public.salons(id) ON DELETE RESTRICT,
  provider text NOT NULL DEFAULT 'twilio' CHECK (provider = 'twilio'),
  provider_account_fingerprint text NOT NULL CHECK (
    provider_account_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  sender_fingerprint text NOT NULL CHECK (
    sender_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  phone_hash text NOT NULL CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  hash_key_id uuid NOT NULL,
  provider_event_id text,
  provider_message_sid text,
  occurred_at timestamptz NOT NULL,
  material_fingerprint text NOT NULL CHECK (
    material_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  status text NOT NULL DEFAULT 'claimed' CHECK (
    status IN ('claimed', 'applied')
  ),
  result_json jsonb,
  claimed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT sms_consent_events_scope_shape_check CHECK (
    (
      scope_kind = 'provider_sender'
      AND event_kind IN ('provider_stop', 'provider_start')
      AND source IN ('twilio_webhook', 'twilio_event_stream')
      AND provider_event_id IS NOT NULL
      AND length(provider_event_id) BETWEEN 1 AND 128
      AND provider_event_id ~ '^[A-Za-z0-9:_-]+$'
      AND provider_message_sid IS NOT NULL
      AND provider_message_sid ~ '^(SM|MM)[0-9A-Fa-f]{32}$'
    )
    OR (
      scope_kind = 'salon'
      AND event_kind IN ('salon_suppress', 'salon_restore')
      AND source = 'salon_service'
      AND origin_salon_id IS NOT NULL
      AND provider_event_id IS NULL
      AND provider_message_sid IS NULL
    )
  ),
  CONSTRAINT sms_consent_events_result_shape_check CHECK (
    (status = 'claimed' AND result_json IS NULL AND applied_at IS NULL)
    OR (status = 'applied' AND result_json IS NOT NULL AND applied_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX sms_consent_events_provider_event_once
  ON public.sms_consent_events(provider, provider_event_id)
  WHERE scope_kind = 'provider_sender';
CREATE INDEX sms_consent_events_claimed_idx
  ON public.sms_consent_events(claimed_at, id)
  WHERE status = 'claimed';
CREATE INDEX sms_consent_events_phone_audit_idx
  ON public.sms_consent_events(hash_key_id, phone_hash, occurred_at DESC, id);
CREATE INDEX sms_consent_events_origin_salon_idx
  ON public.sms_consent_events(origin_salon_id, occurred_at DESC, id)
  WHERE origin_salon_id IS NOT NULL;

CREATE TABLE public.sms_consent_provider_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'twilio' CHECK (provider = 'twilio'),
  provider_account_fingerprint text NOT NULL CHECK (
    provider_account_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  sender_fingerprint text NOT NULL CHECK (
    sender_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  phone_hash text NOT NULL CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  hash_key_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('suppressed', 'clear')),
  state_epoch bigint NOT NULL DEFAULT 1 CHECK (state_epoch > 0),
  latest_event_id uuid NOT NULL UNIQUE
    REFERENCES public.sms_consent_events(id) ON DELETE RESTRICT,
  latest_event_kind text NOT NULL CHECK (
    latest_event_kind IN ('provider_stop', 'provider_start')
  ),
  latest_provider_event_id text NOT NULL,
  latest_occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (
    provider, provider_account_fingerprint, sender_fingerprint,
    hash_key_id, phone_hash
  )
);

CREATE INDEX sms_consent_provider_states_suppressed_idx
  ON public.sms_consent_provider_states(
    provider_account_fingerprint, sender_fingerprint, hash_key_id, phone_hash
  ) WHERE state = 'suppressed';

CREATE TABLE public.sms_consent_salon_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE RESTRICT,
  phone_hash text NOT NULL CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  hash_key_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('suppressed', 'clear')),
  state_epoch bigint NOT NULL DEFAULT 1 CHECK (state_epoch > 0),
  latest_event_id uuid NOT NULL UNIQUE
    REFERENCES public.sms_consent_events(id) ON DELETE RESTRICT,
  latest_event_kind text NOT NULL CHECK (
    latest_event_kind IN ('salon_suppress', 'salon_restore')
  ),
  latest_occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (salon_id, hash_key_id, phone_hash)
);

CREATE INDEX sms_consent_salon_states_suppressed_idx
  ON public.sms_consent_salon_states(salon_id, hash_key_id, phone_hash)
  WHERE state = 'suppressed';

COMMENT ON TABLE public.sms_consent_events IS
  'PII-minimized durable STOP/START and salon suppression event ledger. Provider event identity and material are exact-replay bound.';
COMMENT ON TABLE public.sms_consent_provider_states IS
  'Provider-sender consent state. A Twilio STOP suppresses the recipient across every NailIQ salon using the same account/sender; START clears only this provider scope.';
COMMENT ON TABLE public.sms_consent_salon_states IS
  'Salon-specific suppression state. Provider START never clears an independent salon suppression.';

ALTER TABLE public.sms_consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_consent_provider_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_consent_salon_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY sms_consent_events_service_only
  ON public.sms_consent_events
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY sms_consent_provider_states_service_only
  ON public.sms_consent_provider_states
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY sms_consent_salon_states_service_only
  ON public.sms_consent_salon_states
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.sms_consent_events
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.sms_consent_provider_states
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.sms_consent_salon_states
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.sms_consent_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.sms_consent_provider_states TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.sms_consent_salon_states TO service_role;

CREATE OR REPLACE FUNCTION public.sms_consent_provider_context()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_settings public.platform_settings%ROWTYPE;
  v_account text;
  v_sender text;
BEGIN
  SELECT ps.* INTO v_settings
  FROM public.platform_settings AS ps
  WHERE ps.id = 'platform';

  v_account := pg_catalog.upper(pg_catalog.btrim(
    coalesce(v_settings.twilio_account_sid, '')
  ));
  v_sender := public.canonical_phone(v_settings.twilio_phone_number);

  IF v_account !~ '^AC[0-9A-F]{32}$'
     OR v_sender IS NULL
     OR v_sender !~ '^[0-9]{7,15}$'
     OR v_settings.sms_consent_hash_secret IS NULL
     OR v_settings.sms_consent_hash_key_id IS NULL
     OR length(v_settings.sms_consent_hash_secret) NOT BETWEEN 32 AND 512
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'sms_consent_not_configured',
      'contract_version', 1
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'code', 'loaded',
    'contract_version', 1,
    'provider', 'twilio',
    'provider_account_fingerprint', encode(extensions.digest(
      pg_catalog.convert_to(v_account, 'UTF8'), 'sha256'
    ), 'hex'),
    'sender_fingerprint', encode(extensions.digest(
      pg_catalog.convert_to(v_sender, 'UTF8'), 'sha256'
    ), 'hex'),
    'hash_key_id', v_settings.sms_consent_hash_key_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.hash_sms_consent_phone(p_phone text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_settings public.platform_settings%ROWTYPE;
  v_phone text := public.canonical_phone(p_phone);
BEGIN
  IF v_phone IS NULL OR v_phone !~ '^[0-9]{7,15}$' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'invalid_phone', 'contract_version', 1
    );
  END IF;

  SELECT ps.* INTO v_settings
  FROM public.platform_settings AS ps
  WHERE ps.id = 'platform';

  IF v_settings.sms_consent_hash_secret IS NULL
     OR v_settings.sms_consent_hash_key_id IS NULL
     OR length(v_settings.sms_consent_hash_secret) NOT BETWEEN 32 AND 512
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'sms_consent_not_configured',
      'contract_version', 1
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'code', 'hashed',
    'contract_version', 1,
    'hash_key_id', v_settings.sms_consent_hash_key_id,
    'phone_hash', encode(extensions.hmac(
      pg_catalog.convert_to(v_phone, 'UTF8'),
      pg_catalog.convert_to(v_settings.sms_consent_hash_secret, 'UTF8'),
      'sha256'
    ), 'hex')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_sms_consent_event(
  p_request_id uuid,
  p_scope_kind text,
  p_event_kind text,
  p_source text,
  p_origin_salon_id uuid,
  p_phone_hash text,
  p_hash_key_id uuid,
  p_provider_account_fingerprint text,
  p_sender_fingerprint text,
  p_provider_event_id text,
  p_provider_message_sid text,
  p_occurred_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_context jsonb := public.sms_consent_provider_context();
  v_existing public.sms_consent_events%ROWTYPE;
  v_event public.sms_consent_events%ROWTYPE;
  v_account_fp text;
  v_sender_fp text;
  v_effective_occurred_at timestamptz;
  v_expected_material_fingerprint text;
BEGIN
  -- Validate immutable envelope shape before looking up replay. Time freshness
  -- and live provider configuration are intentionally checked only for a new
  -- event so a committed webhook replay survives config/key drift.
  IF p_request_id IS NULL
     OR p_scope_kind IS NULL
     OR p_scope_kind NOT IN ('provider_sender', 'salon')
     OR p_event_kind IS NULL
     OR p_event_kind NOT IN (
       'provider_stop', 'provider_start', 'salon_suppress', 'salon_restore'
     )
     OR p_source IS NULL
     OR p_source NOT IN (
       'twilio_webhook', 'twilio_event_stream', 'salon_service'
     )
     OR p_phone_hash IS NULL
     OR p_phone_hash !~ '^[0-9a-f]{64}$'
     OR p_hash_key_id IS NULL
     OR p_provider_account_fingerprint IS NULL
     OR p_provider_account_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_sender_fingerprint IS NULL
     OR p_sender_fingerprint !~ '^[0-9a-f]{64}$'
     OR (p_source <> 'twilio_webhook' AND p_occurred_at IS NULL)
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'invalid_request', 'contract_version', 1
    );
  END IF;

  IF (
    p_scope_kind = 'provider_sender'
    AND (
      p_event_kind NOT IN ('provider_stop', 'provider_start')
      OR p_source NOT IN ('twilio_webhook', 'twilio_event_stream')
      OR p_provider_event_id IS NULL
      OR length(p_provider_event_id) NOT BETWEEN 1 AND 128
      OR p_provider_event_id !~ '^[A-Za-z0-9:_-]+$'
      OR p_provider_message_sid IS NULL
      OR p_provider_message_sid !~ '^(SM|MM)[0-9A-Fa-f]{32}$'
    )
  ) OR (
    p_scope_kind = 'salon'
    AND (
      p_event_kind NOT IN ('salon_suppress', 'salon_restore')
      OR p_source <> 'salon_service'
      OR p_origin_salon_id IS NULL
      OR p_provider_event_id IS NOT NULL
      OR p_provider_message_sid IS NOT NULL
    )
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'invalid_scope_material',
      'contract_version', 1
    );
  END IF;

  v_expected_material_fingerprint := encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'contract_version', 1,
      'scope_kind', p_scope_kind,
      'event_kind', p_event_kind,
      'source', p_source,
      'origin_salon_id', p_origin_salon_id,
      'provider', 'twilio',
      'provider_account_fingerprint', p_provider_account_fingerprint,
      'sender_fingerprint', p_sender_fingerprint,
      'phone_hash', p_phone_hash,
      'hash_key_id', p_hash_key_id,
      'provider_event_id', p_provider_event_id,
      'provider_message_sid', p_provider_message_sid,
      'occurred_at', CASE WHEN p_source = 'twilio_webhook'
        THEN NULL ELSE p_occurred_at END
    )::text, 'UTF8'), 'sha256'
  ), 'hex');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'sms-consent-request:' || p_request_id::text, 0
  ));

  SELECT e.* INTO v_existing
  FROM public.sms_consent_events AS e
  WHERE e.request_id = p_request_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.scope_kind IS DISTINCT FROM p_scope_kind
       OR v_existing.event_kind IS DISTINCT FROM p_event_kind
       OR v_existing.source IS DISTINCT FROM p_source
       OR v_existing.origin_salon_id IS DISTINCT FROM p_origin_salon_id
       OR v_existing.phone_hash IS DISTINCT FROM p_phone_hash
       OR v_existing.hash_key_id IS DISTINCT FROM p_hash_key_id
       OR v_existing.provider_account_fingerprint IS DISTINCT FROM
          p_provider_account_fingerprint
       OR v_existing.sender_fingerprint IS DISTINCT FROM p_sender_fingerprint
       OR v_existing.provider_event_id IS DISTINCT FROM p_provider_event_id
       OR v_existing.provider_message_sid IS DISTINCT FROM p_provider_message_sid
       OR (
         p_source <> 'twilio_webhook'
         AND v_existing.occurred_at IS DISTINCT FROM p_occurred_at
       )
       OR v_existing.material_fingerprint IS DISTINCT FROM
          v_expected_material_fingerprint
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false, 'code', 'request_conflict',
        'contract_version', 1, 'event_id', v_existing.id
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'code', CASE WHEN v_existing.status = 'applied'
        THEN 'already_applied' ELSE 'claim_replay' END,
      'contract_version', 1,
      'event_id', v_existing.id,
      'status', v_existing.status,
      'material_fingerprint', v_existing.material_fingerprint,
      'result', v_existing.result_json
    );
  END IF;

  IF p_scope_kind = 'provider_sender' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'sms-consent-provider-event:twilio:' || p_provider_event_id, 0
    ));
    SELECT e.* INTO v_existing
    FROM public.sms_consent_events AS e
    WHERE e.provider = 'twilio'
      AND e.provider_event_id = p_provider_event_id
    FOR UPDATE;
    IF FOUND THEN
      IF v_existing.scope_kind IS DISTINCT FROM p_scope_kind
         OR v_existing.event_kind IS DISTINCT FROM p_event_kind
         OR v_existing.source IS DISTINCT FROM p_source
         OR v_existing.origin_salon_id IS DISTINCT FROM p_origin_salon_id
         OR v_existing.provider_account_fingerprint IS DISTINCT FROM
            p_provider_account_fingerprint
         OR v_existing.sender_fingerprint IS DISTINCT FROM p_sender_fingerprint
         OR v_existing.phone_hash IS DISTINCT FROM p_phone_hash
         OR v_existing.hash_key_id IS DISTINCT FROM p_hash_key_id
         OR v_existing.provider_message_sid IS DISTINCT FROM p_provider_message_sid
         OR (
           p_source <> 'twilio_webhook'
           AND v_existing.occurred_at IS DISTINCT FROM p_occurred_at
         )
         OR v_existing.material_fingerprint IS DISTINCT FROM
            v_expected_material_fingerprint
      THEN
        RETURN pg_catalog.jsonb_build_object(
          'success', false, 'code', 'provider_event_conflict',
          'contract_version', 1, 'event_id', v_existing.id
        );
      END IF;
      RETURN pg_catalog.jsonb_build_object(
        'success', true,
        'code', CASE WHEN v_existing.status = 'applied'
          THEN 'already_applied' ELSE 'provider_event_replay' END,
        'contract_version', 1,
        'event_id', v_existing.id,
        'status', v_existing.status,
        'material_fingerprint', v_existing.material_fingerprint,
        'result', v_existing.result_json
      );
    END IF;
  END IF;

  -- Only a new event depends on current provider configuration and live time
  -- bounds. Exact request/provider-event replay above remains recoverable.
  IF v_context->>'code' <> 'loaded'
     OR (v_context->>'hash_key_id')::uuid IS DISTINCT FROM p_hash_key_id
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'sms_consent_not_configured',
      'contract_version', 1
    );
  END IF;
  v_account_fp := v_context->>'provider_account_fingerprint';
  v_sender_fp := v_context->>'sender_fingerprint';
  IF v_account_fp IS DISTINCT FROM p_provider_account_fingerprint
     OR v_sender_fp IS DISTINCT FROM p_sender_fingerprint
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'provider_context_mismatch',
      'contract_version', 1
    );
  END IF;
  IF p_occurred_at > v_now + interval '5 minutes'
     OR p_occurred_at < v_now - interval '90 days'
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'occurred_at_out_of_bounds',
      'contract_version', 1
    );
  END IF;
  IF p_scope_kind = 'salon' AND NOT EXISTS (
    SELECT 1 FROM public.salons AS s WHERE s.id = p_origin_salon_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'salon_not_found', 'contract_version', 1
    );
  END IF;

  -- The basic Twilio incoming webhook has no immutable provider timestamp.
  -- Bind it to first DB receipt time; provider-event replay recovers that row.
  -- Event Streams and salon actions must supply their authoritative time.
  v_effective_occurred_at := CASE
    WHEN p_source = 'twilio_webhook' THEN v_now ELSE p_occurred_at END;

  INSERT INTO public.sms_consent_events(
    request_id, scope_kind, event_kind, source, origin_salon_id,
    provider, provider_account_fingerprint, sender_fingerprint,
    phone_hash, hash_key_id, provider_event_id, provider_message_sid,
    occurred_at, material_fingerprint
  ) VALUES (
    p_request_id, p_scope_kind, p_event_kind, p_source, p_origin_salon_id,
    'twilio', p_provider_account_fingerprint, p_sender_fingerprint,
    p_phone_hash, p_hash_key_id, p_provider_event_id,
    p_provider_message_sid, v_effective_occurred_at,
    v_expected_material_fingerprint
  ) RETURNING * INTO v_event;

  RETURN pg_catalog.jsonb_build_object(
    'success', true, 'code', 'claimed', 'contract_version', 1,
    'event_id', v_event.id, 'status', v_event.status,
    'material_fingerprint', v_event.material_fingerprint
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_sms_consent_event(
  p_event_id uuid,
  p_request_id uuid,
  p_material_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event public.sms_consent_events%ROWTYPE;
  v_provider_state public.sms_consent_provider_states%ROWTYPE;
  v_salon_state public.sms_consent_salon_states%ROWTYPE;
  v_new_state text;
  v_should_apply boolean;
  v_epoch bigint;
  v_result jsonb;
BEGIN
  IF p_event_id IS NULL OR p_request_id IS NULL
     OR p_material_fingerprint IS NULL
     OR p_material_fingerprint !~ '^[0-9a-f]{64}$'
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'invalid_request', 'contract_version', 1
    );
  END IF;

  SELECT e.* INTO v_event
  FROM public.sms_consent_events AS e
  WHERE e.id = p_event_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'event_not_found', 'contract_version', 1
    );
  END IF;
  IF v_event.request_id IS DISTINCT FROM p_request_id
     OR v_event.material_fingerprint IS DISTINCT FROM p_material_fingerprint
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'event_conflict',
      'contract_version', 1, 'event_id', v_event.id
    );
  END IF;
  IF v_event.status = 'applied' THEN
    RETURN v_event.result_json;
  END IF;

  IF v_event.scope_kind = 'provider_sender' THEN
    v_new_state := CASE WHEN v_event.event_kind = 'provider_stop'
      THEN 'suppressed' ELSE 'clear' END;
    INSERT INTO public.sms_consent_provider_states(
      provider, provider_account_fingerprint, sender_fingerprint,
      phone_hash, hash_key_id, state, latest_event_id,
      latest_event_kind, latest_provider_event_id, latest_occurred_at
    ) VALUES (
      v_event.provider, v_event.provider_account_fingerprint,
      v_event.sender_fingerprint, v_event.phone_hash, v_event.hash_key_id,
      v_new_state, v_event.id, v_event.event_kind,
      v_event.provider_event_id, v_event.occurred_at
    ) ON CONFLICT (
      provider, provider_account_fingerprint, sender_fingerprint,
      hash_key_id, phone_hash
    ) DO NOTHING;

    SELECT s.* INTO v_provider_state
    FROM public.sms_consent_provider_states AS s
    WHERE s.provider = v_event.provider
      AND s.provider_account_fingerprint = v_event.provider_account_fingerprint
      AND s.sender_fingerprint = v_event.sender_fingerprint
      AND s.hash_key_id = v_event.hash_key_id
      AND s.phone_hash = v_event.phone_hash
    FOR UPDATE;

    v_should_apply := v_provider_state.latest_event_id = v_event.id
      OR v_event.occurred_at > v_provider_state.latest_occurred_at
      OR (
        v_event.occurred_at = v_provider_state.latest_occurred_at
        AND v_event.event_kind = 'provider_stop'
        AND v_provider_state.latest_event_kind <> 'provider_stop'
      );
    IF v_should_apply AND v_provider_state.latest_event_id <> v_event.id THEN
      UPDATE public.sms_consent_provider_states AS s SET
        state = v_new_state,
        state_epoch = s.state_epoch + 1,
        latest_event_id = v_event.id,
        latest_event_kind = v_event.event_kind,
        latest_provider_event_id = v_event.provider_event_id,
        latest_occurred_at = v_event.occurred_at,
        updated_at = statement_timestamp()
      WHERE s.id = v_provider_state.id
      RETURNING * INTO v_provider_state;
    END IF;
    v_epoch := v_provider_state.state_epoch;
  ELSE
    v_new_state := CASE WHEN v_event.event_kind = 'salon_suppress'
      THEN 'suppressed' ELSE 'clear' END;
    INSERT INTO public.sms_consent_salon_states(
      salon_id, phone_hash, hash_key_id, state, latest_event_id,
      latest_event_kind, latest_occurred_at
    ) VALUES (
      v_event.origin_salon_id, v_event.phone_hash, v_event.hash_key_id,
      v_new_state, v_event.id, v_event.event_kind, v_event.occurred_at
    ) ON CONFLICT (salon_id, hash_key_id, phone_hash) DO NOTHING;

    SELECT s.* INTO v_salon_state
    FROM public.sms_consent_salon_states AS s
    WHERE s.salon_id = v_event.origin_salon_id
      AND s.hash_key_id = v_event.hash_key_id
      AND s.phone_hash = v_event.phone_hash
    FOR UPDATE;

    v_should_apply := v_salon_state.latest_event_id = v_event.id
      OR v_event.occurred_at > v_salon_state.latest_occurred_at
      OR (
        v_event.occurred_at = v_salon_state.latest_occurred_at
        AND v_event.event_kind = 'salon_suppress'
        AND v_salon_state.latest_event_kind <> 'salon_suppress'
      );
    IF v_should_apply AND v_salon_state.latest_event_id <> v_event.id THEN
      UPDATE public.sms_consent_salon_states AS s SET
        state = v_new_state,
        state_epoch = s.state_epoch + 1,
        latest_event_id = v_event.id,
        latest_event_kind = v_event.event_kind,
        latest_occurred_at = v_event.occurred_at,
        updated_at = statement_timestamp()
      WHERE s.id = v_salon_state.id
      RETURNING * INTO v_salon_state;
    END IF;
    v_epoch := v_salon_state.state_epoch;
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'success', true,
    'code', CASE WHEN v_should_apply THEN 'applied' ELSE 'stale_ignored' END,
    'contract_version', 1,
    'event_id', v_event.id,
    'request_id', v_event.request_id,
    'scope_kind', v_event.scope_kind,
    'event_kind', v_event.event_kind,
    'effective_state', CASE
      WHEN v_event.scope_kind = 'provider_sender' THEN v_provider_state.state
      ELSE v_salon_state.state END,
    'state_epoch', v_epoch,
    'applied_event', v_should_apply
  );

  UPDATE public.sms_consent_events SET
    status = 'applied',
    result_json = v_result,
    applied_at = statement_timestamp(),
    updated_at = statement_timestamp()
  WHERE id = v_event.id;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.inspect_sms_consent_event(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event public.sms_consent_events%ROWTYPE;
BEGIN
  IF p_request_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'invalid_request', 'contract_version', 1
    );
  END IF;
  SELECT e.* INTO v_event
  FROM public.sms_consent_events AS e
  WHERE e.request_id = p_request_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'event_not_found', 'contract_version', 1
    );
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'success', true, 'code', 'loaded', 'contract_version', 1,
    'event_id', v_event.id, 'request_id', v_event.request_id,
    'scope_kind', v_event.scope_kind, 'event_kind', v_event.event_kind,
    'source', v_event.source, 'origin_salon_id', v_event.origin_salon_id,
    'provider', v_event.provider,
    'provider_account_fingerprint', v_event.provider_account_fingerprint,
    'sender_fingerprint', v_event.sender_fingerprint,
    'phone_hash', v_event.phone_hash, 'hash_key_id', v_event.hash_key_id,
    'provider_event_id', v_event.provider_event_id,
    'provider_message_sid', v_event.provider_message_sid,
    'occurred_at', v_event.occurred_at,
    'material_fingerprint', v_event.material_fingerprint,
    'status', v_event.status, 'result', v_event.result_json
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.load_sms_outbound_suppression(
  p_salon_id uuid,
  p_phone_hash text,
  p_hash_key_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_context jsonb := public.sms_consent_provider_context();
  v_salon public.salons%ROWTYPE;
  v_provider_state public.sms_consent_provider_states%ROWTYPE;
  v_salon_state public.sms_consent_salon_states%ROWTYPE;
  v_reason text;
BEGIN
  IF p_salon_id IS NULL OR p_phone_hash IS NULL
     OR p_phone_hash !~ '^[0-9a-f]{64}$'
     OR p_hash_key_id IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'invalid_request', 'contract_version', 1,
      'suppressed', true, 'reason', 'invalid_request',
      'affirmative_consent_not_evaluated', true
    );
  END IF;
  IF v_context->>'code' <> 'loaded'
     OR (v_context->>'hash_key_id')::uuid IS DISTINCT FROM p_hash_key_id
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'sms_consent_not_configured',
      'contract_version', 1, 'suppressed', true,
      'reason', 'provider_context_unavailable',
      'affirmative_consent_not_evaluated', true
    );
  END IF;

  SELECT s.* INTO v_salon
  FROM public.salons AS s
  WHERE s.id = p_salon_id;
  IF NOT FOUND OR v_salon.archived_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'salon_unavailable', 'contract_version', 1,
      'suppressed', true, 'reason', 'salon_unavailable',
      'affirmative_consent_not_evaluated', true
    );
  END IF;
  IF v_salon.sms_outbound_enabled IS NOT TRUE THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', true, 'code', 'suppressed', 'contract_version', 1,
      'suppressed', true, 'reason', 'salon_sms_disabled',
      'affirmative_consent_not_evaluated', true
    );
  END IF;

  SELECT s.* INTO v_provider_state
  FROM public.sms_consent_provider_states AS s
  WHERE s.provider = 'twilio'
    AND s.provider_account_fingerprint =
      v_context->>'provider_account_fingerprint'
    AND s.sender_fingerprint = v_context->>'sender_fingerprint'
    AND s.hash_key_id = p_hash_key_id
    AND s.phone_hash = p_phone_hash;

  SELECT s.* INTO v_salon_state
  FROM public.sms_consent_salon_states AS s
  WHERE s.salon_id = p_salon_id
    AND s.hash_key_id = p_hash_key_id
    AND s.phone_hash = p_phone_hash;

  v_reason := CASE
    WHEN v_provider_state.state = 'suppressed' THEN 'provider_stop'
    WHEN v_salon_state.state = 'suppressed' THEN 'salon_suppression'
    ELSE 'clear'
  END;
  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'code', CASE WHEN v_reason = 'clear' THEN 'clear' ELSE 'suppressed' END,
    'contract_version', 1,
    'suppressed', v_reason <> 'clear',
    'reason', v_reason,
    'scope_kind', CASE
      WHEN v_reason = 'provider_stop' THEN 'provider_sender'
      WHEN v_reason = 'salon_suppression' THEN 'salon'
      ELSE NULL END,
    'provider_state_epoch', v_provider_state.state_epoch,
    'salon_state_epoch', v_salon_state.state_epoch,
    'affirmative_consent_not_evaluated', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sms_consent_provider_context()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.hash_sms_consent_phone(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_sms_consent_event(
  uuid, text, text, text, uuid, text, uuid, text, text,
  text, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_sms_consent_event(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.inspect_sms_consent_event(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.load_sms_outbound_suppression(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.sms_consent_provider_context()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.hash_sms_consent_phone(text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_sms_consent_event(
  uuid, text, text, text, uuid, text, uuid, text, text,
  text, text, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_sms_consent_event(uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.inspect_sms_consent_event(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.load_sms_outbound_suppression(uuid, text, uuid)
  TO service_role;

COMMENT ON FUNCTION public.load_sms_outbound_suppression(uuid, text, uuid) IS
  'Fail-closed suppression decision only. A clear result never replaces the caller requirement to prove affirmative message-specific consent.';
