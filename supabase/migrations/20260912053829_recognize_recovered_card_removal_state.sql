-- Recovery receipts close a card lifecycle without rewriting its unknown operation.
SET lock_timeout='5s';
SET statement_timeout='30s';

CREATE OR REPLACE FUNCTION public.booking_card_protection_state(p_booking public.bookings) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_op public.booking_card_save_operations%ROWTYPE;
BEGIN
 SELECT * INTO v_op FROM public.booking_card_save_operations WHERE booking_id=p_booking.id
   AND salon_id=p_booking.salon_id AND mode='save_card' ORDER BY created_at DESC,delivery_sequence DESC,id DESC LIMIT 1;
 IF FOUND THEN
   IF v_op.status='succeeded' AND v_op.provider_reference IS NOT DISTINCT FROM p_booking.noshow_card_id
     AND coalesce(p_booking.noshow_card_id,'') ~ '^[A-Za-z0-9:_-]{1,255}$'
     AND coalesce(p_booking.noshow_customer_id,'') ~ '^[A-Za-z0-9:_-]{1,255}$'
     AND v_op.result_json->>'customer_id' IS NOT DISTINCT FROM p_booking.noshow_customer_id
     AND v_op.result_json->>'card_brand' IS NOT DISTINCT FROM p_booking.noshow_card_brand
     AND coalesce(p_booking.noshow_card_brand,'') IN ('VISA','MASTERCARD','AMERICAN_EXPRESS','AMEX','DISCOVER','DISCOVER_DINERS','DINERS','DINERS_CLUB','JCB','CHINA_UNIONPAY','UNIONPAY','UNION_PAY','INTERAC','EFTPOS','FELICA','OTHER_BRAND')
     AND v_op.result_json->>'card_last4' IS NOT DISTINCT FROM p_booking.noshow_card_last4
     AND coalesce(p_booking.noshow_card_last4,'') ~ '^[0-9]{4}$'
     AND p_booking.noshow_consent_at IS NOT NULL AND coalesce(v_op.recovery_consent_at,v_op.consent_at) IS NOT DISTINCT FROM p_booking.noshow_consent_at
     AND coalesce(v_op.recovery_consent_meta,v_op.consent_meta) IS NOT DISTINCT FROM p_booking.noshow_consent_meta
     AND coalesce(p_booking.noshow_consent_meta->>'policyVersion','') ~ '^nsp_[0-9a-f]{64}$'
     AND v_op.completion_fingerprint IS NOT NULL THEN RETURN 'saved'; END IF;
   IF v_op.status='unknown' THEN
     RETURN CASE WHEN v_op.resolution_code='manual_review_required' THEN 'manual_review' ELSE 'reconciliation_pending' END;
   ELSIF v_op.status='sending' THEN RETURN 'saving';
   ELSIF v_op.status='failed' THEN RETURN 'retry_required';
   ELSIF (v_op.status='succeeded' AND p_booking.noshow_card_id IS NULL AND p_booking.noshow_customer_id IS NULL
     AND p_booking.noshow_charge_status='removed_by_customer' AND EXISTS(
       SELECT 1 FROM public.booking_card_management_operations removal
       WHERE removal.booking_id=p_booking.id AND removal.salon_id=p_booking.salon_id
         AND removal.operation='remove_card' AND removal.status='succeeded'
         AND removal.provider_reference=v_op.provider_reference
         AND removal.provider_material->>'card_id'=v_op.provider_reference
         AND removal.provider_material->>'customer_id'=v_op.result_json->>'customer_id'
         AND removal.result_json->>'code'='removed' AND removal.result_json->>'outcome'='succeeded'
         AND removal.completed_at>=v_op.completed_at AND removal.created_at>=v_op.completed_at
     )) OR (v_op.status='succeeded' AND p_booking.noshow_card_id IS NULL AND p_booking.noshow_customer_id IS NULL
     AND p_booking.noshow_charge_status='removed_by_customer' AND EXISTS(
       SELECT 1 FROM public.booking_card_management_operations removal
       JOIN public.booking_card_removal_recovery_receipts receipt ON receipt.operation_id=removal.id
       WHERE removal.booking_id=p_booking.id AND removal.salon_id=p_booking.salon_id
         AND removal.operation='remove_card' AND removal.status='unknown'
         AND receipt.booking_id=p_booking.id AND receipt.salon_id=p_booking.salon_id
         AND receipt.provider=v_op.provider AND receipt.provider='square'
         AND receipt.card_id=v_op.provider_reference
         AND receipt.customer_id=v_op.result_json->>'customer_id'
         AND receipt.merchant_id=v_op.expected_merchant_id
         AND receipt.environment=v_op.expected_environment
         AND removal.provider_material->>'card_id'=receipt.card_id
         AND removal.provider_material->>'customer_id'=receipt.customer_id
         AND (receipt.source_save_operation_id=v_op.id OR receipt.source_removal_binding_id=removal.id)
         AND removal.created_at>=v_op.completed_at
         AND receipt.confirmed_at>=removal.created_at
     )) THEN
     -- A durable removal receipt closes the previous card lifecycle. Missing
     -- IDs without this proof remain manual review, never a retry shortcut.
     RETURN 'retry_required';
   ELSE RETURN 'manual_review'; END IF;
 END IF;
 IF p_booking.noshow_card_id IS NOT NULL THEN RETURN 'manual_review'; END IF;
 RETURN CASE WHEN p_booking.noshow_card_required THEN 'awaiting_card' ELSE 'not_required' END;
END; $$;

-- Refresh only already-recovered rows whose derived state changes.
UPDATE public.bookings b SET card_protection_status=public.booking_card_protection_state(b)
WHERE b.card_protection_status='manual_review' AND b.noshow_card_id IS NULL AND b.noshow_customer_id IS NULL
  AND b.noshow_charge_status='removed_by_customer'
  AND EXISTS(SELECT 1 FROM public.booking_card_removal_recovery_receipts r WHERE r.booking_id=b.id AND r.salon_id=b.salon_id)
  AND public.booking_card_protection_state(b)='retry_required';
