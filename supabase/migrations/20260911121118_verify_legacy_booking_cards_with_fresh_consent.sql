-- Approved legacy policy: preserve bookings/cards, require fresh consent and
-- an exact read-only Square receipt. No provider dispatch, outreach or fee here.
ALTER TABLE public.bookings
 ADD COLUMN card_protection_reviewed_at timestamptz,
 ADD COLUMN card_protection_reviewed_by uuid;

CREATE FUNCTION public.is_legacy_booking_card_candidate(p_booking public.bookings) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
 SELECT p_booking.deleted_at IS NULL
 AND p_booking.status IN ('pending','confirmed','waiting','in_progress')
 AND p_booking.start_time_utc>transaction_timestamp()
 AND coalesce(p_booking.noshow_card_id,'') ~ '^[A-Za-z0-9:_-]{1,255}$'
 AND coalesce(p_booking.noshow_customer_id,'') ~ '^[A-Za-z0-9:_-]{1,255}$'
 AND public.booking_card_protection_state(p_booking)<>'saved'
 AND EXISTS(SELECT 1 FROM public.square_integrations WHERE salon_id=p_booking.salon_id AND enabled=true)
 AND NOT EXISTS(SELECT 1 FROM public.booking_card_save_operations
   WHERE booking_id=p_booking.id AND salon_id=p_booking.salon_id AND status IN ('sending','unknown'))
 AND NOT EXISTS(SELECT 1 FROM public.booking_card_management_operations
   WHERE booking_id=p_booking.id AND salon_id=p_booking.salon_id AND status IN ('sending','unknown'))
 AND coalesce((SELECT provider FROM public.booking_card_save_operations
   WHERE booking_id=p_booking.id AND salon_id=p_booking.salon_id AND mode='save_card'
   ORDER BY created_at DESC,delivery_sequence DESC,id DESC LIMIT 1),'square')='square';
$$;

-- This snapshot stays server-side. No secret or client contact fields.
CREATE FUNCTION public.booking_legacy_card_snapshot(p_booking public.bookings) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
 SELECT jsonb_build_object('booking_id',p_booking.id,'salon_id',p_booking.salon_id,
   'card_id',p_booking.noshow_card_id,'customer_id',p_booking.noshow_customer_id,
   'start_time',p_booking.start_time_utc,'status',p_booking.status,'group_id',p_booking.group_id,
   'fee_cents',p_booking.noshow_fee_cents,'salon_name',s.name,'currency',upper(s.currency_code),
   'stored_policy',s.cancellation_policy,'scope',CASE WHEN p_booking.group_id IS NOT NULL
     AND s.noshow_group_whole_party IS DISTINCT FROM false THEN 'whole_party' ELSE 'booking_member' END,
   'merchant_id',i.merchant_id,'environment',i.environment,'integration_enabled',i.enabled)
 FROM public.salons s JOIN public.square_integrations i ON i.salon_id=s.id WHERE s.id=p_booking.salon_id;
$$;

