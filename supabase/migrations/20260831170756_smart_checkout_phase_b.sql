-- Smart Checkout Phase B: durable, provider-neutral pairing and reconciliation.
--
-- This migration never dispatches a payment and stores neither raw webhook
-- bodies/signatures nor card/customer data. Provider signatures are verified
-- by the server adapter before the normalized event reaches the narrow RPC.

ALTER TABLE public.smart_checkout_devices
  ADD COLUMN provider_account_fingerprint text,
  ADD COLUMN last_health_status text,
  ADD COLUMN last_health_checked_at timestamptz,
  ADD CONSTRAINT smart_checkout_devices_account_fingerprint_check CHECK (
    provider_account_fingerprint IS NULL
      OR provider_account_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT smart_checkout_devices_health_status_check CHECK (
    last_health_status IS NULL
      OR last_health_status IN ('online', 'offline', 'unknown')
  );

-- Phase A could have recorded a simulated/legacy `ready` device before an
-- account fingerprint existed. It is not safe to preserve that readiness.
UPDATE public.smart_checkout_devices
SET status = 'unknown', updated_at = clock_timestamp()
WHERE status = 'ready' AND provider_account_fingerprint IS NULL;

ALTER TABLE public.smart_checkout_devices
  ADD CONSTRAINT smart_checkout_devices_ready_binding_check CHECK (
    status <> 'ready' OR provider_account_fingerprint IS NOT NULL
  );

CREATE UNIQUE INDEX smart_checkout_devices_provider_account_device_once
  ON public.smart_checkout_devices (
    provider, provider_account_fingerprint, provider_device_id
  )
  WHERE provider_account_fingerprint IS NOT NULL;

ALTER TABLE public.smart_checkout_sessions
  DROP CONSTRAINT smart_checkout_sessions_status_check,
  DROP CONSTRAINT smart_checkout_sessions_dispatch_check,
  ADD CONSTRAINT smart_checkout_sessions_status_check CHECK (status IN (
    'draft', 'ready_for_review', 'awaiting_customer', 'pending_provider',
    'outcome_unknown', 'partially_paid', 'paid', 'failed', 'cancelled',
    'manual_review'
  )),
  ADD CONSTRAINT smart_checkout_sessions_dispatch_check CHECK (
    provider_requested_at IS NULL OR (
      approved_by IS NOT NULL
      AND approved_at IS NOT NULL
      AND status IN (
        'awaiting_customer', 'pending_provider', 'outcome_unknown',
        'partially_paid', 'paid', 'failed', 'cancelled', 'manual_review'
      )
    )
  ),
  ADD COLUMN reconciliation_attempt_count smallint NOT NULL DEFAULT 0,
  ADD COLUMN reconciliation_max_attempts smallint NOT NULL DEFAULT 5,
  ADD COLUMN reconciliation_attempt_token uuid,
  ADD COLUMN reconciliation_lease_owner text,
  ADD COLUMN reconciliation_lease_expires_at timestamptz,
  ADD COLUMN last_reconcile_at timestamptz,
  ADD COLUMN last_provider_event_at timestamptz,
  ADD COLUMN provider_receipt_id text,
  ADD COLUMN provider_receipt_fingerprint text,
  ADD COLUMN provider_paid_at timestamptz,
  ADD COLUMN manual_review_reason text,
  ADD CONSTRAINT smart_checkout_sessions_reconcile_attempt_check CHECK (
    reconciliation_attempt_count BETWEEN 0 AND reconciliation_max_attempts
      AND reconciliation_max_attempts BETWEEN 1 AND 10
  ),
  ADD CONSTRAINT smart_checkout_sessions_reconcile_lease_check CHECK (
    (reconciliation_attempt_token IS NULL
      AND reconciliation_lease_owner IS NULL
      AND reconciliation_lease_expires_at IS NULL)
    OR (reconciliation_attempt_token IS NOT NULL
      AND length(trim(reconciliation_lease_owner)) BETWEEN 1 AND 100
      AND reconciliation_lease_expires_at IS NOT NULL)
  ),
  ADD CONSTRAINT smart_checkout_sessions_receipt_check CHECK (
    (provider_receipt_id IS NULL
      AND provider_receipt_fingerprint IS NULL
      AND provider_paid_at IS NULL)
    OR (length(trim(provider_receipt_id)) BETWEEN 1 AND 255
      AND provider_receipt_fingerprint ~ '^[0-9a-f]{64}$'
      AND provider_paid_at IS NOT NULL)
  );

-- Phase A never certified live provider collection. Preserve any legacy row
-- that claimed `paid` without Phase B receipt evidence as manual review, not
-- as collected revenue and not as a silent migration failure.
UPDATE public.smart_checkout_sessions
SET status = 'manual_review',
    manual_review_reason = 'legacy_paid_receipt_missing',
    failure_disposition = 'ambiguous',
    error_code = 'legacy_paid_receipt_missing',
    updated_at = clock_timestamp()
WHERE status = 'paid' AND provider_receipt_id IS NULL;

ALTER TABLE public.smart_checkout_sessions
  ADD CONSTRAINT smart_checkout_sessions_paid_receipt_check CHECK (
    status <> 'paid' OR (
      provider_receipt_id IS NOT NULL
      AND provider_receipt_fingerprint IS NOT NULL
      AND provider_paid_at IS NOT NULL
      AND provider_payment_id IS NOT NULL
      AND collected_cents = amount_due_cents
    )
  ),
  ADD CONSTRAINT smart_checkout_sessions_manual_review_check CHECK (
    (status = 'manual_review') = (manual_review_reason IS NOT NULL)
  );

DROP INDEX public.smart_checkout_sessions_reconcile_due;
CREATE INDEX smart_checkout_sessions_reconcile_due
  ON public.smart_checkout_sessions (
    next_reconcile_at, reconciliation_lease_expires_at, created_at, id
  )
  WHERE status IN ('pending_provider', 'outcome_unknown');

CREATE TABLE public.smart_checkout_pairing_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('square', 'stripe')),
  provider_account_fingerprint text NOT NULL CHECK (
    provider_account_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  provider_location_id text CHECK (
    provider_location_id IS NULL
      OR length(trim(provider_location_id)) BETWEEN 1 AND 255
  ),
  device_type text NOT NULL CHECK (device_type IN (
    'square_terminal', 'stripe_terminal', 'tap_to_pay'
  )),
  device_id uuid,
  provider_device_id text CHECK (
    provider_device_id IS NULL
      OR length(trim(provider_device_id)) BETWEEN 1 AND 255
  ),
  provider_pairing_id text CHECK (
    provider_pairing_id IS NULL
      OR length(trim(provider_pairing_id)) BETWEEN 1 AND 255
  ),
  pairing_code_fingerprint text CHECK (
    pairing_code_fingerprint IS NULL
      OR pairing_code_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  label text NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  material_fingerprint text NOT NULL CHECK (
    material_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  provider_idempotency_key text NOT NULL CHECK (
    length(trim(provider_idempotency_key)) BETWEEN 1 AND 255
  ),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'reconciling', 'pending_provider', 'outcome_unknown',
    'ready', 'failed', 'manual_review', 'cancelled'
  )),
  provider_status text CHECK (
    provider_status IS NULL OR length(trim(provider_status)) BETWEEN 1 AND 64
  ),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  attempt_token uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_attempt_at timestamptz,
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'
  ),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT smart_checkout_pairing_provider_type_check CHECK (
    (provider = 'square' AND device_type = 'square_terminal')
    OR (provider = 'stripe' AND device_type IN ('stripe_terminal', 'tap_to_pay'))
  ),
  CONSTRAINT smart_checkout_pairing_lease_check CHECK (
    (attempt_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (attempt_token IS NOT NULL
      AND length(trim(lease_owner)) BETWEEN 1 AND 100
      AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT smart_checkout_pairing_completion_check CHECK (
    (status IN ('ready', 'failed', 'manual_review', 'cancelled'))
      = (completed_at IS NOT NULL)
  ),
  CONSTRAINT smart_checkout_pairing_device_fkey FOREIGN KEY (
    device_id, salon_id, provider
  ) REFERENCES public.smart_checkout_devices (id, salon_id, provider)
    ON DELETE RESTRICT,
  UNIQUE (salon_id, request_id),
  UNIQUE (provider_idempotency_key)
);

CREATE UNIQUE INDEX smart_checkout_pairing_provider_attempt_once
  ON public.smart_checkout_pairing_attempts (
    provider, provider_account_fingerprint, provider_pairing_id
  )
  WHERE provider_pairing_id IS NOT NULL;

CREATE INDEX smart_checkout_pairing_due
  ON public.smart_checkout_pairing_attempts (
    next_attempt_at, lease_expires_at, created_at, id
  )
  WHERE status IN ('queued', 'reconciling', 'pending_provider', 'outcome_unknown');

ALTER TABLE public.smart_checkout_pairing_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smart_checkout_pairing_attempts FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.smart_checkout_pairing_attempts
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.smart_checkout_webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('square', 'stripe')),
  provider_account_fingerprint text NOT NULL CHECK (
    provider_account_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  event_id text NOT NULL CHECK (length(trim(event_id)) BETWEEN 1 AND 255),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z0-9._-]{1,100}$'),
  occurred_at timestamptz NOT NULL,
  signature_verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload_fingerprint text NOT NULL CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  normalized_material_fingerprint text NOT NULL CHECK (
    normalized_material_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  provider_location_id text CHECK (
    provider_location_id IS NULL
      OR length(trim(provider_location_id)) BETWEEN 1 AND 255
  ),
  provider_device_id text CHECK (
    provider_device_id IS NULL
      OR length(trim(provider_device_id)) BETWEEN 1 AND 255
  ),
  provider_checkout_id text CHECK (
    provider_checkout_id IS NULL
      OR length(trim(provider_checkout_id)) BETWEEN 1 AND 255
  ),
  provider_payment_id text CHECK (
    provider_payment_id IS NULL
      OR length(trim(provider_payment_id)) BETWEEN 1 AND 255
  ),
  provider_status text NOT NULL CHECK (
    length(trim(provider_status)) BETWEEN 1 AND 64
  ),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  failure_code text CHECK (
    failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,64}$'
  ),
  processing_status text NOT NULL DEFAULT 'received' CHECK (processing_status IN (
    'received', 'reconciled', 'ignored', 'rejected', 'manual_review'
  )),
  result_code text CHECK (
    result_code IS NULL OR result_code ~ '^[a-z0-9_]{1,64}$'
  ),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT smart_checkout_webhook_session_fkey FOREIGN KEY (
    session_id, salon_id
  ) REFERENCES public.smart_checkout_sessions (id, salon_id)
    ON DELETE RESTRICT,
  CONSTRAINT smart_checkout_webhook_completion_check CHECK (
    (processing_status = 'received' AND completed_at IS NULL AND result_code IS NULL)
    OR (processing_status <> 'received'
      AND completed_at IS NOT NULL AND result_code IS NOT NULL)
  ),
  UNIQUE (provider, provider_account_fingerprint, event_id)
);

