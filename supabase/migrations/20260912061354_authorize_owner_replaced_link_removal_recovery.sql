-- Preserve revocation truth, and authorize positive Owner recovery only for
-- a provable link replacement during an already prepared Square removal.
-- Never renew customer authority, rewrite historic unknown reasons, dispatch
-- provider mutations, or bypass manual revocation. Existing signatures/ACLs.
CREATE OR REPLACE FUNCTION public.complete_booking_card_management_operation(
  p_operation_id uuid,p_attempt_token uuid,p_outcome text,p_provider_reference text,p_error_code text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $card_complete$
DECLARE v_operation public.booking_card_management_operations%ROWTYPE;
  v_cap public.booking_management_capabilities%ROWTYPE; v_booking public.bookings%ROWTYPE;
  v_booking_id uuid; v_group_id uuid; v_fp text; v_now timestamptz:=transaction_timestamp();
  v_result jsonb; v_payload text; v_result_hash text;
  v_outcome text:=p_outcome; v_error_code text:=nullif(trim(coalesce(p_error_code,'')),'');
BEGIN
  IF p_operation_id IS NULL OR p_attempt_token IS NULL
     OR p_outcome NOT IN ('succeeded','failed','unknown')
     OR (p_outcome='succeeded' AND (coalesce(trim(p_provider_reference),'')=''
       OR length(trim(p_provider_reference))>255 OR trim(p_provider_reference)!~'^[[:graph:]]+$'))
     OR (p_outcome IN ('failed','unknown') AND (coalesce(trim(p_error_code),'')=''
       OR length(trim(p_error_code))>100 OR trim(p_error_code)!~'^[a-z0-9_]+$')) THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_completion');
  END IF;
  SELECT booking_id INTO v_booking_id FROM public.booking_card_management_operations WHERE id=p_operation_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','operation_not_found'); END IF;
  SELECT group_id INTO v_group_id FROM public.bookings WHERE id=v_booking_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(CASE
    WHEN v_group_id IS NULL THEN 'booking-management:'||v_booking_id::text
    ELSE 'booking-management-group:'||v_group_id::text END,0));
  SELECT * INTO v_operation FROM public.booking_card_management_operations WHERE id=p_operation_id FOR UPDATE;
  IF v_operation.attempt_token<>p_attempt_token THEN RETURN jsonb_build_object('ok',false,'code','claim_mismatch'); END IF;
  IF v_operation.status<>'sending' THEN
    IF (v_operation.status=p_outcome
          AND coalesce(v_operation.provider_reference,'')=coalesce(nullif(trim(coalesce(p_provider_reference,'')),''),'')
          AND coalesce(v_operation.error_code,'')=coalesce(nullif(trim(coalesce(p_error_code,'')),''),''))
       OR (v_operation.status='unknown' AND p_outcome='succeeded'
          AND v_operation.error_code='card_state_changed_after_provider'
          AND coalesce(v_operation.provider_reference,'')=coalesce(trim(p_provider_reference),'')) THEN
      RETURN v_operation.result_json||jsonb_build_object('idempotent',true);
    END IF;
    RETURN jsonb_build_object('ok',false,'code','completion_conflict');
  END IF;
  SELECT * INTO STRICT v_cap FROM public.booking_management_capabilities WHERE id=v_operation.capability_id FOR UPDATE;
  SELECT * INTO STRICT v_booking FROM public.bookings
  WHERE id=v_operation.booking_id AND salon_id=v_operation.salon_id FOR UPDATE;
  v_fp:=encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'card_id',v_booking.noshow_card_id,'customer_id',v_booking.noshow_customer_id,
    'charge_status',v_booking.noshow_charge_status)::text,'UTF8'),'sha256'),'hex');
  IF v_outcome='succeeded' AND v_fp<>v_operation.card_fingerprint THEN v_outcome:='unknown';
    v_error_code:='card_state_changed_after_provider'; END IF;
  IF v_outcome='succeeded' THEN
    UPDATE public.bookings SET noshow_card_id=NULL,noshow_customer_id=NULL,
      noshow_charge_status='removed_by_customer' WHERE id=v_booking.id;
  END IF;
  v_result:=jsonb_build_object('ok',v_outcome='succeeded','code',CASE v_outcome
      WHEN 'succeeded' THEN 'removed' WHEN 'failed' THEN 'remove_failed' ELSE 'remove_unknown' END,
    'booking_id',v_booking.id,'salon_id',v_booking.salon_id,'outcome',v_outcome,'idempotent',false);
  v_payload:=encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'operation','remove_card','card_fingerprint',v_operation.card_fingerprint)::text,'UTF8'),'sha256'),'hex');
  v_result_hash:=encode(extensions.digest(pg_catalog.convert_to(v_result::text,'UTF8'),'sha256'),'hex');
  UPDATE public.booking_card_management_operations SET status=v_outcome,
    provider_reference=nullif(trim(coalesce(p_provider_reference,'')),''),
    error_code=v_error_code,result_json=v_result,
    completed_at=v_now,updated_at=v_now WHERE id=v_operation.id;
  UPDATE public.booking_management_capabilities SET consumed_at=v_now,request_id=v_operation.request_id,
    payload_fingerprint=v_payload,result_json=v_result,result_fingerprint=v_result_hash,
    revoke_reason=CASE WHEN v_cap.revoked_at IS NOT NULL THEN v_cap.revoke_reason
      ELSE 'action_consumed' END,updated_at=v_now WHERE id=v_cap.id;
  UPDATE public.booking_management_action_state SET epoch=epoch+1,updated_at=v_now
  WHERE salon_id=v_cap.salon_id AND booking_id=v_cap.booking_id AND action='card_manage';
  INSERT INTO public.booking_management_action_receipts(capability_id,salon_id,booking_id,
    action,request_id,action_epoch,payload_fingerprint,result_fingerprint)
  VALUES(v_cap.id,v_cap.salon_id,v_cap.booking_id,'card_manage',v_operation.request_id,
    v_cap.epoch,v_payload,v_result_hash);
  RETURN v_result;
