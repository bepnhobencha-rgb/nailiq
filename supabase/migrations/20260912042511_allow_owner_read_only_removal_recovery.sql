-- Owner/Admin can reconcile an existing removal after customer-link expiry.
-- Never renew the link, ignore revocation, or issue another provider mutation.
ALTER TABLE public.booking_card_removal_recovery_receipts
 ADD COLUMN owner_actor_id uuid REFERENCES auth.users(id);
CREATE INDEX ON public.booking_card_removal_recovery_receipts(owner_actor_id);
CREATE FUNCTION public.get_booking_card_removal_recovery_context_for_actor(
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
 IF NOT FOUND OR c.action<>'card_manage' OR c.revoked_at IS NOT NULL
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

CREATE OR REPLACE FUNCTION public.get_booking_card_removal_recovery_context(
 p_token_id uuid,p_request_id uuid,p_card_fingerprint text) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path TO '' AS $$
 SELECT public.get_booking_card_removal_recovery_context_for_actor(p_token_id,p_request_id,p_card_fingerprint,NULL,NULL);
$$;

CREATE FUNCTION public.get_owner_booking_card_removal_recovery_context(
 p_salon_id uuid,p_operation_id uuid,p_actor_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE o public.booking_card_management_operations%ROWTYPE;
BEGIN
 IF p_actor_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.salon_members
   WHERE salon_id=p_salon_id AND user_id=p_actor_id AND role IN ('owner','admin')) THEN
   RETURN jsonb_build_object('ok',false,'code','unauthorized'); END IF;
 SELECT * INTO o FROM public.booking_card_management_operations WHERE id=p_operation_id AND salon_id=p_salon_id AND operation='remove_card';
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','invalid_request'); END IF;
 RETURN public.get_booking_card_removal_recovery_context_for_actor(o.capability_id,o.request_id,o.card_fingerprint,p_actor_id,p_salon_id);
END; $$;

CREATE FUNCTION public.complete_owner_booking_card_removal_recovery(
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

CREATE FUNCTION public.record_owner_booking_card_removal_recovery_outcome(
 p_salon_id uuid,p_operation_id uuid,p_actor_id uuid,p_event_id uuid,
 p_provider text,p_stage text,p_code text,p_retryability text,p_read_status text,
 p_http_status integer,p_square_codes text[],p_square_categories text[]) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE o public.booking_card_management_operations%ROWTYPE;
BEGIN
 IF p_actor_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.salon_members
   WHERE salon_id=p_salon_id AND user_id=p_actor_id AND role IN ('owner','admin')) THEN
   RETURN jsonb_build_object('ok',false,'code','unauthorized'); END IF;
 SELECT * INTO o FROM public.booking_card_management_operations WHERE id=p_operation_id AND salon_id=p_salon_id AND operation='remove_card';
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','invalid_request'); END IF;
 RETURN public.record_booking_card_removal_recovery_outcome(o.capability_id,o.request_id,o.card_fingerprint,p_event_id,
   p_provider,p_stage,p_code,p_retryability,p_read_status,p_http_status,p_square_codes,p_square_categories);
END; $$;
REVOKE ALL ON FUNCTION public.get_booking_card_removal_recovery_context_for_actor(uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_booking_card_removal_recovery_context_for_actor(uuid,uuid,text,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.get_booking_card_removal_recovery_context(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_booking_card_removal_recovery_context(uuid,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.get_owner_booking_card_removal_recovery_context(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_owner_booking_card_removal_recovery_context(uuid,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.complete_owner_booking_card_removal_recovery(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_owner_booking_card_removal_recovery(uuid,uuid,uuid,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.record_owner_booking_card_removal_recovery_outcome(uuid,uuid,uuid,uuid,text,text,text,text,text,integer,text[],text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_owner_booking_card_removal_recovery_outcome(uuid,uuid,uuid,uuid,text,text,text,text,text,integer,text[],text[]) TO service_role;
