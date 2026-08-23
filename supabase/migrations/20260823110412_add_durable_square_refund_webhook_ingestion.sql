-- MQA-0126: bind signature-verified Square refund events to the exact
-- tenant/provider account and the pre-existing authoritative refund operation.
-- Raw webhook bodies and provider credentials are intentionally not stored.

CREATE TABLE public.square_refund_webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  operation_id uuid REFERENCES public.booking_payment_operations(id) ON DELETE CASCADE,
  provider_account_fingerprint text NOT NULL
    CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  event_id text NOT NULL CHECK (
    length(event_id) BETWEEN 1 AND 255
    AND event_id ~ '^[[:graph:]]+$'
  ),
  occurred_at timestamptz NOT NULL,
  refund_updated_at timestamptz NOT NULL,
  provider_refund_id text NOT NULL CHECK (
    length(provider_refund_id) BETWEEN 1 AND 255
    AND provider_refund_id ~ '^[[:graph:]]+$'
  ),
  parent_payment_id text NOT NULL CHECK (
    length(parent_payment_id) BETWEEN 1 AND 255
    AND parent_payment_id ~ '^[[:graph:]]+$'
  ),
  provider_status text NOT NULL
    CHECK (provider_status IN ('PENDING','COMPLETED','REJECTED','FAILED')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  merchant_id text NOT NULL CHECK (
    length(merchant_id) BETWEEN 1 AND 255
    AND merchant_id ~ '^[[:graph:]]+$'
  ),
  location_id text NOT NULL CHECK (
    length(location_id) BETWEEN 1 AND 255
    AND location_id ~ '^[[:graph:]]+$'
  ),
  application_id text NOT NULL CHECK (
    length(application_id) BETWEEN 1 AND 255
    AND application_id ~ '^[[:graph:]]+$'
  ),
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  payload_fingerprint text NOT NULL
    CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  material_fingerprint text NOT NULL
    CHECK (material_fingerprint ~ '^[0-9a-f]{64}$'),
  processing_status text NOT NULL DEFAULT 'received'
    CHECK (processing_status IN ('received','applied','ignored','rejected')),
  result_code text CHECK (
    result_code IS NULL OR result_code ~ '^[a-z0-9_]{1,64}$'
  ),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (provider_account_fingerprint, event_id),
  CONSTRAINT square_refund_webhook_inbox_completion_check CHECK (
    (processing_status = 'received' AND completed_at IS NULL AND result_code IS NULL)
    OR (processing_status <> 'received' AND completed_at IS NOT NULL AND result_code IS NOT NULL)
  )
);

CREATE INDEX square_refund_webhook_inbox_salon_history
  ON public.square_refund_webhook_inbox (salon_id, received_at DESC);
CREATE INDEX square_refund_webhook_inbox_operation_revision
  ON public.square_refund_webhook_inbox (operation_id, refund_updated_at DESC, event_id)
  WHERE operation_id IS NOT NULL;

