-- Manual, two-step money boundary for approved late/group cancellation fees.
-- Approval and cancellation never dispatch. This claim requires a second
-- Owner/Admin action, a server release switch, a salon allowlist, and an
-- immutable approval receipt. The provider call remains in application code.

CREATE OR REPLACE FUNCTION public.claim_approved_cancellation_fee_payment(
  p_review_kind text,
  p_review_id uuid,
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_actor_role text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $claim$
DECLARE
  v_member_role text;
  v_late public.booking_late_cancellation_fee_reviews%ROWTYPE;
  v_group public.booking_group_cancellation_fee_reviews%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_salon public.salons%ROWTYPE;
  v_existing public.booking_payment_operations%ROWTYPE;
  v_booking_id uuid;
  v_request_id uuid;
  v_amount integer;
  v_currency text;
  v_card_last4 text;
  v_policy_version text;
  v_occurrence bigint;
  v_context jsonb;
  v_provider_material jsonb;
  v_cancel_preview jsonb;
  v_material jsonb;
  v_fingerprint text;
  v_operation_id uuid := extensions.gen_random_uuid();
  v_attempt_token uuid := extensions.gen_random_uuid();
  v_receipt_ok boolean := false;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_review_kind NOT IN ('late', 'group')
     OR p_review_id IS NULL OR p_salon_id IS NULL OR p_actor_user_id IS NULL
     OR p_actor_role NOT IN ('owner', 'admin') THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_request');
  END IF;

  SELECT m.role INTO v_member_role
  FROM public.salon_members m
  WHERE m.salon_id = p_salon_id AND m.user_id = p_actor_user_id
    AND m.role IN ('owner', 'admin')
  LIMIT 1;
  IF v_member_role IS NULL OR v_member_role IS DISTINCT FROM p_actor_role THEN
    RETURN jsonb_build_object('success', false, 'code', 'dispatch_unauthorized');
  END IF;

  SELECT * INTO v_salon FROM public.salons WHERE id = p_salon_id;
  IF NOT FOUND OR coalesce(v_salon.feature_flags->>'approved_cancellation_fee_dispatch', '') <> 'true' THEN
    RETURN jsonb_build_object('success', false, 'code', 'salon_not_allowlisted');
  END IF;

  IF p_review_kind = 'late' THEN
    SELECT * INTO v_late
    FROM public.booking_late_cancellation_fee_reviews r
    WHERE r.id = p_review_id AND r.salon_id = p_salon_id
    FOR UPDATE;
    IF NOT FOUND OR v_late.state <> 'approved_charge'
       OR v_late.approval_request_id IS NULL
       OR v_late.payment_status NOT IN (
         'dispatch_blocked', 'dispatching', 'pending_provider', 'unknown',
         'succeeded', 'failed'
       ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'charge_not_approved');
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM public.booking_late_cancellation_fee_approval_receipts a
      WHERE a.review_id = v_late.id
        AND a.salon_id = v_late.salon_id
        AND a.approval_request_id = v_late.approval_request_id
        AND a.action = 'charge'
        AND a.amount_cents = v_late.amount_cents
        AND a.currency = v_late.currency
        AND a.consent_policy_version = v_late.consent_policy_version
    ) INTO v_receipt_ok;
    v_booking_id := v_late.booking_id;
    v_request_id := v_late.approval_request_id;
    v_amount := v_late.amount_cents;
    v_currency := v_late.currency;
    v_card_last4 := v_late.card_last4;
    v_policy_version := v_late.consent_policy_version;
    v_occurrence := v_late.cancellation_occurrence_version;
  ELSE
    SELECT * INTO v_group
    FROM public.booking_group_cancellation_fee_reviews r
    WHERE r.id = p_review_id AND r.salon_id = p_salon_id
    FOR UPDATE;
    IF NOT FOUND OR v_group.state <> 'approved_charge'
       OR v_group.approval_request_id IS NULL
       OR v_group.payment_status NOT IN (
         'dispatch_blocked', 'dispatching', 'pending_provider', 'unknown',
         'succeeded', 'failed'
       ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'charge_not_approved');
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM public.booking_group_cancellation_fee_approval_receipts a
      WHERE a.review_id = v_group.id
        AND a.salon_id = v_group.salon_id
        AND a.approval_request_id = v_group.approval_request_id
        AND a.action = 'charge'
        AND a.amount_cents = v_group.amount_cents
        AND a.currency = v_group.currency
        AND a.consent_policy_version IS NOT DISTINCT FROM v_group.consent_policy_version
    ) INTO v_receipt_ok;
    v_booking_id := v_group.organizer_booking_id;
    v_request_id := v_group.approval_request_id;
    v_amount := v_group.amount_cents;
    v_currency := v_group.currency;
    v_card_last4 := v_group.card_last4;
    v_policy_version := v_group.consent_policy_version;
  END IF;

  IF NOT v_receipt_ok OR v_amount <= 0 OR v_amount > 2147483647
     OR v_currency !~ '^[A-Z]{3}$' OR coalesce(v_card_last4, '') !~ '^[0-9]{4}$'
     OR nullif(trim(coalesce(v_policy_version, '')), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'approval_receipt_mismatch');
  END IF;

  SELECT * INTO v_booking
  FROM public.bookings b
  WHERE b.id = v_booking_id AND b.salon_id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND OR v_booking.status <> 'cancelled'
     OR (p_review_kind = 'late' AND v_booking.group_id IS NOT NULL)
     OR (p_review_kind = 'group' AND (
       v_booking.group_id IS NULL OR v_booking.group_id IS DISTINCT FROM v_group.group_id
     ))
     OR nullif(trim(coalesce(v_booking.noshow_card_id, '')), '') IS NULL
     OR nullif(trim(coalesce(v_booking.noshow_customer_id, '')), '') IS NULL
     OR v_booking.noshow_consent_at IS NULL
     OR v_booking.noshow_card_last4 IS DISTINCT FROM v_card_last4
     OR coalesce(v_booking.noshow_charge_status, '') = 'charged'
     OR coalesce(v_booking.late_cancel_charge_status, 'none') IN ('charged', 'refunded') THEN
    RETURN jsonb_build_object('success', false, 'code', 'booking_payment_material_invalid');
  END IF;
  IF p_review_kind = 'group' THEN
    v_occurrence := greatest(coalesce(v_booking.customer_transition_version, 0), 1);
  END IF;

  SELECT * INTO v_existing
  FROM public.booking_payment_operations o
  WHERE o.salon_id = p_salon_id
    AND o.request_id = v_request_id
    AND o.operation_kind = 'late_cancel_charge'
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.booking_id IS DISTINCT FROM v_booking_id
       OR v_existing.amount_cents IS DISTINCT FROM v_amount
       OR v_existing.currency IS DISTINCT FROM v_currency
       OR v_existing.operation_occurrence_version IS DISTINCT FROM v_occurrence THEN
      RETURN jsonb_build_object('success', false, 'code', 'operation_conflict');
    END IF;
    IF v_existing.status = 'succeeded' THEN
      RETURN jsonb_build_object(
        'success', true, 'code', 'operation_replay', 'status', 'succeeded',
        'operation_id', v_existing.id,
        'material_fingerprint', v_existing.material_fingerprint,
        'material', v_existing.material_json, 'result', v_existing.result_json
      );
    ELSIF v_existing.status = 'failed' THEN
      RETURN jsonb_build_object(
        'success', false, 'code', 'operation_failed', 'status', 'failed',
        'operation_id', v_existing.id, 'error_code', v_existing.error_code,
        'material_fingerprint', v_existing.material_fingerprint
      );
    ELSIF v_existing.status IN ('pending_provider', 'unknown') THEN
      RETURN jsonb_build_object(
        'success', false, 'code', 'reconciliation_required',
        'status', v_existing.status, 'operation_id', v_existing.id,
        'request_id', v_existing.request_id,
        'material_fingerprint', v_existing.material_fingerprint
      );
    ELSE
      RETURN jsonb_build_object(
        'success', false, 'code', 'in_flight', 'status', v_existing.status,
        'operation_id', v_existing.id,
        'request_id', v_existing.request_id,
        'lease_expires_at', v_existing.lease_expires_at,
        'material_fingerprint', v_existing.material_fingerprint
      );
    END IF;
  END IF;

  SELECT * INTO v_existing
  FROM public.booking_payment_operations o
  WHERE o.booking_id = v_booking_id
    AND o.operation_kind = 'late_cancel_charge'
    AND o.operation_occurrence_version = v_occurrence
  FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', false, 'code', 'charge_occurrence_conflict',
      'operation_id', v_existing.id, 'status', v_existing.status
    );
  END IF;

  v_context := public.booking_payment_provider_context(
    p_salon_id, 'late_cancel_charge'
  );
  IF coalesce((v_context->>'success')::boolean, false) IS NOT TRUE THEN
    RETURN v_context;
  END IF;
  IF v_context->>'currency' IS DISTINCT FROM v_currency THEN
    RETURN jsonb_build_object('success', false, 'code', 'currency_mismatch');
  END IF;
  v_provider_material := v_context->'provider_material' || jsonb_build_object(
    'saved_card_id', v_booking.noshow_card_id,
    'customer_id', v_booking.noshow_customer_id
  );
  v_cancel_preview := jsonb_build_object(
    'will_charge', true,
    'has_chargeable_card', true,
    'fee_cents', v_amount,
    'currency', v_currency,
    'review_kind', p_review_kind,
    'review_id', p_review_id,
    'approval_request_id', v_request_id,
    'consent_policy_version', v_policy_version
  );
  v_material := jsonb_build_object(
    'salon_id', p_salon_id,
    'booking_id', v_booking_id,
    'operation_kind', 'late_cancel_charge',
    'provider', v_context->>'provider',
    'provider_account_fingerprint', v_context->>'provider_account_fingerprint',
    'amount_cents', v_amount,
    'currency', v_currency,
    'parent_payment_id', NULL,
    'parent_operation_id', NULL,
    'operation_occurrence_version', v_occurrence,
    'cancel_preview', v_cancel_preview,
    'scope_kind', 'booking_own',
    'rsvp_semantic', '',
    'captured_cents', v_amount,
    'refunded_cents', 0,
    'reserved_cents', 0,
    'remaining_refundable_cents', 0,
    'consent_at', v_booking.noshow_consent_at,
    'card_fingerprint', encode(extensions.digest(
      convert_to(v_booking.noshow_card_id, 'UTF8'), 'sha256'
    ), 'hex'),
    'provider_material', v_provider_material
  );
  v_fingerprint := encode(extensions.digest(
    convert_to(v_material::text, 'UTF8'), 'sha256'
  ), 'hex');

  INSERT INTO public.booking_payment_operations (
    id, salon_id, booking_id, request_id, operation_kind,
    operation_occurrence_version, provider, provider_account_fingerprint,
    amount_cents, currency, material_fingerprint, material_json,
    provider_material, provider_idempotency_key, status, attempt_token,
    lease_expires_at
  ) VALUES (
    v_operation_id, p_salon_id, v_booking_id, v_request_id,
    'late_cancel_charge', v_occurrence, v_context->>'provider',
    v_context->>'provider_account_fingerprint', v_amount, v_currency,
    v_fingerprint, v_material, v_provider_material,
    'nq:' || v_operation_id::text, 'sending', v_attempt_token,
    clock_timestamp() + interval '2 minutes'
  );

  IF p_review_kind = 'late' THEN
    UPDATE public.booking_late_cancellation_fee_reviews
    SET payment_operation_id = v_operation_id,
        payment_status = 'dispatching', payment_error_code = NULL,
        updated_at = clock_timestamp()
    WHERE id = p_review_id;
  ELSE
    UPDATE public.booking_group_cancellation_fee_reviews
    SET payment_operation_id = v_operation_id,
        payment_status = 'dispatching', payment_error_code = NULL,
        updated_at = clock_timestamp()
    WHERE id = p_review_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'code', 'claimed', 'status', 'sending',
    'operation_id', v_operation_id, 'attempt_token', v_attempt_token,
    'provider_idempotency_key', 'nq:' || v_operation_id::text,
    'attempt_count', 1,
    'lease_expires_at', clock_timestamp() + interval '2 minutes',
    'material_fingerprint', v_fingerprint, 'material', v_material
  );