CREATE INDEX smart_checkout_webhook_session_events
  ON public.smart_checkout_webhook_inbox (session_id, occurred_at DESC, received_at DESC);

ALTER TABLE public.smart_checkout_webhook_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smart_checkout_webhook_inbox FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.smart_checkout_webhook_inbox
  FROM PUBLIC, anon, authenticated, service_role;

-- Phase B mutations must pass through the narrow RPCs below. Preserve the
-- foundation's service-side SELECT access, but remove every direct write path.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE
  public.smart_checkout_devices,
  public.smart_checkout_sessions,
  public.smart_checkout_lines
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.request_smart_checkout_pairing(
  p_salon_id uuid,
  p_request_id uuid,
  p_provider text,
  p_provider_account_fingerprint text,
  p_provider_location_id text,
  p_device_type text,
  p_provider_device_id text,
  p_provider_pairing_id text,
  p_pairing_code_fingerprint text,
  p_label text,
  p_material_fingerprint text,
  p_provider_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_existing public.smart_checkout_pairing_attempts%ROWTYPE;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_request_id IS NULL
     OR p_provider IS NULL OR p_provider NOT IN ('square', 'stripe')
     OR p_provider_account_fingerprint IS NULL
     OR p_provider_account_fingerprint !~ '^[0-9a-f]{64}$'
     OR (p_provider_location_id IS NOT NULL
       AND length(trim(p_provider_location_id)) NOT BETWEEN 1 AND 255)
     OR p_device_type IS NULL
     OR p_device_type NOT IN ('square_terminal', 'stripe_terminal', 'tap_to_pay')
     OR (p_provider = 'square' AND p_device_type <> 'square_terminal')
     OR (p_provider = 'stripe' AND p_device_type = 'square_terminal')
     OR (p_provider_device_id IS NOT NULL
       AND length(trim(p_provider_device_id)) NOT BETWEEN 1 AND 255)
     OR (p_provider_pairing_id IS NOT NULL
       AND length(trim(p_provider_pairing_id)) NOT BETWEEN 1 AND 255)
     OR (p_pairing_code_fingerprint IS NOT NULL
       AND p_pairing_code_fingerprint !~ '^[0-9a-f]{64}$')
     OR p_label IS NULL OR length(trim(p_label)) NOT BETWEEN 1 AND 100
     OR p_material_fingerprint IS NULL
     OR p_material_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_provider_idempotency_key IS NULL
     OR length(trim(p_provider_idempotency_key)) NOT BETWEEN 1 AND 255 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_pairing_request');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.salons WHERE id = p_salon_id) THEN
    RETURN jsonb_build_object('success', false, 'code', 'salon_not_found');
  END IF;

  SELECT * INTO v_existing
  FROM public.smart_checkout_pairing_attempts
  WHERE (salon_id = p_salon_id AND request_id = p_request_id)
     OR provider_idempotency_key = p_provider_idempotency_key
  ORDER BY (salon_id = p_salon_id AND request_id = p_request_id) DESC
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.salon_id IS DISTINCT FROM p_salon_id
       OR v_existing.request_id IS DISTINCT FROM p_request_id
       OR v_existing.provider IS DISTINCT FROM p_provider
       OR v_existing.provider_account_fingerprint IS DISTINCT FROM p_provider_account_fingerprint
       OR v_existing.provider_location_id IS DISTINCT FROM p_provider_location_id
       OR v_existing.device_type IS DISTINCT FROM p_device_type
       OR v_existing.provider_device_id IS DISTINCT FROM p_provider_device_id
       OR v_existing.provider_pairing_id IS DISTINCT FROM p_provider_pairing_id
       OR v_existing.pairing_code_fingerprint IS DISTINCT FROM p_pairing_code_fingerprint
       OR v_existing.label IS DISTINCT FROM trim(p_label)
       OR v_existing.material_fingerprint IS DISTINCT FROM p_material_fingerprint
       OR v_existing.provider_idempotency_key IS DISTINCT FROM p_provider_idempotency_key THEN
      RETURN jsonb_build_object('success', false, 'code', 'pairing_request_conflict');
    END IF;
    RETURN jsonb_build_object(
      'success', true, 'code', 'pairing_request_replay',
      'pairing_attempt_id', v_existing.id, 'status', v_existing.status
    );
  END IF;

  INSERT INTO public.smart_checkout_pairing_attempts (
    salon_id, request_id, provider, provider_account_fingerprint,
    provider_location_id, device_type, provider_device_id,
    provider_pairing_id, pairing_code_fingerprint, label,
    material_fingerprint, provider_idempotency_key
  ) VALUES (
    p_salon_id, p_request_id, p_provider, p_provider_account_fingerprint,
    nullif(trim(p_provider_location_id), ''), p_device_type,
    nullif(trim(p_provider_device_id), ''), nullif(trim(p_provider_pairing_id), ''),
    p_pairing_code_fingerprint, trim(p_label), p_material_fingerprint,
    trim(p_provider_idempotency_key)
  ) RETURNING * INTO v_existing;

  RETURN jsonb_build_object(
    'success', true, 'code', 'pairing_requested',
    'pairing_attempt_id', v_existing.id, 'status', v_existing.status
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_due_smart_checkout_pairings(
  p_worker_id text,
  p_limit integer DEFAULT 25,
  p_lease_seconds integer DEFAULT 120
) RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_row public.smart_checkout_pairing_attempts%ROWTYPE;
  v_token uuid;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN;
  END IF;
  IF p_worker_id IS NULL OR length(trim(p_worker_id)) NOT BETWEEN 1 AND 100
     OR p_limit NOT BETWEEN 1 AND 100
     OR p_lease_seconds NOT BETWEEN 30 AND 600 THEN
    RAISE EXCEPTION 'invalid pairing claim' USING ERRCODE = '22023';
  END IF;

  UPDATE public.smart_checkout_pairing_attempts
  SET status = 'manual_review', last_error_code = 'pairing_retry_exhausted',
      attempt_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
      completed_at = v_now, updated_at = v_now
  WHERE status IN ('queued', 'reconciling', 'pending_provider', 'outcome_unknown')
    AND attempt_count >= 5
    AND (lease_expires_at IS NULL OR lease_expires_at <= v_now);

  FOR v_row IN
    SELECT p.*
    FROM public.smart_checkout_pairing_attempts p
    WHERE p.status IN ('queued', 'reconciling', 'pending_provider', 'outcome_unknown')
      AND p.attempt_count < 5
      AND p.next_attempt_at <= v_now
      AND (p.lease_expires_at IS NULL OR p.lease_expires_at <= v_now)
    ORDER BY p.next_attempt_at, p.created_at, p.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  LOOP
    v_token := gen_random_uuid();
    UPDATE public.smart_checkout_pairing_attempts
    SET status = 'reconciling', attempt_count = attempt_count + 1,
        attempt_token = v_token, lease_owner = trim(p_worker_id),
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        last_attempt_at = v_now, last_error_code = NULL, updated_at = v_now
    WHERE id = v_row.id
    RETURNING * INTO v_row;

    RETURN NEXT jsonb_build_object(
      'success', true, 'code', 'pairing_claimed',
      'pairing_attempt_id', v_row.id, 'salon_id', v_row.salon_id,
      'provider', v_row.provider,
      'provider_account_fingerprint', v_row.provider_account_fingerprint,
      'provider_location_id', v_row.provider_location_id,
      'provider_pairing_id', v_row.provider_pairing_id,
      'device_id', v_row.device_id,
      'provider_device_id', v_row.provider_device_id,
      'device_type', v_row.device_type, 'label', v_row.label,
      'status', v_row.status,
      'provider_idempotency_key', v_row.provider_idempotency_key,
      'material_fingerprint', v_row.material_fingerprint,
      'attempt_token', v_row.attempt_token,
      'lease_expires_at', v_row.lease_expires_at,
      'attempt_count', v_row.attempt_count
    );
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_smart_checkout_pairing(
  p_pairing_attempt_id uuid,
  p_attempt_token uuid,
  p_outcome text,
  p_provider_pairing_id text,
  p_provider_device_id text,
  p_provider_status text,
  p_failure_code text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_attempt public.smart_checkout_pairing_attempts%ROWTYPE;
  v_device public.smart_checkout_devices%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_delay integer;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_pairing_attempt_id IS NULL OR p_attempt_token IS NULL
     OR p_outcome IS NULL
     OR p_outcome NOT IN ('ready', 'pending_provider', 'outcome_unknown',
       'definite_failure', 'manual_review')
     OR (p_provider_pairing_id IS NOT NULL
       AND length(trim(p_provider_pairing_id)) NOT BETWEEN 1 AND 255)
     OR (p_provider_device_id IS NOT NULL
       AND length(trim(p_provider_device_id)) NOT BETWEEN 1 AND 255)
     OR p_provider_status IS NULL
     OR length(trim(p_provider_status)) NOT BETWEEN 1 AND 64
     OR (p_failure_code IS NOT NULL AND p_failure_code !~ '^[a-z0-9_]{1,64}$')
     OR (p_outcome = 'ready' AND p_provider_device_id IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_pairing_completion');
  END IF;

  SELECT * INTO v_attempt
  FROM public.smart_checkout_pairing_attempts
  WHERE id = p_pairing_attempt_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'pairing_not_found');
  END IF;
  IF v_attempt.status IN ('ready', 'failed', 'manual_review', 'cancelled') THEN
    RETURN jsonb_build_object(
      'success', v_attempt.status = 'ready', 'code', 'pairing_terminal_replay',
      'pairing_attempt_id', v_attempt.id, 'status', v_attempt.status,
      'device_id', v_attempt.device_id
    );
  END IF;
  IF v_attempt.attempt_token IS DISTINCT FROM p_attempt_token
     OR v_attempt.lease_expires_at IS NULL
     OR v_attempt.lease_expires_at < v_now THEN
    RETURN jsonb_build_object('success', false, 'code', 'pairing_lease_mismatch');
  END IF;
  IF (v_attempt.provider_pairing_id IS NOT NULL
       AND v_attempt.provider_pairing_id IS DISTINCT FROM trim(p_provider_pairing_id))
     OR (v_attempt.provider_device_id IS NOT NULL
       AND p_provider_device_id IS NOT NULL
       AND v_attempt.provider_device_id IS DISTINCT FROM trim(p_provider_device_id)) THEN
    UPDATE public.smart_checkout_pairing_attempts
    SET status = 'manual_review', provider_status = trim(p_provider_status),
        last_error_code = 'pairing_provider_binding_mismatch',
        attempt_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
        completed_at = v_now, updated_at = v_now
    WHERE id = v_attempt.id;
    RETURN jsonb_build_object(
      'success', false, 'code', 'pairing_provider_binding_mismatch',
      'pairing_attempt_id', v_attempt.id, 'status', 'manual_review'
    );
  END IF;

  IF p_outcome = 'ready' THEN
    SELECT * INTO v_device
    FROM public.smart_checkout_devices
    WHERE provider = v_attempt.provider
      AND provider_account_fingerprint = v_attempt.provider_account_fingerprint
      AND provider_device_id = trim(p_provider_device_id)
    FOR UPDATE;
    IF FOUND AND (v_device.salon_id IS DISTINCT FROM v_attempt.salon_id
       OR (v_attempt.device_id IS NOT NULL AND v_device.id IS DISTINCT FROM v_attempt.device_id)) THEN
      UPDATE public.smart_checkout_pairing_attempts
      SET status = 'manual_review', provider_status = trim(p_provider_status),
          last_error_code = 'device_already_bound', attempt_token = NULL,
          lease_owner = NULL, lease_expires_at = NULL,
          completed_at = v_now, updated_at = v_now
      WHERE id = v_attempt.id;
      RETURN jsonb_build_object(
        'success', false, 'code', 'device_already_bound',
        'pairing_attempt_id', v_attempt.id, 'status', 'manual_review'
      );
    END IF;

    IF v_attempt.device_id IS NOT NULL THEN
      UPDATE public.smart_checkout_devices
      SET provider_account_fingerprint = v_attempt.provider_account_fingerprint,
          provider_location_id = v_attempt.provider_location_id,
          provider_device_id = trim(p_provider_device_id), status = 'ready',
          paired_at = coalesce(paired_at, v_now), last_seen_at = v_now,
          disabled_at = NULL, updated_at = v_now
      WHERE id = v_attempt.device_id
        AND salon_id = v_attempt.salon_id
        AND provider = v_attempt.provider
      RETURNING * INTO v_device;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pairing device tenant binding missing';
      END IF;
    ELSIF v_device.id IS NULL THEN
      INSERT INTO public.smart_checkout_devices (
        salon_id, provider, device_type, provider_device_id,
        provider_location_id, provider_account_fingerprint, label, status,
        paired_at, last_seen_at
      ) VALUES (
        v_attempt.salon_id, v_attempt.provider, v_attempt.device_type,
        trim(p_provider_device_id), v_attempt.provider_location_id,
        v_attempt.provider_account_fingerprint, v_attempt.label, 'ready',
        v_now, v_now
      ) RETURNING * INTO v_device;
    END IF;

    UPDATE public.smart_checkout_pairing_attempts
    SET status = 'ready', device_id = v_device.id,
        provider_device_id = trim(p_provider_device_id),
        provider_pairing_id = coalesce(trim(p_provider_pairing_id), provider_pairing_id),
        provider_status = trim(p_provider_status), last_error_code = NULL,
        attempt_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
        completed_at = v_now, updated_at = v_now
    WHERE id = v_attempt.id;
    RETURN jsonb_build_object(
      'success', true, 'code', 'pairing_ready',
      'pairing_attempt_id', v_attempt.id, 'status', 'ready',
      'device_id', v_device.id
    );
  END IF;

  IF p_outcome IN ('pending_provider', 'outcome_unknown')
     AND v_attempt.attempt_count < 5 THEN
    v_delay := least(900, 15 * power(2, greatest(v_attempt.attempt_count - 1, 0))::integer);
    UPDATE public.smart_checkout_pairing_attempts
    SET status = p_outcome,
        provider_pairing_id = coalesce(trim(p_provider_pairing_id), provider_pairing_id),
        provider_device_id = coalesce(trim(p_provider_device_id), provider_device_id),
        provider_status = trim(p_provider_status), last_error_code = p_failure_code,
        attempt_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
        next_attempt_at = v_now + make_interval(secs => v_delay),
        updated_at = v_now
    WHERE id = v_attempt.id;
    RETURN jsonb_build_object(
      'success', true, 'code', p_outcome,
      'pairing_attempt_id', v_attempt.id, 'status', p_outcome,
      'next_attempt_at', v_now + make_interval(secs => v_delay)
    );
  END IF;

  UPDATE public.smart_checkout_pairing_attempts
  SET status = CASE
        WHEN p_outcome = 'definite_failure' THEN 'failed' ELSE 'manual_review' END,
      provider_pairing_id = coalesce(trim(p_provider_pairing_id), provider_pairing_id),
      provider_device_id = coalesce(trim(p_provider_device_id), provider_device_id),
      provider_status = trim(p_provider_status),
      last_error_code = coalesce(p_failure_code,
        CASE WHEN p_outcome = 'definite_failure'
          THEN 'provider_pairing_failed' ELSE 'pairing_manual_review' END),
      attempt_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
      completed_at = v_now, updated_at = v_now
  WHERE id = v_attempt.id;
  RETURN jsonb_build_object(
    'success', false,
    'code', CASE WHEN p_outcome = 'definite_failure'
      THEN 'pairing_failed' ELSE 'pairing_manual_review' END,
    'pairing_attempt_id', v_attempt.id,
    'status', CASE WHEN p_outcome = 'definite_failure'
      THEN 'failed' ELSE 'manual_review' END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_smart_checkout_webhook_event(
  p_provider text,
  p_salon_id uuid,
  p_event_id text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_payload_fingerprint text,
  p_provider_account_id text,
  p_provider_location_id text,
  p_provider_device_id text,
  p_provider_checkout_id text,
  p_provider_payment_id text,
  p_provider_status text,
  p_amount_cents integer,
  p_currency text,
  p_material jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_session public.smart_checkout_sessions%ROWTYPE;
  v_device public.smart_checkout_devices%ROWTYPE;
  v_event public.smart_checkout_webhook_inbox%ROWTYPE;
  v_session_id uuid;
  v_failure_code text;
  v_provider_account_fingerprint text;
  v_normalized_material jsonb;
  v_material_fingerprint text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_material IS NULL OR jsonb_typeof(p_material) <> 'object'
     OR NOT (p_material ? 'session_id')
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_material) AS key
       WHERE key NOT IN ('session_id', 'failure_code')
     )
     OR (p_material ->> 'session_id') IS NULL
     OR (p_material ->> 'session_id') !~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
     OR ((p_material ->> 'failure_code') IS NOT NULL
       AND (p_material ->> 'failure_code') !~ '^[a-z0-9_]{1,64}$') THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_webhook_material');
  END IF;
  v_session_id := (p_material ->> 'session_id')::uuid;
  v_failure_code := p_material ->> 'failure_code';
  v_provider_account_fingerprint := encode(
    extensions.digest(
      convert_to(p_provider || ':' || trim(p_provider_account_id), 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  IF p_provider IS NULL OR p_provider NOT IN ('square', 'stripe')
     OR p_salon_id IS NULL
     OR p_event_id IS NULL OR length(trim(p_event_id)) NOT BETWEEN 1 AND 255
     OR p_event_type IS NULL OR p_event_type !~ '^[a-z0-9._-]{1,100}$'
     OR p_occurred_at IS NULL OR NOT isfinite(p_occurred_at)
     OR p_payload_fingerprint IS NULL
     OR p_payload_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_provider_account_id IS NULL
     OR length(trim(p_provider_account_id)) NOT BETWEEN 1 AND 255
     OR (p_provider_location_id IS NOT NULL
       AND length(trim(p_provider_location_id)) NOT BETWEEN 1 AND 255)
     OR (p_provider_device_id IS NOT NULL
       AND length(trim(p_provider_device_id)) NOT BETWEEN 1 AND 255)
     OR (p_provider_checkout_id IS NOT NULL
       AND length(trim(p_provider_checkout_id)) NOT BETWEEN 1 AND 255)
     OR (p_provider_payment_id IS NOT NULL
       AND length(trim(p_provider_payment_id)) NOT BETWEEN 1 AND 255)
     OR p_provider_status IS NULL
     OR length(trim(p_provider_status)) NOT BETWEEN 1 AND 64
     OR p_amount_cents IS NULL OR p_amount_cents < 0
     OR p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_webhook_event');
  END IF;

  SELECT * INTO v_session
  FROM public.smart_checkout_sessions
  WHERE id = v_session_id AND salon_id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'session_not_found');
  END IF;
  IF v_session.approved_by IS NULL OR v_session.approved_at IS NULL
     OR v_session.provider_requested_at IS NULL
     OR v_session.status NOT IN (
       'awaiting_customer', 'pending_provider', 'outcome_unknown',
       'partially_paid', 'paid', 'failed', 'cancelled', 'manual_review'
     ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'session_state_mismatch');
  END IF;
  IF v_session.device_id IS NOT NULL THEN
    SELECT * INTO v_device
    FROM public.smart_checkout_devices
    WHERE id = v_session.device_id
      AND salon_id = v_session.salon_id
      AND provider = v_session.provider;
  END IF;

  IF v_session.provider IS DISTINCT FROM p_provider
     OR v_session.provider_account_fingerprint IS DISTINCT FROM v_provider_account_fingerprint
     OR v_session.provider_location_id IS DISTINCT FROM nullif(trim(p_provider_location_id), '')
     OR v_session.currency IS DISTINCT FROM p_currency
     OR v_session.amount_due_cents IS DISTINCT FROM p_amount_cents
     OR (v_session.device_id IS NULL) <> (p_provider_device_id IS NULL)
     OR (v_session.device_id IS NOT NULL AND (
       v_device.id IS NULL
       OR v_device.provider_account_fingerprint IS DISTINCT FROM v_provider_account_fingerprint
       OR v_device.provider_device_id IS DISTINCT FROM trim(p_provider_device_id)
     ))
     OR (v_session.provider_checkout_id IS NOT NULL
       AND v_session.provider_checkout_id IS DISTINCT FROM trim(p_provider_checkout_id))
     OR (v_session.provider_payment_id IS NOT NULL
       AND v_session.provider_payment_id IS DISTINCT FROM trim(p_provider_payment_id)) THEN
    RETURN jsonb_build_object('success', false, 'code', 'webhook_binding_mismatch');
  END IF;

  v_normalized_material := jsonb_build_object(
    'provider', p_provider, 'salon_id', p_salon_id, 'session_id', v_session_id,
    'event_id', trim(p_event_id), 'event_type', p_event_type,
    'occurred_at', p_occurred_at,
    'provider_account_fingerprint', v_provider_account_fingerprint,
    'provider_location_id', nullif(trim(p_provider_location_id), ''),
    'provider_device_id', nullif(trim(p_provider_device_id), ''),
    'provider_checkout_id', nullif(trim(p_provider_checkout_id), ''),
    'provider_payment_id', nullif(trim(p_provider_payment_id), ''),
    'provider_status', trim(p_provider_status),
    'amount_cents', p_amount_cents, 'currency', p_currency,
    'failure_code', v_failure_code
  );
  v_material_fingerprint := encode(
    extensions.digest(convert_to(v_normalized_material::text, 'UTF8'), 'sha256'), 'hex'
  );

  INSERT INTO public.smart_checkout_webhook_inbox (
    salon_id, session_id, provider, provider_account_fingerprint,
    event_id, event_type, occurred_at, payload_fingerprint,
    normalized_material_fingerprint, provider_location_id,
    provider_device_id, provider_checkout_id, provider_payment_id,
    provider_status, amount_cents, currency, failure_code
  ) VALUES (
    p_salon_id, v_session_id, p_provider, v_provider_account_fingerprint,
    trim(p_event_id), p_event_type, p_occurred_at, p_payload_fingerprint,
    v_material_fingerprint, nullif(trim(p_provider_location_id), ''),
    nullif(trim(p_provider_device_id), ''), nullif(trim(p_provider_checkout_id), ''),
    nullif(trim(p_provider_payment_id), ''), trim(p_provider_status),
    p_amount_cents, p_currency, v_failure_code
  )
  ON CONFLICT (provider, provider_account_fingerprint, event_id) DO NOTHING
  RETURNING * INTO v_event;

  IF NOT FOUND THEN
    SELECT * INTO v_event
    FROM public.smart_checkout_webhook_inbox
    WHERE provider = p_provider
      AND provider_account_fingerprint = v_provider_account_fingerprint
      AND event_id = trim(p_event_id)
    FOR UPDATE;
    IF v_event.salon_id IS DISTINCT FROM p_salon_id
       OR v_event.session_id IS DISTINCT FROM v_session_id
       OR v_event.payload_fingerprint IS DISTINCT FROM p_payload_fingerprint
       OR v_event.normalized_material_fingerprint IS DISTINCT FROM v_material_fingerprint THEN
      RETURN jsonb_build_object('success', false, 'code', 'webhook_event_conflict');
    END IF;
    RETURN jsonb_build_object(
      'success', v_event.processing_status IN ('received', 'reconciled', 'ignored'),
      'code', 'webhook_event_replay', 'event_id', v_event.event_id,
      'session_id', v_event.session_id,
      'processing_status', v_event.processing_status,
      'result_code', v_event.result_code
    );
  END IF;

  IF v_session.status IN ('paid', 'failed', 'cancelled', 'manual_review') THEN
    UPDATE public.smart_checkout_webhook_inbox
    SET processing_status = 'ignored', result_code = 'terminal_state_noop',
        completed_at = v_now
    WHERE id = v_event.id;
    RETURN jsonb_build_object(
      'success', true, 'code', 'terminal_state_noop',
      'event_id', v_event.event_id, 'session_id', v_event.session_id,
      'processing_status', 'ignored'
    );
  END IF;

  UPDATE public.smart_checkout_sessions
  SET provider_checkout_id = coalesce(provider_checkout_id,
        nullif(trim(p_provider_checkout_id), '')),
      provider_payment_id = coalesce(provider_payment_id,
        nullif(trim(p_provider_payment_id), '')),
      provider_status = trim(p_provider_status),
      status = CASE WHEN status IN ('paid', 'failed', 'cancelled', 'manual_review')
        THEN status ELSE 'outcome_unknown' END,
      failure_disposition = CASE WHEN status IN ('paid', 'failed', 'cancelled', 'manual_review')
        THEN failure_disposition ELSE 'ambiguous' END,
      error_code = CASE WHEN status IN ('paid', 'failed', 'cancelled', 'manual_review')
        THEN error_code ELSE coalesce(v_failure_code, 'provider_webhook_reconcile_due') END,
      last_provider_event_at = greatest(coalesce(last_provider_event_at, p_occurred_at), p_occurred_at),
      next_reconcile_at = CASE WHEN status IN ('paid', 'failed', 'cancelled', 'manual_review')
        THEN next_reconcile_at ELSE least(coalesce(next_reconcile_at, v_now), v_now) END,
      updated_at = v_now
  WHERE id = v_session.id;

  RETURN jsonb_build_object(
    'success', true, 'code', 'webhook_event_recorded',
    'event_id', v_event.event_id, 'session_id', v_event.session_id,
    'processing_status', v_event.processing_status
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_due_smart_checkout_reconciliations(
  p_worker_id text,
  p_limit integer DEFAULT 25,
  p_lease_seconds integer DEFAULT 120
) RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_session public.smart_checkout_sessions%ROWTYPE;
  v_device public.smart_checkout_devices%ROWTYPE;
  v_token uuid;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN;
  END IF;
  IF p_worker_id IS NULL OR length(trim(p_worker_id)) NOT BETWEEN 1 AND 100
     OR p_limit NOT BETWEEN 1 AND 100
     OR p_lease_seconds NOT BETWEEN 30 AND 600 THEN
    RAISE EXCEPTION 'invalid reconciliation claim' USING ERRCODE = '22023';
  END IF;

  UPDATE public.smart_checkout_sessions
  SET status = 'manual_review', manual_review_reason = 'reconciliation_retry_exhausted',
      error_code = 'reconciliation_retry_exhausted',
      reconciliation_attempt_token = NULL, reconciliation_lease_owner = NULL,
      reconciliation_lease_expires_at = NULL, next_reconcile_at = NULL,
      updated_at = v_now
  WHERE status IN ('pending_provider', 'outcome_unknown')
    AND reconciliation_attempt_count >= reconciliation_max_attempts
    AND (reconciliation_lease_expires_at IS NULL
      OR reconciliation_lease_expires_at <= v_now);

  FOR v_session IN
    SELECT s.*
    FROM public.smart_checkout_sessions s
    WHERE s.status IN ('pending_provider', 'outcome_unknown')
      AND s.approved_by IS NOT NULL AND s.approved_at IS NOT NULL
      AND s.provider_requested_at IS NOT NULL
      AND s.reconciliation_attempt_count < s.reconciliation_max_attempts
      AND coalesce(s.next_reconcile_at, s.provider_requested_at) <= v_now
      AND (s.reconciliation_lease_expires_at IS NULL
        OR s.reconciliation_lease_expires_at <= v_now)
    ORDER BY coalesce(s.next_reconcile_at, s.provider_requested_at), s.created_at, s.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  LOOP
    IF v_session.device_id IS NOT NULL THEN
      SELECT * INTO v_device
      FROM public.smart_checkout_devices
      WHERE id = v_session.device_id
        AND salon_id = v_session.salon_id
        AND provider = v_session.provider;
    ELSE
      v_device := NULL;
    END IF;

    IF v_session.device_id IS NOT NULL AND (
      v_device.id IS NULL
      OR v_device.status <> 'ready'
      OR v_device.provider_account_fingerprint IS DISTINCT FROM
        v_session.provider_account_fingerprint
    ) THEN
      UPDATE public.smart_checkout_sessions
      SET status = 'manual_review', manual_review_reason = 'device_binding_invalid',
          error_code = 'device_binding_invalid', next_reconcile_at = NULL,
          reconciliation_attempt_token = NULL, reconciliation_lease_owner = NULL,
          reconciliation_lease_expires_at = NULL, updated_at = v_now
      WHERE id = v_session.id;
      CONTINUE;
    END IF;

    v_token := gen_random_uuid();
    UPDATE public.smart_checkout_sessions
    SET reconciliation_attempt_count = reconciliation_attempt_count + 1,
        reconciliation_attempt_token = v_token,
        reconciliation_lease_owner = trim(p_worker_id),
        reconciliation_lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        last_reconcile_at = v_now, next_reconcile_at = NULL,
        updated_at = v_now
    WHERE id = v_session.id
    RETURNING * INTO v_session;

    RETURN NEXT jsonb_build_object(
      'success', true, 'code', 'reconciliation_claimed',
      'session_id', v_session.id, 'salon_id', v_session.salon_id,
      'provider', v_session.provider,
      'provider_account_fingerprint', v_session.provider_account_fingerprint,
      'provider_location_id', v_session.provider_location_id,
      'device_id', v_session.device_id,
      'provider_device_id', v_device.provider_device_id,
      'provider_checkout_id', v_session.provider_checkout_id,
      'provider_payment_id', v_session.provider_payment_id,
      'amount_cents', v_session.amount_due_cents,
      'currency', v_session.currency,
      'status', v_session.status,
      'provider_status', v_session.provider_status,
      'provider_idempotency_key', v_session.provider_idempotency_key,
      'material_fingerprint', v_session.material_fingerprint,
      'attempt_token', v_session.reconciliation_attempt_token,
      'lease_expires_at', v_session.reconciliation_lease_expires_at,
      'attempt_count', v_session.reconciliation_attempt_count
    );
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_smart_checkout_reconciliation(
  p_session_id uuid,
  p_attempt_token uuid,
  p_outcome text,
  p_provider_account_fingerprint text,
  p_provider_location_id text,
  p_device_id uuid,
  p_provider_device_id text,
  p_provider_checkout_id text,
  p_provider_payment_id text,
  p_provider_status text,
  p_amount_cents integer,
  p_currency text,
  p_receipt_id text,
  p_receipt_fingerprint text,
  p_paid_at timestamptz,
  p_webhook_event_id text DEFAULT NULL,
  p_failure_code text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_session public.smart_checkout_sessions%ROWTYPE;
  v_device public.smart_checkout_devices%ROWTYPE;
  v_event public.smart_checkout_webhook_inbox%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_delay integer;
  v_mismatch boolean := false;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_session_id IS NULL OR p_attempt_token IS NULL
     OR p_outcome IS NULL
     OR p_outcome NOT IN ('paid', 'retry', 'failed', 'cancelled', 'manual_review')
     OR p_provider_account_fingerprint IS NULL
     OR p_provider_account_fingerprint !~ '^[0-9a-f]{64}$'
     OR (p_provider_location_id IS NOT NULL
       AND length(trim(p_provider_location_id)) NOT BETWEEN 1 AND 255)
     OR (p_provider_device_id IS NOT NULL
       AND length(trim(p_provider_device_id)) NOT BETWEEN 1 AND 255)
     OR (p_provider_checkout_id IS NOT NULL
       AND length(trim(p_provider_checkout_id)) NOT BETWEEN 1 AND 255)
     OR (p_provider_payment_id IS NOT NULL
       AND length(trim(p_provider_payment_id)) NOT BETWEEN 1 AND 255)
     OR p_provider_status IS NULL
     OR length(trim(p_provider_status)) NOT BETWEEN 1 AND 64
     OR p_amount_cents IS NULL OR p_amount_cents < 0
     OR p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$'
     OR (p_webhook_event_id IS NOT NULL
       AND length(trim(p_webhook_event_id)) NOT BETWEEN 1 AND 255)
     OR (p_failure_code IS NOT NULL AND p_failure_code !~ '^[a-z0-9_]{1,64}$')
     OR (p_outcome = 'paid' AND (
       p_provider_payment_id IS NULL
       OR length(trim(p_receipt_id)) NOT BETWEEN 1 AND 255
       OR p_receipt_fingerprint !~ '^[0-9a-f]{64}$'
       OR p_paid_at IS NULL OR NOT isfinite(p_paid_at)
     )) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_reconciliation_completion');
  END IF;

  SELECT * INTO v_session
  FROM public.smart_checkout_sessions
  WHERE id = p_session_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'session_not_found');
  END IF;
  IF v_session.status IN ('paid', 'failed', 'cancelled', 'manual_review') THEN
    RETURN jsonb_build_object(
      'success', v_session.status = 'paid', 'code', 'reconciliation_terminal_replay',
      'session_id', v_session.id, 'status', v_session.status
    );
  END IF;
  IF v_session.reconciliation_attempt_token IS DISTINCT FROM p_attempt_token
     OR v_session.reconciliation_lease_expires_at IS NULL
     OR v_session.reconciliation_lease_expires_at < v_now THEN
    RETURN jsonb_build_object('success', false, 'code', 'reconciliation_lease_mismatch');
  END IF;
  IF v_session.device_id IS NOT NULL THEN
    SELECT * INTO v_device
    FROM public.smart_checkout_devices
    WHERE id = v_session.device_id
      AND salon_id = v_session.salon_id
      AND provider = v_session.provider;
  END IF;
  IF p_webhook_event_id IS NOT NULL THEN
    SELECT * INTO v_event
    FROM public.smart_checkout_webhook_inbox
    WHERE provider = v_session.provider
      AND provider_account_fingerprint = v_session.provider_account_fingerprint
      AND event_id = trim(p_webhook_event_id)
    FOR UPDATE;
    IF NOT FOUND OR v_event.session_id IS DISTINCT FROM v_session.id THEN
      v_mismatch := true;
    END IF;
  END IF;

  v_mismatch := v_mismatch
    OR v_session.provider_account_fingerprint IS DISTINCT FROM p_provider_account_fingerprint
    OR v_session.provider_location_id IS DISTINCT FROM nullif(trim(p_provider_location_id), '')
    OR v_session.device_id IS DISTINCT FROM p_device_id
    OR (v_session.device_id IS NULL) <> (p_provider_device_id IS NULL)
    OR (v_session.device_id IS NOT NULL AND (
      v_device.id IS NULL
      OR v_device.provider_account_fingerprint IS DISTINCT FROM p_provider_account_fingerprint
      OR v_device.provider_device_id IS DISTINCT FROM trim(p_provider_device_id)
    ))
    OR (v_session.provider_checkout_id IS NOT NULL
      AND v_session.provider_checkout_id IS DISTINCT FROM trim(p_provider_checkout_id))
    OR (v_session.provider_payment_id IS NOT NULL
      AND v_session.provider_payment_id IS DISTINCT FROM trim(p_provider_payment_id))
    OR v_session.amount_due_cents IS DISTINCT FROM p_amount_cents
    OR v_session.currency IS DISTINCT FROM p_currency
    OR (p_outcome = 'paid' AND v_event.id IS NOT NULL AND (
      v_event.provider_location_id IS DISTINCT FROM nullif(trim(p_provider_location_id), '')
      OR v_event.provider_device_id IS DISTINCT FROM nullif(trim(p_provider_device_id), '')
      OR v_event.provider_checkout_id IS DISTINCT FROM nullif(trim(p_provider_checkout_id), '')
      OR v_event.provider_payment_id IS DISTINCT FROM nullif(trim(p_provider_payment_id), '')
      OR v_event.amount_cents IS DISTINCT FROM p_amount_cents
      OR v_event.currency IS DISTINCT FROM p_currency
    ));

  IF v_mismatch THEN
    UPDATE public.smart_checkout_sessions
    SET status = 'manual_review', manual_review_reason = 'provider_binding_mismatch',
        failure_disposition = 'ambiguous', error_code = 'provider_binding_mismatch',
        reconciliation_attempt_token = NULL, reconciliation_lease_owner = NULL,
        reconciliation_lease_expires_at = NULL, next_reconcile_at = NULL,
        updated_at = v_now
    WHERE id = v_session.id;
    IF v_event.id IS NOT NULL AND v_event.processing_status = 'received' THEN
      UPDATE public.smart_checkout_webhook_inbox
      SET processing_status = 'manual_review', result_code = 'provider_binding_mismatch',
          completed_at = v_now
      WHERE id = v_event.id;
    END IF;
    RETURN jsonb_build_object(
      'success', false, 'code', 'provider_binding_mismatch',
      'session_id', v_session.id, 'status', 'manual_review'
    );
  END IF;

  IF p_outcome = 'paid' THEN
    UPDATE public.smart_checkout_sessions
    SET status = 'paid', collected_cents = amount_due_cents,
        provider_checkout_id = coalesce(provider_checkout_id,
          nullif(trim(p_provider_checkout_id), '')),
        provider_payment_id = trim(p_provider_payment_id),
        provider_status = trim(p_provider_status),
        provider_receipt_id = trim(p_receipt_id),
        provider_receipt_fingerprint = p_receipt_fingerprint,
        provider_paid_at = p_paid_at, result_json = jsonb_build_object(
          'provider', provider, 'provider_status', trim(p_provider_status),
          'provider_payment_id', trim(p_provider_payment_id),
          'provider_receipt_id', trim(p_receipt_id),
          'amount_cents', p_amount_cents, 'currency', p_currency
        ), failure_disposition = NULL, error_code = NULL,
        reconciliation_attempt_token = NULL, reconciliation_lease_owner = NULL,
        reconciliation_lease_expires_at = NULL, next_reconcile_at = NULL,
        completed_at = v_now, updated_at = v_now
    WHERE id = v_session.id;
    IF v_event.id IS NOT NULL AND v_event.processing_status = 'received' THEN
      UPDATE public.smart_checkout_webhook_inbox
      SET processing_status = 'reconciled', result_code = 'paid_receipt_applied',
          completed_at = v_now
      WHERE id = v_event.id;
    END IF;
    RETURN jsonb_build_object(
      'success', true, 'code', 'paid_receipt_applied',
      'session_id', v_session.id, 'status', 'paid'
    );
  END IF;

  IF p_outcome = 'retry'
     AND v_session.reconciliation_attempt_count < v_session.reconciliation_max_attempts THEN
    v_delay := least(900, 15 * power(
      2, greatest(v_session.reconciliation_attempt_count - 1, 0)
    )::integer);
    UPDATE public.smart_checkout_sessions
    SET status = 'outcome_unknown',
        provider_checkout_id = coalesce(provider_checkout_id,
          nullif(trim(p_provider_checkout_id), '')),
        provider_payment_id = coalesce(provider_payment_id,
          nullif(trim(p_provider_payment_id), '')),
        provider_status = trim(p_provider_status),
        failure_disposition = 'ambiguous',
        error_code = coalesce(p_failure_code, 'provider_outcome_ambiguous'),
        reconciliation_attempt_token = NULL, reconciliation_lease_owner = NULL,
        reconciliation_lease_expires_at = NULL,
        next_reconcile_at = v_now + make_interval(secs => v_delay),
        updated_at = v_now
    WHERE id = v_session.id;
    IF v_event.id IS NOT NULL AND v_event.processing_status = 'received' THEN
      UPDATE public.smart_checkout_webhook_inbox
      SET processing_status = 'reconciled', result_code = 'reconciliation_retry_scheduled',
          completed_at = v_now
      WHERE id = v_event.id;
    END IF;
    RETURN jsonb_build_object(
      'success', true, 'code', 'reconciliation_retry_scheduled',
      'session_id', v_session.id, 'status', 'outcome_unknown',
      'next_reconcile_at', v_now + make_interval(secs => v_delay)
    );
  END IF;

  UPDATE public.smart_checkout_sessions
  SET status = CASE
        WHEN p_outcome = 'failed' THEN 'failed'
        WHEN p_outcome = 'cancelled' THEN 'cancelled'
        ELSE 'manual_review' END,
      manual_review_reason = CASE WHEN p_outcome IN ('failed', 'cancelled') THEN NULL
        ELSE coalesce(p_failure_code, 'provider_manual_review') END,
      provider_checkout_id = coalesce(provider_checkout_id,
        nullif(trim(p_provider_checkout_id), '')),
      provider_payment_id = coalesce(provider_payment_id,
        nullif(trim(p_provider_payment_id), '')),
      provider_status = trim(p_provider_status),
      failure_disposition = CASE WHEN p_outcome IN ('failed', 'cancelled')
        THEN 'terminal' ELSE 'ambiguous' END,
      error_code = coalesce(p_failure_code,
        CASE WHEN p_outcome = 'failed' THEN 'provider_definite_failure'
          WHEN p_outcome = 'cancelled' THEN 'provider_cancelled'
          ELSE 'provider_manual_review' END),
      reconciliation_attempt_token = NULL, reconciliation_lease_owner = NULL,
      reconciliation_lease_expires_at = NULL, next_reconcile_at = NULL,
      completed_at = CASE WHEN p_outcome IN ('failed', 'cancelled') THEN v_now
        ELSE completed_at END,
      updated_at = v_now
  WHERE id = v_session.id;
  IF v_event.id IS NOT NULL AND v_event.processing_status = 'received' THEN
    UPDATE public.smart_checkout_webhook_inbox
    SET processing_status = CASE WHEN p_outcome IN ('failed', 'cancelled')
          THEN 'reconciled' ELSE 'manual_review' END,
        result_code = CASE WHEN p_outcome = 'failed' THEN 'provider_definite_failure'
          WHEN p_outcome = 'cancelled' THEN 'provider_cancelled'
          ELSE 'provider_manual_review' END,
        completed_at = v_now
    WHERE id = v_event.id;
  END IF;
  RETURN jsonb_build_object(
    'success', p_outcome IN ('failed', 'cancelled'),
    'code', CASE WHEN p_outcome = 'failed' THEN 'provider_definite_failure'
      WHEN p_outcome = 'cancelled' THEN 'provider_cancelled'
      ELSE 'provider_manual_review' END,
    'session_id', v_session.id,
    'status', CASE WHEN p_outcome = 'failed' THEN 'failed'
      WHEN p_outcome = 'cancelled' THEN 'cancelled'
      ELSE 'manual_review' END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.request_smart_checkout_pairing(
  uuid,uuid,text,text,text,text,text,text,text,text,text,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_smart_checkout_pairing(
  uuid,uuid,text,text,text,text,text,text,text,text,text,text
) TO service_role;

REVOKE ALL ON FUNCTION public.claim_due_smart_checkout_pairings(text,integer,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_smart_checkout_pairings(text,integer,integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.complete_smart_checkout_pairing(
  uuid,uuid,text,text,text,text,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_smart_checkout_pairing(
  uuid,uuid,text,text,text,text,text
) TO service_role;

REVOKE ALL ON FUNCTION public.record_smart_checkout_webhook_event(
  text,uuid,text,text,timestamptz,text,text,text,text,text,text,text,integer,text,jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_smart_checkout_webhook_event(
  text,uuid,text,text,timestamptz,text,text,text,text,text,text,text,integer,text,jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.claim_due_smart_checkout_reconciliations(text,integer,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_smart_checkout_reconciliations(text,integer,integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.complete_smart_checkout_reconciliation(
  uuid,uuid,text,text,text,uuid,text,text,text,text,integer,text,text,text,
  timestamptz,text,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_smart_checkout_reconciliation(
  uuid,uuid,text,text,text,uuid,text,text,text,text,integer,text,text,text,
  timestamptz,text,text
) TO service_role;

DO $smart_checkout_phase_b_acl$
DECLARE
  v_table text;
  v_function regprocedure;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'smart_checkout_devices', 'smart_checkout_sessions', 'smart_checkout_lines',
    'smart_checkout_pairing_attempts', 'smart_checkout_webhook_inbox'
  ] LOOP
    IF has_table_privilege('anon', 'public.' || v_table, 'INSERT')
       OR has_table_privilege('anon', 'public.' || v_table, 'UPDATE')
       OR has_table_privilege('anon', 'public.' || v_table, 'DELETE')
       OR has_table_privilege('anon', 'public.' || v_table, 'TRUNCATE')
       OR has_table_privilege('anon', 'public.' || v_table, 'REFERENCES')
       OR has_table_privilege('anon', 'public.' || v_table, 'TRIGGER')
       OR has_table_privilege('authenticated', 'public.' || v_table, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || v_table, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || v_table, 'DELETE')
       OR has_table_privilege('authenticated', 'public.' || v_table, 'TRUNCATE')
       OR has_table_privilege('authenticated', 'public.' || v_table, 'REFERENCES')
       OR has_table_privilege('authenticated', 'public.' || v_table, 'TRIGGER')
       OR has_table_privilege('service_role', 'public.' || v_table, 'INSERT')
       OR has_table_privilege('service_role', 'public.' || v_table, 'UPDATE')
       OR has_table_privilege('service_role', 'public.' || v_table, 'DELETE')
       OR has_table_privilege('service_role', 'public.' || v_table, 'TRUNCATE')
       OR has_table_privilege('service_role', 'public.' || v_table, 'REFERENCES')
       OR has_table_privilege('service_role', 'public.' || v_table, 'TRIGGER') THEN
      RAISE EXCEPTION 'Smart Checkout direct table write remains reachable: %', v_table;
    END IF;
  END LOOP;

  FOREACH v_function IN ARRAY ARRAY[
    'public.request_smart_checkout_pairing(uuid,uuid,text,text,text,text,text,text,text,text,text,text)'::regprocedure,
    'public.claim_due_smart_checkout_pairings(text,integer,integer)'::regprocedure,
    'public.complete_smart_checkout_pairing(uuid,uuid,text,text,text,text,text)'::regprocedure,
    'public.record_smart_checkout_webhook_event(text,uuid,text,text,timestamp with time zone,text,text,text,text,text,text,text,integer,text,jsonb)'::regprocedure,
    'public.claim_due_smart_checkout_reconciliations(text,integer,integer)'::regprocedure,
    'public.complete_smart_checkout_reconciliation(uuid,uuid,text,text,text,uuid,text,text,text,text,integer,text,text,text,timestamp with time zone,text,text)'::regprocedure
  ] LOOP
    IF has_function_privilege('anon', v_function, 'EXECUTE')
       OR has_function_privilege('authenticated', v_function, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'Smart Checkout Phase B RPC ACL mismatch: %', v_function;
    END IF;
  END LOOP;
END;
$smart_checkout_phase_b_acl$;

COMMENT ON COLUMN public.smart_checkout_pairing_attempts.pairing_code_fingerprint IS
  'One-way evidence only; raw pairing codes are never persisted.';
COMMENT ON TABLE public.smart_checkout_pairing_attempts IS
  'Service-only pairing lifecycle with bounded leases/backoff and no raw pairing code or credentials.';
COMMENT ON TABLE public.smart_checkout_webhook_inbox IS
  'Service-only signature-verified normalized payment events. No raw body, signature, card, or customer PII.';
COMMENT ON FUNCTION public.record_smart_checkout_webhook_event(
  text,uuid,text,text,timestamptz,text,text,text,text,text,text,text,integer,text,jsonb
) IS
  'Idempotently records a server-verified normalized webhook and schedules exact-session reconciliation; never marks paid.';
COMMENT ON FUNCTION public.complete_smart_checkout_reconciliation(
  uuid,uuid,text,text,text,uuid,text,text,text,text,integer,text,text,text,
  timestamptz,text,text
) IS
  'Completes a leased reconciliation only when provider account/location/device, amount, currency, checkout/payment, and paid receipt all match.';
