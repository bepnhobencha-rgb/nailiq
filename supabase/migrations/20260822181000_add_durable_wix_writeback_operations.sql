-- Durable NailIQ -> Wix create-writeback claim and reconciliation contract.
--
-- This migration intentionally does not enable Wix, call Wix, or grant a
-- browser role mutation access. Its purpose is to make an ambiguous provider
-- outcome non-redispatchable: a timed-out create is reconciled by the stable
-- Wix externalUserId before any human-authorized retry decision.

CREATE TABLE public.wix_create_writeback_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE RESTRICT,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  operation_kind text NOT NULL DEFAULT 'create_booking'
    CHECK (operation_kind = 'create_booking'),
  status text NOT NULL
    CHECK (status IN ('sending', 'reconciling', 'succeeded', 'failed', 'unknown')),
  provider_account_fingerprint text NOT NULL
    CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  provider_external_user_id text NOT NULL
    CHECK (length(provider_external_user_id) BETWEEN 1 AND 128
      AND provider_external_user_id !~ '[[:cntrl:]]'),
  material jsonb NOT NULL CHECK (jsonb_typeof(material) = 'object'),
  material_fingerprint text NOT NULL
    CHECK (material_fingerprint ~ '^[0-9a-f]{64}$'),
  provider_booking_id text,
  provider_revision text,
  result_fingerprint text
    CHECK (result_fingerprint IS NULL OR result_fingerprint ~ '^[0-9a-f]{64}$'),
  attempt_token uuid,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_expires_at timestamptz,
  next_reconcile_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT wix_create_writeback_operation_booking_unique
    UNIQUE (booking_id, operation_kind),
  CONSTRAINT wix_create_writeback_operation_salon_booking_unique
    UNIQUE (salon_id, booking_id),
  CONSTRAINT wix_create_writeback_operation_attempt_shape CHECK (
    (status IN ('sending', 'reconciling') AND attempt_token IS NOT NULL
      AND lease_expires_at IS NOT NULL)
    OR
    (status IN ('succeeded', 'failed', 'unknown') AND attempt_token IS NULL
      AND lease_expires_at IS NULL)
  ),
  CONSTRAINT wix_create_writeback_operation_result_shape CHECK (
    (status = 'succeeded' AND provider_booking_id IS NOT NULL
      AND result_fingerprint IS NOT NULL AND completed_at IS NOT NULL)
    OR
    (status <> 'succeeded')
  )
);

CREATE UNIQUE INDEX wix_create_writeback_provider_booking_unique
  ON public.wix_create_writeback_operations (salon_id, provider_booking_id)
  WHERE provider_booking_id IS NOT NULL;

CREATE UNIQUE INDEX wix_create_writeback_external_user_unique
  ON public.wix_create_writeback_operations (salon_id, provider_external_user_id);

CREATE INDEX wix_create_writeback_reconciliation_due_idx
  ON public.wix_create_writeback_operations (next_reconcile_at, created_at)
  WHERE status IN ('unknown', 'reconciling');

