-- MQA-0127 safe-local boundary: the generic optional-feature claim accepts a
-- caller-provided source_id and therefore cannot authorize Inventory writes.
-- Keep Catalog reads on the generic path, but require a future specialized
-- owner/admin + confirmed-mapping claim before any adjustment can be queued.

CREATE OR REPLACE FUNCTION public.claim_square_feature_operation(
  p_salon_id uuid,
  p_request_id uuid,
  p_operation_kind text,
  p_request jsonb,
  p_expected_material_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $claim_square_feature_operation$
DECLARE
  v_role text := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_resolved jsonb;
  v_op public.square_feature_operations%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_operation_kind = 'inventory_adjustment' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'specialized_inventory_claim_required'
    );
  END IF;
  IF p_request_id IS NULL
     OR p_expected_material_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_request');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_salon_id::text || ':' || p_request_id::text, 0)
  );
  SELECT * INTO v_op
  FROM public.square_feature_operations
  WHERE salon_id = p_salon_id AND request_id = p_request_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_op.operation_kind <> p_operation_kind
       OR v_op.material_fingerprint <> p_expected_material_fingerprint THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'idempotency_conflict'
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'code', CASE v_op.status
        WHEN 'succeeded' THEN 'operation_succeeded'
        WHEN 'sending' THEN 'operation_in_flight'
        WHEN 'pending_provider' THEN 'reconciliation_required'
        WHEN 'unknown' THEN 'reconciliation_required'
        WHEN 'failed' THEN 'operation_failed'
        ELSE 'operation_pending'
      END,
      'operation_id', v_op.id,
      'status', v_op.status,
      'provider_object_id', v_op.provider_object_id,
      'provider_receipt_id', v_op.provider_receipt_id,
      'material_fingerprint', v_op.material_fingerprint
    );
  END IF;

  v_resolved := public.resolve_square_feature_operation_material(
    p_salon_id,
    p_operation_kind,
    p_request
  );
  IF v_resolved ->> 'code' <> 'resolved' THEN
    RETURN v_resolved;
  END IF;
  IF v_resolved ->> 'material_fingerprint' <> p_expected_material_fingerprint THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'material_mismatch');
  END IF;

  INSERT INTO public.square_feature_operations(
    salon_id,
    request_id,
    feature,
    operation_kind,
    parent_operation_id,
    provider_account_fingerprint,
    material_fingerprint,
    material,
    provider_idempotency_key,
    status,
    attempt_token,
    attempt_count,
    lease_expires_at
  ) VALUES (
    p_salon_id,
    p_request_id,
    v_resolved ->> 'feature',
    p_operation_kind,
    nullif(p_request ->> 'parent_operation_id', '')::uuid,
    v_resolved -> 'material' ->> 'provider_account_fingerprint',
    p_expected_material_fingerprint,
    v_resolved -> 'material',
    'nq:' || p_request_id::text,
    'sending',
    extensions.gen_random_uuid(),
    1,
    v_now + interval '5 minutes'
  )
  RETURNING * INTO v_op;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'code', 'operation_claimed',
    'operation_id', v_op.id,
    'attempt_token', v_op.attempt_token,
    'provider_idempotency_key', v_op.provider_idempotency_key,
    'material', v_op.material,
    'provider_material', v_resolved -> 'provider_material',
    'material_fingerprint', v_op.material_fingerprint
  );
END
$claim_square_feature_operation$;

REVOKE ALL ON FUNCTION public.claim_square_feature_operation(uuid, uuid, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_square_feature_operation(uuid, uuid, text, jsonb, text)
  TO service_role;

COMMENT ON FUNCTION public.claim_square_feature_operation(uuid, uuid, text, jsonb, text) IS
  'Claims optional Square operations; raw Inventory adjustments are refused until a specialized actor- and mapping-bound claim exists.';
