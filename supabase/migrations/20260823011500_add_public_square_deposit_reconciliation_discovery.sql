-- Dedicated, explicitly environment-gated discovery for ambiguous public
-- customer-present Square deposits. Provider lookup remains application-hard-off
-- unless the matching environment flag is set; this RPC only leases durable rows.

CREATE OR REPLACE FUNCTION public.discover_due_public_square_deposit_reconciliations(
  p_expected_environment text,
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
  IF p_expected_environment IS NULL
     OR p_expected_environment NOT IN ('sandbox', 'production') THEN
    RAISE EXCEPTION 'invalid Square reconciliation environment' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid limit' USING ERRCODE = '22023';
  END IF;

  FOR v_op IN
    SELECT p.*
    FROM public.booking_payment_operations p
    WHERE p.provider = 'square'
      AND p.delivery_mode = 'public_customer_present'
      AND p.operation_kind = 'deposit_charge'
      AND p.attempt_count < 3
      AND p.provider_material ->> 'provider_environment' = p_expected_environment
      AND nullif(pg_catalog.btrim(p.provider_material ->> 'provider_account_id'), '') IS NOT NULL
      AND nullif(pg_catalog.btrim(p.provider_material ->> 'provider_location_id'), '') IS NOT NULL
      AND nullif(pg_catalog.btrim(p.provider_material ->> 'provider_application_id'), '') IS NOT NULL
      AND p.booking_intent_idempotency_key IS NOT NULL
      AND p.provider_material ->> 'booking_intent_reference'
        = p.booking_intent_idempotency_key::text
      AND p.material_json ->> 'booking_idempotency_key'
        = p.booking_intent_idempotency_key::text
      AND p.material_json ->> 'provider' = 'square'
      AND p.material_json ->> 'provider_account_fingerprint'
        = p.provider_account_fingerprint
      AND p.material_json -> 'provider_material' = p.provider_material
      AND pg_catalog.encode(
        extensions.digest(
          pg_catalog.convert_to(
            'square:' || (p.provider_material ->> 'provider_account_id') || ':' ||
            (p.provider_material ->> 'provider_location_id') || ':' ||
            (p.provider_material ->> 'provider_environment'),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) = p.provider_account_fingerprint
      AND pg_catalog.encode(
        extensions.digest(
          pg_catalog.convert_to(p.material_json::text, 'UTF8'),
          'sha256'
        ),
        'hex'
      ) = p.material_fingerprint
      AND p.provider_material ->> 'amount_cents' = p.amount_cents::text
      AND p.material_json ->> 'amount_cents' = p.amount_cents::text
      AND p.provider_material ->> 'currency' = p.currency
      AND p.material_json ->> 'currency' = p.currency
      AND (
        (p.status IN ('sending', 'reconciling') AND p.lease_expires_at <= now())
        OR (
          p.status IN ('pending_provider', 'unknown')
          AND coalesce(p.next_reconcile_at, p.updated_at) <= now()
        )
      )
    ORDER BY coalesce(p.next_reconcile_at, p.lease_expires_at, p.updated_at), p.created_at, p.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  LOOP
    v_attempt := gen_random_uuid();
    UPDATE public.booking_payment_operations
    SET status = 'reconciling',
        failure_disposition = 'ambiguous',
        error_code = 'provider_outcome_ambiguous',
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

-- Generic reconciliation must never consume attempts for this explicitly gated
-- path. It continues to lease Stripe operations and non-public Square modes.
CREATE OR REPLACE FUNCTION public.discover_due_booking_payment_reconciliations(
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
  FOR v_op IN
    SELECT p.*
    FROM public.booking_payment_operations p
    WHERE p.attempt_count < 3
      AND NOT (
        p.provider = 'square'
        AND p.delivery_mode = 'public_customer_present'
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

REVOKE ALL ON FUNCTION public.discover_due_public_square_deposit_reconciliations(text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discover_due_public_square_deposit_reconciliations(text, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.discover_due_booking_payment_reconciliations(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discover_due_booking_payment_reconciliations(integer)
  TO service_role;
