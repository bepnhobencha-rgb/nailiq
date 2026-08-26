-- Forward-only completion of the durable Square create-booking writeback.
--
-- Migration 20260823034000 is already present in migration history and is
-- immutable. This migration only replaces/adds functions and grants; it does
-- not rewrite that historical file or make any provider call.

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
VOLATILE
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
  v_service_mapping_basis text;
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
  IF p_api_version IS DISTINCT FROM '2024-12-18'
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

  -- Lock order used by all writeback RPCs: operation (when present), booking,
  -- integration, service, staff. Locks are held only for this DB statement.
  SELECT b.*
  INTO v_booking
  FROM public.bookings b
  WHERE b.id = p_booking_id
    AND b.salon_id = p_salon_id
  FOR UPDATE;
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
  WHERE si.salon_id = p_salon_id
  FOR UPDATE;
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
    AND s.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'service_not_eligible');
  END IF;
  v_service_mapping_basis := regexp_replace(
    regexp_replace(
      lower(v_service.name),
      '^[[:space:]]*[0-9]+[[:space:]]*[-.][[:space:]]*',
      '',
      'g'
    ),
    '[^a-z0-9]',
    '',
    'g'
  );
  IF v_service_mapping_basis = '' THEN
    RETURN jsonb_build_object('success', false, 'code', 'service_mapping_invalid');
  END IF;

  SELECT st.*
  INTO v_staff
  FROM public.staff st
  WHERE st.id = v_booking.staff_id
    AND st.salon_id = p_salon_id
    AND st.deleted_at IS NULL
    AND st.status = 'active'
  FOR UPDATE;
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
    'service_mapping_basis', v_service_mapping_basis,
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

  -- Raw contact data exists only in this service-role RPC response. The table
  -- stores contact_fingerprint, never the raw values or access token.
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
    'service_mapping_basis', v_service_mapping_basis,
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

CREATE OR REPLACE FUNCTION public.begin_square_booking_writeback_dispatch(
  p_operation_id uuid,
  p_attempt_token uuid,
  p_expected_material_fingerprint text
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
  IF p_expected_material_fingerprint IS NULL
     OR p_expected_material_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_material_fingerprint');
  END IF;

  SELECT o.* INTO v_operation
  FROM public.square_booking_writeback_operations o
  WHERE o.id = p_operation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'operation_not_found');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'square:booking:create:' || v_operation.salon_id::text || ':'
      || v_operation.booking_id::text,
    0
  ));
  SELECT o.* INTO v_operation
  FROM public.square_booking_writeback_operations o
  WHERE o.id = p_operation_id
  FOR UPDATE;

  IF v_operation.status = 'succeeded' THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'operation_succeeded',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'provider_booking_id', v_operation.provider_booking_id
    );
  END IF;
  IF v_operation.status IN ('sending', 'unknown', 'reconciling') THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'reconciliation_required',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'next_reconcile_at', v_operation.next_reconcile_at
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
  IF v_operation.status <> 'claimed'
     OR v_operation.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN jsonb_build_object('success', false, 'code', 'claim_mismatch');
  END IF;
  IF v_operation.lease_expires_at <= v_now THEN
    RETURN jsonb_build_object('success', false, 'code', 'claim_expired');
  END IF;
  IF v_operation.material_fingerprint
     IS DISTINCT FROM p_expected_material_fingerprint THEN
    RETURN jsonb_build_object('success', false, 'code', 'material_fingerprint_mismatch');
  END IF;

  v_resolved := public.resolve_square_booking_writeback_material(
    v_operation.salon_id,
    v_operation.booking_id,
    v_operation.material ->> 'square_team_member_id',
    v_operation.material ->> 'square_service_variation_id',
    (v_operation.material ->> 'square_service_variation_version')::bigint,
    v_operation.provider_api_version
  );
  IF v_resolved ->> 'code' <> 'resolved'
     OR v_resolved ->> 'material_fingerprint'
        IS DISTINCT FROM v_operation.material_fingerprint
     OR v_resolved ->> 'contact_fingerprint'
        IS DISTINCT FROM v_operation.contact_fingerprint
     OR v_resolved ->> 'provider_account_fingerprint'
        IS DISTINCT FROM v_operation.provider_account_fingerprint THEN
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
  SET status = 'sending',
      dispatched_at = v_now,
      updated_at = v_now
  WHERE id = v_operation.id
    AND status = 'claimed'
    AND attempt_token = p_attempt_token
  RETURNING * INTO v_operation;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'claim_mismatch');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'dispatch_authorized',
    'operation_id', v_operation.id,
    'attempt_token', v_operation.attempt_token,
    'status', v_operation.status,
    'material_fingerprint', v_operation.material_fingerprint,
    'provider_account_fingerprint', v_operation.provider_account_fingerprint,
    'customer_idempotency_key', v_operation.customer_idempotency_key,
    'booking_idempotency_key', v_operation.booking_idempotency_key,
    'provider_correlation_key', v_operation.provider_correlation_key,
    'provider_material', v_resolved -> 'provider_material'
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
  IF v_role <> 'service_role' THEN RETURN false; END IF;
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
    AND regexp_replace(
      regexp_replace(
        lower(v_service.name),
        '^[[:space:]]*[0-9]+[[:space:]]*[-.][[:space:]]*',
        '',
        'g'
      ),
      '[^a-z0-9]',
      '',
      'g'
    ) = v_operation.material ->> 'service_mapping_basis'
    AND coalesce(nullif(btrim(v_service.square_catalog_item_id), ''), '')
      = coalesce(v_operation.material ->> 'service_square_catalog_item_id', '')
    AND v_staff.status = v_operation.material ->> 'staff_status'
    AND v_staff.deleted_at IS NULL
    AND nullif(btrim(v_staff.square_team_member_id), '')
      = v_operation.material ->> 'square_team_member_id';
