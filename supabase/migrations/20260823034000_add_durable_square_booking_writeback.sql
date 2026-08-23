-- Durable NailIQ -> Square create-booking writeback contract.
--
-- This migration does not call Square and does not expose credentials. It
-- persists the immutable, PII-free identity of a provider mutation before the
-- mutation is allowed. Once dispatch begins, an ambiguous outcome can only be
-- reconciled by provider reads; it can never become a fresh create claim.

CREATE TABLE public.square_booking_writeback_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE RESTRICT,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  operation_kind text NOT NULL DEFAULT 'create_booking'
    CHECK (operation_kind = 'create_booking'),
  status text NOT NULL DEFAULT 'claimed'
    CHECK (status IN (
      'claimed', 'sending', 'unknown', 'reconciling', 'blocked', 'succeeded'
    )),
  provider_environment text NOT NULL
    CHECK (provider_environment IN ('sandbox', 'production')),
  provider_application_id text NOT NULL
    CHECK (length(provider_application_id) BETWEEN 1 AND 255
      AND provider_application_id !~ '[[:cntrl:]]'),
  provider_merchant_id text NOT NULL
    CHECK (length(provider_merchant_id) BETWEEN 1 AND 255
      AND provider_merchant_id !~ '[[:cntrl:]]'),
  provider_location_id text NOT NULL
    CHECK (length(provider_location_id) BETWEEN 1 AND 255
      AND provider_location_id !~ '[[:cntrl:]]'),
  provider_api_version text NOT NULL
    CHECK (provider_api_version = '2024-12-18'),
  provider_account_fingerprint text NOT NULL
    CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  contact_fingerprint text NOT NULL
    CHECK (contact_fingerprint ~ '^[0-9a-f]{64}$'),
  material jsonb NOT NULL
    CHECK (
      jsonb_typeof(material) = 'object'
      AND pg_column_size(material) <= 32768
      AND NOT (material ?| ARRAY[
        'client_name', 'client_phone', 'client_email', 'access_token'
      ])
    ),
  material_fingerprint text NOT NULL
    CHECK (material_fingerprint ~ '^[0-9a-f]{64}$'),
  customer_idempotency_key text NOT NULL,
  booking_idempotency_key text NOT NULL,
  provider_correlation_key text NOT NULL
    CHECK (length(provider_correlation_key) BETWEEN 1 AND 255
      AND provider_correlation_key !~ '[[:cntrl:]]'),
  provider_customer_id text
    CHECK (provider_customer_id IS NULL OR (
      length(provider_customer_id) BETWEEN 1 AND 255
      AND provider_customer_id !~ '[[:cntrl:]]'
    )),
  provider_booking_id text
    CHECK (provider_booking_id IS NULL OR (
      length(provider_booking_id) BETWEEN 1 AND 255
      AND provider_booking_id !~ '[[:cntrl:]]'
    )),
  provider_booking_version bigint
    CHECK (provider_booking_version IS NULL OR provider_booking_version >= 0),
  customer_result_fingerprint text
    CHECK (customer_result_fingerprint IS NULL
      OR customer_result_fingerprint ~ '^[0-9a-f]{64}$'),
  result_fingerprint text
    CHECK (result_fingerprint IS NULL
      OR result_fingerprint ~ '^[0-9a-f]{64}$'),
  attempt_token uuid,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_expires_at timestamptz,
  next_reconcile_at timestamptz,
  dispatched_at timestamptz,
  customer_recorded_at timestamptz,
  error_code text
    CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,96}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT square_booking_writeback_one_per_booking
    UNIQUE (salon_id, booking_id),
  CONSTRAINT square_booking_writeback_customer_key_exact CHECK (
    customer_idempotency_key = 'sqcust:' || booking_id::text
  ),
  CONSTRAINT square_booking_writeback_booking_key_exact CHECK (
    booking_idempotency_key = 'create:' || booking_id::text
  ),
  CONSTRAINT square_booking_writeback_correlation_exact CHECK (
    provider_correlation_key = 'NailIQ booking:' || booking_id::text
  ),
  CONSTRAINT square_booking_writeback_attempt_shape CHECK (
    (
      status IN ('claimed', 'sending', 'reconciling')
      AND attempt_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
    ) OR (
      status IN ('unknown', 'blocked', 'succeeded')
      AND attempt_token IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT square_booking_writeback_dispatch_shape CHECK (
    (status IN ('claimed', 'blocked') AND dispatched_at IS NULL)
    OR (status IN ('sending', 'unknown', 'reconciling', 'succeeded')
      AND dispatched_at IS NOT NULL)
  ),
  CONSTRAINT square_booking_writeback_success_shape CHECK (
    (
      status = 'succeeded'
      AND provider_customer_id IS NOT NULL
      AND provider_booking_id IS NOT NULL
      AND provider_booking_version IS NOT NULL
      AND result_fingerprint IS NOT NULL
      AND completed_at IS NOT NULL
      AND next_reconcile_at IS NULL
      AND error_code IS NULL
    ) OR status <> 'succeeded'
  )
);
CREATE UNIQUE INDEX square_booking_writeback_provider_booking_once
  ON public.square_booking_writeback_operations (
    provider_account_fingerprint, provider_booking_id
  )
  WHERE provider_booking_id IS NOT NULL;
CREATE UNIQUE INDEX square_booking_writeback_customer_key_once
  ON public.square_booking_writeback_operations (
    provider_account_fingerprint, customer_idempotency_key
  );
CREATE UNIQUE INDEX square_booking_writeback_booking_key_once
  ON public.square_booking_writeback_operations (
    provider_account_fingerprint, booking_idempotency_key
  );
CREATE UNIQUE INDEX square_booking_writeback_correlation_once
  ON public.square_booking_writeback_operations (
    provider_account_fingerprint, provider_correlation_key
  );
CREATE INDEX square_booking_writeback_reconciliation_due_idx
  ON public.square_booking_writeback_operations (
    next_reconcile_at, created_at
  )
  WHERE status IN ('unknown', 'reconciling');
ALTER TABLE public.square_booking_writeback_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.square_booking_writeback_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.square_booking_writeback_operations
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.square_booking_writeback_operations TO service_role;
CREATE OR REPLACE FUNCTION public.square_booking_writeback_contact_fingerprint(
  p_client_name text,
  p_client_phone text,
  p_client_email text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path TO ''
AS $$
  SELECT encode(
    extensions.digest(
      convert_to(
        regexp_replace(
          lower(btrim(coalesce(p_client_name, ''))),
          '[[:space:]]+',
          ' ',
          'g'
        )
        || E'\n'
        || regexp_replace(coalesce(p_client_phone, ''), '[^0-9]', '', 'g')
        || E'\n'
        || lower(btrim(coalesce(p_client_email, ''))),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;
CREATE OR REPLACE FUNCTION public.square_booking_writeback_account_fingerprint(
  p_environment text,
  p_application_id text,
  p_merchant_id text,
  p_location_id text,
  p_api_version text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path TO ''
AS $$
  SELECT encode(
    extensions.digest(
      convert_to(
        p_api_version || E'\n'
        || p_environment || E'\n'
        || btrim(p_application_id) || E'\n'
        || btrim(p_merchant_id) || E'\n'
        || btrim(p_location_id),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;
CREATE OR REPLACE FUNCTION public.resolve_square_booking_writeback_material(
  p_salon_id uuid,
  p_booking_id uuid,
  p_square_team_member_id text,
  p_square_service_variation_id text,
  p_square_service_variation_version bigint,
  p_api_version text DEFAULT '2024-12-18'
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
  v_integration public.square_integrations%ROWTYPE;
  v_service public.services%ROWTYPE;
  v_staff public.staff%ROWTYPE;
  v_contact_fingerprint text;
  v_account_fingerprint text;
  v_material_fingerprint text;
  v_start text;
  v_end text;
  v_duration integer;
  v_team_member text := nullif(btrim(p_square_team_member_id), '');
  v_variation text := nullif(btrim(p_square_service_variation_id), '');
  v_application text;
  v_merchant text;
  v_location text;
  v_customer_key text := 'sqcust:' || p_booking_id::text;
  v_booking_key text := 'create:' || p_booking_id::text;
  v_correlation text := 'NailIQ booking:' || p_booking_id::text;
  v_material jsonb;
  v_provider_material jsonb;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_api_version <> '2024-12-18'
     OR v_team_member IS NULL
     OR length(v_team_member) > 255
     OR v_team_member ~ '[[:cntrl:]]'
     OR v_variation IS NULL
     OR length(v_variation) > 255
     OR v_variation ~ '[[:cntrl:]]'
     OR p_square_service_variation_version IS NULL
     OR p_square_service_variation_version < 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_provider_material');
  END IF;

  SELECT b.*
  INTO v_booking
  FROM public.bookings b
  WHERE b.id = p_booking_id
    AND b.salon_id = p_salon_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'booking_not_found');
  END IF;
  IF nullif(btrim(v_booking.square_booking_id), '') IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'already_linked',
      'provider_booking_id', v_booking.square_booking_id
    );
  END IF;
  IF v_booking.service_id IS NULL
     OR v_booking.staff_id IS NULL
     OR v_booking.status NOT IN ('confirmed', 'pending')
     OR v_booking.deleted_at IS NOT NULL
     OR v_booking.start_time_utc IS NULL
     OR v_booking.end_time_utc IS NULL
     OR v_booking.end_time_utc <= v_booking.start_time_utc THEN
    RETURN jsonb_build_object('success', false, 'code', 'booking_not_eligible');
  END IF;

  SELECT si.*
  INTO v_integration
  FROM public.square_integrations si
  WHERE si.salon_id = p_salon_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'integration_not_found');
  END IF;
  v_application := nullif(btrim(v_integration.application_id), '');
  v_merchant := nullif(btrim(v_integration.merchant_id), '');
  v_location := nullif(btrim(v_integration.location_id), '');
  IF v_integration.enabled IS DISTINCT FROM true
     OR v_integration.sync_push_create IS DISTINCT FROM true
     OR v_integration.environment NOT IN ('sandbox', 'production')
     OR v_application IS NULL
     OR v_merchant IS NULL
     OR v_location IS NULL
     OR nullif(btrim(v_integration.access_token), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'integration_not_ready');
  END IF;

  SELECT s.*
  INTO v_service
  FROM public.services s
  WHERE s.id = v_booking.service_id
    AND s.salon_id = p_salon_id
    AND s.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'service_not_eligible');
  END IF;

  SELECT st.*
  INTO v_staff
  FROM public.staff st
  WHERE st.id = v_booking.staff_id
    AND st.salon_id = p_salon_id
    AND st.deleted_at IS NULL
    AND st.status = 'active';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'staff_not_eligible');
  END IF;
  IF nullif(btrim(v_staff.square_team_member_id), '') IS DISTINCT FROM v_team_member THEN
    RETURN jsonb_build_object('success', false, 'code', 'staff_mapping_mismatch');
  END IF;

  v_contact_fingerprint := public.square_booking_writeback_contact_fingerprint(
    v_booking.client_name,
    v_booking.client_phone,
    v_booking.client_email
  );
  v_account_fingerprint := public.square_booking_writeback_account_fingerprint(
    v_integration.environment,
    v_application,
    v_merchant,
    v_location,
    p_api_version
  );
  v_start := to_char(
    v_booking.start_time_utc AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_end := to_char(
    v_booking.end_time_utc AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_duration := greatest(
    5,
    round(extract(epoch FROM (
      v_booking.end_time_utc - v_booking.start_time_utc
    )) / 60.0)::integer
  );

  v_material := jsonb_build_object(
    'contract_version', 1,
    'provider', 'square',
    'operation_kind', 'create_booking',
    'api_version', p_api_version,
    'salon_id', p_salon_id::text,
    'booking_id', p_booking_id::text,
    'booking_service_id', v_booking.service_id::text,
    'booking_staff_id', v_booking.staff_id::text,
    'booking_status', v_booking.status,
    'booking_deleted_at', NULL,
    'start_time_utc', v_start,
    'end_time_utc', v_end,
    'duration_minutes', v_duration,
    'service_deleted_at', NULL,
    'service_square_catalog_item_id',
      nullif(btrim(v_service.square_catalog_item_id), ''),
    'staff_status', v_staff.status,
    'staff_deleted_at', NULL,
    'square_team_member_id', v_team_member,
    'square_service_variation_id', v_variation,
    'square_service_variation_version', p_square_service_variation_version,
    'provider_environment', v_integration.environment,
    'provider_application_id', v_application,
    'provider_merchant_id', v_merchant,
    'provider_location_id', v_location,
    'provider_account_fingerprint', v_account_fingerprint,
    'contact_fingerprint', v_contact_fingerprint,
    'provider_correlation_key', v_correlation,
    'customer_idempotency_key', v_customer_key,
    'booking_idempotency_key', v_booking_key
  );
  v_material_fingerprint := encode(
    extensions.digest(convert_to(v_material::text, 'UTF8'), 'sha256'),
    'hex'
  );

  -- This response is transient and service-role-only. Raw contact values are
  -- never copied into the operation row or its material JSON.
  v_provider_material := jsonb_build_object(
    'contract_version', 1,
    'provider', 'square',
    'operation_kind', 'create_booking',
    'api_version', p_api_version,
    'salon_id', p_salon_id::text,
    'booking_id', p_booking_id::text,
    'provider_environment', v_integration.environment,
    'provider_application_id', v_application,
    'provider_merchant_id', v_merchant,
    'provider_location_id', v_location,
    'provider_account_fingerprint', v_account_fingerprint,
    'client_name', v_booking.client_name,
    'client_phone', nullif(btrim(v_booking.client_phone), ''),
    'client_email', nullif(btrim(v_booking.client_email), ''),
    'contact_fingerprint', v_contact_fingerprint,
    'start_time_utc', v_start,
    'end_time_utc', v_end,
    'duration_minutes', v_duration,
    'square_team_member_id', v_team_member,
    'square_service_variation_id', v_variation,
    'square_service_variation_version', p_square_service_variation_version,
    'seller_note', v_correlation,
    'customer_reference_id', 'booking:' || p_booking_id::text,
    'customer_idempotency_key', v_customer_key,
    'booking_idempotency_key', v_booking_key
  );

  RETURN jsonb_build_object(
    'success', true,
    'code', 'resolved',
    'material', v_material,
    'material_fingerprint', v_material_fingerprint,
    'contact_fingerprint', v_contact_fingerprint,
    'provider_account_fingerprint', v_account_fingerprint,
    'customer_idempotency_key', v_customer_key,
    'booking_idempotency_key', v_booking_key,
    'provider_correlation_key', v_correlation,
    'provider_material', v_provider_material
  );
END;
$$;
CREATE OR REPLACE FUNCTION public.square_booking_writeback_local_material_matches(
  p_operation_id uuid
)
RETURNS boolean
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
  v_operation public.square_booking_writeback_operations%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_service public.services%ROWTYPE;
  v_staff public.staff%ROWTYPE;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN false;
  END IF;
  SELECT o.* INTO v_operation
  FROM public.square_booking_writeback_operations o
  WHERE o.id = p_operation_id;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT b.* INTO v_booking
  FROM public.bookings b
  WHERE b.id = v_operation.booking_id
    AND b.salon_id = v_operation.salon_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT s.* INTO v_service
  FROM public.services s
  WHERE s.id = v_booking.service_id
    AND s.salon_id = v_operation.salon_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT st.* INTO v_staff
  FROM public.staff st
  WHERE st.id = v_booking.staff_id
    AND st.salon_id = v_operation.salon_id;
  IF NOT FOUND THEN RETURN false; END IF;

  RETURN v_booking.service_id::text = v_operation.material ->> 'booking_service_id'
    AND v_booking.staff_id::text = v_operation.material ->> 'booking_staff_id'
    AND v_booking.status = v_operation.material ->> 'booking_status'
    AND v_booking.deleted_at IS NULL
    AND to_char(
      v_booking.start_time_utc AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) = v_operation.material ->> 'start_time_utc'
    AND to_char(
      v_booking.end_time_utc AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) = v_operation.material ->> 'end_time_utc'
    AND public.square_booking_writeback_contact_fingerprint(
      v_booking.client_name,
      v_booking.client_phone,
      v_booking.client_email
    ) = v_operation.contact_fingerprint
    AND v_service.deleted_at IS NULL
    AND coalesce(nullif(btrim(v_service.square_catalog_item_id), ''), '')
      = coalesce(v_operation.material ->> 'service_square_catalog_item_id', '')
    AND v_staff.status = v_operation.material ->> 'staff_status'
    AND v_staff.deleted_at IS NULL
    AND nullif(btrim(v_staff.square_team_member_id), '')
      = v_operation.material ->> 'square_team_member_id';
END;
$$;
CREATE OR REPLACE FUNCTION public.claim_square_booking_writeback(
  p_salon_id uuid,
  p_booking_id uuid,
  p_square_team_member_id text,
  p_square_service_variation_id text,
  p_square_service_variation_version bigint,
  p_expected_contact_fingerprint text,
  p_api_version text DEFAULT '2024-12-18'
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
  v_operation public.square_booking_writeback_operations%ROWTYPE;
  v_resolved jsonb;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_expected_contact_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_contact_fingerprint');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'square:booking:create:' || p_salon_id::text || ':' || p_booking_id::text,
    0
  ));
  SELECT o.*
  INTO v_operation
  FROM public.square_booking_writeback_operations o
  WHERE o.salon_id = p_salon_id
    AND o.booking_id = p_booking_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_operation.status = 'succeeded' THEN
      RETURN jsonb_build_object(
        'success', true,
        'code', 'operation_succeeded',
        'operation_id', v_operation.id,
        'status', v_operation.status,
        'provider_booking_id', v_operation.provider_booking_id,
        'provider_customer_id', v_operation.provider_customer_id,
        'provider_booking_version', v_operation.provider_booking_version,
        'material', v_operation.material,
        'material_fingerprint', v_operation.material_fingerprint,
        'provider_account_fingerprint', v_operation.provider_account_fingerprint
      );
    END IF;
    IF v_operation.status = 'blocked' THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'operation_blocked',
        'operation_id', v_operation.id,
        'status', v_operation.status,
        'error_code', v_operation.error_code
      );
    END IF;
    IF v_operation.status = 'unknown' THEN
      RETURN jsonb_build_object(
        'success', true,
        'code', 'reconciliation_required',
        'operation_id', v_operation.id,
        'status', v_operation.status,
        'next_reconcile_at', v_operation.next_reconcile_at,
        'material', v_operation.material,
        'material_fingerprint', v_operation.material_fingerprint,
        'provider_account_fingerprint', v_operation.provider_account_fingerprint
      );
    END IF;
    IF v_operation.status = 'sending' THEN
      IF v_operation.lease_expires_at <= v_now THEN
        UPDATE public.square_booking_writeback_operations
        SET status = 'unknown',
            attempt_token = NULL,
            lease_expires_at = NULL,
            next_reconcile_at = v_now,
            error_code = 'dispatch_lease_expired',
            updated_at = v_now
        WHERE id = v_operation.id
        RETURNING * INTO v_operation;
        RETURN jsonb_build_object(
          'success', true,
          'code', 'reconciliation_required',
          'operation_id', v_operation.id,
          'status', v_operation.status,
          'next_reconcile_at', v_operation.next_reconcile_at,
          'material', v_operation.material,
          'material_fingerprint', v_operation.material_fingerprint,
          'provider_account_fingerprint', v_operation.provider_account_fingerprint
        );
      END IF;
      RETURN jsonb_build_object(
        'success', true,
        'code', 'operation_in_flight',
        'operation_id', v_operation.id,
        'status', v_operation.status,
        'lease_expires_at', v_operation.lease_expires_at
      );
    END IF;
    IF v_operation.status = 'reconciling' THEN
      IF v_operation.lease_expires_at <= v_now THEN
        UPDATE public.square_booking_writeback_operations
        SET status = 'unknown',
            attempt_token = NULL,
            lease_expires_at = NULL,
            next_reconcile_at = v_now,
            error_code = 'reconciliation_lease_expired',
            updated_at = v_now
        WHERE id = v_operation.id
        RETURNING * INTO v_operation;
        RETURN jsonb_build_object(
          'success', true,
          'code', 'reconciliation_required',
          'operation_id', v_operation.id,
          'status', v_operation.status,
          'next_reconcile_at', v_operation.next_reconcile_at,
          'material', v_operation.material,
          'material_fingerprint', v_operation.material_fingerprint,
          'provider_account_fingerprint', v_operation.provider_account_fingerprint
        );
      END IF;
      RETURN jsonb_build_object(
        'success', true,
        'code', 'operation_in_flight',
        'operation_id', v_operation.id,
        'status', v_operation.status,
        'lease_expires_at', v_operation.lease_expires_at
      );
    END IF;
    IF v_operation.status = 'claimed'
       AND v_operation.lease_expires_at > v_now THEN
      RETURN jsonb_build_object(
        'success', true,
        'code', 'operation_in_flight',
        'operation_id', v_operation.id,
        'status', v_operation.status,
        'lease_expires_at', v_operation.lease_expires_at
      );
    END IF;

    -- An expired pre-dispatch claim is the only state that may become a new
    -- mutation authorization, and only when every pinned byte is unchanged.
    PERFORM 1 FROM public.bookings b
      WHERE b.id = p_booking_id AND b.salon_id = p_salon_id FOR UPDATE;
    PERFORM 1 FROM public.square_integrations si
      WHERE si.salon_id = p_salon_id FOR UPDATE;
    v_resolved := public.resolve_square_booking_writeback_material(
      p_salon_id,
      p_booking_id,
      p_square_team_member_id,
      p_square_service_variation_id,
      p_square_service_variation_version,
      p_api_version
    );
    IF v_resolved ->> 'code' <> 'resolved'
       OR v_resolved ->> 'contact_fingerprint'
          IS DISTINCT FROM p_expected_contact_fingerprint
       OR v_resolved ->> 'material_fingerprint'
          IS DISTINCT FROM v_operation.material_fingerprint THEN
      UPDATE public.square_booking_writeback_operations
      SET status = 'blocked',
          attempt_token = NULL,
          lease_expires_at = NULL,
          error_code = CASE
            WHEN v_resolved ->> 'provider_account_fingerprint'
                 IS DISTINCT FROM v_operation.provider_account_fingerprint
              THEN 'provider_context_changed'
            ELSE 'material_changed_before_dispatch'
          END,
          completed_at = v_now,
          updated_at = v_now
      WHERE id = v_operation.id
      RETURNING * INTO v_operation;
      RETURN jsonb_build_object(
        'success', false,
        'code', 'operation_blocked',
        'operation_id', v_operation.id,
        'status', v_operation.status,
        'error_code', v_operation.error_code
      );
    END IF;

    UPDATE public.square_booking_writeback_operations
    SET attempt_token = gen_random_uuid(),
        attempt_count = attempt_count + 1,
        lease_expires_at = v_now + interval '5 minutes',
        error_code = NULL,
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
    RETURN jsonb_build_object(
      'success', true,
      'code', 'operation_claimed',
      'operation_id', v_operation.id,
      'attempt_token', v_operation.attempt_token,
      'status', v_operation.status,
      'material', v_operation.material,
      'material_fingerprint', v_operation.material_fingerprint,
      'contact_fingerprint', v_operation.contact_fingerprint,
      'provider_account_fingerprint', v_operation.provider_account_fingerprint,
      'customer_idempotency_key', v_operation.customer_idempotency_key,
      'booking_idempotency_key', v_operation.booking_idempotency_key,
      'provider_correlation_key', v_operation.provider_correlation_key
    );
  END IF;

  PERFORM 1 FROM public.bookings b
    WHERE b.id = p_booking_id AND b.salon_id = p_salon_id FOR UPDATE;
  PERFORM 1 FROM public.square_integrations si
    WHERE si.salon_id = p_salon_id FOR UPDATE;
  v_resolved := public.resolve_square_booking_writeback_material(
    p_salon_id,
    p_booking_id,
    p_square_team_member_id,
    p_square_service_variation_id,
    p_square_service_variation_version,
    p_api_version
  );
  IF v_resolved ->> 'code' <> 'resolved' THEN
    RETURN v_resolved;
  END IF;
  IF v_resolved ->> 'contact_fingerprint'
     IS DISTINCT FROM p_expected_contact_fingerprint THEN
    RETURN jsonb_build_object('success', false, 'code', 'contact_changed');
  END IF;

  INSERT INTO public.square_booking_writeback_operations (
    salon_id,
    booking_id,
    status,
    provider_environment,
    provider_application_id,
    provider_merchant_id,
    provider_location_id,
    provider_api_version,
    provider_account_fingerprint,
    contact_fingerprint,
    material,
    material_fingerprint,
    customer_idempotency_key,
    booking_idempotency_key,
    provider_correlation_key,
    attempt_token,
    attempt_count,
    lease_expires_at
  ) VALUES (
    p_salon_id,
    p_booking_id,
    'claimed',
    v_resolved -> 'material' ->> 'provider_environment',
    v_resolved -> 'material' ->> 'provider_application_id',
    v_resolved -> 'material' ->> 'provider_merchant_id',
    v_resolved -> 'material' ->> 'provider_location_id',
    v_resolved -> 'material' ->> 'api_version',
    v_resolved ->> 'provider_account_fingerprint',
    v_resolved ->> 'contact_fingerprint',
    v_resolved -> 'material',
    v_resolved ->> 'material_fingerprint',
    v_resolved ->> 'customer_idempotency_key',
    v_resolved ->> 'booking_idempotency_key',
    v_resolved ->> 'provider_correlation_key',
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
    'material', v_operation.material,
    'material_fingerprint', v_operation.material_fingerprint,
    'contact_fingerprint', v_operation.contact_fingerprint,
    'provider_account_fingerprint', v_operation.provider_account_fingerprint,
    'customer_idempotency_key', v_operation.customer_idempotency_key,
    'booking_idempotency_key', v_operation.booking_idempotency_key,
    'provider_correlation_key', v_operation.provider_correlation_key
  );
END;
$$;
