-- Append-only diagnostic outcomes; not receipts or authority to mutate a card.
CREATE TABLE public.booking_card_removal_delivery_events (
 id uuid PRIMARY KEY,
 operation_id uuid NOT NULL REFERENCES public.booking_card_management_operations(id) ON DELETE CASCADE,
 salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
 booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
 provider text CHECK(provider IN ('square','stripe')),
 stage text NOT NULL, code text NOT NULL, retryability text NOT NULL, mutation_status text NOT NULL, reconciliation_outcome text NOT NULL,
 http_status integer CHECK(http_status BETWEEN 100 AND 599),
 square_codes text[] NOT NULL DEFAULT '{}', square_categories text[] NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((code,stage,mutation_status)=('removal_configuration_unavailable','configuration','not_requested') OR
   (code,stage,mutation_status)=('removal_configuration_invalid','configuration','not_requested') OR
   (code,stage,mutation_status)=('removal_dispatch_unavailable','dispatch_preparation','not_requested') OR
   (code,stage,mutation_status)=('removal_preflight_failed','provider_preflight','not_requested') OR
   (code,stage,mutation_status)=('removal_preflight_invalid','provider_preflight','not_requested') OR
   (code,stage,mutation_status)=('removal_provider_write_failed','provider_mutation','possibly_dispatched') OR
   (code,stage,mutation_status)=('removal_invalid_provider_receipt','receipt_validation','possibly_dispatched') OR
   (code,stage,mutation_status)=('removal_provider_unclassified','provider_unknown','possibly_dispatched') OR
   (code,stage,mutation_status)=('removal_completion_uncertain','database_completion','not_proven') OR
   (code,stage,mutation_status)=('removal_completion_rejected','database_completion','not_proven')),
 CHECK (retryability='reconcile_first'),
 CHECK (reconciliation_outcome IN ('not_requested','read_failed','not_removed','invalid_receipt')),
 CHECK (stage IN ('provider_mutation','receipt_validation','provider_unknown') OR reconciliation_outcome='not_requested'),
 CHECK (stage NOT IN ('dispatch_preparation','provider_preflight','provider_mutation','receipt_validation','provider_unknown') OR provider IS NOT NULL),
 CHECK ((provider='square' AND provider IS NOT NULL AND stage IN ('provider_preflight','provider_mutation','receipt_validation')) OR (http_status IS NULL AND cardinality(square_codes)=0 AND cardinality(square_categories)=0)),
 CHECK (cardinality(square_codes)<=8 AND array_position(square_codes,NULL) IS NULL AND square_codes <@ ARRAY['UNAUTHORIZED','ACCESS_TOKEN_EXPIRED','ACCESS_TOKEN_REVOKED','FORBIDDEN','INSUFFICIENT_SCOPES','RATE_LIMITED','INTERNAL_SERVER_ERROR','SERVICE_UNAVAILABLE','BAD_REQUEST','INVALID_REQUEST_ERROR','INVALID_VALUE','MISSING_REQUIRED_PARAMETER','INVALID_PHONE_NUMBER','INVALID_EMAIL_ADDRESS','NOT_FOUND','CONFLICT','IDEMPOTENCY_KEY_REUSED','CARD_DECLINED','GENERIC_DECLINE','CARD_NOT_SUPPORTED','CARD_EXPIRED','INVALID_CARD_DATA','VERIFY_CVV_FAILURE','VERIFY_AVS_FAILURE','CARD_DECLINED_VERIFICATION_REQUIRED','SOURCE_EXPIRED','SOURCE_USED','CUSTOMER_NOT_FOUND','CARD_TOKEN_EXPIRED','CARD_TOKEN_USED']::text[]),
 CHECK (cardinality(square_categories)<=8 AND array_position(square_categories,NULL) IS NULL AND square_categories <@ ARRAY['API_ERROR','AUTHENTICATION_ERROR','INVALID_REQUEST_ERROR','RATE_LIMIT_ERROR','PAYMENT_METHOD_ERROR','REFUND_ERROR']::text[])
);
CREATE INDEX ON public.booking_card_removal_delivery_events(operation_id,created_at DESC);
CREATE INDEX ON public.booking_card_removal_delivery_events(salon_id,created_at DESC);
CREATE INDEX ON public.booking_card_removal_delivery_events(booking_id);
ALTER TABLE public.booking_card_removal_delivery_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_card_removal_delivery_events FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.booking_card_removal_delivery_events TO service_role;
CREATE POLICY "deny direct api removal delivery events" ON public.booking_card_removal_delivery_events
 AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);

