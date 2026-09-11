-- Recover corrected contact after a proven pre-CreateCustomer failure.
-- No provider calls or booking rewrites. Preserve all uncertain-dispatch identity fences.

CREATE OR REPLACE FUNCTION public.claim_booking_card_save_operation(p_token_id uuid,p_request_id uuid,p_provider text,p_mode text,p_source_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_booking public.bookings%ROWTYPE; v_result jsonb; v_first public.booking_card_save_operations%ROWTYPE; v_material jsonb;
BEGIN
 SELECT b.* INTO v_booking FROM public.bookings b JOIN public.booking_management_capabilities c
   ON c.booking_id=b.id AND c.salon_id=b.salon_id WHERE c.id=p_token_id AND c.action='card_manage';
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','invalid_token'); END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(CASE WHEN v_booking.group_id IS NULL
   THEN 'booking-management:'||v_booking.id::text ELSE 'booking-management-group:'||v_booking.group_id::text END,0));
 IF EXISTS(SELECT 1 FROM public.booking_card_save_operations WHERE booking_id=v_booking.id
   AND salon_id=v_booking.salon_id AND status IN ('sending','unknown') AND capability_id<>p_token_id) THEN
   RETURN jsonb_build_object('ok',false,'code','reconciliation_required'); END IF;
 v_result:=public.claim_booking_card_save_operation_pre_delivery_truth(p_token_id,p_request_id,p_provider,p_mode,p_source_fingerprint);
 IF v_result->>'ok'='true' AND v_result->>'code' IN ('saved','reconciled_saved') THEN
   SELECT * INTO v_booking FROM public.bookings WHERE id=v_booking.id;
   IF public.booking_card_protection_state(v_booking)<>'saved' THEN
     RETURN jsonb_build_object('ok',false,'code','card_state_changed'); END IF;
 END IF;
 IF v_result->>'code'='claimed' AND v_result->>'attempt_replay'='false' THEN
   -- Freeze customer identity only once it is known or a creation may have
   -- reached Square. A proven pre-create failure can use corrected booking
   -- contact on a fresh card attempt. Legacy ambiguity remains conservative.
   SELECT old.* INTO v_first FROM public.booking_card_save_operations old
     WHERE old.booking_id=v_booking.id AND old.salon_id=v_booking.salon_id AND old.provider=p_provider
       AND (old.id=(v_result->>'operation_id')::uuid
         OR (old.customer_delivery_version IS NULL AND old.dispatch_prepared_at IS NOT NULL)
         OR old.card_dispatch_bound_at IS NOT NULL
         OR EXISTS(SELECT 1 FROM public.square_card_customer_claims c WHERE c.id=old.customer_claim_id
           AND (c.dispatch_prepared_at IS NOT NULL OR c.customer_id IS NOT NULL)))
     ORDER BY old.created_at,old.delivery_sequence,old.id LIMIT 1;
   UPDATE public.booking_card_save_operations SET provider_material=provider_material||jsonb_build_object(
     'client_name',v_first.provider_material->'client_name','client_phone',v_first.provider_material->'client_phone',
     'client_email',v_first.provider_material->'client_email',
     'whole_party',(SELECT noshow_group_whole_party FROM public.salons WHERE id=v_booking.salon_id),
     'customer_idempotency_key',CASE WHEN v_first.delivery_version IS NULL THEN v_first.id::text||':customer' ELSE 'sqcust:'||v_booking.id::text END),
     expected_merchant_id=(SELECT expected_merchant_id FROM public.booking_card_save_operations WHERE booking_id=v_booking.id
       AND provider=p_provider AND expected_merchant_id IS NOT NULL ORDER BY created_at,delivery_sequence,id LIMIT 1),
     expected_environment=(SELECT expected_environment FROM public.booking_card_save_operations WHERE booking_id=v_booking.id
       AND provider=p_provider AND expected_environment IS NOT NULL ORDER BY created_at,delivery_sequence,id LIMIT 1),
     expected_customer_id=(SELECT expected_customer_id FROM public.booking_card_save_operations WHERE booking_id=v_booking.id
       AND provider=p_provider AND expected_customer_id IS NOT NULL ORDER BY created_at,delivery_sequence,id LIMIT 1)
   WHERE id=(v_result->>'operation_id')::uuid RETURNING provider_material INTO v_material;
   v_result:=v_result||jsonb_build_object('provider_material',v_material);
 END IF;
 RETURN v_result;
