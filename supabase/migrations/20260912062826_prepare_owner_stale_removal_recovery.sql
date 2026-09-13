-- Owner-only quarantine of a stale prepared Square removal. Time never renews
-- provider dispatch authority. Positive read-only recovery uses existing receipts.
CREATE FUNCTION public.prepare_owner_booking_card_removal_recovery(
 p_salon_id uuid,p_operation_id uuid,p_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE o public.booking_card_management_operations%ROWTYPE;
 c public.booking_management_capabilities%ROWTYPE; b public.bookings%ROWTYPE;
 d public.booking_card_removal_dispatch_bindings%ROWTYPE;
 bid uuid; gid uuid; fp text; result jsonb;
BEGIN
 IF p_actor_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.salon_members
   WHERE salon_id=p_salon_id AND user_id=p_actor_id AND role IN ('owner','admin')) THEN
   RETURN jsonb_build_object('ok',false,'code','unauthorized'); END IF;
 SELECT booking_id INTO bid FROM public.booking_card_management_operations
 WHERE id=p_operation_id AND salon_id=p_salon_id AND operation='remove_card';
 IF bid IS NULL THEN RETURN jsonb_build_object('ok',false,'code','invalid_request'); END IF;
 SELECT group_id INTO gid FROM public.bookings WHERE id=bid AND salon_id=p_salon_id;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(CASE WHEN gid IS NULL
   THEN 'booking-management:'||bid::text ELSE 'booking-management-group:'||gid::text END,0));
 SELECT * INTO o FROM public.booking_card_management_operations WHERE id=p_operation_id FOR UPDATE;
 SELECT * INTO c FROM public.booking_management_capabilities WHERE id=o.capability_id FOR UPDATE;
 SELECT * INTO b FROM public.bookings WHERE id=bid AND salon_id=p_salon_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','booking_state_changed'); END IF;
 PERFORM 1 FROM public.salon_members WHERE salon_id=p_salon_id AND user_id=p_actor_id
   AND role IN ('owner','admin') FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','unauthorized'); END IF;
 IF o.status<>'sending' THEN
   RETURN public.get_owner_booking_card_removal_recovery_context(p_salon_id,p_operation_id,p_actor_id); END IF;
 IF c.id IS NULL OR c.action<>'card_manage' OR c.salon_id<>o.salon_id OR c.booking_id<>o.booking_id
   OR c.consumed_at IS NOT NULL OR (c.revoked_at IS NOT NULL
     AND c.revoke_reason IS DISTINCT FROM 'replaced_for_longer_expiry') THEN
   RETURN jsonb_build_object('ok',false,'code','expired_or_revoked'); END IF;
 fp:=encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
   'card_id',b.noshow_card_id,'customer_id',b.noshow_customer_id,
   'charge_status',b.noshow_charge_status)::text,'UTF8'),'sha256'),'hex');
 IF fp IS DISTINCT FROM o.card_fingerprint OR fp IS DISTINCT FROM c.card_state_fingerprint
   OR b.noshow_card_id IS DISTINCT FROM o.provider_material->>'card_id'
   OR b.noshow_customer_id IS DISTINCT FROM o.provider_material->>'customer_id'
   OR b.noshow_charge_status='charged' OR NOT EXISTS(SELECT 1 FROM public.booking_management_action_state
     WHERE salon_id=o.salon_id AND booking_id=o.booking_id AND action='card_manage' AND epoch=c.epoch) THEN
   RETURN jsonb_build_object('ok',false,'code','booking_state_changed'); END IF;
 SELECT * INTO d FROM public.booking_card_removal_dispatch_bindings WHERE operation_id=o.id;
 IF NOT FOUND OR d.provider<>'square' OR d.salon_id<>o.salon_id OR d.booking_id<>o.booking_id
   OR d.card_id IS DISTINCT FROM b.noshow_card_id OR d.customer_id IS DISTINCT FROM b.noshow_customer_id THEN
   RETURN jsonb_build_object('ok',false,'code','removal_manual_review'); END IF;
 PERFORM 1 FROM public.booking_management_capabilities WHERE salon_id=o.salon_id AND booking_id=o.booking_id
   AND action='card_manage' AND epoch=c.epoch AND id<>c.id ORDER BY id FOR SHARE;
 IF c.revoked_at IS NOT NULL AND (d.prepared_at>c.revoked_at OR c.revoked_at>transaction_timestamp()
   OR NOT EXISTS(SELECT 1 FROM public.booking_management_capabilities successor
     WHERE successor.id<>c.id AND successor.salon_id=c.salon_id AND successor.booking_id=c.booking_id
       AND successor.action='card_manage' AND successor.epoch=c.epoch
       AND successor.card_state_fingerprint=c.card_state_fingerprint
       AND successor.created_at>=c.revoked_at AND successor.created_at<=transaction_timestamp()
       AND successor.revoked_at IS NULL AND successor.consumed_at IS NULL)) THEN
   RETURN jsonb_build_object('ok',false,'code','expired_or_revoked'); END IF;
 IF d.prepared_at>clock_timestamp()-interval '2 minutes' THEN
   RETURN jsonb_build_object('ok',false,'code','in_flight'); END IF;
 result:=public.complete_booking_card_management_operation(o.id,o.attempt_token,'unknown',NULL,
   'removal_dispatch_outcome_uncertain');
 IF result->>'code' IS DISTINCT FROM 'remove_unknown' THEN
   RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='owner_removal_recovery_state_changed'; END IF;
 result:=public.get_owner_booking_card_removal_recovery_context(p_salon_id,p_operation_id,p_actor_id);
 IF result->>'ok' IS DISTINCT FROM 'true' THEN
   RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='owner_removal_recovery_state_changed'; END IF;
 RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.prepare_owner_booking_card_removal_recovery(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_owner_booking_card_removal_recovery(uuid,uuid,uuid) TO service_role;