END;
$$;

CREATE OR REPLACE FUNCTION public.record_square_booking_writeback_customer(
  p_operation_id uuid,
  p_attempt_token uuid,
  p_provider_customer_id text,
  p_result_fingerprint text
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
  v_customer_id text := nullif(btrim(p_provider_customer_id), '');
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF v_customer_id IS NULL
     OR length(v_customer_id) > 255
     OR v_customer_id ~ '[[:cntrl:]]'
     OR p_result_fingerprint IS NULL
     OR p_result_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_customer_receipt');
  END IF;

  SELECT o.* INTO v_operation
  FROM public.square_booking_writeback_operations o
  WHERE o.id = p_operation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'operation_not_found');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'square:booking:create:' || v_operation.salon_id::text || ':'
      || v_operation.booking_id::text,
    0
  ));
  SELECT o.* INTO v_operation
  FROM public.square_booking_writeback_operations o
  WHERE o.id = p_operation_id
  FOR UPDATE;

  IF v_operation.status = 'succeeded' THEN
    IF v_operation.provider_customer_id IS DISTINCT FROM v_customer_id THEN
      RETURN jsonb_build_object('success', false, 'code', 'customer_receipt_conflict');
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'code', 'operation_succeeded',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'provider_customer_id', v_operation.provider_customer_id
    );
  END IF;
  IF v_operation.status <> 'sending'
     OR v_operation.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN jsonb_build_object('success', false, 'code', 'claim_mismatch');
  END IF;
  IF v_operation.provider_customer_id IS NOT NULL
     AND v_operation.provider_customer_id <> v_customer_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'customer_receipt_conflict');
  END IF;
  IF v_operation.lease_expires_at <= v_now THEN
    UPDATE public.square_booking_writeback_operations
    SET status = 'unknown',
        provider_customer_id = v_customer_id,
        customer_result_fingerprint = p_result_fingerprint,
        customer_recorded_at = v_now,
        attempt_token = NULL,
        lease_expires_at = NULL,
        next_reconcile_at = v_now + interval '2 minutes',
        error_code = 'customer_receipt_after_lease',
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
    RETURN jsonb_build_object(
      'success', false,
      'code', 'reconciliation_required',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'error_code', v_operation.error_code,
      'next_reconcile_at', v_operation.next_reconcile_at
    );
  END IF;

  v_resolved := public.resolve_square_booking_writeback_material(
    v_operation.salon_id,
    v_operation.booking_id,
    v_operation.material ->> 'square_team_member_id',
    v_operation.material ->> 'square_service_variation_id',
    (v_operation.material ->> 'square_service_variation_version')::bigint,
    v_operation.provider_api_version
  );
  IF v_resolved ->> 'code' <> 'resolved'
     OR v_resolved ->> 'material_fingerprint'
        IS DISTINCT FROM v_operation.material_fingerprint
     OR v_resolved ->> 'provider_account_fingerprint'
        IS DISTINCT FROM v_operation.provider_account_fingerprint THEN
    UPDATE public.square_booking_writeback_operations
    SET status = 'unknown',
        provider_customer_id = v_customer_id,
        customer_result_fingerprint = p_result_fingerprint,
        customer_recorded_at = v_now,
        attempt_token = NULL,
        lease_expires_at = NULL,
        next_reconcile_at = v_now + interval '2 minutes',
        error_code = CASE
          WHEN v_resolved ->> 'provider_account_fingerprint'
               IS DISTINCT FROM v_operation.provider_account_fingerprint
            THEN 'provider_context_changed_after_customer'
          ELSE 'material_changed_after_customer'
        END,
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
    RETURN jsonb_build_object(
      'success', false,
      'code', 'reconciliation_required',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'error_code', v_operation.error_code,
      'next_reconcile_at', v_operation.next_reconcile_at
    );
  END IF;

  UPDATE public.square_booking_writeback_operations
  SET provider_customer_id = v_customer_id,
      customer_result_fingerprint = p_result_fingerprint,
      customer_recorded_at = coalesce(customer_recorded_at, v_now),
      lease_expires_at = v_now + interval '5 minutes',
      updated_at = v_now
  WHERE id = v_operation.id
  RETURNING * INTO v_operation;
  RETURN jsonb_build_object(
    'success', true,
    'code', 'customer_recorded',
    'operation_id', v_operation.id,
    'attempt_token', v_operation.attempt_token,
    'status', v_operation.status,
    'provider_customer_id', v_operation.provider_customer_id,
    'material_fingerprint', v_operation.material_fingerprint
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_square_booking_writeback_unknown(
  p_operation_id uuid,
  p_attempt_token uuid,
  p_error_code text,
  p_result_fingerprint text,
  p_provider_booking_id text DEFAULT NULL,
  p_provider_customer_id text DEFAULT NULL,
  p_provider_booking_version bigint DEFAULT NULL
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
  v_booking_id text := nullif(btrim(p_provider_booking_id), '');
  v_customer_id text := nullif(btrim(p_provider_customer_id), '');
  v_error text := nullif(btrim(p_error_code), '');
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF v_error IS NULL
     OR v_error !~ '^[a-z0-9_]{1,96}$'
     OR p_result_fingerprint IS NULL
     OR p_result_fingerprint !~ '^[0-9a-f]{64}$'
     OR (v_booking_id IS NOT NULL AND (
       length(v_booking_id) > 255 OR v_booking_id ~ '[[:cntrl:]]'
     ))
     OR (v_customer_id IS NOT NULL AND (
       length(v_customer_id) > 255 OR v_customer_id ~ '[[:cntrl:]]'
     ))
     OR (p_provider_booking_version IS NOT NULL
       AND p_provider_booking_version < 0) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_unknown_receipt');
  END IF;

  SELECT o.* INTO v_operation
  FROM public.square_booking_writeback_operations o
  WHERE o.id = p_operation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'operation_not_found');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'square:booking:create:' || v_operation.salon_id::text || ':'
      || v_operation.booking_id::text,
    0
  ));
  IF v_booking_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'square:booking:provider:' || v_operation.provider_account_fingerprint
        || ':' || v_booking_id,
      0
    ));
  END IF;
  SELECT o.* INTO v_operation
  FROM public.square_booking_writeback_operations o
  WHERE o.id = p_operation_id
  FOR UPDATE;

  IF v_operation.status = 'succeeded' THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'operation_succeeded',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'provider_booking_id', v_operation.provider_booking_id
    );
  END IF;
  IF v_operation.status = 'unknown' THEN
    IF (v_booking_id IS NOT NULL
        AND v_operation.provider_booking_id IS NOT NULL
        AND v_operation.provider_booking_id <> v_booking_id)
       OR (v_customer_id IS NOT NULL
        AND v_operation.provider_customer_id IS NOT NULL
        AND v_operation.provider_customer_id <> v_customer_id)
       OR (p_provider_booking_version IS NOT NULL
        AND v_operation.provider_booking_version IS NOT NULL
        AND v_operation.provider_booking_version <> p_provider_booking_version)
       OR (v_operation.result_fingerprint IS NOT NULL
        AND v_operation.result_fingerprint <> p_result_fingerprint) THEN
      RETURN jsonb_build_object('success', false, 'code', 'unknown_receipt_conflict');
    END IF;
    IF v_booking_id IS NOT NULL
       AND v_operation.provider_booking_id IS NULL
       AND EXISTS (
         SELECT 1
         FROM public.square_booking_writeback_operations other
         WHERE other.provider_account_fingerprint =
           v_operation.provider_account_fingerprint
           AND other.provider_booking_id = v_booking_id
           AND other.id <> v_operation.id
       ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'provider_receipt_conflict');
    END IF;
    UPDATE public.square_booking_writeback_operations
    SET provider_booking_id = coalesce(provider_booking_id, v_booking_id),
        provider_customer_id = coalesce(provider_customer_id, v_customer_id),
        provider_booking_version = coalesce(
          provider_booking_version,
          p_provider_booking_version
        ),
        result_fingerprint = coalesce(result_fingerprint, p_result_fingerprint),
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
    RETURN jsonb_build_object(
      'success', true,
      'code', 'operation_unknown',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'provider_booking_id', v_operation.provider_booking_id,
      'provider_customer_id', v_operation.provider_customer_id,
      'provider_booking_version', v_operation.provider_booking_version,
      'next_reconcile_at', v_operation.next_reconcile_at
    );
  END IF;
  IF v_operation.status NOT IN ('sending', 'reconciling')
     OR v_operation.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN jsonb_build_object('success', false, 'code', 'claim_mismatch');
  END IF;
  IF v_operation.provider_booking_id IS NOT NULL
     AND v_booking_id IS NOT NULL
     AND v_operation.provider_booking_id <> v_booking_id THEN
    UPDATE public.square_booking_writeback_operations
    SET status = 'unknown',
        attempt_token = NULL,
        lease_expires_at = NULL,
        next_reconcile_at = v_now + interval '5 minutes',
        error_code = 'provider_receipt_conflict',
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
    RETURN jsonb_build_object(
      'success', false,
      'code', 'provider_receipt_conflict',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'provider_booking_id', v_operation.provider_booking_id,
      'next_reconcile_at', v_operation.next_reconcile_at
    );
  END IF;
  IF v_operation.provider_customer_id IS NOT NULL
     AND v_customer_id IS NOT NULL
     AND v_operation.provider_customer_id <> v_customer_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'customer_receipt_conflict');
  END IF;

  IF v_booking_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.square_booking_writeback_operations other
    WHERE other.provider_account_fingerprint = v_operation.provider_account_fingerprint
      AND other.provider_booking_id = v_booking_id
      AND other.id <> v_operation.id
  ) THEN
    v_booking_id := NULL;
    v_error := 'provider_receipt_conflict';
  END IF;

  UPDATE public.square_booking_writeback_operations
  SET status = 'unknown',
      provider_booking_id = coalesce(v_booking_id, provider_booking_id),
      provider_customer_id = coalesce(v_customer_id, provider_customer_id),
      provider_booking_version = coalesce(
        p_provider_booking_version,
        provider_booking_version
      ),
      result_fingerprint = p_result_fingerprint,
      attempt_token = NULL,
      lease_expires_at = NULL,
      next_reconcile_at = v_now + interval '2 minutes',
      error_code = v_error,
      updated_at = v_now
  WHERE id = v_operation.id
  RETURNING * INTO v_operation;
  RETURN jsonb_build_object(
    'success', true,
    'code', 'operation_unknown',
    'operation_id', v_operation.id,
    'status', v_operation.status,
    'provider_booking_id', v_operation.provider_booking_id,
    'provider_customer_id', v_operation.provider_customer_id,
    'provider_booking_version', v_operation.provider_booking_version,
    'next_reconcile_at', v_operation.next_reconcile_at,
    'error_code', v_operation.error_code
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_square_booking_writeback_reconciliation(
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
  v_operation public.square_booking_writeback_operations%ROWTYPE;
  v_integration public.square_integrations%ROWTYPE;
  v_application text;
  v_merchant text;
  v_location text;
  v_current_account_fingerprint text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'square:booking:create:' || p_salon_id::text || ':' || p_booking_id::text,
    0
  ));
  SELECT o.* INTO v_operation
  FROM public.square_booking_writeback_operations o
  WHERE o.salon_id = p_salon_id
    AND o.booking_id = p_booking_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'operation_not_found');
  END IF;

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
  IF v_operation.status = 'claimed' THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'dispatch_not_started',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'lease_expires_at', v_operation.lease_expires_at
    );
  END IF;
  IF v_operation.status IN ('sending', 'reconciling')
     AND v_operation.lease_expires_at > v_now THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'operation_in_flight',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'lease_expires_at', v_operation.lease_expires_at
    );
  END IF;
  IF v_operation.status IN ('sending', 'reconciling') THEN
    UPDATE public.square_booking_writeback_operations
    SET status = 'unknown',
        attempt_token = NULL,
        lease_expires_at = NULL,
        next_reconcile_at = v_now,
        error_code = CASE v_operation.status
          WHEN 'sending' THEN 'dispatch_lease_expired'
          ELSE 'reconciliation_lease_expired'
        END,
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
  END IF;
  IF v_operation.status <> 'unknown' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_operation_state');
  END IF;
  IF v_operation.next_reconcile_at IS NOT NULL
     AND v_operation.next_reconcile_at > v_now THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'reconciliation_not_due',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'next_reconcile_at', v_operation.next_reconcile_at
    );
  END IF;

  -- Unknown is terminal for mutation dispatch. This function only grants a
  -- read claim against the exact pinned provider account.
  PERFORM 1 FROM public.bookings b
    WHERE b.id = v_operation.booking_id
      AND b.salon_id = v_operation.salon_id
    FOR UPDATE;
  SELECT si.* INTO v_integration
  FROM public.square_integrations si
  WHERE si.salon_id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'provider_context_unavailable',
      'operation_id', v_operation.id,
      'provider_account_fingerprint', v_operation.provider_account_fingerprint
    );
  END IF;
  v_application := nullif(btrim(v_integration.application_id), '');
  v_merchant := nullif(btrim(v_integration.merchant_id), '');
  v_location := nullif(btrim(v_integration.location_id), '');
  IF v_integration.enabled IS DISTINCT FROM true
     OR v_integration.environment NOT IN ('sandbox', 'production')
     OR v_application IS NULL
     OR v_merchant IS NULL
     OR v_location IS NULL
     OR nullif(btrim(v_integration.access_token), '') IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'provider_context_unavailable',
      'operation_id', v_operation.id,
      'provider_account_fingerprint', v_operation.provider_account_fingerprint
    );
  END IF;
  v_current_account_fingerprint :=
    public.square_booking_writeback_account_fingerprint(
      v_integration.environment,
      v_application,
      v_merchant,
      v_location,
      v_operation.provider_api_version
    );
  IF v_current_account_fingerprint
     IS DISTINCT FROM v_operation.provider_account_fingerprint THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'provider_context_changed',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'provider_account_fingerprint', v_operation.provider_account_fingerprint,
      'current_provider_account_fingerprint', v_current_account_fingerprint,
      'material', v_operation.material,
      'material_fingerprint', v_operation.material_fingerprint
    );
  END IF;

  PERFORM 1 FROM public.services s
    WHERE s.id = (v_operation.material ->> 'booking_service_id')::uuid
      AND s.salon_id = v_operation.salon_id
    FOR UPDATE;
  PERFORM 1 FROM public.staff st
    WHERE st.id = (v_operation.material ->> 'booking_staff_id')::uuid
      AND st.salon_id = v_operation.salon_id
    FOR UPDATE;
  IF public.square_booking_writeback_local_material_matches(v_operation.id)
     IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'material_changed',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'material_fingerprint', v_operation.material_fingerprint
    );
  END IF;

  UPDATE public.square_booking_writeback_operations
  SET status = 'reconciling',
      attempt_token = gen_random_uuid(),
      attempt_count = attempt_count + 1,
      lease_expires_at = v_now + interval '5 minutes',
      next_reconcile_at = NULL,
      error_code = 'provider_outcome_requires_reconciliation',
      updated_at = v_now
  WHERE id = v_operation.id
    AND status = 'unknown'
  RETURNING * INTO v_operation;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'claim_mismatch');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'reconciliation_claimed',
    'operation_id', v_operation.id,
    'attempt_token', v_operation.attempt_token,
    'status', v_operation.status,
    'material', v_operation.material,
    'material_fingerprint', v_operation.material_fingerprint,
    'contact_fingerprint', v_operation.contact_fingerprint,
    'provider_account_fingerprint', v_operation.provider_account_fingerprint,
    'provider_customer_id', v_operation.provider_customer_id,
    'provider_booking_id', v_operation.provider_booking_id,
    'provider_booking_version', v_operation.provider_booking_version,
    'customer_idempotency_key', v_operation.customer_idempotency_key,
    'booking_idempotency_key', v_operation.booking_idempotency_key,
    'provider_correlation_key', v_operation.provider_correlation_key
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_square_booking_writeback_success(
  p_operation_id uuid,
  p_attempt_token uuid,
  p_provider_booking_id text,
  p_provider_customer_id text,
  p_provider_booking_version bigint,
  p_result_fingerprint text
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
  v_integration public.square_integrations%ROWTYPE;
  v_provider_booking_id text := nullif(btrim(p_provider_booking_id), '');
  v_provider_customer_id text := nullif(btrim(p_provider_customer_id), '');
  v_application text;
  v_merchant text;
  v_location text;
  v_current_account_fingerprint text;
  v_context_ready boolean := false;
  v_existing_binding text;
  v_bound_count integer := 0;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF v_provider_booking_id IS NULL
     OR length(v_provider_booking_id) > 255
     OR v_provider_booking_id ~ '[[:cntrl:]]'
     OR v_provider_customer_id IS NULL
     OR length(v_provider_customer_id) > 255
     OR v_provider_customer_id ~ '[[:cntrl:]]'
     OR p_provider_booking_version IS NULL
     OR p_provider_booking_version < 0
     OR p_result_fingerprint IS NULL
     OR p_result_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_provider_receipt');
  END IF;

  SELECT o.* INTO v_operation
  FROM public.square_booking_writeback_operations o
  WHERE o.id = p_operation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'operation_not_found');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'square:booking:create:' || v_operation.salon_id::text || ':'
      || v_operation.booking_id::text,
    0
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'square:booking:provider:' || v_operation.provider_account_fingerprint
      || ':' || v_provider_booking_id,
    0
  ));
  SELECT o.* INTO v_operation
  FROM public.square_booking_writeback_operations o
  WHERE o.id = p_operation_id
  FOR UPDATE;

  IF v_operation.status = 'succeeded' THEN
    IF v_operation.provider_booking_id IS DISTINCT FROM v_provider_booking_id
       OR v_operation.provider_customer_id IS DISTINCT FROM v_provider_customer_id
       OR v_operation.provider_booking_version
          IS DISTINCT FROM p_provider_booking_version
       OR v_operation.result_fingerprint
          IS DISTINCT FROM p_result_fingerprint THEN
      RETURN jsonb_build_object('success', false, 'code', 'completion_conflict');
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'code', 'completion_replay',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'provider_booking_id', v_operation.provider_booking_id,
      'provider_customer_id', v_operation.provider_customer_id,
      'provider_booking_version', v_operation.provider_booking_version,
      'material_fingerprint', v_operation.material_fingerprint
    );
  END IF;
  IF v_operation.status NOT IN ('sending', 'reconciling')
     OR v_operation.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN jsonb_build_object('success', false, 'code', 'claim_mismatch');
  END IF;
  IF v_operation.provider_booking_id IS NOT NULL
     AND v_operation.provider_booking_id <> v_provider_booking_id THEN
    UPDATE public.square_booking_writeback_operations
    SET status = 'unknown',
        attempt_token = NULL,
        lease_expires_at = NULL,
        next_reconcile_at = v_now + interval '5 minutes',
        error_code = 'provider_receipt_conflict',
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
    RETURN jsonb_build_object(
      'success', false,
      'code', 'provider_receipt_conflict',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'provider_booking_id', v_operation.provider_booking_id,
      'next_reconcile_at', v_operation.next_reconcile_at
    );
  END IF;
  IF v_operation.provider_customer_id IS NOT NULL
     AND v_operation.provider_customer_id <> v_provider_customer_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'customer_receipt_conflict');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.square_booking_writeback_operations other
    WHERE other.provider_account_fingerprint = v_operation.provider_account_fingerprint
      AND other.provider_booking_id = v_provider_booking_id
      AND other.id <> v_operation.id
  ) OR EXISTS (
    SELECT 1
    FROM public.bookings other_booking
    WHERE other_booking.square_booking_id = v_provider_booking_id
      AND other_booking.id <> v_operation.booking_id
  ) THEN
    UPDATE public.square_booking_writeback_operations
    SET status = 'unknown',
        provider_customer_id = coalesce(provider_customer_id, v_provider_customer_id),
        provider_booking_version = p_provider_booking_version,
        result_fingerprint = p_result_fingerprint,
        attempt_token = NULL,
        lease_expires_at = NULL,
        next_reconcile_at = v_now + interval '5 minutes',
        error_code = 'provider_receipt_conflict',
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
    RETURN jsonb_build_object(
      'success', false,
      'code', 'provider_receipt_conflict',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'next_reconcile_at', v_operation.next_reconcile_at
    );
  END IF;

  SELECT b.square_booking_id INTO v_existing_binding
  FROM public.bookings b
  WHERE b.id = v_operation.booking_id
    AND b.salon_id = v_operation.salon_id
  FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE public.square_booking_writeback_operations
    SET status = 'unknown',
        provider_booking_id = v_provider_booking_id,
        provider_customer_id = v_provider_customer_id,
        provider_booking_version = p_provider_booking_version,
        result_fingerprint = p_result_fingerprint,
        attempt_token = NULL,
        lease_expires_at = NULL,
        next_reconcile_at = v_now + interval '5 minutes',
        error_code = 'booking_not_found',
        updated_at = v_now
    WHERE id = v_operation.id;
    RETURN jsonb_build_object('success', false, 'code', 'booking_not_found');
  END IF;

  IF v_existing_binding IS NOT NULL
     AND v_existing_binding <> v_provider_booking_id THEN
    UPDATE public.square_booking_writeback_operations
    SET status = 'unknown',
        provider_booking_id = v_provider_booking_id,
        provider_customer_id = v_provider_customer_id,
        provider_booking_version = p_provider_booking_version,
        result_fingerprint = p_result_fingerprint,
        attempt_token = NULL,
        lease_expires_at = NULL,
        next_reconcile_at = v_now + interval '5 minutes',
        error_code = 'provider_binding_conflict',
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
    RETURN jsonb_build_object(
      'success', false,
      'code', 'provider_binding_conflict',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'existing_provider_booking_id', v_existing_binding,
      'provider_booking_id', v_provider_booking_id
    );
  END IF;

  -- Completion is a config CAS as well as a booking CAS. The old receipt is
  -- retained when config changes, but it is never bound under a new account.
  SELECT si.* INTO v_integration
  FROM public.square_integrations si
  WHERE si.salon_id = v_operation.salon_id
  FOR UPDATE;
  v_context_ready := FOUND;
  IF v_context_ready THEN
    v_application := nullif(btrim(v_integration.application_id), '');
    v_merchant := nullif(btrim(v_integration.merchant_id), '');
    v_location := nullif(btrim(v_integration.location_id), '');
    IF v_integration.environment IN ('sandbox', 'production')
       AND v_application IS NOT NULL
       AND v_merchant IS NOT NULL
       AND v_location IS NOT NULL THEN
      v_current_account_fingerprint :=
        public.square_booking_writeback_account_fingerprint(
          v_integration.environment,
          v_application,
          v_merchant,
          v_location,
          v_operation.provider_api_version
        );
    END IF;
  END IF;
  IF NOT v_context_ready
     OR v_integration.enabled IS DISTINCT FROM true
     OR v_integration.sync_push_create IS DISTINCT FROM true
     OR nullif(btrim(v_integration.access_token), '') IS NULL
     OR v_current_account_fingerprint
        IS DISTINCT FROM v_operation.provider_account_fingerprint THEN
    UPDATE public.square_booking_writeback_operations
    SET status = 'unknown',
        provider_booking_id = v_provider_booking_id,
        provider_customer_id = v_provider_customer_id,
        provider_booking_version = p_provider_booking_version,
        result_fingerprint = p_result_fingerprint,
        attempt_token = NULL,
        lease_expires_at = NULL,
        next_reconcile_at = v_now + interval '5 minutes',
        error_code = 'provider_context_changed',
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
    RETURN jsonb_build_object(
      'success', false,
      'code', 'provider_context_changed',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'provider_booking_id', v_operation.provider_booking_id,
      'provider_customer_id', v_operation.provider_customer_id,
      'provider_booking_version', v_operation.provider_booking_version,
      'provider_account_fingerprint', v_operation.provider_account_fingerprint,
      'current_provider_account_fingerprint', v_current_account_fingerprint,
      'next_reconcile_at', v_operation.next_reconcile_at
    );
  END IF;

  PERFORM 1 FROM public.services s
    WHERE s.id = (v_operation.material ->> 'booking_service_id')::uuid
      AND s.salon_id = v_operation.salon_id
    FOR UPDATE;
  PERFORM 1 FROM public.staff st
    WHERE st.id = (v_operation.material ->> 'booking_staff_id')::uuid
      AND st.salon_id = v_operation.salon_id
    FOR UPDATE;
  IF public.square_booking_writeback_local_material_matches(v_operation.id)
     IS NOT TRUE THEN
    UPDATE public.square_booking_writeback_operations
    SET status = 'unknown',
        provider_booking_id = v_provider_booking_id,
        provider_customer_id = v_provider_customer_id,
        provider_booking_version = p_provider_booking_version,
        result_fingerprint = p_result_fingerprint,
        attempt_token = NULL,
        lease_expires_at = NULL,
        next_reconcile_at = v_now + interval '5 minutes',
        error_code = 'local_material_changed',
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
    RETURN jsonb_build_object(
      'success', false,
      'code', 'material_changed',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'provider_booking_id', v_operation.provider_booking_id,
      'next_reconcile_at', v_operation.next_reconcile_at
    );
  END IF;

  BEGIN
    UPDATE public.bookings b
    SET square_booking_id = v_provider_booking_id
    WHERE b.id = v_operation.booking_id
      AND b.salon_id = v_operation.salon_id
      AND b.service_id = (v_operation.material ->> 'booking_service_id')::uuid
      AND b.staff_id = (v_operation.material ->> 'booking_staff_id')::uuid
      AND b.status = v_operation.material ->> 'booking_status'
      AND b.deleted_at IS NULL
      AND b.start_time_utc = (v_operation.material ->> 'start_time_utc')::timestamptz
      AND b.end_time_utc = (v_operation.material ->> 'end_time_utc')::timestamptz
      AND public.square_booking_writeback_contact_fingerprint(
        b.client_name,
        b.client_phone,
        b.client_email
      ) = v_operation.contact_fingerprint
      AND (b.square_booking_id IS NULL OR b.square_booking_id = v_provider_booking_id);
    GET DIAGNOSTICS v_bound_count = ROW_COUNT;
  EXCEPTION WHEN unique_violation THEN
    v_bound_count := 0;
  END;
  IF v_bound_count <> 1 THEN
    UPDATE public.square_booking_writeback_operations
    SET status = 'unknown',
        provider_booking_id = v_provider_booking_id,
        provider_customer_id = v_provider_customer_id,
        provider_booking_version = p_provider_booking_version,
        result_fingerprint = p_result_fingerprint,
        attempt_token = NULL,
        lease_expires_at = NULL,
        next_reconcile_at = v_now + interval '5 minutes',
        error_code = 'booking_bind_cas_failed',
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
    RETURN jsonb_build_object(
      'success', false,
      'code', 'booking_bind_cas_failed',
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'provider_booking_id', v_operation.provider_booking_id
    );
  END IF;

  UPDATE public.square_booking_writeback_operations
  SET status = 'succeeded',
      provider_booking_id = v_provider_booking_id,
      provider_customer_id = v_provider_customer_id,
      provider_booking_version = p_provider_booking_version,
      result_fingerprint = p_result_fingerprint,
      customer_recorded_at = coalesce(customer_recorded_at, v_now),
      attempt_token = NULL,
      lease_expires_at = NULL,
      next_reconcile_at = NULL,
      error_code = NULL,
      completed_at = v_now,
      updated_at = v_now
  WHERE id = v_operation.id
  RETURNING * INTO v_operation;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'operation_completed',
    'operation_id', v_operation.id,
    'status', v_operation.status,
    'provider_booking_id', v_operation.provider_booking_id,
    'provider_customer_id', v_operation.provider_customer_id,
    'provider_booking_version', v_operation.provider_booking_version,
    'material_fingerprint', v_operation.material_fingerprint,
    'result_fingerprint', v_operation.result_fingerprint
  );