ALTER TABLE public.wix_create_writeback_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wix_create_writeback_operations FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.wix_create_writeback_operations
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.wix_create_writeback_operations TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_wix_create_writeback_material(
  p_salon_id uuid,
  p_booking_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_booking public.bookings%ROWTYPE;
  v_site_id text;
  v_location_id text;
  v_default_resource_id text;
  v_service_id text;
  v_schedule_id text;
  v_resource_id text;
  v_timezone text;
  v_material jsonb;
  v_account_fingerprint text;
  v_material_fingerprint text;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;

  SELECT b.*
  INTO v_booking
  FROM public.bookings b
  WHERE b.id = p_booking_id
    AND b.salon_id = p_salon_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'booking_not_found');
  END IF;

  IF v_booking.wix_booking_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'already_linked',
      'provider_booking_id', v_booking.wix_booking_id
    );
  END IF;

  IF v_booking.status NOT IN ('confirmed', 'pending')
     OR v_booking.start_time_utc IS NULL
     OR v_booking.end_time_utc IS NULL
     OR v_booking.end_time_utc <= v_booking.start_time_utc
     OR v_booking.service_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'booking_not_eligible');
  END IF;

  SELECT
    wi.site_id,
    wi.wix_location_id,
    wi.wix_default_resource_id
  INTO v_site_id, v_location_id, v_default_resource_id
  FROM public.wix_integrations wi
  WHERE wi.salon_id = p_salon_id
    AND wi.enabled = true;

  IF NOT FOUND OR nullif(trim(v_site_id), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'integration_not_ready');
  END IF;

  SELECT s.wix_service_id, s.wix_schedule_id
  INTO v_service_id, v_schedule_id
  FROM public.services s
  WHERE s.id = v_booking.service_id
    AND s.salon_id = p_salon_id
    AND s.deleted_at IS NULL;

  IF NOT FOUND
     OR nullif(trim(v_service_id), '') IS NULL
     OR nullif(trim(v_schedule_id), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'service_not_mapped');
  END IF;

  IF v_booking.staff_id IS NOT NULL THEN
    SELECT st.wix_resource_id
    INTO v_resource_id
    FROM public.staff st
    WHERE st.id = v_booking.staff_id
      AND st.salon_id = p_salon_id
      AND st.deleted_at IS NULL;
  END IF;
  v_resource_id := coalesce(
    nullif(trim(v_resource_id), ''),
    nullif(trim(v_default_resource_id), '')
  );
  IF v_resource_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'resource_not_mapped');
  END IF;

  SELECT coalesce(nullif(trim(sa.timezone), ''), 'America/Vancouver')
  INTO v_timezone
  FROM public.salons sa
  WHERE sa.id = p_salon_id;

  v_account_fingerprint := encode(
    extensions.digest(convert_to('wix' || E'\n' || v_site_id, 'UTF8'), 'sha256'),
    'hex'
  );
  v_material := jsonb_build_object(
    'contract_version', 1,
    'provider', 'wix',
    'operation_kind', 'create_booking',
    'salon_id', p_salon_id::text,
    'booking_id', p_booking_id::text,
    'provider_account_fingerprint', v_account_fingerprint,
    'provider_external_user_id', p_booking_id::text,
    'site_id', v_site_id,
    'service_id', v_service_id,
    'schedule_id', v_schedule_id,
    'resource_id', v_resource_id,
    'location_id', nullif(trim(v_location_id), ''),
    'start_time_utc', to_char(v_booking.start_time_utc AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'end_time_utc', to_char(v_booking.end_time_utc AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'timezone', v_timezone
  );
  v_material_fingerprint := encode(
    extensions.digest(convert_to(v_material::text, 'UTF8'), 'sha256'),
    'hex'
  );

  RETURN jsonb_build_object(
    'success', true,
    'code', 'resolved',
    'material', v_material,
    'material_fingerprint', v_material_fingerprint,
    'provider_external_user_id', p_booking_id::text,
    'site_id', v_site_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_wix_create_writeback(
  p_salon_id uuid,
  p_booking_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_resolved jsonb;
  v_operation public.wix_create_writeback_operations%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'wix:create:' || p_salon_id::text || ':' || p_booking_id::text,
    0
  ));

  SELECT *
  INTO v_operation
  FROM public.wix_create_writeback_operations
  WHERE salon_id = p_salon_id
    AND booking_id = p_booking_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_operation.status = 'succeeded' THEN
      RETURN jsonb_build_object(
        'success', true,
        'code', 'operation_succeeded',
        'operation_id', v_operation.id,
        'status', v_operation.status,
        'provider_booking_id', v_operation.provider_booking_id,
        'provider_external_user_id', v_operation.provider_external_user_id,
        'material_fingerprint', v_operation.material_fingerprint
      );
    END IF;
    IF v_operation.status = 'failed' THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'operation_failed',
        'operation_id', v_operation.id,
        'error_code', v_operation.error_code
      );
    END IF;
    IF v_operation.status IN ('sending', 'reconciling')
       AND v_operation.lease_expires_at > v_now THEN
      RETURN jsonb_build_object(
        'success', true,
        'code', 'operation_in_flight',
        'operation_id', v_operation.id,
        'status', v_operation.status,
        'provider_external_user_id', v_operation.provider_external_user_id
      );
    END IF;
    IF v_operation.next_reconcile_at IS NOT NULL
       AND v_operation.next_reconcile_at > v_now THEN
      RETURN jsonb_build_object(
        'success', true,
        'code', 'reconciliation_not_due',
        'operation_id', v_operation.id,
        'status', v_operation.status,
        'provider_external_user_id', v_operation.provider_external_user_id,
        'next_reconcile_at', v_operation.next_reconcile_at
      );
    END IF;

    UPDATE public.wix_create_writeback_operations
    SET status = 'reconciling',
        attempt_token = gen_random_uuid(),
        attempt_count = attempt_count + 1,
        lease_expires_at = v_now + interval '5 minutes',
        next_reconcile_at = NULL,
        error_code = 'provider_outcome_requires_reconciliation',
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;

    RETURN jsonb_build_object(
      'success', true,
      'code', 'reconciliation_claimed',
      'operation_id', v_operation.id,
      'attempt_token', v_operation.attempt_token,
      'status', v_operation.status,
      'provider_external_user_id', v_operation.provider_external_user_id,
      'material', v_operation.material,
      'material_fingerprint', v_operation.material_fingerprint
    );
  END IF;

  v_resolved := public.resolve_wix_create_writeback_material(
    p_salon_id,
    p_booking_id
  );
  IF v_resolved ->> 'code' <> 'resolved' THEN
    RETURN v_resolved;
  END IF;

  INSERT INTO public.wix_create_writeback_operations (
    salon_id,
    booking_id,
    status,
    provider_account_fingerprint,
    provider_external_user_id,
    material,
    material_fingerprint,
    attempt_token,
    attempt_count,
    lease_expires_at
  ) VALUES (
    p_salon_id,
    p_booking_id,
    'sending',
    v_resolved -> 'material' ->> 'provider_account_fingerprint',
    v_resolved ->> 'provider_external_user_id',
    v_resolved -> 'material',
    v_resolved ->> 'material_fingerprint',
    gen_random_uuid(),
    1,
    v_now + interval '5 minutes'
  )
  RETURNING * INTO v_operation;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'operation_claimed',
    'operation_id', v_operation.id,
    'attempt_token', v_operation.attempt_token,
    'status', v_operation.status,
    'provider_external_user_id', v_operation.provider_external_user_id,
    'material', v_operation.material,
    'material_fingerprint', v_operation.material_fingerprint
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_wix_create_writeback(
  p_operation_id uuid,
  p_attempt_token uuid,
  p_status text,
  p_provider_booking_id text,
  p_provider_revision text,
  p_result_fingerprint text,
  p_error_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_operation public.wix_create_writeback_operations%ROWTYPE;
  v_existing_wix_id text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_status NOT IN ('succeeded', 'failed', 'unknown')
     OR p_result_fingerprint !~ '^[0-9a-f]{64}$'
     OR (p_status = 'succeeded'
       AND nullif(trim(p_provider_booking_id), '') IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_completion');
  END IF;

  SELECT *
  INTO v_operation
  FROM public.wix_create_writeback_operations
  WHERE id = p_operation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'operation_not_found');
  END IF;

  IF v_operation.status = 'succeeded' THEN
    IF p_status <> 'succeeded'
       OR v_operation.provider_booking_id IS DISTINCT FROM nullif(trim(p_provider_booking_id), '')
       OR v_operation.provider_revision IS DISTINCT FROM nullif(trim(p_provider_revision), '')
       OR v_operation.result_fingerprint IS DISTINCT FROM p_result_fingerprint THEN
      RETURN jsonb_build_object('success', false, 'code', 'completion_conflict');
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'code', 'completion_replay',
      'status', v_operation.status,
      'provider_booking_id', v_operation.provider_booking_id
    );
  END IF;

  IF v_operation.status NOT IN ('sending', 'reconciling')
     OR v_operation.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN jsonb_build_object('success', false, 'code', 'claim_mismatch');
  END IF;

  IF p_status = 'succeeded' THEN
    SELECT b.wix_booking_id
    INTO v_existing_wix_id
    FROM public.bookings b
    WHERE b.id = v_operation.booking_id
      AND b.salon_id = v_operation.salon_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'booking_not_found');
    END IF;
    IF v_existing_wix_id IS NOT NULL
       AND v_existing_wix_id <> trim(p_provider_booking_id) THEN
      UPDATE public.wix_create_writeback_operations
      SET status = 'unknown',
          attempt_token = NULL,
          lease_expires_at = NULL,
          next_reconcile_at = v_now + interval '5 minutes',
          result_fingerprint = p_result_fingerprint,
          error_code = 'provider_binding_conflict',
          updated_at = v_now
      WHERE id = v_operation.id;
      RETURN jsonb_build_object('success', false, 'code', 'provider_binding_conflict');
    END IF;

    UPDATE public.bookings
    SET wix_booking_id = trim(p_provider_booking_id)
    WHERE id = v_operation.booking_id
      AND salon_id = v_operation.salon_id
      AND (wix_booking_id IS NULL OR wix_booking_id = trim(p_provider_booking_id));

    UPDATE public.wix_create_writeback_operations
    SET status = 'succeeded',
        provider_booking_id = trim(p_provider_booking_id),
        provider_revision = nullif(trim(p_provider_revision), ''),
        result_fingerprint = p_result_fingerprint,
        attempt_token = NULL,
        lease_expires_at = NULL,
        next_reconcile_at = NULL,
        error_code = NULL,
        completed_at = v_now,
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
  ELSIF p_status = 'unknown' THEN
    UPDATE public.wix_create_writeback_operations
    SET status = 'unknown',
        provider_booking_id = coalesce(
          nullif(trim(p_provider_booking_id), ''),
          provider_booking_id
        ),
        provider_revision = coalesce(
          nullif(trim(p_provider_revision), ''),
          provider_revision
        ),
        result_fingerprint = p_result_fingerprint,
        attempt_token = NULL,
        lease_expires_at = NULL,
        next_reconcile_at = v_now + interval '2 minutes',
        error_code = coalesce(nullif(trim(p_error_code), ''), 'provider_outcome_unknown'),
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
  ELSE
    UPDATE public.wix_create_writeback_operations
    SET status = 'failed',
        result_fingerprint = p_result_fingerprint,
        attempt_token = NULL,
        lease_expires_at = NULL,
        next_reconcile_at = NULL,
        error_code = coalesce(nullif(trim(p_error_code), ''), 'provider_request_failed'),
        completed_at = v_now,
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'operation_completed',
    'operation_id', v_operation.id,
    'status', v_operation.status,
    'provider_booking_id', v_operation.provider_booking_id,
    'next_reconcile_at', v_operation.next_reconcile_at
  );
