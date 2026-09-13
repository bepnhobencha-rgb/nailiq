-- Append-only diagnostic outcomes; not receipts or authority to mutate a card.
CREATE TABLE public.booking_card_removal_recovery_events (
 id uuid PRIMARY KEY,
 operation_id uuid NOT NULL REFERENCES public.booking_card_management_operations(id) ON DELETE CASCADE,
 salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
 booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
 provider text CHECK(provider='square'),
 stage text NOT NULL, code text NOT NULL, retryability text NOT NULL, read_status text NOT NULL,
 http_status integer CHECK(http_status BETWEEN 100 AND 599),
 square_codes text[] NOT NULL DEFAULT '{}', square_categories text[] NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((code,stage,retryability,read_status)=('recovery_context_unavailable','context','reconcile_first','not_requested') OR
   (code,stage,retryability,read_status)=('recovery_context_invalid','context','manual_review','not_requested') OR
   (code,stage,retryability,read_status)=('recovery_authority_expired_or_revoked','authority','manual_review','not_requested') OR
   (code,stage,retryability,read_status)=('recovery_state_changed','authority','manual_review','not_requested') OR
   (code,stage,retryability,read_status)=('recovery_identity_unavailable','authority','manual_review','not_requested') OR
   (code,stage,retryability,read_status)=('square_config_unavailable','configuration','reconcile_first','not_requested') OR
   (code,stage,retryability,read_status)=('removal_provider_mismatch','configuration','manual_review','not_requested') OR
   (code,stage,retryability,read_status)=('reconciliation_read_failed','provider_read','reconcile_first','failed') OR
   (code,stage,retryability,read_status)=('reconciliation_not_found','provider_read','manual_review','failed') OR
   (code,stage,retryability,read_status)=('reconciliation_invalid_card','provider_read','manual_review','invalid_receipt') OR
   (code,stage,retryability,read_status)=('reconciliation_card_active','provider_read','manual_review','completed') OR
   (code,stage,retryability,read_status)=('database_completion_uncertain','database_completion','reconcile_first','completed') OR
   (code,stage,retryability,read_status)=('recovery_completion_rejected','database_completion','manual_review','completed')),
 CHECK ((stage IN ('context','authority') AND provider IS NULL)
   OR (stage IN ('configuration','provider_read','database_completion') AND provider='square' AND provider IS NOT NULL)),
 CHECK (stage='provider_read' OR (http_status IS NULL AND cardinality(square_codes)=0 AND cardinality(square_categories)=0)),
 CHECK (cardinality(square_codes)<=8 AND array_position(square_codes,NULL) IS NULL AND square_codes <@ ARRAY['UNAUTHORIZED','ACCESS_TOKEN_EXPIRED','ACCESS_TOKEN_REVOKED','FORBIDDEN','INSUFFICIENT_SCOPES','RATE_LIMITED','INTERNAL_SERVER_ERROR','SERVICE_UNAVAILABLE','BAD_REQUEST','INVALID_REQUEST_ERROR','INVALID_VALUE','MISSING_REQUIRED_PARAMETER','INVALID_PHONE_NUMBER','INVALID_EMAIL_ADDRESS','NOT_FOUND','CONFLICT','IDEMPOTENCY_KEY_REUSED','CARD_DECLINED','GENERIC_DECLINE','CARD_NOT_SUPPORTED','CARD_EXPIRED','INVALID_CARD_DATA','VERIFY_CVV_FAILURE','VERIFY_AVS_FAILURE','CARD_DECLINED_VERIFICATION_REQUIRED','SOURCE_EXPIRED','SOURCE_USED','CUSTOMER_NOT_FOUND','CARD_TOKEN_EXPIRED','CARD_TOKEN_USED']::text[]),
 CHECK (cardinality(square_categories)<=8 AND array_position(square_categories,NULL) IS NULL AND square_categories <@ ARRAY['API_ERROR','AUTHENTICATION_ERROR','INVALID_REQUEST_ERROR','RATE_LIMIT_ERROR','PAYMENT_METHOD_ERROR','REFUND_ERROR']::text[])
);
CREATE INDEX ON public.booking_card_removal_recovery_events(operation_id,created_at DESC);
CREATE INDEX ON public.booking_card_removal_recovery_events(salon_id,created_at DESC);
CREATE INDEX ON public.booking_card_removal_recovery_events(booking_id);
ALTER TABLE public.booking_card_removal_recovery_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_card_removal_recovery_events FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.booking_card_removal_recovery_events TO service_role;
CREATE POLICY "deny direct api removal recovery events" ON public.booking_card_removal_recovery_events
 AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);

