-- Enforce the No-show Payment Truth boundary at the database ledger.
--
-- Attendance/cancellation is not payment authorization. A no-show charge may
-- enter provider dispatch only when it is bound to the immutable Owner/Admin
-- approval receipt created by decide_booking_no_show_fee_review. This migration
-- does not enable dispatch and does not call a provider.

CREATE OR REPLACE FUNCTION public.enforce_no_show_payment_operation_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_review public.booking_no_show_fee_reviews%ROWTYPE;
  v_receipt public.booking_no_show_fee_approval_receipts%ROWTYPE;
BEGIN
  IF NEW.operation_kind = 'late_cancel_charge'
     AND NEW.status IN ('sending', 'reconciling') THEN
    RAISE EXCEPTION 'late-cancel charge requires a dedicated approval receipt workflow'
      USING errcode = 'NI009';
  END IF;

  IF NEW.operation_kind <> 'noshow_charge'
     OR NEW.status NOT IN ('sending', 'reconciling') THEN
    RETURN NEW;
  END IF;

  SELECT r.* INTO v_review
    FROM public.booking_no_show_fee_reviews r
   WHERE r.salon_id = NEW.salon_id
     AND r.booking_id = NEW.booking_id
     AND r.approval_request_id = NEW.request_id
   FOR SHARE;

  IF NOT FOUND
     OR v_review.state <> 'approved_charge'
     OR v_review.amount_cents IS DISTINCT FROM NEW.amount_cents
     OR v_review.currency IS DISTINCT FROM NEW.currency
     OR v_review.payment_status NOT IN ('dispatching', 'pending_provider', 'unknown')
     OR (v_review.payment_operation_id IS NOT NULL
         AND v_review.payment_operation_id IS DISTINCT FROM NEW.id) THEN
    RAISE EXCEPTION 'no-show charge requires an exact approved review'
      USING errcode = 'NI007';
  END IF;

  SELECT a.* INTO v_receipt
    FROM public.booking_no_show_fee_approval_receipts a
   WHERE a.review_id = v_review.id
   FOR SHARE;

  IF NOT FOUND
     OR v_receipt.action <> 'charge'
     OR v_receipt.salon_id IS DISTINCT FROM v_review.salon_id
     OR v_receipt.booking_id IS DISTINCT FROM v_review.booking_id
     OR v_receipt.no_show_decision_id IS DISTINCT FROM v_review.no_show_decision_id
     OR v_receipt.approval_request_id IS DISTINCT FROM v_review.approval_request_id
     OR v_receipt.amount_cents IS DISTINCT FROM v_review.amount_cents
     OR v_receipt.currency IS DISTINCT FROM v_review.currency
     OR v_receipt.group_scope IS DISTINCT FROM v_review.group_scope
     OR v_receipt.card_brand IS DISTINCT FROM v_review.card_brand
     OR v_receipt.card_last4 IS DISTINCT FROM v_review.card_last4
     OR v_receipt.consent_at IS DISTINCT FROM v_review.consent_at
     OR v_receipt.consent_policy_version IS DISTINCT FROM v_review.consent_policy_version
     OR v_receipt.consent_snapshot_hash IS DISTINCT FROM v_review.consent_snapshot_hash
     OR v_receipt.ai_recommendation IS DISTINCT FROM v_review.ai_recommendation
     OR v_receipt.ai_reason_codes IS DISTINCT FROM v_review.ai_reason_codes
     OR v_receipt.approved_by_user_id IS DISTINCT FROM v_review.decided_by_user_id
     OR v_receipt.approved_by_role IS DISTINCT FROM v_review.decided_by_role THEN
    RAISE EXCEPTION 'no-show charge approval receipt mismatch'
      USING errcode = 'NI008';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS booking_payment_operations_no_show_approval_insert
  ON public.booking_payment_operations;
CREATE TRIGGER booking_payment_operations_no_show_approval_insert
  BEFORE INSERT ON public.booking_payment_operations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_no_show_payment_operation_approval();

DROP TRIGGER IF EXISTS booking_payment_operations_no_show_approval_reconcile
  ON public.booking_payment_operations;
CREATE TRIGGER booking_payment_operations_no_show_approval_reconcile
  BEFORE UPDATE OF status ON public.booking_payment_operations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_no_show_payment_operation_approval();