END;
$$;

ALTER TABLE public.square_booking_writeback_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.square_booking_writeback_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.square_booking_writeback_operations
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.square_booking_writeback_operations TO service_role;

REVOKE ALL ON FUNCTION
  public.square_booking_writeback_contact_fingerprint(text, text, text),
  public.square_booking_writeback_account_fingerprint(text, text, text, text, text),
  public.resolve_square_booking_writeback_material(uuid, uuid, text, text, bigint, text),
  public.square_booking_writeback_local_material_matches(uuid),
  public.claim_square_booking_writeback(uuid, uuid, text, text, bigint, text, text),
  public.begin_square_booking_writeback_dispatch(uuid, uuid, text),
  public.record_square_booking_writeback_customer(uuid, uuid, text, text),
  public.mark_square_booking_writeback_unknown(uuid, uuid, text, text, text, text, bigint),
  public.claim_square_booking_writeback_reconciliation(uuid, uuid),
  public.complete_square_booking_writeback_success(uuid, uuid, text, text, bigint, text)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.square_booking_writeback_contact_fingerprint(text, text, text),
  public.square_booking_writeback_account_fingerprint(text, text, text, text, text),
  public.resolve_square_booking_writeback_material(uuid, uuid, text, text, bigint, text),
  public.square_booking_writeback_local_material_matches(uuid),
  public.claim_square_booking_writeback(uuid, uuid, text, text, bigint, text, text),
  public.begin_square_booking_writeback_dispatch(uuid, uuid, text),
  public.record_square_booking_writeback_customer(uuid, uuid, text, text),
  public.mark_square_booking_writeback_unknown(uuid, uuid, text, text, text, text, bigint),
  public.claim_square_booking_writeback_reconciliation(uuid, uuid),
  public.complete_square_booking_writeback_success(uuid, uuid, text, text, bigint, text)
