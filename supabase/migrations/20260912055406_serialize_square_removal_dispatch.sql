-- Square removal: one dispatch authorization per operation, across processes.
-- Existing bindings are conservatively treated as possibly dispatched.
-- Keep authority/card/account checks and ACLs. No provider call or re-dispatch.
-- A stale sending operation becomes immutable unknown through existing completion;
-- its frozen identity supports the existing read-only recovery path.
CREATE OR REPLACE FUNCTION public.prepare_booking_card_removal_dispatch(
 p_operation_id uuid,p_attempt_token uuid,p_provider text,p_merchant_id text,p_environment text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE o public.booking_card_management_operations%ROWTYPE;
 c public.booking_management_capabilities%ROWTYPE; b public.bookings%ROWTYPE;
 d public.booking_card_removal_dispatch_bindings%ROWTYPE; bid uuid; gid uuid; fp text; settled jsonb;
BEGIN
 IF p_operation_id IS NULL OR p_attempt_token IS NULL OR p_provider IS NULL
   OR p_provider NOT IN ('square','stripe') THEN
   RETURN jsonb_build_object('ok',false,'code','invalid_request'); END IF;
 SELECT booking_id INTO bid FROM public.booking_card_management_operations WHERE id=p_operation_id;
 IF bid IS NULL THEN RETURN jsonb_build_object('ok',false,'code','operation_not_found'); END IF;
 SELECT group_id INTO gid FROM public.bookings WHERE id=bid;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(CASE WHEN gid IS NULL
   THEN 'booking-management:'||bid::text ELSE 'booking-management-group:'||gid::text END,0));
 SELECT * INTO o FROM public.booking_card_management_operations WHERE id=p_operation_id FOR UPDATE;
 IF o.attempt_token IS DISTINCT FROM p_attempt_token OR o.status<>'sending' OR o.operation<>'remove_card' THEN
   RETURN jsonb_build_object('ok',false,'code','claim_mismatch'); END IF;
 SELECT * INTO c FROM public.booking_management_capabilities WHERE id=o.capability_id FOR UPDATE;
 IF NOT FOUND OR c.action<>'card_manage' OR c.salon_id<>o.salon_id OR c.booking_id<>o.booking_id
   OR c.consumed_at IS NOT NULL OR c.revoked_at IS NOT NULL OR c.expires_at<=transaction_timestamp() THEN
   RETURN jsonb_build_object('ok',false,'code','expired_or_revoked'); END IF;
 SELECT * INTO b FROM public.bookings WHERE id=o.booking_id AND salon_id=o.salon_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','booking_state_changed'); END IF;
 fp:=encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
   'card_id',b.noshow_card_id,'customer_id',b.noshow_customer_id,
   'charge_status',b.noshow_charge_status)::text,'UTF8'),'sha256'),'hex');
 IF fp IS DISTINCT FROM o.card_fingerprint OR fp IS DISTINCT FROM c.card_state_fingerprint
   OR b.noshow_card_id IS DISTINCT FROM o.provider_material->>'card_id'
   OR coalesce(b.noshow_customer_id,'') IS DISTINCT FROM o.provider_material->>'customer_id'
   OR b.noshow_charge_status='charged' OR NOT EXISTS(SELECT 1 FROM public.booking_management_action_state
     WHERE salon_id=o.salon_id AND booking_id=o.booking_id AND action='card_manage' AND epoch=c.epoch) THEN
   RETURN jsonb_build_object('ok',false,'code','booking_state_changed'); END IF;
 SELECT * INTO d FROM public.booking_card_removal_dispatch_bindings WHERE operation_id=o.id;
 IF FOUND THEN
   IF d.provider IS DISTINCT FROM p_provider OR d.merchant_id IS DISTINCT FROM p_merchant_id
     OR d.environment IS DISTINCT FROM p_environment OR d.card_id IS DISTINCT FROM b.noshow_card_id
     OR d.customer_id IS DISTINCT FROM b.noshow_customer_id THEN
     RETURN jsonb_build_object('ok',false,'code','removal_provider_mismatch'); END IF;
   -- A durable binding consumes the one provider-dispatch authorization. A
   -- repeated/lost acknowledgment never grants a second authorization.
   -- Age only enables read-only recovery; it NEVER renews dispatch permission.
   IF d.prepared_at > clock_timestamp()-interval '2 minutes' THEN
     RETURN jsonb_build_object('ok',false,'code','removal_dispatch_in_progress'); END IF;
   settled:=public.complete_booking_card_management_operation(o.id,p_attempt_token,
     'unknown',NULL,'removal_dispatch_outcome_uncertain');
   RETURN settled;

 END IF;
 -- Stripe retains its existing path, but cannot take over a frozen Square operation.
 -- No Stripe account identity is claimed by this bounded migration.
 IF p_provider='stripe' THEN
   RETURN jsonb_build_object('ok',true,'code','removal_dispatch_prepared','idempotent',false); END IF;
 IF (p_merchant_id ~ '^[A-Za-z0-9:_-]{1,255}$' AND p_environment IN ('sandbox','production')
   AND b.noshow_card_id ~ '^[A-Za-z0-9:_-]{1,255}$' AND b.noshow_customer_id ~ '^[A-Za-z0-9:_-]{1,255}$') IS NOT TRUE THEN
   RETURN jsonb_build_object('ok',false,'code','invalid_provider_identity'); END IF;
 INSERT INTO public.booking_card_removal_dispatch_bindings(operation_id,salon_id,booking_id,provider,
   card_id,customer_id,merchant_id,environment) VALUES(o.id,o.salon_id,o.booking_id,'square',
   b.noshow_card_id,b.noshow_customer_id,p_merchant_id,p_environment);
 RETURN jsonb_build_object('ok',true,'code','removal_dispatch_prepared','idempotent',false);
END; $$;
REVOKE ALL ON FUNCTION public.prepare_booking_card_removal_dispatch(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_booking_card_removal_dispatch(uuid,uuid,text,text,text) TO service_role;
