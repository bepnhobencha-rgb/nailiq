BEGIN;
-- Filter disabled operations before leasing or consuming their retry budget.
CREATE OR REPLACE FUNCTION public.discover_due_enabled_booking_payment_reconciliations(
  p_operation_kinds text[],
  p_limit integer DEFAULT 25
) RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_op public.booking_payment_operations%ROWTYPE;
  v_attempt uuid;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid limit' USING ERRCODE = '22023';
  END IF;
  IF p_operation_kinds IS NULL OR array_position(p_operation_kinds, NULL) IS NOT NULL
     OR NOT p_operation_kinds <@ ARRAY[
       'deposit_charge', 'deposit_refund', 'noshow_charge', 'noshow_refund',
       'late_cancel_charge', 'late_cancel_refund'
     ]::text[] THEN
    RAISE EXCEPTION 'invalid operation kinds' USING ERRCODE = '22023';
  END IF;
  FOR v_op IN
    SELECT p.*
    FROM public.booking_payment_operations p
    WHERE p.operation_kind = ANY(p_operation_kinds)
      -- Do not consume the reconciliation budget of a disabled salon.
      AND (p.operation_kind NOT IN ('noshow_charge', 'late_cancel_charge') OR EXISTS (
        SELECT 1 FROM public.salons s WHERE s.id = p.salon_id
          AND s.feature_flags -> CASE p.operation_kind
            WHEN 'noshow_charge' THEN 'approved_no_show_charge_dispatch'
            ELSE 'approved_cancellation_fee_dispatch'
          END = 'true'::jsonb
      ))
      AND p.attempt_count < 3
      AND NOT (
        p.provider = 'square'
        AND coalesce(p.delivery_mode, '') = 'public_customer_present'
      )
      AND (
        (p.status IN ('sending', 'reconciling') AND p.lease_expires_at <= now())
        OR (
          p.status IN ('pending_provider', 'unknown')
          AND coalesce(p.next_reconcile_at, p.updated_at) <= now()
        )
      )
      AND NOT (
        coalesce(p.delivery_mode, '') = 'public_customer_present'
        AND p.provider_payment_id IS NULL
        AND p.status = 'unknown'
      )
    ORDER BY coalesce(p.next_reconcile_at, p.lease_expires_at, p.updated_at), p.created_at, p.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  LOOP
    -- Preserve the generic worker's previous corruption-safe handling. Valid
    -- public Square rows cannot enter this branch because they are excluded
    -- above and are leased only by the dedicated environment-gated RPC.
    IF v_op.delivery_mode = 'public_customer_present'
       AND v_op.provider_payment_id IS NULL
       AND v_op.status IN ('sending', 'reconciling', 'unknown') THEN
      UPDATE public.booking_payment_operations
      SET status = 'unknown',
          failure_disposition = 'ambiguous',
          error_code = 'customer_present_receipt_unknown',
          attempt_token = NULL,
          lease_expires_at = NULL,
          next_reconcile_at = NULL,
          updated_at = now()
      WHERE id = v_op.id
      RETURNING * INTO v_op;
      RETURN NEXT pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'manual_reconciliation_required',
        'status', 'unknown',
        'operation_id', v_op.id,
        'salon_id', v_op.salon_id,
        'booking_id', v_op.booking_id,
        'request_id', v_op.request_id,
        'operation_kind', v_op.operation_kind,
        'material_fingerprint', v_op.material_fingerprint
      );
      CONTINUE;
    END IF;

    v_attempt := gen_random_uuid();
    UPDATE public.booking_payment_operations
    SET status = 'reconciling',
        failure_disposition = CASE
          WHEN v_op.status IN ('sending', 'reconciling') THEN 'ambiguous'
          ELSE failure_disposition
        END,
        error_code = CASE
          WHEN v_op.status = 'sending' AND v_op.booking_intent_idempotency_key IS NOT NULL
            THEN 'provider_attach_outcome_unknown'
          WHEN v_op.status IN ('sending', 'reconciling') THEN 'provider_outcome_ambiguous'
          ELSE error_code
        END,
        attempt_token = v_attempt,
        attempt_count = attempt_count + 1,
        lease_expires_at = now() + interval '2 minutes',
        next_reconcile_at = NULL,
        updated_at = now()
    WHERE id = v_op.id
    RETURNING * INTO v_op;

    RETURN NEXT pg_catalog.jsonb_build_object(
      'success', true,
      'code', 'reconcile_claimed',
      'status', 'reconciling',
      'operation_id', v_op.id,
      'salon_id', v_op.salon_id,
      'booking_id', v_op.booking_id,
      'request_id', v_op.request_id,
      'operation_kind', v_op.operation_kind,
      'attempt_token', v_attempt,
      'attempt_count', v_op.attempt_count,
      'lease_expires_at', v_op.lease_expires_at,
      'operation_created_at', v_op.created_at,
      'provider_payment_id', v_op.provider_payment_id,
      'provider_refund_id', v_op.provider_refund_id,
      'provider_order_id', v_op.provider_order_id,
      'provider_link_id', v_op.provider_link_id,
      'provider_link_url', v_op.provider_link_url,
      'delivery_mode', v_op.delivery_mode,
      'provider_idempotency_key', v_op.provider_idempotency_key,
      'material_fingerprint', v_op.material_fingerprint,
      'material', v_op.material_json,
      'provider_material', v_op.provider_material
    );
  END LOOP;
END
$function$;

REVOKE ALL ON FUNCTION public.discover_due_enabled_booking_payment_reconciliations(text[], integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discover_due_enabled_booking_payment_reconciliations(text[], integer)
  TO service_role;

COMMENT ON FUNCTION public.discover_due_enabled_booking_payment_reconciliations(text[], integer) IS
  'Claims only released operation kinds and allowlisted fee salons before consuming attempts. Original RPC retained for rolling application deploy compatibility.';

COMMIT;
