-- Test fixture only. Loaded into pg_temp by disposable SQL/race rehearsals.
-- Model a successful card receipt recorded before a historical fee occurrence;
-- no provider dispatch and no changes to booking status or appointment time.
CREATE FUNCTION pg_temp.seed_historical_card_receipt(p_booking_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE b public.bookings%ROWTYPE; cap uuid:=extensions.gen_random_uuid();
 consent jsonb; consent_at timestamptz;
BEGIN
 SELECT * INTO STRICT b FROM public.bookings WHERE id=p_booking_id;
 IF b.client_name NOT IN ('Late cancel QA','Late cancel','No show')
   OR b.salon_id NOT IN ('15150000-0000-4000-8000-000000000001','15160000-0000-4000-8000-000000000001')
   OR b.noshow_card_id IS NULL OR b.noshow_customer_id IS NULL THEN
   RAISE EXCEPTION 'unexpected card rehearsal fixture';
 END IF;
 consent_at:=b.start_time_utc-interval '1 day';
 consent:=jsonb_build_object('policyVersion','nsp_'||repeat('a',64),'scope','booking_member',
   'policyEn','Synthetic policy','policyVi','Synthetic policy','feeCents',b.noshow_fee_cents);
 INSERT INTO public.booking_management_action_state(salon_id,booking_id,action,epoch)
 VALUES(b.salon_id,b.id,'card_manage',1) ON CONFLICT DO NOTHING;
 INSERT INTO public.booking_management_capabilities(id,salon_id,booking_id,action,scope_kind,
   epoch,booking_version,card_state_fingerprint,expires_at,revoked_at,revoke_reason)
 VALUES(cap,b.salon_id,b.id,'card_manage','booking_own',1,0,repeat('a',64),
   consent_at+interval '25 minutes',consent_at,'card_delivery_settled');
 UPDATE public.bookings SET noshow_card_brand='VISA',noshow_card_last4='4242',
   noshow_consent_at=consent_at,noshow_consent_meta=consent WHERE id=b.id;
 INSERT INTO public.booking_card_save_operations(capability_id,salon_id,booking_id,request_id,provider,mode,
   source_fingerprint,initial_card_fingerprint,provider_material,status,attempt_token,provider_reference,
   completion_fingerprint,result_json,created_at,completed_at,consent_at,consent_meta,dispatch_prepared_at,
   expected_customer_id,expected_merchant_id,expected_environment,card_dispatch_bound_at)
 VALUES(cap,b.salon_id,b.id,extensions.gen_random_uuid(),'stripe','save_card',repeat('a',64),repeat('b',64),
   '{}'::jsonb,'succeeded',extensions.gen_random_uuid(),b.noshow_card_id,repeat('c',64),
   jsonb_build_object('ok',true,'code','saved','customer_id',b.noshow_customer_id,'card_brand','VISA','card_last4','4242'),
   consent_at,consent_at,consent_at,consent,consent_at,b.noshow_customer_id,'acct_payment_rehearsal','sandbox',consent_at);
 IF (SELECT card_protection_status FROM public.bookings WHERE id=b.id) IS DISTINCT FROM 'saved' THEN
   RAISE EXCEPTION 'historical fixture lacks durable card protection';
 END IF;
END; $$;