CREATE FUNCTION public.record_booking_card_removal_recovery_outcome(
 p_token_id uuid,p_request_id uuid,p_card_fingerprint text,p_event_id uuid,
 p_provider text,p_stage text,p_code text,p_retryability text,p_read_status text,
 p_http_status integer,p_square_codes text[],p_square_categories text[])
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE o public.booking_card_management_operations%ROWTYPE;
 c public.booking_management_capabilities%ROWTYPE;
 e public.booking_card_removal_recovery_events%ROWTYPE; inserted_id uuid;
BEGIN
 IF p_event_id IS NULL THEN RETURN jsonb_build_object('ok',false,'code','invalid_request'); END IF;
 SELECT * INTO c FROM public.booking_management_capabilities WHERE id=p_token_id;
 IF NOT FOUND OR c.action<>'card_manage' THEN
   RETURN jsonb_build_object('ok',false,'code','invalid_request'); END IF;
 SELECT * INTO o FROM public.booking_card_management_operations WHERE capability_id=c.id;
 IF NOT FOUND OR o.operation<>'remove_card' OR o.status<>'unknown'
   OR o.request_id IS DISTINCT FROM p_request_id OR c.request_id IS DISTINCT FROM p_request_id
   OR o.card_fingerprint IS DISTINCT FROM p_card_fingerprint
   OR c.card_state_fingerprint IS DISTINCT FROM p_card_fingerprint
   OR o.salon_id<>c.salon_id OR o.booking_id<>c.booking_id OR c.consumed_at IS NULL THEN
   RETURN jsonb_build_object('ok',false,'code','invalid_request'); END IF;
 -- Expired/revoked capabilities may identify historical diagnostics only.
 -- No capability renewal, operation status change, booking write or provider call.
 BEGIN
   INSERT INTO public.booking_card_removal_recovery_events(id,operation_id,salon_id,booking_id,provider,
     stage,code,retryability,read_status,http_status,square_codes,square_categories)
   VALUES(p_event_id,o.id,o.salon_id,o.booking_id,p_provider,p_stage,p_code,p_retryability,p_read_status,
     p_http_status,p_square_codes,p_square_categories)
   ON CONFLICT (id) DO NOTHING RETURNING id INTO inserted_id;
 EXCEPTION WHEN check_violation OR not_null_violation THEN
   RETURN jsonb_build_object('ok',false,'code','invalid_diagnostic');
 END;
 IF inserted_id IS NOT NULL THEN RETURN jsonb_build_object('ok',true,'code','outcome_recorded','idempotent',false); END IF;
 SELECT * INTO e FROM public.booking_card_removal_recovery_events WHERE id=p_event_id;
 IF e.operation_id IS DISTINCT FROM o.id OR e.salon_id IS DISTINCT FROM o.salon_id
   OR e.booking_id IS DISTINCT FROM o.booking_id OR e.provider IS DISTINCT FROM p_provider
   OR e.stage IS DISTINCT FROM p_stage OR e.code IS DISTINCT FROM p_code
   OR e.retryability IS DISTINCT FROM p_retryability OR e.read_status IS DISTINCT FROM p_read_status
   OR e.http_status IS DISTINCT FROM p_http_status OR e.square_codes IS DISTINCT FROM p_square_codes
   OR e.square_categories IS DISTINCT FROM p_square_categories THEN
   RETURN jsonb_build_object('ok',false,'code','outcome_conflict'); END IF;
 RETURN jsonb_build_object('ok',true,'code','outcome_recorded','idempotent',true);
END; $$;
REVOKE ALL ON FUNCTION public.record_booking_card_removal_recovery_outcome(uuid,uuid,text,uuid,text,text,text,text,text,integer,text[],text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_booking_card_removal_recovery_outcome(uuid,uuid,text,uuid,text,text,text,text,text,integer,text[],text[]) TO service_role;