-- Service-role application code can inspect these rows but must mutate them
-- only through the SECURITY DEFINER request/decision/dispatch RPC contracts.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.booking_no_show_fee_reviews
  FROM service_role;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.booking_no_show_fee_approval_receipts
  FROM service_role;
GRANT SELECT ON TABLE public.booking_no_show_fee_reviews,
  public.booking_no_show_fee_approval_receipts TO service_role;

CREATE OR REPLACE FUNCTION public.authorize_approved_no_show_fee_dispatch(
  p_review_id uuid,
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_actor_role text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_actual_role text;
  v_review public.booking_no_show_fee_reviews%ROWTYPE;
  v_receipt public.booking_no_show_fee_approval_receipts%ROWTYPE;
  v_operation public.booking_payment_operations%ROWTYPE;
BEGIN
  IF v_request_role <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  SELECT sm.role INTO v_actual_role FROM public.salon_members sm
   WHERE sm.salon_id = p_salon_id AND sm.user_id = p_actor_user_id
     AND sm.role IN ('owner', 'admin') LIMIT 1;
  IF v_actual_role IS NULL OR v_actual_role IS DISTINCT FROM p_actor_role THEN
    RETURN jsonb_build_object('success', false, 'code', 'dispatch_unauthorized');
  END IF;

  SELECT r.* INTO v_review FROM public.booking_no_show_fee_reviews r
   WHERE r.id = p_review_id AND r.salon_id = p_salon_id FOR UPDATE;
  IF NOT FOUND OR v_review.state <> 'approved_charge'
     OR v_review.approval_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'charge_not_approved');
  END IF;

  SELECT a.* INTO v_receipt FROM public.booking_no_show_fee_approval_receipts a
   WHERE a.review_id = v_review.id;
  IF NOT FOUND
     OR v_receipt.action <> 'charge'
     OR v_receipt.salon_id IS DISTINCT FROM v_review.salon_id
     OR v_receipt.booking_id IS DISTINCT FROM v_review.booking_id
     OR v_receipt.no_show_decision_id IS DISTINCT FROM v_review.no_show_decision_id
     OR v_receipt.approval_request_id IS DISTINCT FROM v_review.approval_request_id
     OR v_receipt.amount_cents IS DISTINCT FROM v_review.amount_cents
     OR v_receipt.currency IS DISTINCT FROM v_review.currency
     OR v_receipt.group_scope IS DISTINCT FROM v_review.group_scope
     OR v_receipt.card_brand IS DISTINCT FROM v_review.card_brand
     OR v_receipt.card_last4 IS DISTINCT FROM v_review.card_last4
     OR v_receipt.consent_at IS DISTINCT FROM v_review.consent_at
     OR v_receipt.consent_policy_version IS DISTINCT FROM v_review.consent_policy_version
     OR v_receipt.consent_snapshot_hash IS DISTINCT FROM v_review.consent_snapshot_hash
     OR v_receipt.ai_recommendation IS DISTINCT FROM v_review.ai_recommendation
     OR v_receipt.ai_reason_codes IS DISTINCT FROM v_review.ai_reason_codes
     OR v_receipt.approved_by_user_id IS DISTINCT FROM v_review.decided_by_user_id
     OR v_receipt.approved_by_role IS DISTINCT FROM v_review.decided_by_role THEN
    RETURN jsonb_build_object('success', false, 'code', 'approval_receipt_mismatch');
  END IF;

  IF v_review.payment_status = 'succeeded' THEN
    SELECT o.* INTO v_operation FROM public.booking_payment_operations o
     WHERE o.id = v_review.payment_operation_id
       AND o.salon_id = v_review.salon_id
       AND o.booking_id = v_review.booking_id
       AND o.request_id = v_review.approval_request_id
       AND o.operation_kind = 'noshow_charge'
       AND o.amount_cents = v_review.amount_cents
       AND o.currency = v_review.currency
       AND o.status = 'succeeded'
       AND nullif(trim(coalesce(o.provider_payment_id, '')), '') IS NOT NULL;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'succeeded_receipt_invalid');
    END IF;
    RETURN jsonb_build_object(
      'success', true, 'code', 'dispatch_replay', 'booking_id', v_review.booking_id,
      'request_id', v_review.approval_request_id, 'amount_cents', v_review.amount_cents,
      'currency', v_review.currency, 'payment_operation_id', v_operation.id
    );
  END IF;
  IF v_review.payment_status = 'failed' THEN
    RETURN jsonb_build_object('success', false, 'code', 'charge_failed_no_blind_retry');
  END IF;

  UPDATE public.booking_no_show_fee_reviews r
     SET payment_status = 'dispatching', payment_error_code = NULL,
         updated_at = clock_timestamp()
   WHERE r.id = v_review.id;
  RETURN jsonb_build_object(
    'success', true, 'code', 'dispatch_authorized', 'booking_id', v_review.booking_id,
    'request_id', v_review.approval_request_id, 'amount_cents', v_review.amount_cents,
    'currency', v_review.currency
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.record_approved_no_show_fee_dispatch_outcome(
  p_review_id uuid,
  p_salon_id uuid,
  p_payment_operation_id uuid,
  p_status text,
  p_error_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_review public.booking_no_show_fee_reviews%ROWTYPE;
  v_receipt public.booking_no_show_fee_approval_receipts%ROWTYPE;
  v_operation public.booking_payment_operations%ROWTYPE;
BEGIN
  IF v_request_role <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_status NOT IN ('pending_provider', 'unknown', 'succeeded', 'failed')
     OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z0-9_]{1,64}$') THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_outcome');
  END IF;

  SELECT r.* INTO v_review FROM public.booking_no_show_fee_reviews r
   WHERE r.id = p_review_id AND r.salon_id = p_salon_id FOR UPDATE;
  IF NOT FOUND OR v_review.state <> 'approved_charge' THEN
    RETURN jsonb_build_object('success', false, 'code', 'charge_not_approved');
  END IF;
  SELECT a.* INTO v_receipt FROM public.booking_no_show_fee_approval_receipts a
   WHERE a.review_id = v_review.id AND a.action = 'charge';
  IF NOT FOUND
     OR v_receipt.salon_id IS DISTINCT FROM v_review.salon_id
     OR v_receipt.booking_id IS DISTINCT FROM v_review.booking_id
     OR v_receipt.approval_request_id IS DISTINCT FROM v_review.approval_request_id
     OR v_receipt.amount_cents IS DISTINCT FROM v_review.amount_cents
     OR v_receipt.currency IS DISTINCT FROM v_review.currency THEN
    RETURN jsonb_build_object('success', false, 'code', 'approval_receipt_mismatch');
  END IF;

  SELECT o.* INTO v_operation FROM public.booking_payment_operations o
   WHERE o.id = p_payment_operation_id AND o.salon_id = p_salon_id
     AND o.booking_id = v_review.booking_id AND o.operation_kind = 'noshow_charge'
     AND o.request_id = v_review.approval_request_id
     AND o.amount_cents = v_review.amount_cents
     AND o.currency = v_review.currency;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'operation_binding_mismatch');
  END IF;

  IF p_status IS DISTINCT FROM v_operation.status
     OR (p_status = 'succeeded'
         AND nullif(trim(coalesce(v_operation.provider_payment_id, '')), '') IS NULL)
     OR (p_status = 'succeeded' AND p_error_code IS NOT NULL) THEN
    RETURN jsonb_build_object('success', false, 'code', 'operation_outcome_mismatch');
  END IF;

  UPDATE public.booking_no_show_fee_reviews r
     SET payment_operation_id = v_operation.id,
         payment_status = p_status,
         payment_error_code = p_error_code,
         updated_at = clock_timestamp()
   WHERE r.id = v_review.id;
  RETURN jsonb_build_object(
    'success', true, 'code', 'outcome_recorded', 'review_id', v_review.id,
    'payment_operation_id', v_operation.id, 'payment_status', p_status
  );
END
$function$;

REVOKE ALL ON FUNCTION public.enforce_no_show_payment_operation_approval(),
  public.authorize_approved_no_show_fee_dispatch(uuid,uuid,uuid,text),
  public.record_approved_no_show_fee_dispatch_outcome(uuid,uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.authorize_approved_no_show_fee_dispatch(uuid,uuid,uuid,text),
  public.record_approved_no_show_fee_dispatch_outcome(uuid,uuid,uuid,text,text)
  TO service_role;

COMMENT ON FUNCTION public.enforce_no_show_payment_operation_approval() IS
  'Fail-closed ledger gate: no-show provider dispatch requires an exact immutable Owner/Admin approval receipt.';