CREATE OR REPLACE FUNCTION public.inspect_booking_card_recovery(p_token_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_cap public.booking_management_capabilities%ROWTYPE; v_booking public.bookings%ROWTYPE;
 v_status text; v_operation uuid;
BEGIN
 SELECT * INTO v_cap FROM public.booking_management_capabilities WHERE id=p_token_id AND action='card_manage';
 IF NOT FOUND OR v_cap.expires_at<=transaction_timestamp() OR
   (v_cap.revoked_at IS NOT NULL AND coalesce(v_cap.revoke_reason,'')<>'card_delivery_settled') THEN
   RETURN jsonb_build_object('ok',false,'code','expired_or_revoked'); END IF;
 SELECT * INTO v_booking FROM public.bookings WHERE id=v_cap.booking_id AND salon_id=v_cap.salon_id AND deleted_at IS NULL;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','invalid_token'); END IF;
 v_status:=public.booking_card_protection_state(v_booking);
 SELECT id INTO v_operation FROM public.booking_card_save_operations WHERE booking_id=v_booking.id
   AND salon_id=v_booking.salon_id AND status IN ('sending','unknown') ORDER BY created_at DESC,delivery_sequence DESC,id DESC LIMIT 1;
 RETURN jsonb_build_object('ok',true,'booking_id',v_booking.id,'salon_id',v_booking.salon_id,
   'protection_status',v_status,'expires_at',v_cap.expires_at,'operation_id',v_operation,
   'can_verify_existing_card',public.is_legacy_booking_card_candidate(v_booking),
   'can_refresh_consent',v_booking.status<>'cancelled' AND v_booking.start_time_utc>transaction_timestamp() AND EXISTS(SELECT 1 FROM public.booking_card_save_operations op WHERE op.id=v_operation
     AND op.reconciliation_receipt IS NOT NULL AND op.reconciliation_receipt_at>transaction_timestamp()-interval '5 minutes'
     AND (op.reconciliation_lease_expires_at IS NULL OR op.reconciliation_lease_expires_at<=transaction_timestamp()) AND op.recovery_consent_at IS NULL
     AND coalesce(op.consent_meta->>'policyVersion','') !~ '^nsp_[0-9a-f]{64}$'),
   'can_retry',v_operation IS NULL AND v_status IN ('awaiting_card','retry_required')
     AND v_booking.noshow_card_id IS NULL
     AND v_booking.status<>'cancelled' AND v_booking.start_time_utc>transaction_timestamp(),
   'cancelled',v_booking.status='cancelled');
END; $$;

CREATE FUNCTION public.inspect_booking_legacy_card(p_token_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_ctx jsonb; v_booking public.bookings%ROWTYPE;
BEGIN
 v_ctx:=public.inspect_booking_card_recovery(p_token_id);
 IF v_ctx->>'ok' IS DISTINCT FROM 'true' OR v_ctx->>'can_verify_existing_card' IS DISTINCT FROM 'true' THEN
   RETURN jsonb_build_object('ok',false,'code','verification_unavailable'); END IF;
 SELECT * INTO v_booking FROM public.bookings WHERE id=(v_ctx->>'booking_id')::uuid AND salon_id=(v_ctx->>'salon_id')::uuid;
 RETURN jsonb_build_object('ok',true,'snapshot',public.booking_legacy_card_snapshot(v_booking));
END; $$;

CREATE FUNCTION public.confirm_booking_legacy_card_verification(p_token_id uuid,p_expected_snapshot jsonb,
 p_receipt jsonb,p_read_at timestamptz,p_consent_meta jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_booking public.bookings%ROWTYPE; v_cap public.booking_management_capabilities%ROWTYPE;
 v_ctx jsonb; v_snapshot jsonb; v_result jsonb; v_meta jsonb; v_op uuid:=extensions.gen_random_uuid();
 v_receipt_cap uuid:=extensions.gen_random_uuid(); v_now timestamptz:=transaction_timestamp();
BEGIN
 v_ctx:=public.inspect_booking_card_recovery(p_token_id);
 IF v_ctx->>'ok' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('ok',false,'code','expired_or_revoked'); END IF;
 SELECT * INTO v_booking FROM public.bookings WHERE id=(v_ctx->>'booking_id')::uuid AND salon_id=(v_ctx->>'salon_id')::uuid;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(CASE WHEN v_booking.group_id IS NULL
   THEN 'booking-management:'||v_booking.id::text ELSE 'booking-management-group:'||v_booking.group_id::text END,0));
 SELECT * INTO v_booking FROM public.bookings WHERE id=(v_ctx->>'booking_id')::uuid AND salon_id=(v_ctx->>'salon_id')::uuid FOR UPDATE;
 SELECT * INTO v_cap FROM public.booking_management_capabilities WHERE id=p_token_id FOR UPDATE;
 v_now:=clock_timestamp();
 v_ctx:=public.inspect_booking_card_recovery(p_token_id);
 IF v_cap.expires_at<=v_now OR v_ctx->>'ok' IS DISTINCT FROM 'true' OR v_booking.deleted_at IS NOT NULL
   OR v_booking.status NOT IN ('pending','confirmed','waiting','in_progress') OR v_booking.start_time_utc<=v_now THEN
   RETURN jsonb_build_object('ok',false,'code','verification_unavailable'); END IF;
 -- No database lock was held during the provider GET. Freeze current policy
 -- and account only for this short compare-and-complete transaction.
 PERFORM 1 FROM public.salons WHERE id=v_booking.salon_id FOR SHARE;
 PERFORM 1 FROM public.square_integrations WHERE salon_id=v_booking.salon_id FOR SHARE;
 v_now:=clock_timestamp();
 IF v_cap.expires_at<=v_now OR v_booking.start_time_utc<=v_now THEN
   RETURN jsonb_build_object('ok',false,'code','verification_unavailable'); END IF;
 v_snapshot:=public.booking_legacy_card_snapshot(v_booking);
 IF v_snapshot IS NULL OR p_expected_snapshot IS DISTINCT FROM v_snapshot THEN
   RETURN jsonb_build_object('ok',false,'code','verification_changed'); END IF;
 IF p_read_at IS NULL OR p_read_at<v_now-interval '2 minutes' OR p_read_at>v_now+interval '5 seconds'
   OR p_receipt->>'enabled' IS DISTINCT FROM 'true'
   OR p_receipt->>'card_id' IS DISTINCT FROM v_booking.noshow_card_id
   OR p_receipt->>'customer_id' IS DISTINCT FROM v_booking.noshow_customer_id
   OR p_receipt->>'merchant_id' IS DISTINCT FROM v_snapshot->>'merchant_id'
   OR p_receipt->>'environment' IS DISTINCT FROM v_snapshot->>'environment'
   OR coalesce(p_receipt->>'card_brand','') NOT IN ('VISA','MASTERCARD','AMERICAN_EXPRESS','DISCOVER','DISCOVER_DINERS','DINERS_CLUB','JCB','UNIONPAY','CHINA_UNIONPAY','EFTPOS','INTERAC','OTHER_BRAND')
   OR coalesce(p_receipt->>'card_last4','') !~ '^[0-9]{4}$' THEN
   RETURN jsonb_build_object('ok',false,'code','invalid_read_receipt'); END IF;
 IF coalesce(p_consent_meta->>'policyVersion','') !~ '^nsp_[0-9a-f]{64}$'
   OR p_consent_meta->>'source' IS DISTINCT FROM 'legacy_card_fresh_consent'
   OR p_consent_meta->>'receiptSource' IS DISTINCT FROM 'existing_card_read'
   OR p_consent_meta->>'feeCents' IS DISTINCT FROM v_snapshot->>'fee_cents'
   OR coalesce(v_booking.noshow_fee_cents,0)<=0
   OR p_consent_meta->>'currency' IS DISTINCT FROM v_snapshot->>'currency'
   OR p_consent_meta->>'scope' IS DISTINCT FROM v_snapshot->>'scope'
   OR length(btrim(coalesce(p_consent_meta->>'policyEn','')))=0 OR length(coalesce(p_consent_meta->>'policyEn',''))>10000
   OR length(btrim(coalesce(p_consent_meta->>'policyVi','')))=0 OR length(coalesce(p_consent_meta->>'policyVi',''))>10000 THEN
   RETURN jsonb_build_object('ok',false,'code','fresh_consent_required'); END IF;
 -- Drop unknown keys instead of persisting caller-supplied arbitrary material.
 v_meta:=jsonb_build_object('v',2,'source','legacy_card_fresh_consent','receiptSource','existing_card_read',
   'policyVersion',p_consent_meta->>'policyVersion','feeCents',v_booking.noshow_fee_cents,
   'currency',v_snapshot->>'currency','scope',v_snapshot->>'scope',
   'policyEn',p_consent_meta->>'policyEn','policyVi',p_consent_meta->>'policyVi');
 IF public.booking_card_protection_state(v_booking)='saved' AND v_booking.noshow_consent_meta=v_meta THEN
   RETURN jsonb_build_object('ok',true,'code','saved','idempotent',true); END IF;
 IF NOT public.is_legacy_booking_card_candidate(v_booking) THEN
   RETURN jsonb_build_object('ok',false,'code','reconciliation_required'); END IF;
 -- An already revoked internal capability provides the existing operation FK.
 -- It can never dispatch, be returned to a browser, or replace the owner's link.
 INSERT INTO public.booking_management_capabilities(id,salon_id,booking_id,action,scope_kind,epoch,
   booking_version,card_state_fingerprint,expires_at,revoked_at,revoke_reason)
 VALUES(v_receipt_cap,v_cap.salon_id,v_cap.booking_id,'card_manage',v_cap.scope_kind,v_cap.epoch,
   v_cap.booking_version,v_cap.card_state_fingerprint,v_now+interval '1 second',v_now,'manual_revoke');
 v_result:=jsonb_build_object('ok',true,'code','saved','outcome','succeeded',
   'card_id',v_booking.noshow_card_id,'customer_id',v_booking.noshow_customer_id,
   'card_brand',p_receipt->>'card_brand','card_last4',p_receipt->>'card_last4',
   'receipt_source','existing_card_read','provider_read_at',p_read_at);
 INSERT INTO public.booking_card_save_operations(id,capability_id,salon_id,booking_id,request_id,provider,mode,
   source_fingerprint,initial_card_fingerprint,provider_material,status,attempt_token,provider_reference,
   completion_fingerprint,result_json,completed_at,recovery_consent_at,recovery_consent_meta,expected_customer_id,expected_merchant_id,expected_environment)
 VALUES(v_op,v_receipt_cap,v_booking.salon_id,v_booking.id,extensions.gen_random_uuid(),'square','save_card',
   encode(extensions.digest(convert_to(v_snapshot::text,'UTF8'),'sha256'),'hex'),v_cap.card_state_fingerprint,
   jsonb_build_object('receipt_source','existing_card_read','prior_consent_at',v_booking.noshow_consent_at,
     'prior_consent_fingerprint',encode(extensions.digest(convert_to(coalesce(v_booking.noshow_consent_meta,'{}')::text,'UTF8'),'sha256'),'hex')),
   'succeeded',extensions.gen_random_uuid(),v_booking.noshow_card_id,
   encode(extensions.digest(convert_to(v_result::text,'UTF8'),'sha256'),'hex'),v_result,v_now,v_now,v_meta,
   v_booking.noshow_customer_id,v_snapshot->>'merchant_id',v_snapshot->>'environment');
 UPDATE public.bookings SET noshow_card_brand=p_receipt->>'card_brand',noshow_card_last4=p_receipt->>'card_last4',
   noshow_consent_at=v_now,noshow_consent_meta=v_meta WHERE id=v_booking.id AND salon_id=v_booking.salon_id;
 INSERT INTO public.booking_card_delivery_events(operation_id,booking_id,salon_id,provider,stage,code,retryability,reconciliation_outcome)
 VALUES(v_op,v_booking.id,v_booking.salon_id,'square','reconciliation','legacy_card_verified','none','found');
 RETURN jsonb_build_object('ok',true,'code','saved');
END; $$;

CREATE FUNCTION public.mark_booking_card_protection_reviewed(p_booking_id uuid,p_salon_id uuid,p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.salon_members WHERE salon_id=p_salon_id AND user_id=p_actor_id AND role IN ('owner','admin')) THEN
   RETURN jsonb_build_object('ok',false,'code','forbidden'); END IF;
 UPDATE public.bookings SET card_protection_reviewed_at=transaction_timestamp(),card_protection_reviewed_by=p_actor_id
 WHERE id=p_booking_id AND salon_id=p_salon_id AND deleted_at IS NULL;
 RETURN jsonb_build_object('ok',FOUND);
END; $$;

REVOKE ALL ON FUNCTION public.is_legacy_booking_card_candidate(public.bookings),public.booking_legacy_card_snapshot(public.bookings),
 public.inspect_booking_legacy_card(uuid),public.confirm_booking_legacy_card_verification(uuid,jsonb,jsonb,timestamptz,jsonb),
 public.mark_booking_card_protection_reviewed(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.inspect_booking_legacy_card(uuid),
 public.confirm_booking_legacy_card_verification(uuid,jsonb,jsonb,timestamptz,jsonb),
 public.mark_booking_card_protection_reviewed(uuid,uuid,uuid) TO service_role;

-- A legacy check is a provider READ, not a sending/failed save operation.
-- Keep its diagnostic history separately so a timeout cannot unlock CreateCard.
CREATE TABLE public.booking_legacy_card_checks (
 id uuid PRIMARY KEY,
 booking_id uuid NOT NULL REFERENCES public.bookings(id),
 salon_id uuid NOT NULL REFERENCES public.salons(id),
 provider text NOT NULL DEFAULT 'square' CHECK(provider='square'),
 stage text NOT NULL CHECK(stage IN ('configuration','reconciliation','database_completion')),
 code text NOT NULL CHECK(code IN ('square_config_unavailable','reconciliation_read_failed','reconciliation_invalid_card',
   'database_completion_uncertain','verification_changed','legacy_card_verified')),
 provider_http_status integer CHECK(provider_http_status BETWEEN 100 AND 599),
 square_codes text[] NOT NULL DEFAULT '{}',square_categories text[] NOT NULL DEFAULT '{}',
 retryability text NOT NULL CHECK(retryability IN ('safe_retry','manual_review')),
 outcome text NOT NULL CHECK(outcome IN ('config_unavailable','read_failed','invalid_card','completion_uncertain','changed','found')),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE INDEX booking_legacy_card_checks_booking ON public.booking_legacy_card_checks(salon_id,booking_id,created_at DESC);
ALTER TABLE public.booking_legacy_card_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_legacy_card_checks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_legacy_card_checks FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.booking_legacy_card_checks TO service_role;
CREATE TRIGGER legacy_card_checks_append_only BEFORE UPDATE OR DELETE ON public.booking_legacy_card_checks
 FOR EACH ROW EXECUTE FUNCTION public.prevent_card_delivery_event_edit();

CREATE FUNCTION public.record_booking_legacy_card_check(p_token_id uuid,p_check_id uuid,p_stage text,p_code text,
 p_http_status integer,p_square_codes text[],p_square_categories text[],p_outcome text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_ctx jsonb;
BEGIN
 v_ctx:=public.inspect_booking_card_recovery(p_token_id);
 IF v_ctx->>'ok' IS DISTINCT FROM 'true' OR p_check_id IS NULL
 OR p_stage IS NULL OR p_stage NOT IN ('configuration','reconciliation','database_completion')
 OR p_code IS NULL OR p_code NOT IN ('square_config_unavailable','reconciliation_read_failed','reconciliation_invalid_card',
   'database_completion_uncertain','verification_changed','legacy_card_verified')
 OR p_outcome IS NULL OR p_outcome NOT IN ('config_unavailable','read_failed','invalid_card','completion_uncertain','changed','found')
 OR (p_http_status IS NOT NULL AND p_http_status NOT BETWEEN 100 AND 599)
 OR NOT coalesce(p_square_codes,'{}') <@ ARRAY['UNAUTHORIZED','ACCESS_TOKEN_EXPIRED','ACCESS_TOKEN_REVOKED','FORBIDDEN',
   'INSUFFICIENT_SCOPES','RATE_LIMITED','INTERNAL_SERVER_ERROR','SERVICE_UNAVAILABLE','BAD_REQUEST','INVALID_REQUEST_ERROR',
   'INVALID_VALUE','MISSING_REQUIRED_PARAMETER','NOT_FOUND','CONFLICT']::text[]
 OR NOT coalesce(p_square_categories,'{}') <@ ARRAY['API_ERROR','AUTHENTICATION_ERROR','INVALID_REQUEST_ERROR','RATE_LIMIT_ERROR']::text[]
 THEN RETURN jsonb_build_object('ok',false,'code','invalid_diagnostic'); END IF;
 INSERT INTO public.booking_legacy_card_checks(id,booking_id,salon_id,stage,code,provider_http_status,
   square_codes,square_categories,retryability,outcome)
 VALUES(p_check_id,(v_ctx->>'booking_id')::uuid,(v_ctx->>'salon_id')::uuid,p_stage,p_code,p_http_status,
   coalesce(p_square_codes,'{}'),coalesce(p_square_categories,'{}'),
   CASE WHEN p_outcome='invalid_card' THEN 'manual_review' ELSE 'safe_retry' END,p_outcome)
 ON CONFLICT(id) DO NOTHING;
 RETURN jsonb_build_object('ok',true);
END; $$;
REVOKE ALL ON FUNCTION public.record_booking_legacy_card_check(uuid,uuid,text,text,integer,text[],text[],text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_booking_legacy_card_check(uuid,uuid,text,text,integer,text[],text[],text) TO service_role;
