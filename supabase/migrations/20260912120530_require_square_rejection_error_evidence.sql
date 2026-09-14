-- Require explicit allowlisted Square rejection codes as well as retryability.
CREATE OR REPLACE FUNCTION public.complete_booking_card_save_operation(p_operation_id uuid, p_attempt_token uuid, p_outcome text, p_provider_reference text, p_card_id text, p_customer_id text, p_card_brand text, p_card_last4 text, p_consent_at timestamp with time zone, p_consent_meta jsonb, p_error_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_op public.booking_card_save_operations%ROWTYPE; v_result jsonb;
BEGIN
 IF p_attempt_token IS NULL OR p_outcome IS NULL THEN RETURN jsonb_build_object('ok',false,'code','invalid_completion'); END IF;
 SELECT * INTO v_op FROM public.booking_card_save_operations WHERE id=p_operation_id;
 IF p_outcome='succeeded' AND v_op.mode='save_card' AND (
   coalesce(p_customer_id,'') !~ '^[A-Za-z0-9:_-]{1,255}$'
   OR coalesce(p_card_brand,'') NOT IN ('VISA','MASTERCARD','AMERICAN_EXPRESS','AMEX','DISCOVER','DISCOVER_DINERS','DINERS','DINERS_CLUB','JCB','CHINA_UNIONPAY','UNIONPAY','UNION_PAY','INTERAC','EFTPOS','FELICA','OTHER_BRAND')
   OR p_card_id IS DISTINCT FROM p_provider_reference
   OR coalesce(p_consent_meta->>'policyVersion','') !~ '^nsp_[0-9a-f]{64}$'
   OR v_op.consent_at IS DISTINCT FROM p_consent_at OR v_op.consent_meta IS DISTINCT FROM p_consent_meta
   OR (v_op.provider='square' AND (v_op.expected_customer_id IS DISTINCT FROM p_customer_id
     OR v_op.card_dispatch_bound_at IS NULL))) THEN
   RETURN jsonb_build_object('ok',false,'code','invalid_completion'); END IF;
 v_result:=public.complete_booking_card_save_operation_pre_delivery_truth(p_operation_id,p_attempt_token,p_outcome,
   p_provider_reference,p_card_id,p_customer_id,p_card_brand,p_card_last4,p_consent_at,p_consent_meta,p_error_code);
 IF v_result->>'ok'='true' AND v_op.mode='save_card' THEN
   UPDATE public.booking_card_save_operations SET result_json=result_json||jsonb_build_object('customer_id',p_customer_id),
     next_reconcile_at=NULL,resolution_code='provider_card_found' WHERE id=p_operation_id;
 ELSIF v_result->>'code'='save_failed' THEN
   UPDATE public.booking_card_save_operations SET next_reconcile_at=NULL,resolution_code='customer_reentry_required'
     WHERE id=p_operation_id;
 END IF;

 -- Classify only a durably failed Square card creation with explicit provider
 -- rejection evidence. Store the classification in the same transaction so
 -- claim/replay returns identical semantics without calling the provider.
 IF v_result->>'ok'='false' AND v_result->>'code'='save_failed'
   AND EXISTS (
     SELECT 1 FROM public.booking_card_save_operations o
     JOIN public.booking_card_delivery_events e ON e.operation_id=o.id
       AND e.booking_id=o.booking_id AND e.salon_id=o.salon_id AND e.provider=o.provider
     WHERE o.id=p_operation_id AND o.status='failed' AND o.mode='save_card'
       AND o.provider='square' AND o.error_code='square_card_create_failed'
       AND o.card_dispatch_bound_at IS NOT NULL
       AND e.stage='card_create' AND e.code=o.error_code AND e.retryability='new_card'
       AND cardinality(e.square_codes)>0
       AND e.square_codes <@ ARRAY['CARD_DECLINED','GENERIC_DECLINE','CARD_NOT_SUPPORTED','CARD_EXPIRED',
         'INVALID_CARD_DATA','VERIFY_CVV_FAILURE','VERIFY_AVS_FAILURE','CARD_DECLINED_VERIFICATION_REQUIRED',
         'SOURCE_EXPIRED','SOURCE_USED','CARD_TOKEN_EXPIRED','CARD_TOKEN_USED']::text[]
       AND e.provider_http_status BETWEEN 400 AND 499
       AND e.provider_http_status NOT IN (408,409,425,429)
   ) THEN
   v_result:=v_result||jsonb_build_object('failure_kind','card_rejected');
   UPDATE public.booking_card_save_operations
     SET result_json=result_json||jsonb_build_object('failure_kind','card_rejected')
     WHERE id=p_operation_id AND status='failed';
 END IF;
 RETURN v_result;
END; $function$;