END; $$;

CREATE OR REPLACE FUNCTION public.claim_square_card_customer(p_operation_id uuid,p_attempt_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_op public.booking_card_save_operations%ROWTYPE; v_claim public.square_card_customer_claims%ROWTYPE;
 v_legacy public.booking_card_save_operations%ROWTYPE; v_contact text; v_legacy_keys integer; v_token uuid:=extensions.gen_random_uuid();
 v_id uuid:=extensions.gen_random_uuid(); v_now timestamptz:=transaction_timestamp();
BEGIN
 SELECT * INTO v_op FROM public.booking_card_save_operations WHERE id=p_operation_id FOR UPDATE;
 IF NOT FOUND OR p_attempt_token IS NULL OR v_op.attempt_token IS DISTINCT FROM p_attempt_token
   OR v_op.status<>'sending' OR v_op.provider<>'square' OR v_op.mode<>'save_card'
   OR v_op.dispatch_prepared_at IS NULL OR v_op.created_at<v_now-interval '2 minutes'
   OR v_op.expected_merchant_id IS NULL OR v_op.expected_environment IS NULL OR v_op.customer_delivery_version IS DISTINCT FROM 1
 THEN RETURN jsonb_build_object('ok',false,'code','claim_mismatch'); END IF;
 v_contact:=public.square_card_contact_fingerprint(v_op.provider_material,v_op.booking_id);
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('square-card-customer:'||v_op.salon_id::text||':'||
   v_op.expected_merchant_id||':'||v_op.expected_environment||':'||v_contact,0));
 SELECT * INTO v_claim FROM public.square_card_customer_claims WHERE salon_id=v_op.salon_id
   AND merchant_id=v_op.expected_merchant_id AND environment=v_op.expected_environment AND contact_fingerprint=v_contact FOR UPDATE;
 IF NOT FOUND THEN
   -- The first deployment must not use a fresh key while an older customer
   -- request may exist. Adopt its exact frozen material/key/reference, or fence
   -- multiple legacy identities for manual review rather than choosing one.
   SELECT count(DISTINCT coalesce(old.provider_material->>'customer_idempotency_key',CASE WHEN old.delivery_version IS NULL
     THEN old.id::text||':customer' ELSE 'sqcust:'||old.booking_id::text END)) INTO v_legacy_keys
   FROM public.booking_card_save_operations old WHERE old.id<>v_op.id AND old.salon_id=v_op.salon_id AND old.provider='square' AND old.mode='save_card'
     AND old.customer_delivery_version IS NULL AND old.dispatch_prepared_at IS NOT NULL
     AND old.status<>'succeeded' AND old.expected_customer_id IS NULL
     AND (old.expected_merchant_id IS NULL OR old.expected_merchant_id=v_op.expected_merchant_id)
     AND (old.expected_environment IS NULL OR old.expected_environment=v_op.expected_environment)
     AND public.square_card_contact_fingerprint(old.provider_material,old.booking_id)=v_contact;
   IF v_legacy_keys>1 THEN RETURN jsonb_build_object('ok',false,'code','legacy_customer_review_required'); END IF;
   SELECT * INTO v_legacy FROM public.booking_card_save_operations old WHERE old.id<>v_op.id AND old.salon_id=v_op.salon_id AND old.provider='square' AND old.mode='save_card'
     AND old.customer_delivery_version IS NULL AND old.dispatch_prepared_at IS NOT NULL
     AND old.status<>'succeeded' AND old.expected_customer_id IS NULL
     AND (old.expected_merchant_id IS NULL OR old.expected_merchant_id=v_op.expected_merchant_id)
     AND (old.expected_environment IS NULL OR old.expected_environment=v_op.expected_environment)
     AND public.square_card_contact_fingerprint(old.provider_material,old.booking_id)=v_contact ORDER BY created_at,delivery_sequence,id LIMIT 1;
   IF v_legacy.id IS NULL AND v_contact=public.square_card_contact_fingerprint('{}',v_op.booking_id) THEN
     -- Without phone/email, a completed history cannot be found by contact.
     -- Keep the same booking reference for a read before any new creation.
     SELECT * INTO v_legacy FROM public.booking_card_save_operations old WHERE old.id<>v_op.id
       AND old.booking_id=v_op.booking_id AND old.salon_id=v_op.salon_id AND old.provider='square' AND old.mode='save_card'
       AND old.customer_delivery_version IS NULL AND old.dispatch_prepared_at IS NOT NULL
       AND (old.expected_merchant_id IS NULL OR old.expected_merchant_id=v_op.expected_merchant_id)
       AND (old.expected_environment IS NULL OR old.expected_environment=v_op.expected_environment)
       ORDER BY created_at,delivery_sequence,id LIMIT 1;
   END IF;
   INSERT INTO public.square_card_customer_claims(id,salon_id,merchant_id,environment,contact_fingerprint,anchor_operation_id,
     request_material,reference_id,idempotency_key,status,dispatch_prepared_at)
   VALUES(v_id,v_op.salon_id,v_op.expected_merchant_id,v_op.expected_environment,v_contact,coalesce(v_legacy.id,v_op.id),
     coalesce(v_legacy.provider_material,v_op.provider_material),
     CASE WHEN v_legacy.id IS NULL THEN 'nq-customer:'||v_id::text ELSE 'booking:'||v_legacy.booking_id::text END,
     CASE WHEN v_legacy.id IS NULL THEN 'sqcu:'||v_id::text ELSE coalesce(v_legacy.provider_material->>'customer_idempotency_key',
       CASE WHEN v_legacy.delivery_version IS NULL THEN v_legacy.id::text||':customer' ELSE 'sqcust:'||v_legacy.booking_id::text END) END,
     CASE WHEN v_legacy.id IS NULL THEN 'ready' ELSE 'unknown' END,v_legacy.dispatch_prepared_at)
   RETURNING * INTO v_claim;
 END IF;
 UPDATE public.booking_card_save_operations SET customer_claim_id=v_claim.id WHERE id=v_op.id;
 IF v_claim.status='known' THEN RETURN jsonb_build_object('ok',true,'code','known','customer_id',v_claim.customer_id,
   'salon_id',v_claim.salon_id,'merchant_id',v_claim.merchant_id,'environment',v_claim.environment); END IF;
 IF v_claim.lease_expires_at>v_now OR v_claim.next_read_at>v_now THEN
   RETURN jsonb_build_object('ok',false,'code','customer_wait'); END IF;
 -- The row lock and expired-lease check above fence active workers. Preserve
 -- the exact key/reference; refresh the body only before the first possible
 -- CreateCustomer dispatch, including when the phone fingerprint is unchanged.
 -- A ready claim after uncertain-dispatch exhaustion still keeps its old body.
 IF v_claim.status='ready' AND v_claim.dispatch_prepared_at IS NULL THEN
   UPDATE public.square_card_customer_claims SET request_material=v_op.provider_material,updated_at=v_now
     WHERE id=v_claim.id RETURNING * INTO v_claim;
 END IF;
 UPDATE public.square_card_customer_claims SET lease_token=v_token,lease_expires_at=v_now+interval '90 seconds',
   lease_allows_create=(status='ready'),updated_at=v_now WHERE id=v_claim.id;
 RETURN jsonb_build_object('ok',true,'code','claimed','claim_id',v_claim.id,'lease_token',v_token,
   'allow_create',v_claim.status='ready','salon_id',v_claim.salon_id,'merchant_id',v_claim.merchant_id,'environment',v_claim.environment,
   'reference_id',v_claim.reference_id,'idempotency_key',v_claim.idempotency_key,'request_material',v_claim.request_material);
END; $$;

REVOKE ALL ON FUNCTION public.claim_booking_card_save_operation(uuid,uuid,text,text,text),
 public.claim_square_card_customer(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_booking_card_save_operation(uuid,uuid,text,text,text),
 public.claim_square_card_customer(uuid,uuid) TO service_role;