END;
$card_complete$;

CREATE OR REPLACE FUNCTION public.get_booking_card_removal_recovery_context_for_actor(
 p_token_id uuid,p_request_id uuid,p_card_fingerprint text,p_actor_id uuid,p_salon_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE c public.booking_management_capabilities%ROWTYPE;
 o public.booking_card_management_operations%ROWTYPE; b public.bookings%ROWTYPE;
 s public.booking_card_save_operations%ROWTYPE; d public.booking_card_removal_dispatch_bindings%ROWTYPE; n integer; fp text;
BEGIN
 IF (p_actor_id IS NULL) IS DISTINCT FROM (p_salon_id IS NULL) THEN
   RETURN jsonb_build_object('ok',false,'code','unauthorized'); END IF;
 IF p_actor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.salon_members
   WHERE user_id=p_actor_id AND salon_id=p_salon_id AND role IN ('owner','admin')) THEN
   RETURN jsonb_build_object('ok',false,'code','unauthorized'); END IF;
 SELECT * INTO c FROM public.booking_management_capabilities WHERE id=p_token_id;
 IF NOT FOUND OR c.action<>'card_manage'
   OR (c.revoked_at IS NOT NULL AND (p_actor_id IS NULL
     OR c.revoke_reason IS DISTINCT FROM 'replaced_for_longer_expiry'))
   OR (p_actor_id IS NULL AND c.expires_at<=transaction_timestamp()) THEN
   RETURN jsonb_build_object('ok',false,'code','expired_or_revoked'); END IF;
 IF p_actor_id IS NOT NULL AND c.salon_id IS DISTINCT FROM p_salon_id THEN
   RETURN jsonb_build_object('ok',false,'code','unauthorized'); END IF;
 SELECT * INTO o FROM public.booking_card_management_operations WHERE capability_id=c.id;
 IF NOT FOUND OR o.request_id IS DISTINCT FROM p_request_id
   OR o.card_fingerprint IS DISTINCT FROM p_card_fingerprint
   OR o.booking_id<>c.booking_id OR o.salon_id<>c.salon_id THEN
   RETURN jsonb_build_object('ok',false,'code','invalid_request'); END IF;
 SELECT * INTO b FROM public.bookings WHERE id=o.booking_id AND salon_id=o.salon_id AND deleted_at IS NULL;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','booking_state_changed'); END IF;
 IF c.consumed_at IS NULL OR c.request_id IS DISTINCT FROM p_request_id OR NOT EXISTS(
   SELECT 1 FROM public.booking_management_action_state WHERE salon_id=o.salon_id
     AND booking_id=o.booking_id AND action='card_manage' AND epoch=c.epoch+1) THEN
   RETURN jsonb_build_object('ok',false,'code','booking_state_changed'); END IF;
 -- Owner authority is independent of the retired customer link, but only a
 -- proven replacement during this same removal qualifies. Manual/unknown
 -- revocation, missing history and later card actions remain denied.
 IF c.revoked_at IS NOT NULL AND (
   o.status<>'unknown' OR o.completed_at IS NULL OR c.revoked_at>o.completed_at
   OR NOT EXISTS(SELECT 1 FROM public.booking_management_capabilities successor
     WHERE successor.id<>c.id AND successor.salon_id=c.salon_id
       AND successor.booking_id=c.booking_id AND successor.action='card_manage'
       AND successor.epoch=c.epoch AND successor.card_state_fingerprint=c.card_state_fingerprint
       AND successor.created_at>=c.revoked_at AND successor.created_at<=o.completed_at
       AND successor.revoked_at IS NULL AND successor.consumed_at IS NULL)
   OR NOT EXISTS(SELECT 1 FROM public.booking_card_removal_dispatch_bindings binding
     WHERE binding.operation_id=o.id AND binding.salon_id=o.salon_id
       AND binding.booking_id=o.booking_id AND binding.provider='square'
       AND binding.card_id=o.provider_material->>'card_id'
       AND binding.customer_id=o.provider_material->>'customer_id'
       AND binding.prepared_at<=c.revoked_at)) THEN
   RETURN jsonb_build_object('ok',false,'code','expired_or_revoked'); END IF;
 IF EXISTS(SELECT 1 FROM public.booking_card_removal_recovery_receipts WHERE operation_id=o.id) THEN
   IF b.noshow_card_id IS NOT NULL OR b.noshow_charge_status IS DISTINCT FROM 'removed_by_customer' THEN
     RETURN jsonb_build_object('ok',false,'code','booking_state_changed'); END IF;
   RETURN jsonb_build_object('ok',true,'code','removed','idempotent',true); END IF;
 IF o.status<>'unknown' THEN RETURN jsonb_build_object('ok',false,'code','recovery_not_required'); END IF;
 fp:=encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
   'card_id',b.noshow_card_id,'customer_id',b.noshow_customer_id,
   'charge_status',b.noshow_charge_status)::text,'UTF8'),'sha256'),'hex');
 IF fp<>o.card_fingerprint OR b.noshow_card_id IS DISTINCT FROM o.provider_material->>'card_id'
   OR b.noshow_customer_id IS DISTINCT FROM o.provider_material->>'customer_id'
   OR b.noshow_charge_status='charged' THEN
   RETURN jsonb_build_object('ok',false,'code','booking_state_changed'); END IF;
 -- A dispatch binding identifies the account used by this removal, even when
 -- the legacy card predates the card-save operation ledger.
 SELECT * INTO d FROM public.booking_card_removal_dispatch_bindings WHERE operation_id=o.id;
 IF FOUND THEN
   IF d.salon_id<>o.salon_id OR d.booking_id<>o.booking_id
     OR d.card_id IS DISTINCT FROM b.noshow_card_id OR d.customer_id IS DISTINCT FROM b.noshow_customer_id THEN
     RETURN jsonb_build_object('ok',false,'code','booking_state_changed'); END IF;
   RETURN jsonb_build_object('ok',true,'code','recovery_read_required','operation_id',o.id,
     'source_save_operation_id',NULL,'source_removal_binding_id',d.operation_id,
     'salon_id',o.salon_id,'card_id',d.card_id,'customer_id',d.customer_id,
     'merchant_id',d.merchant_id,'environment',d.environment);
 END IF;
 -- A later save or a current integration config cannot establish historical
 -- ownership. Require exactly one successful, bound save predating removal.
 SELECT count(*) INTO n FROM public.booking_card_save_operations
 WHERE booking_id=b.id AND salon_id=b.salon_id AND status='succeeded' AND provider='square'
   AND provider_reference=b.noshow_card_id AND expected_customer_id=b.noshow_customer_id
   AND expected_merchant_id IS NOT NULL AND expected_environment IS NOT NULL
   AND completed_at<=o.created_at;
 IF n<>1 THEN RETURN jsonb_build_object('ok',false,'code','removal_manual_review'); END IF;
 SELECT * INTO s FROM public.booking_card_save_operations
 WHERE booking_id=b.id AND salon_id=b.salon_id AND status='succeeded' AND provider='square'
   AND provider_reference=b.noshow_card_id AND expected_customer_id=b.noshow_customer_id
   AND expected_merchant_id IS NOT NULL AND expected_environment IS NOT NULL
   AND completed_at<=o.created_at;
 RETURN jsonb_build_object('ok',true,'code','recovery_read_required','operation_id',o.id,
   'source_save_operation_id',s.id,'salon_id',o.salon_id,'card_id',b.noshow_card_id,
   'customer_id',s.expected_customer_id,'merchant_id',s.expected_merchant_id,
   'environment',s.expected_environment);