ALTER TABLE public.square_refund_webhook_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.square_refund_webhook_inbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.square_refund_webhook_inbox
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_square_refund_webhook_event(
  p_salon_id uuid,
  p_event_id text,
  p_occurred_at timestamptz,
  p_payload_fingerprint text,
  p_provider_refund_id text,
  p_parent_payment_id text,
  p_location_id text,
  p_provider_status text,
  p_amount_cents integer,
  p_currency text,
  p_refund_updated_at timestamptz,
  p_merchant_id text,
  p_application_id text,
  p_environment text
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
  v_integration public.square_integrations%ROWTYPE;
  v_account_fingerprint text;
  v_material jsonb;
  v_material_fingerprint text;
  v_inbox public.square_refund_webhook_inbox%ROWTYPE;
  v_operation public.booking_payment_operations%ROWTYPE;
  v_latest public.square_refund_webhook_inbox%ROWTYPE;
  v_attempt_token uuid;
  v_completion jsonb;
  v_original_status text;
  v_original_attempt_token uuid;
  v_original_lease_expires_at timestamptz;
  v_original_updated_at timestamptz;
  v_outcome text;
  v_result_code text;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_salon_id IS NULL
     OR p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255
     OR p_event_id !~ '^[[:graph:]]+$'
     OR p_occurred_at IS NULL
     OR NOT isfinite(p_occurred_at)
     OR p_payload_fingerprint IS NULL
     OR p_payload_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_provider_refund_id IS NULL
     OR length(p_provider_refund_id) NOT BETWEEN 1 AND 255
     OR p_provider_refund_id !~ '^[[:graph:]]+$'
     OR p_parent_payment_id IS NULL
     OR length(p_parent_payment_id) NOT BETWEEN 1 AND 255
     OR p_parent_payment_id !~ '^[[:graph:]]+$'
     OR p_location_id IS NULL OR length(p_location_id) NOT BETWEEN 1 AND 255
     OR p_location_id !~ '^[[:graph:]]+$'
     OR p_provider_status IS NULL
     OR p_provider_status NOT IN ('PENDING','COMPLETED','REJECTED','FAILED')
     OR p_amount_cents IS NULL OR p_amount_cents <= 0
     OR p_currency IS NULL
     OR p_currency !~ '^[A-Z]{3}$'
     OR p_refund_updated_at IS NULL
     OR NOT isfinite(p_refund_updated_at)
     OR p_merchant_id IS NULL OR length(p_merchant_id) NOT BETWEEN 1 AND 255
     OR p_merchant_id !~ '^[[:graph:]]+$'
     OR p_application_id IS NULL OR length(p_application_id) NOT BETWEEN 1 AND 255
     OR p_application_id !~ '^[[:graph:]]+$'
     OR p_environment IS NULL
     OR p_environment NOT IN ('sandbox','production') THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_refund_event');
  END IF;

  SELECT * INTO v_integration
  FROM public.square_integrations
  WHERE salon_id = p_salon_id
    AND merchant_id = p_merchant_id
    AND location_id = p_location_id
    AND application_id = p_application_id
    AND environment = p_environment
    AND enabled IS TRUE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'provider_context_mismatch');
  END IF;

  v_account_fingerprint := encode(
    extensions.digest(
      convert_to(
        'square:' || p_merchant_id || ':' || p_location_id || ':' || p_environment,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  v_material := jsonb_build_object(
    'event_id', p_event_id,
    'occurred_at', p_occurred_at,
    'provider_refund_id', p_provider_refund_id,
    'parent_payment_id', p_parent_payment_id,
    'location_id', p_location_id,
    'provider_status', p_provider_status,
    'amount_cents', p_amount_cents,
    'currency', p_currency,
    'refund_updated_at', p_refund_updated_at,
    'merchant_id', p_merchant_id,
    'application_id', p_application_id,
    'environment', p_environment
  );
  v_material_fingerprint := encode(
    extensions.digest(convert_to(v_material::text, 'UTF8'), 'sha256'),
    'hex'
  );

  INSERT INTO public.square_refund_webhook_inbox (
    salon_id, provider_account_fingerprint, event_id, occurred_at,
    refund_updated_at, provider_refund_id, parent_payment_id, provider_status,
    amount_cents, currency, merchant_id, location_id, application_id,
    environment, payload_fingerprint, material_fingerprint
  ) VALUES (
    p_salon_id, v_account_fingerprint, p_event_id, p_occurred_at,
    p_refund_updated_at, p_provider_refund_id, p_parent_payment_id,
    p_provider_status, p_amount_cents, p_currency, p_merchant_id,
    p_location_id, p_application_id, p_environment, p_payload_fingerprint,
    v_material_fingerprint
  )
  ON CONFLICT (provider_account_fingerprint, event_id) DO NOTHING
  RETURNING * INTO v_inbox;

  IF NOT FOUND THEN
    SELECT * INTO v_inbox
    FROM public.square_refund_webhook_inbox
    WHERE provider_account_fingerprint = v_account_fingerprint
      AND event_id = p_event_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'inbox_state_unavailable');
    END IF;
    IF v_inbox.salon_id IS DISTINCT FROM p_salon_id
       OR v_inbox.payload_fingerprint IS DISTINCT FROM p_payload_fingerprint
       OR v_inbox.material_fingerprint IS DISTINCT FROM v_material_fingerprint THEN
      RETURN jsonb_build_object(
        'success', false, 'code', 'event_conflict', 'event_id', p_event_id
      );
    END IF;
    IF v_inbox.processing_status IN ('applied','ignored') THEN
      RETURN jsonb_build_object(
        'success', true, 'code', 'event_replay', 'event_id', p_event_id,
        'result_code', v_inbox.result_code
      );
    END IF;
    IF v_inbox.processing_status = 'rejected'
       AND v_inbox.result_code <> 'operation_not_found' THEN
      RETURN jsonb_build_object(
        'success', false, 'code', 'event_replay_rejected',
        'event_id', p_event_id, 'result_code', v_inbox.result_code
      );
    END IF;
    UPDATE public.square_refund_webhook_inbox
    SET processing_status = 'received', result_code = NULL, completed_at = NULL
    WHERE id = v_inbox.id
    RETURNING * INTO v_inbox;
  END IF;

  SELECT * INTO v_operation
  FROM public.booking_payment_operations
  WHERE salon_id = p_salon_id
    AND provider = 'square'
    AND provider_account_fingerprint = v_account_fingerprint
    AND provider_refund_id = p_provider_refund_id
  FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE public.square_refund_webhook_inbox
    SET processing_status = 'rejected', result_code = 'operation_not_found',
        completed_at = clock_timestamp()
    WHERE id = v_inbox.id;
    RETURN jsonb_build_object(
      'success', false, 'code', 'operation_not_found', 'event_id', p_event_id
    );
  END IF;

  UPDATE public.square_refund_webhook_inbox
  SET operation_id = v_operation.id
  WHERE id = v_inbox.id;

  IF v_operation.operation_kind NOT IN (
       'deposit_refund','noshow_refund','late_cancel_refund'
     )
     OR v_operation.parent_payment_id IS DISTINCT FROM p_parent_payment_id
     OR v_operation.amount_cents IS DISTINCT FROM p_amount_cents
     OR v_operation.currency IS DISTINCT FROM p_currency
     OR v_operation.provider_material ->> 'provider_account_id'
        IS DISTINCT FROM p_merchant_id
     OR v_operation.provider_material ->> 'provider_location_id'
        IS DISTINCT FROM p_location_id
     OR v_operation.provider_material ->> 'provider_application_id'
        IS DISTINCT FROM p_application_id
     OR v_operation.provider_material ->> 'provider_environment'
        IS DISTINCT FROM p_environment
     OR v_operation.provider_material ->> 'currency'
        IS DISTINCT FROM p_currency THEN
    UPDATE public.square_refund_webhook_inbox
    SET processing_status = 'rejected', result_code = 'provider_binding_mismatch',
        completed_at = clock_timestamp()
    WHERE id = v_inbox.id;
    RETURN jsonb_build_object(
      'success', false, 'code', 'provider_binding_mismatch',
      'event_id', p_event_id
    );
  END IF;

  SELECT * INTO v_latest
  FROM public.square_refund_webhook_inbox
  WHERE operation_id = v_operation.id
    AND id <> v_inbox.id
    AND processing_status IN ('applied','ignored')
  ORDER BY refund_updated_at DESC, received_at DESC, event_id DESC
  LIMIT 1;

  IF v_operation.status = 'succeeded' THEN
    IF p_provider_status <> 'COMPLETED' THEN
      IF p_provider_status = 'PENDING'
         AND v_latest.id IS NOT NULL
         AND v_latest.provider_status = 'COMPLETED'
         AND v_latest.refund_updated_at >= p_refund_updated_at THEN
        UPDATE public.square_refund_webhook_inbox
        SET processing_status = 'ignored', result_code = 'stale_event_ignored',
            completed_at = clock_timestamp()
        WHERE id = v_inbox.id;
        RETURN jsonb_build_object(
          'success', true, 'code', 'stale_event_ignored',
          'event_id', p_event_id
        );
      END IF;
      UPDATE public.square_refund_webhook_inbox
      SET processing_status = 'rejected', result_code = 'terminal_state_conflict',
          completed_at = clock_timestamp()
      WHERE id = v_inbox.id;
      RETURN jsonb_build_object(
        'success', false, 'code', 'terminal_state_conflict',
        'event_id', p_event_id
      );
    END IF;
    UPDATE public.square_refund_webhook_inbox
    SET processing_status = 'ignored', result_code = 'refund_terminal_noop',
        completed_at = clock_timestamp()
    WHERE id = v_inbox.id;
    RETURN jsonb_build_object(
      'success', true, 'code', 'refund_terminal_noop',
      'event_id', p_event_id
    );
  ELSIF v_operation.status = 'failed' THEN
    IF p_provider_status NOT IN ('REJECTED','FAILED') THEN
      IF p_provider_status = 'PENDING'
         AND v_latest.id IS NOT NULL
         AND v_latest.provider_status IN ('REJECTED','FAILED')
         AND v_latest.refund_updated_at >= p_refund_updated_at THEN
        UPDATE public.square_refund_webhook_inbox
        SET processing_status = 'ignored', result_code = 'stale_event_ignored',
            completed_at = clock_timestamp()
        WHERE id = v_inbox.id;
        RETURN jsonb_build_object(
          'success', true, 'code', 'stale_event_ignored',
          'event_id', p_event_id
        );
      END IF;
      UPDATE public.square_refund_webhook_inbox
      SET processing_status = 'rejected', result_code = 'terminal_state_conflict',
          completed_at = clock_timestamp()
      WHERE id = v_inbox.id;
      RETURN jsonb_build_object(
        'success', false, 'code', 'terminal_state_conflict',
        'event_id', p_event_id
      );
    END IF;
    UPDATE public.square_refund_webhook_inbox
    SET processing_status = 'ignored', result_code = 'refund_terminal_noop',
        completed_at = clock_timestamp()
    WHERE id = v_inbox.id;
    RETURN jsonb_build_object(
      'success', true, 'code', 'refund_terminal_noop',
      'event_id', p_event_id
    );
  ELSIF v_operation.status NOT IN (
      'sending','pending_provider','reconciling','unknown'
    ) THEN
    UPDATE public.square_refund_webhook_inbox
    SET processing_status = 'rejected', result_code = 'operation_state_mismatch',
        completed_at = clock_timestamp()
    WHERE id = v_inbox.id;
    RETURN jsonb_build_object(
      'success', false, 'code', 'operation_state_mismatch',
      'event_id', p_event_id
    );
  END IF;

  IF v_latest.id IS NOT NULL AND v_latest.refund_updated_at > p_refund_updated_at THEN
    UPDATE public.square_refund_webhook_inbox
    SET processing_status = 'ignored', result_code = 'stale_event_ignored',
        completed_at = clock_timestamp()
    WHERE id = v_inbox.id;
    RETURN jsonb_build_object(
      'success', true, 'code', 'stale_event_ignored', 'event_id', p_event_id
    );
  ELSIF v_latest.id IS NOT NULL AND v_latest.refund_updated_at = p_refund_updated_at THEN
    IF v_latest.provider_status <> p_provider_status THEN
      UPDATE public.square_refund_webhook_inbox
      SET processing_status = 'rejected', result_code = 'revision_conflict',
          completed_at = clock_timestamp()
      WHERE id = v_inbox.id;
      RETURN jsonb_build_object(
        'success', false, 'code', 'revision_conflict', 'event_id', p_event_id
      );
    END IF;
    UPDATE public.square_refund_webhook_inbox
    SET processing_status = 'ignored', result_code = 'duplicate_revision_ignored',
        completed_at = clock_timestamp()
    WHERE id = v_inbox.id;
    RETURN jsonb_build_object(
      'success', true, 'code', 'duplicate_revision_ignored',
      'event_id', p_event_id
    );
  END IF;

  v_original_status := v_operation.status;
  v_original_attempt_token := v_operation.attempt_token;
  v_original_lease_expires_at := v_operation.lease_expires_at;
  v_original_updated_at := v_operation.updated_at;
  v_attempt_token := gen_random_uuid();
  UPDATE public.booking_payment_operations
  SET status = 'reconciling', attempt_token = v_attempt_token,
      lease_expires_at = clock_timestamp() + interval '5 minutes',
      updated_at = clock_timestamp()
  WHERE id = v_operation.id;

  v_outcome := CASE p_provider_status
    WHEN 'PENDING' THEN 'pending_provider'
    WHEN 'COMPLETED' THEN 'succeeded'
    ELSE 'definite_failure'
  END;
  v_completion := public.complete_booking_payment_operation(
    v_operation.id,
    v_attempt_token,
    v_outcome,
    p_provider_status,
    NULL,
    p_provider_refund_id,
    CASE WHEN v_outcome = 'definite_failure' THEN 'provider_rejected' END
  );

  IF v_outcome = 'pending_provider'
     AND v_completion ->> 'success' = 'true'
     AND v_completion ->> 'code' = 'pending_provider' THEN
    v_result_code := 'refund_pending';
  ELSIF v_outcome = 'succeeded'
     AND v_completion ->> 'success' = 'true'
     AND v_completion ->> 'code' IN ('succeeded','compensated') THEN
    v_result_code := 'refund_applied';
  ELSIF v_outcome = 'definite_failure'
     AND v_completion ->> 'status' = 'failed'
     AND v_completion ->> 'code' = 'definite_failure' THEN
    v_result_code := 'refund_failed';
  ELSE
    UPDATE public.booking_payment_operations
    SET status = v_original_status,
        attempt_token = v_original_attempt_token,
        lease_expires_at = v_original_lease_expires_at,
        updated_at = v_original_updated_at
    WHERE id = v_operation.id;
    UPDATE public.square_refund_webhook_inbox
    SET processing_status = 'rejected', result_code = 'completion_rejected',
        completed_at = clock_timestamp()
    WHERE id = v_inbox.id;
    RETURN jsonb_build_object(
      'success', false, 'code', 'completion_rejected', 'event_id', p_event_id
    );
  END IF;

  UPDATE public.square_refund_webhook_inbox
  SET processing_status = 'applied', result_code = v_result_code,
      completed_at = clock_timestamp()
  WHERE id = v_inbox.id;
  RETURN jsonb_build_object(
    'success', true, 'code', v_result_code, 'event_id', p_event_id,
    'operation_id', v_operation.id
  );
END
$function$;

REVOKE ALL ON FUNCTION public.record_square_refund_webhook_event(
  uuid,text,timestamptz,text,text,text,text,text,integer,text,timestamptz,text,text,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_square_refund_webhook_event(
  uuid,text,timestamptz,text,text,text,text,text,integer,text,timestamptz,text,text,text
) TO service_role;

DO $square_refund_acl$
DECLARE
  v_signature text :=
    'public.record_square_refund_webhook_event(uuid,text,timestamp with time zone,text,text,text,text,text,integer,text,timestamp with time zone,text,text,text)';
BEGIN
  IF has_table_privilege('anon','public.square_refund_webhook_inbox','SELECT')
     OR has_table_privilege('authenticated','public.square_refund_webhook_inbox','SELECT')
     OR has_table_privilege('service_role','public.square_refund_webhook_inbox','SELECT')
     OR has_table_privilege('service_role','public.square_refund_webhook_inbox','INSERT')
     OR has_table_privilege('service_role','public.square_refund_webhook_inbox','UPDATE')
     OR has_table_privilege('service_role','public.square_refund_webhook_inbox','DELETE') THEN
    RAISE EXCEPTION 'Square refund inbox direct table access remains reachable';
  END IF;
  IF has_function_privilege('anon',v_signature,'EXECUTE')
     OR has_function_privilege('authenticated',v_signature,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_signature,'EXECUTE') THEN
    RAISE EXCEPTION 'Square refund webhook function ACL is invalid';
  END IF;
END
$square_refund_acl$;

COMMENT ON TABLE public.square_refund_webhook_inbox IS
  'Service-only, tenant/account-bound Square refund.updated replay evidence. Stores normalized financial material and hashes, never raw bodies or credentials.';
COMMENT ON FUNCTION public.record_square_refund_webhook_event(
  uuid,text,timestamptz,text,text,text,text,text,integer,text,timestamptz,text,text,text
) IS
  'Atomically binds a signed Square refund revision to an existing authoritative refund operation; identical delivery is a no-op and conflicting or stale terminal material never regresses financial state.';