CREATE FUNCTION public.record_booking_card_removal_delivery_failure(
 p_operation_id uuid,p_attempt_token uuid,p_event_id uuid,
 p_provider text,p_stage text,p_code text,p_retryability text,p_mutation_status text,p_reconciliation_outcome text,
 p_http_status integer,p_square_codes text[],p_square_categories text[])
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE o public.booking_card_management_operations%ROWTYPE;
 e public.booking_card_removal_delivery_events%ROWTYPE; inserted_id uuid;
BEGIN
 IF p_event_id IS NULL OR p_attempt_token IS NULL THEN RETURN jsonb_build_object('ok',false,'code','invalid_request'); END IF;
 SELECT * INTO o FROM public.booking_card_management_operations WHERE id=p_operation_id;
 IF NOT FOUND OR o.operation<>'remove_card' OR o.attempt_token IS DISTINCT FROM p_attempt_token THEN
   RETURN jsonb_build_object('ok',false,'code','claim_mismatch'); END IF;
 -- Diagnostics may arrive after completion response loss. They cannot change
 -- the original operation, claim, authority, booking or provider state.
 BEGIN
   INSERT INTO public.booking_card_removal_delivery_events(id,operation_id,salon_id,booking_id,provider,
     stage,code,retryability,mutation_status,reconciliation_outcome,http_status,square_codes,square_categories)
   VALUES(p_event_id,o.id,o.salon_id,o.booking_id,p_provider,p_stage,p_code,p_retryability,p_mutation_status,
     p_reconciliation_outcome,p_http_status,p_square_codes,p_square_categories)
   ON CONFLICT (id) DO NOTHING RETURNING id INTO inserted_id;
 EXCEPTION WHEN check_violation OR not_null_violation THEN
   RETURN jsonb_build_object('ok',false,'code','invalid_diagnostic');
 END;
 IF inserted_id IS NOT NULL THEN RETURN jsonb_build_object('ok',true,'code','failure_recorded','idempotent',false); END IF;
 SELECT * INTO e FROM public.booking_card_removal_delivery_events WHERE id=p_event_id;
 IF e.operation_id IS DISTINCT FROM o.id OR e.salon_id IS DISTINCT FROM o.salon_id
   OR e.booking_id IS DISTINCT FROM o.booking_id OR e.provider IS DISTINCT FROM p_provider
   OR e.stage IS DISTINCT FROM p_stage OR e.code IS DISTINCT FROM p_code
   OR e.retryability IS DISTINCT FROM p_retryability OR e.mutation_status IS DISTINCT FROM p_mutation_status
   OR e.reconciliation_outcome IS DISTINCT FROM p_reconciliation_outcome
   OR e.http_status IS DISTINCT FROM p_http_status OR e.square_codes IS DISTINCT FROM p_square_codes
   OR e.square_categories IS DISTINCT FROM p_square_categories THEN
   RETURN jsonb_build_object('ok',false,'code','failure_conflict'); END IF;
 RETURN jsonb_build_object('ok',true,'code','failure_recorded','idempotent',true);
END; $$;
REVOKE ALL ON FUNCTION public.record_booking_card_removal_delivery_failure(uuid,uuid,uuid,text,text,text,text,text,text,integer,text[],text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_booking_card_removal_delivery_failure(uuid,uuid,uuid,text,text,text,text,text,text,integer,text[],text[]) TO service_role;