TO service_role;

COMMENT ON TABLE public.square_booking_writeback_operations IS
  'PII-free durable NailIQ-to-Square create-booking claims, pinned provider identity, stable idempotency keys, ambiguous outcome state, and exact provider receipt.';
COMMENT ON FUNCTION public.claim_square_booking_writeback(uuid, uuid, text, text, bigint, text, text) IS
  'Single-winner pre-dispatch claim. Unknown or dispatched operations are reconciliation-only and never redispatched.';
COMMENT ON FUNCTION public.begin_square_booking_writeback_dispatch(uuid, uuid, text) IS
  'One-way claimed-to-sending transition. Only its first success returns transient service-role contact material.';
COMMENT ON FUNCTION public.record_square_booking_writeback_customer(uuid, uuid, text, text) IS
  'Records the exact customer-create receipt only while the booking, contact, mapping, and provider context remain pinned.';
COMMENT ON FUNCTION public.mark_square_booking_writeback_unknown(uuid, uuid, text, text, text, text, bigint) IS
  'Persists an ambiguous provider outcome and optional receipt without granting another mutation dispatch.';
COMMENT ON FUNCTION public.claim_square_booking_writeback_reconciliation(uuid, uuid) IS
  'Claims provider-read reconciliation only when current provider identity exactly matches the pinned dispatched account.';
COMMENT ON FUNCTION public.complete_square_booking_writeback_success(uuid, uuid, text, text, bigint, text) IS
  'Atomically records a provider receipt and exact-CAS binds bookings.square_booking_id; context/material/binding mismatch remains unknown.';