END;
$claim$;

REVOKE ALL ON FUNCTION public.claim_approved_cancellation_fee_payment(
  text, uuid, uuid, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_approved_cancellation_fee_payment(
  text, uuid, uuid, uuid, text
) TO service_role;

-- Extend the existing payment-ledger guard. No-show behavior is preserved;
-- late/group operations are admitted only when this migration's exact review
-- and immutable receipt can be re-proved at INSERT and every reconciliation.
CREATE OR REPLACE FUNCTION public.enforce_no_show_payment_operation_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $guard$
DECLARE
  v_no_show public.booking_no_show_fee_reviews%ROWTYPE;
  v_no_show_receipt public.booking_no_show_fee_approval_receipts%ROWTYPE;
  v_late public.booking_late_cancellation_fee_reviews%ROWTYPE;
  v_late_receipt public.booking_late_cancellation_fee_approval_receipts%ROWTYPE;
  v_group public.booking_group_cancellation_fee_reviews%ROWTYPE;
  v_group_receipt public.booking_group_cancellation_fee_approval_receipts%ROWTYPE;
  v_review_kind text;
  v_review_id uuid;
BEGIN
  IF NEW.operation_kind = 'late_cancel_charge'
     AND NEW.status IN ('sending', 'reconciling') THEN
    v_review_kind := NEW.material_json->'cancel_preview'->>'review_kind';
    v_review_id := nullif(
      NEW.material_json->'cancel_preview'->>'review_id', ''
    )::uuid;
    IF v_review_kind = 'late' THEN
      SELECT * INTO v_late
      FROM public.booking_late_cancellation_fee_reviews r
      WHERE r.id = v_review_id AND r.salon_id = NEW.salon_id
        AND r.booking_id = NEW.booking_id
        AND r.approval_request_id = NEW.request_id
      FOR SHARE;
      IF NOT FOUND OR v_late.state <> 'approved_charge'
         OR v_late.amount_cents IS DISTINCT FROM NEW.amount_cents
         OR v_late.currency IS DISTINCT FROM NEW.currency
         OR v_late.cancellation_occurrence_version IS DISTINCT FROM NEW.operation_occurrence_version
         OR v_late.payment_status NOT IN (
           'dispatch_blocked', 'dispatching', 'pending_provider', 'unknown'
         )
         OR (v_late.payment_operation_id IS NOT NULL
           AND v_late.payment_operation_id IS DISTINCT FROM NEW.id) THEN
        RAISE EXCEPTION 'late cancellation charge requires an exact approved review'
          USING errcode = 'NI009';
      END IF;
      SELECT * INTO v_late_receipt
      FROM public.booking_late_cancellation_fee_approval_receipts a
      WHERE a.review_id = v_late.id
      FOR SHARE;
      IF NOT FOUND OR v_late_receipt.action <> 'charge'
         OR v_late_receipt.salon_id IS DISTINCT FROM v_late.salon_id
         OR v_late_receipt.approval_request_id IS DISTINCT FROM v_late.approval_request_id
         OR v_late_receipt.amount_cents IS DISTINCT FROM v_late.amount_cents
         OR v_late_receipt.currency IS DISTINCT FROM v_late.currency
         OR v_late_receipt.consent_policy_version IS DISTINCT FROM v_late.consent_policy_version
         OR v_late_receipt.actor_user_id IS DISTINCT FROM v_late.decided_by_user_id
         OR v_late_receipt.actor_role IS DISTINCT FROM v_late.decided_by_role THEN
        RAISE EXCEPTION 'late cancellation charge approval receipt mismatch'
          USING errcode = 'NI009';
      END IF;
      RETURN NEW;
    ELSIF v_review_kind = 'group' THEN
      SELECT * INTO v_group
      FROM public.booking_group_cancellation_fee_reviews r
      WHERE r.id = v_review_id AND r.salon_id = NEW.salon_id
        AND r.organizer_booking_id = NEW.booking_id
        AND r.approval_request_id = NEW.request_id
      FOR SHARE;
      IF NOT FOUND OR v_group.state <> 'approved_charge'
         OR v_group.amount_cents IS DISTINCT FROM NEW.amount_cents
         OR v_group.currency IS DISTINCT FROM NEW.currency
         OR v_group.payment_status NOT IN (
           'dispatch_blocked', 'dispatching', 'pending_provider', 'unknown'
         )
         OR (v_group.payment_operation_id IS NOT NULL
           AND v_group.payment_operation_id IS DISTINCT FROM NEW.id) THEN
        RAISE EXCEPTION 'group cancellation charge requires an exact approved review'
          USING errcode = 'NI009';
      END IF;
      SELECT * INTO v_group_receipt
      FROM public.booking_group_cancellation_fee_approval_receipts a
      WHERE a.review_id = v_group.id
      FOR SHARE;
      IF NOT FOUND OR v_group_receipt.action <> 'charge'
         OR v_group_receipt.salon_id IS DISTINCT FROM v_group.salon_id
         OR v_group_receipt.approval_request_id IS DISTINCT FROM v_group.approval_request_id
         OR v_group_receipt.amount_cents IS DISTINCT FROM v_group.amount_cents
         OR v_group_receipt.currency IS DISTINCT FROM v_group.currency
         OR v_group_receipt.consent_policy_version IS DISTINCT FROM v_group.consent_policy_version
         OR v_group_receipt.actor_user_id IS DISTINCT FROM v_group.decided_by_user_id
         OR v_group_receipt.actor_role IS DISTINCT FROM v_group.decided_by_role THEN
        RAISE EXCEPTION 'group cancellation charge approval receipt mismatch'
          USING errcode = 'NI009';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'late-cancel charge requires a dedicated approval receipt workflow'
      USING errcode = 'NI009';
  END IF;

  IF NEW.operation_kind <> 'noshow_charge'
     OR NEW.status NOT IN ('sending', 'reconciling') THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_no_show
  FROM public.booking_no_show_fee_reviews r
  WHERE r.salon_id = NEW.salon_id AND r.booking_id = NEW.booking_id
    AND r.approval_request_id = NEW.request_id
  FOR SHARE;
  IF NOT FOUND OR v_no_show.state <> 'approved_charge'
     OR v_no_show.amount_cents IS DISTINCT FROM NEW.amount_cents
     OR v_no_show.currency IS DISTINCT FROM NEW.currency
     OR v_no_show.payment_status NOT IN ('dispatching', 'pending_provider', 'unknown')
     OR (v_no_show.payment_operation_id IS NOT NULL
       AND v_no_show.payment_operation_id IS DISTINCT FROM NEW.id) THEN
    RAISE EXCEPTION 'no-show charge requires an exact approved review'
      USING errcode = 'NI007';
  END IF;
  SELECT * INTO v_no_show_receipt
  FROM public.booking_no_show_fee_approval_receipts a
  WHERE a.review_id = v_no_show.id
  FOR SHARE;
  IF NOT FOUND OR v_no_show_receipt.action <> 'charge'
     OR v_no_show_receipt.salon_id IS DISTINCT FROM v_no_show.salon_id
     OR v_no_show_receipt.booking_id IS DISTINCT FROM v_no_show.booking_id
     OR v_no_show_receipt.no_show_decision_id IS DISTINCT FROM v_no_show.no_show_decision_id
     OR v_no_show_receipt.approval_request_id IS DISTINCT FROM v_no_show.approval_request_id
     OR v_no_show_receipt.amount_cents IS DISTINCT FROM v_no_show.amount_cents
     OR v_no_show_receipt.currency IS DISTINCT FROM v_no_show.currency
     OR v_no_show_receipt.group_scope IS DISTINCT FROM v_no_show.group_scope
     OR v_no_show_receipt.card_brand IS DISTINCT FROM v_no_show.card_brand
     OR v_no_show_receipt.card_last4 IS DISTINCT FROM v_no_show.card_last4
     OR v_no_show_receipt.consent_at IS DISTINCT FROM v_no_show.consent_at
     OR v_no_show_receipt.consent_policy_version IS DISTINCT FROM v_no_show.consent_policy_version
     OR v_no_show_receipt.consent_snapshot_hash IS DISTINCT FROM v_no_show.consent_snapshot_hash
     OR v_no_show_receipt.ai_recommendation IS DISTINCT FROM v_no_show.ai_recommendation
     OR v_no_show_receipt.ai_reason_codes IS DISTINCT FROM v_no_show.ai_reason_codes
     OR v_no_show_receipt.approved_by_user_id IS DISTINCT FROM v_no_show.decided_by_user_id
     OR v_no_show_receipt.approved_by_role IS DISTINCT FROM v_no_show.decided_by_role THEN
    RAISE EXCEPTION 'no-show charge approval receipt mismatch'
      USING errcode = 'NI008';
  END IF;
  RETURN NEW;
END;
$guard$;

REVOKE ALL ON FUNCTION public.enforce_no_show_payment_operation_approval()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sync_approved_cancellation_fee_payment_outcome()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $sync$
DECLARE
  v_payment_status text;
BEGIN
  IF NEW.operation_kind <> 'late_cancel_charge' THEN
    RETURN NEW;
  END IF;
  v_payment_status := CASE NEW.status
    WHEN 'succeeded' THEN 'succeeded'
    WHEN 'failed' THEN 'failed'
    WHEN 'pending_provider' THEN 'pending_provider'
    WHEN 'unknown' THEN 'unknown'
    ELSE 'dispatching'
  END;
  UPDATE public.booking_late_cancellation_fee_reviews
  SET payment_status = v_payment_status,
      payment_error_code = CASE WHEN v_payment_status IN ('failed', 'unknown')
        THEN NEW.error_code ELSE NULL END,
      updated_at = clock_timestamp()
  WHERE payment_operation_id = NEW.id AND state = 'approved_charge';
  UPDATE public.booking_group_cancellation_fee_reviews
  SET payment_status = v_payment_status,
      payment_error_code = CASE WHEN v_payment_status IN ('failed', 'unknown')
        THEN NEW.error_code ELSE NULL END,
      updated_at = clock_timestamp()
  WHERE payment_operation_id = NEW.id AND state = 'approved_charge';
  RETURN NEW;
END;
$sync$;

DROP TRIGGER IF EXISTS booking_payment_operations_sync_cancellation_fee_outcome
  ON public.booking_payment_operations;
CREATE TRIGGER booking_payment_operations_sync_cancellation_fee_outcome
AFTER UPDATE OF status, error_code ON public.booking_payment_operations
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.error_code IS DISTINCT FROM NEW.error_code)
EXECUTE FUNCTION public.sync_approved_cancellation_fee_payment_outcome();

REVOKE ALL ON FUNCTION public.sync_approved_cancellation_fee_payment_outcome()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.claim_approved_cancellation_fee_payment(
  text, uuid, uuid, uuid, text
) IS 'Second Owner/Admin action that claims one receipt-bound late/group fee payment; no provider call occurs in SQL.';