END;
$$;

REVOKE ALL ON FUNCTION
  public.resolve_wix_create_writeback_material(uuid, uuid),
  public.claim_wix_create_writeback(uuid, uuid),
  public.complete_wix_create_writeback(uuid, uuid, text, text, text, text, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.resolve_wix_create_writeback_material(uuid, uuid),
  public.claim_wix_create_writeback(uuid, uuid),
  public.complete_wix_create_writeback(uuid, uuid, text, text, text, text, text)
TO service_role;

COMMENT ON TABLE public.wix_create_writeback_operations IS
  'PII-free durable NailIQ-to-Wix create claims. Ambiguous sends are reconciliation-only and must be found by provider externalUserId before binding.';
COMMENT ON FUNCTION public.claim_wix_create_writeback(uuid, uuid) IS
  'Single-winner create claim. An expired or unknown send becomes reconciliation_claimed and is never automatically redispatched.';
COMMENT ON FUNCTION public.complete_wix_create_writeback(uuid, uuid, text, text, text, text, text) IS
  'Atomically records Wix outcome and binds bookings.wix_booking_id only for an exact claimed operation.';

-- Confirm/cancel/decline use the same at-most-once rule. A response-loss retry
-- first reads the provider's revisioned booking status. If the target state is
-- not visible, the operation stays unknown for operator review; it is not
-- automatically dispatched a second time.
CREATE TABLE public.wix_lifecycle_writeback_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE RESTRICT,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('confirm', 'cancel', 'decline')),
  target_status text NOT NULL CHECK (target_status IN ('CONFIRMED', 'CANCELED', 'DECLINED')),
  status text NOT NULL CHECK (status IN ('sending', 'reconciling', 'succeeded', 'failed', 'unknown')),
  provider_account_fingerprint text NOT NULL CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  provider_booking_id text NOT NULL CHECK (length(provider_booking_id) BETWEEN 1 AND 255 AND provider_booking_id !~ '[[:cntrl:]]'),
  material jsonb NOT NULL CHECK (jsonb_typeof(material) = 'object'),
  material_fingerprint text NOT NULL CHECK (material_fingerprint ~ '^[0-9a-f]{64}$'),
  provider_revision text,
  result_fingerprint text CHECK (result_fingerprint IS NULL OR result_fingerprint ~ '^[0-9a-f]{64}$'),
  attempt_token uuid,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_expires_at timestamptz,
  next_reconcile_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (booking_id, action),
  CONSTRAINT wix_lifecycle_writeback_attempt_shape CHECK (
    (status IN ('sending', 'reconciling') AND attempt_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status IN ('succeeded', 'failed', 'unknown') AND attempt_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT wix_lifecycle_writeback_completion_shape CHECK (
    (status = 'succeeded' AND result_fingerprint IS NOT NULL AND completed_at IS NOT NULL)
    OR status <> 'succeeded'
  )
);

CREATE INDEX wix_lifecycle_writeback_salon_status_idx
  ON public.wix_lifecycle_writeback_operations (salon_id, status, created_at);
CREATE INDEX wix_lifecycle_writeback_reconciliation_due_idx
  ON public.wix_lifecycle_writeback_operations (next_reconcile_at, created_at)
  WHERE status IN ('unknown', 'reconciling');

ALTER TABLE public.wix_lifecycle_writeback_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wix_lifecycle_writeback_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.wix_lifecycle_writeback_operations
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.wix_lifecycle_writeback_operations TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_wix_lifecycle_writeback_material(
  p_salon_id uuid,
  p_booking_id uuid,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_role text := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_booking public.bookings%ROWTYPE;
  v_site_id text;
  v_material jsonb;
  v_target text;
BEGIN
  IF v_role <> 'service_role' THEN RETURN jsonb_build_object('success', false, 'code', 'unauthorized'); END IF;
  IF p_action NOT IN ('confirm', 'cancel', 'decline') THEN RETURN jsonb_build_object('success', false, 'code', 'invalid_action'); END IF;
  SELECT b.* INTO v_booking FROM public.bookings b WHERE b.id=p_booking_id AND b.salon_id=p_salon_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'code', 'booking_not_found'); END IF;
  IF nullif(trim(v_booking.wix_booking_id), '') IS NULL THEN RETURN jsonb_build_object('success', false, 'code', 'provider_booking_not_linked'); END IF;
  IF (p_action='confirm' AND v_booking.status<>'confirmed') OR (p_action IN ('cancel','decline') AND v_booking.status<>'cancelled') THEN
    RETURN jsonb_build_object('success', false, 'code', 'local_state_mismatch');
  END IF;
  SELECT wi.site_id INTO v_site_id FROM public.wix_integrations wi WHERE wi.salon_id=p_salon_id AND wi.enabled=true;
  IF NOT FOUND OR nullif(trim(v_site_id), '') IS NULL THEN RETURN jsonb_build_object('success', false, 'code', 'integration_not_ready'); END IF;
  v_target := CASE p_action WHEN 'confirm' THEN 'CONFIRMED' WHEN 'cancel' THEN 'CANCELED' ELSE 'DECLINED' END;
  v_material := jsonb_build_object(
    'contract_version',1,'provider','wix','operation_kind','booking_lifecycle','action',p_action,
    'target_status',v_target,'salon_id',p_salon_id::text,'booking_id',p_booking_id::text,
    'provider_booking_id',v_booking.wix_booking_id,'site_id',v_site_id,
    'provider_account_fingerprint',encode(extensions.digest(convert_to('wix'||E'\n'||v_site_id,'UTF8'),'sha256'),'hex')
  );
  RETURN jsonb_build_object(
    'success',true,'code','resolved','target_status',v_target,'material',v_material,
    'material_fingerprint',encode(extensions.digest(convert_to(v_material::text,'UTF8'),'sha256'),'hex')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_wix_lifecycle_writeback(
  p_salon_id uuid,
  p_booking_id uuid,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_role text := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_resolved jsonb;
  v_operation public.wix_lifecycle_writeback_operations%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_role <> 'service_role' THEN RETURN jsonb_build_object('success',false,'code','unauthorized'); END IF;
  IF p_action NOT IN ('confirm','cancel','decline') THEN RETURN jsonb_build_object('success',false,'code','invalid_action'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wix:lifecycle:'||p_salon_id::text||':'||p_booking_id::text||':'||p_action,0));
  SELECT * INTO v_operation FROM public.wix_lifecycle_writeback_operations
    WHERE booking_id=p_booking_id AND action=p_action FOR UPDATE;
  IF FOUND THEN
    IF v_operation.salon_id<>p_salon_id THEN RETURN jsonb_build_object('success',false,'code','salon_mismatch'); END IF;
    IF v_operation.status='succeeded' THEN RETURN jsonb_build_object('success',true,'code','operation_succeeded','operation_id',v_operation.id,'status',v_operation.status,'provider_booking_id',v_operation.provider_booking_id,'target_status',v_operation.target_status); END IF;
    IF v_operation.status='failed' THEN RETURN jsonb_build_object('success',false,'code','operation_failed','operation_id',v_operation.id,'error_code',v_operation.error_code); END IF;
    IF v_operation.status IN ('sending','reconciling') AND v_operation.lease_expires_at>v_now THEN RETURN jsonb_build_object('success',true,'code','operation_in_flight','operation_id',v_operation.id,'status',v_operation.status); END IF;
    IF v_operation.next_reconcile_at IS NOT NULL AND v_operation.next_reconcile_at>v_now THEN RETURN jsonb_build_object('success',true,'code','reconciliation_not_due','operation_id',v_operation.id,'status',v_operation.status,'next_reconcile_at',v_operation.next_reconcile_at); END IF;
    UPDATE public.wix_lifecycle_writeback_operations SET status='reconciling',attempt_token=gen_random_uuid(),attempt_count=attempt_count+1,lease_expires_at=v_now+interval '5 minutes',next_reconcile_at=NULL,error_code='provider_outcome_requires_reconciliation',updated_at=v_now WHERE id=v_operation.id RETURNING * INTO v_operation;
    RETURN jsonb_build_object('success',true,'code','reconciliation_claimed','operation_id',v_operation.id,'attempt_token',v_operation.attempt_token,'action',v_operation.action,'target_status',v_operation.target_status,'provider_booking_id',v_operation.provider_booking_id,'material_fingerprint',v_operation.material_fingerprint);
  END IF;
  v_resolved:=public.resolve_wix_lifecycle_writeback_material(p_salon_id,p_booking_id,p_action);
  IF v_resolved->>'code'<>'resolved' THEN RETURN v_resolved; END IF;
  INSERT INTO public.wix_lifecycle_writeback_operations(salon_id,booking_id,action,target_status,status,provider_account_fingerprint,provider_booking_id,material,material_fingerprint,attempt_token,attempt_count,lease_expires_at)
  VALUES(p_salon_id,p_booking_id,p_action,v_resolved->>'target_status','sending',v_resolved->'material'->>'provider_account_fingerprint',v_resolved->'material'->>'provider_booking_id',v_resolved->'material',v_resolved->>'material_fingerprint',gen_random_uuid(),1,v_now+interval '5 minutes') RETURNING * INTO v_operation;
  RETURN jsonb_build_object('success',true,'code','operation_claimed','operation_id',v_operation.id,'attempt_token',v_operation.attempt_token,'action',v_operation.action,'target_status',v_operation.target_status,'provider_booking_id',v_operation.provider_booking_id,'material_fingerprint',v_operation.material_fingerprint);
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_wix_lifecycle_writeback(
  p_operation_id uuid,
  p_attempt_token uuid,
  p_status text,
  p_provider_revision text,
  p_result_fingerprint text,
  p_error_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_role text := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_operation public.wix_lifecycle_writeback_operations%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_role<>'service_role' THEN RETURN jsonb_build_object('success',false,'code','unauthorized'); END IF;
  IF p_status NOT IN ('succeeded','failed','unknown') OR p_result_fingerprint!~'^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('success',false,'code','invalid_completion'); END IF;
  SELECT * INTO v_operation FROM public.wix_lifecycle_writeback_operations WHERE id=p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','operation_not_found'); END IF;
  IF v_operation.status='succeeded' THEN
    IF p_status<>'succeeded' OR v_operation.provider_revision IS DISTINCT FROM nullif(trim(p_provider_revision),'') OR v_operation.result_fingerprint IS DISTINCT FROM p_result_fingerprint THEN RETURN jsonb_build_object('success',false,'code','completion_conflict'); END IF;
    RETURN jsonb_build_object('success',true,'code','completion_replay','status','succeeded');
  END IF;
  IF v_operation.status NOT IN ('sending','reconciling') OR v_operation.attempt_token IS DISTINCT FROM p_attempt_token THEN RETURN jsonb_build_object('success',false,'code','claim_mismatch'); END IF;
  UPDATE public.wix_lifecycle_writeback_operations SET
    status=p_status,provider_revision=nullif(trim(p_provider_revision),''),result_fingerprint=p_result_fingerprint,
    attempt_token=NULL,lease_expires_at=NULL,
    next_reconcile_at=CASE WHEN p_status='unknown' THEN v_now+interval '2 minutes' ELSE NULL END,
    error_code=CASE WHEN p_status='succeeded' THEN NULL ELSE coalesce(nullif(trim(p_error_code),''),CASE p_status WHEN 'unknown' THEN 'provider_outcome_unknown' ELSE 'provider_request_failed' END) END,
    completed_at=CASE WHEN p_status IN ('succeeded','failed') THEN v_now ELSE NULL END,updated_at=v_now
  WHERE id=v_operation.id RETURNING * INTO v_operation;
  RETURN jsonb_build_object('success',true,'code','operation_completed','operation_id',v_operation.id,'status',v_operation.status,'target_status',v_operation.target_status,'next_reconcile_at',v_operation.next_reconcile_at);
END;
$$;

REVOKE ALL ON FUNCTION
  public.resolve_wix_lifecycle_writeback_material(uuid,uuid,text),
  public.claim_wix_lifecycle_writeback(uuid,uuid,text),
  public.complete_wix_lifecycle_writeback(uuid,uuid,text,text,text,text)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION
  public.resolve_wix_lifecycle_writeback_material(uuid,uuid,text),
  public.claim_wix_lifecycle_writeback(uuid,uuid,text),
  public.complete_wix_lifecycle_writeback(uuid,uuid,text,text,text,text)
TO service_role;

COMMENT ON TABLE public.wix_lifecycle_writeback_operations IS
  'PII-free at-most-once confirm/cancel/decline claims. Unknown outcomes are provider-read reconciliation only.';

CREATE TABLE public.wix_webhook_event_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE RESTRICT,
  provider_account_fingerprint text NOT NULL CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  site_id text NOT NULL CHECK (length(site_id) BETWEEN 1 AND 255 AND site_id !~ '[[:cntrl:]]'),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 255 AND event_id !~ '[[:cntrl:]]'),
  entity_id text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 255 AND entity_id !~ '[[:cntrl:]]'),
  event_slug text NOT NULL CHECK (event_slug IN ('created','updated','confirmed','cancelled','canceled','declined')),
  occurred_at timestamptz NOT NULL,
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  signature_verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','processed','failed','unknown')),
  claim_token uuid,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_expires_at timestamptz,
  next_reconcile_at timestamptz,
  result_fingerprint text CHECK (result_fingerprint IS NULL OR result_fingerprint ~ '^[0-9a-f]{64}$'),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (provider_account_fingerprint, event_id),
  CONSTRAINT wix_webhook_event_claim_shape CHECK (
    (status='processing' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status<>'processing' AND claim_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT wix_webhook_event_completion_shape CHECK (
    (status='processed' AND result_fingerprint IS NOT NULL AND completed_at IS NOT NULL)
    OR status<>'processed'
  )
);

CREATE INDEX wix_webhook_event_salon_status_idx
  ON public.wix_webhook_event_inbox(salon_id,status,created_at);
CREATE INDEX wix_webhook_event_reconciliation_due_idx
  ON public.wix_webhook_event_inbox(next_reconcile_at,created_at)
  WHERE status IN ('unknown','processing');
ALTER TABLE public.wix_webhook_event_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wix_webhook_event_inbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.wix_webhook_event_inbox FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.wix_webhook_event_inbox TO service_role;

CREATE OR REPLACE FUNCTION public.record_wix_webhook_event(
  p_salon_id uuid,p_site_id text,p_event_id text,p_entity_id text,p_event_slug text,
  p_occurred_at timestamptz,p_payload_fingerprint text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE
  v_role text:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','');
  v_site_id text; v_account text; v_row public.wix_webhook_event_inbox%ROWTYPE;
BEGIN
  IF v_role<>'service_role' THEN RETURN jsonb_build_object('success',false,'code','unauthorized'); END IF;
  IF nullif(trim(p_site_id),'') IS NULL OR length(p_site_id)>255 OR nullif(trim(p_event_id),'') IS NULL OR length(p_event_id)>255 OR nullif(trim(p_entity_id),'') IS NULL OR length(p_entity_id)>255 OR p_event_slug NOT IN ('created','updated','confirmed','cancelled','canceled','declined') OR p_occurred_at IS NULL OR p_payload_fingerprint!~'^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('success',false,'code','invalid_event'); END IF;
  SELECT wi.site_id INTO v_site_id FROM public.wix_integrations wi WHERE wi.salon_id=p_salon_id AND wi.enabled=true;
  IF NOT FOUND OR v_site_id IS DISTINCT FROM p_site_id THEN RETURN jsonb_build_object('success',false,'code','integration_mismatch'); END IF;
  v_account:=encode(extensions.digest(convert_to('wix'||E'\n'||v_site_id,'UTF8'),'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('wix:webhook:'||v_account||':'||p_event_id,0));
  SELECT * INTO v_row FROM public.wix_webhook_event_inbox WHERE provider_account_fingerprint=v_account AND event_id=p_event_id FOR UPDATE;
  IF FOUND THEN
    IF v_row.salon_id<>p_salon_id OR v_row.site_id<>p_site_id OR v_row.entity_id<>p_entity_id OR v_row.event_slug<>p_event_slug OR v_row.occurred_at<>p_occurred_at OR v_row.payload_fingerprint<>p_payload_fingerprint THEN RETURN jsonb_build_object('success',false,'code','event_conflict'); END IF;
    RETURN jsonb_build_object('success',true,'code','event_replay','inbox_id',v_row.id,'status',v_row.status);
  END IF;
  INSERT INTO public.wix_webhook_event_inbox(salon_id,provider_account_fingerprint,site_id,event_id,entity_id,event_slug,occurred_at,payload_fingerprint)
  VALUES(p_salon_id,v_account,p_site_id,p_event_id,p_entity_id,p_event_slug,p_occurred_at,p_payload_fingerprint) RETURNING * INTO v_row;
  RETURN jsonb_build_object('success',true,'code','event_recorded','inbox_id',v_row.id,'status',v_row.status);
END $$;

CREATE OR REPLACE FUNCTION public.claim_wix_webhook_event(p_inbox_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE
  v_role text:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','');
  v_row public.wix_webhook_event_inbox%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
  IF v_role<>'service_role' THEN RETURN jsonb_build_object('success',false,'code','unauthorized'); END IF;
  SELECT * INTO v_row FROM public.wix_webhook_event_inbox WHERE id=p_inbox_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','event_not_found'); END IF;
  IF v_row.status='processed' THEN RETURN jsonb_build_object('success',true,'code','event_processed','inbox_id',v_row.id,'status',v_row.status); END IF;
  IF v_row.status='failed' THEN RETURN jsonb_build_object('success',false,'code','event_failed','inbox_id',v_row.id,'error_code',v_row.error_code); END IF;
  IF v_row.status='processing' AND v_row.lease_expires_at>v_now THEN RETURN jsonb_build_object('success',true,'code','event_in_flight','inbox_id',v_row.id,'status',v_row.status); END IF;
  IF v_row.next_reconcile_at IS NOT NULL AND v_row.next_reconcile_at>v_now THEN RETURN jsonb_build_object('success',true,'code','reconciliation_not_due','inbox_id',v_row.id,'status',v_row.status); END IF;
  UPDATE public.wix_webhook_event_inbox SET status='processing',claim_token=gen_random_uuid(),attempt_count=attempt_count+1,lease_expires_at=v_now+interval '5 minutes',next_reconcile_at=NULL,error_code=NULL,updated_at=v_now WHERE id=v_row.id RETURNING * INTO v_row;
  RETURN jsonb_build_object('success',true,'code','event_claimed','inbox_id',v_row.id,'claim_token',v_row.claim_token,'salon_id',v_row.salon_id,'site_id',v_row.site_id,'event_id',v_row.event_id,'entity_id',v_row.entity_id,'event_slug',v_row.event_slug,'occurred_at',v_row.occurred_at,'payload_fingerprint',v_row.payload_fingerprint);
END $$;

CREATE OR REPLACE FUNCTION public.complete_wix_webhook_event(
  p_inbox_id uuid,p_claim_token uuid,p_status text,p_result_fingerprint text,p_error_code text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE
  v_role text:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','');
  v_row public.wix_webhook_event_inbox%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
  IF v_role<>'service_role' THEN RETURN jsonb_build_object('success',false,'code','unauthorized'); END IF;
  IF p_status NOT IN ('processed','failed','unknown') OR p_result_fingerprint!~'^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('success',false,'code','invalid_completion'); END IF;
  SELECT * INTO v_row FROM public.wix_webhook_event_inbox WHERE id=p_inbox_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','event_not_found'); END IF;
  IF v_row.status='processed' THEN
    IF p_status<>'processed' OR v_row.result_fingerprint<>p_result_fingerprint THEN RETURN jsonb_build_object('success',false,'code','completion_conflict'); END IF;
    RETURN jsonb_build_object('success',true,'code','completion_replay','status','processed');
  END IF;
  IF v_row.status<>'processing' OR v_row.claim_token IS DISTINCT FROM p_claim_token THEN RETURN jsonb_build_object('success',false,'code','claim_mismatch'); END IF;
  UPDATE public.wix_webhook_event_inbox SET status=p_status,result_fingerprint=p_result_fingerprint,claim_token=NULL,lease_expires_at=NULL,next_reconcile_at=CASE WHEN p_status='unknown' THEN v_now+interval '1 minute' ELSE NULL END,error_code=CASE WHEN p_status='processed' THEN NULL ELSE coalesce(nullif(trim(p_error_code),''),CASE p_status WHEN 'unknown' THEN 'event_outcome_unknown' ELSE 'event_failed' END) END,completed_at=CASE WHEN p_status IN ('processed','failed') THEN v_now ELSE NULL END,updated_at=v_now WHERE id=v_row.id RETURNING * INTO v_row;
  RETURN jsonb_build_object('success',true,'code','event_completed','inbox_id',v_row.id,'status',v_row.status,'next_reconcile_at',v_row.next_reconcile_at);
END $$;

REVOKE ALL ON FUNCTION public.record_wix_webhook_event(uuid,text,text,text,text,timestamptz,text),public.claim_wix_webhook_event(uuid),public.complete_wix_webhook_event(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_wix_webhook_event(uuid,text,text,text,text,timestamptz,text),public.claim_wix_webhook_event(uuid),public.complete_wix_webhook_event(uuid,uuid,text,text,text) TO service_role;
COMMENT ON TABLE public.wix_webhook_event_inbox IS 'Signature-verified PII-free Wix webhook event identity, claim, retry, and completion ledger.';