END; $$;

CREATE OR REPLACE FUNCTION public.complete_owner_booking_card_removal_recovery(
 p_salon_id uuid,p_operation_id uuid,p_actor_id uuid,p_receipt jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE ctx jsonb; bid uuid; gid uuid; opid uuid; capid uuid;
BEGIN
 SELECT booking_id,capability_id INTO bid,capid FROM public.booking_card_management_operations WHERE id=p_operation_id AND salon_id=p_salon_id;
 IF bid IS NULL THEN RETURN jsonb_build_object('ok',false,'code','invalid_token'); END IF;
 SELECT group_id INTO gid FROM public.bookings WHERE id=bid;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(CASE WHEN gid IS NULL
   THEN 'booking-management:'||bid::text ELSE 'booking-management-group:'||gid::text END,0));
 PERFORM 1 FROM public.booking_management_capabilities WHERE id=capid FOR UPDATE;
 PERFORM 1 FROM public.booking_card_management_operations WHERE id=p_operation_id FOR UPDATE;
 PERFORM 1 FROM public.bookings WHERE id=bid FOR UPDATE;
 -- Serialize the final membership check with concurrent role changes.
 PERFORM 1 FROM public.salon_members WHERE salon_id=p_salon_id AND user_id=p_actor_id
   AND role IN ('owner','admin') FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','unauthorized'); END IF;
 -- Freeze successor authority through receipt insertion. The original cap is
 -- already locked; a concurrent manual revocation cannot pass the final check.
 PERFORM 1 FROM public.booking_management_capabilities
 WHERE salon_id=p_salon_id AND booking_id=bid AND action='card_manage' AND id<>capid
   AND epoch=(SELECT epoch FROM public.booking_management_capabilities WHERE id=capid)
 ORDER BY id FOR SHARE;
 ctx:=public.get_owner_booking_card_removal_recovery_context(p_salon_id,p_operation_id,p_actor_id);
 IF ctx->>'code'='removed' OR ctx->>'ok' IS DISTINCT FROM 'true' THEN RETURN ctx; END IF;
 IF (jsonb_typeof(p_receipt)='object' AND p_receipt->'enabled'='false'::jsonb
   AND p_receipt->>'operation_id'=ctx->>'operation_id'
   AND (p_receipt->>'source_save_operation_id' IS NOT DISTINCT FROM ctx->>'source_save_operation_id')
   AND (p_receipt->>'source_removal_binding_id' IS NOT DISTINCT FROM ctx->>'source_removal_binding_id')
   AND p_receipt->>'card_id'=ctx->>'card_id' AND p_receipt->>'customer_id'=ctx->>'customer_id'
   AND p_receipt->>'merchant_id'=ctx->>'merchant_id' AND p_receipt->>'environment'=ctx->>'environment'
   AND p_receipt->>'last4' ~ '^[0-9]{4}$'
   AND p_receipt->>'brand' IN ('VISA','MASTERCARD','AMERICAN_EXPRESS','DISCOVER','DISCOVER_DINERS',
     'DINERS_CLUB','JCB','UNIONPAY','CHINA_UNIONPAY','EFTPOS','INTERAC','OTHER_BRAND')) IS NOT TRUE THEN
   RETURN jsonb_build_object('ok',false,'code','invalid_recovery_receipt'); END IF;
 opid:=(ctx->>'operation_id')::uuid;
 INSERT INTO public.booking_card_removal_recovery_receipts(operation_id,salon_id,booking_id,
   source_save_operation_id,source_removal_binding_id,provider,card_id,customer_id,merchant_id,environment,owner_actor_id)
 VALUES(opid,(ctx->>'salon_id')::uuid,bid,(ctx->>'source_save_operation_id')::uuid,(ctx->>'source_removal_binding_id')::uuid,'square',
   ctx->>'card_id',ctx->>'customer_id',ctx->>'merchant_id',ctx->>'environment',p_actor_id);
 UPDATE public.bookings SET noshow_card_id=NULL,noshow_customer_id=NULL,
   noshow_charge_status='removed_by_customer' WHERE id=bid AND salon_id=(ctx->>'salon_id')::uuid;
 RETURN jsonb_build_object('ok',true,'code','removed','idempotent',false);
END; $$;
