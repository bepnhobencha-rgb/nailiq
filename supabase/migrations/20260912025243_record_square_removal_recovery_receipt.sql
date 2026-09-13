-- Additive evidence for a read-confirmed removal. The original unknown
-- operation and its consumed capability/action receipt remain immutable.
CREATE TABLE public.booking_card_removal_recovery_receipts (
  operation_id uuid PRIMARY KEY REFERENCES public.booking_card_management_operations(id) ON DELETE CASCADE,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  source_save_operation_id uuid NOT NULL REFERENCES public.booking_card_save_operations(id),
  provider text NOT NULL CHECK (provider='square'),
  card_id text NOT NULL, customer_id text NOT NULL, merchant_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  confirmed_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE INDEX ON public.booking_card_removal_recovery_receipts(salon_id,confirmed_at);
CREATE INDEX ON public.booking_card_removal_recovery_receipts(booking_id);
CREATE INDEX ON public.booking_card_removal_recovery_receipts(source_save_operation_id);
ALTER TABLE public.booking_card_removal_recovery_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_card_removal_recovery_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.booking_card_removal_recovery_receipts TO service_role;
CREATE POLICY "deny direct api removal recovery" ON public.booking_card_removal_recovery_receipts
 AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);

CREATE FUNCTION public.get_booking_card_removal_recovery_context(
 p_token_id uuid,p_request_id uuid,p_card_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE c public.booking_management_capabilities%ROWTYPE;
 o public.booking_card_management_operations%ROWTYPE; b public.bookings%ROWTYPE;
 s public.booking_card_save_operations%ROWTYPE; n integer; fp text;
BEGIN
 SELECT * INTO c FROM public.booking_management_capabilities WHERE id=p_token_id;
 IF NOT FOUND OR c.action<>'card_manage' OR c.revoked_at IS NOT NULL
   OR c.expires_at<=transaction_timestamp() THEN
   RETURN jsonb_build_object('ok',false,'code','expired_or_revoked'); END IF;
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

CREATE FUNCTION public.complete_booking_card_removal_recovery(
 p_token_id uuid,p_request_id uuid,p_card_fingerprint text,p_receipt jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE ctx jsonb; bid uuid; gid uuid; opid uuid;
BEGIN
 SELECT booking_id INTO bid FROM public.booking_management_capabilities WHERE id=p_token_id;
 IF bid IS NULL THEN RETURN jsonb_build_object('ok',false,'code','invalid_token'); END IF;
 SELECT group_id INTO gid FROM public.bookings WHERE id=bid;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(CASE WHEN gid IS NULL
   THEN 'booking-management:'||bid::text ELSE 'booking-management-group:'||gid::text END,0));
 PERFORM 1 FROM public.booking_management_capabilities WHERE id=p_token_id FOR UPDATE;
 PERFORM 1 FROM public.booking_card_management_operations WHERE capability_id=p_token_id FOR UPDATE;
 PERFORM 1 FROM public.bookings WHERE id=bid FOR UPDATE;
 ctx:=public.get_booking_card_removal_recovery_context(p_token_id,p_request_id,p_card_fingerprint);
 IF ctx->>'code'='removed' OR ctx->>'ok' IS DISTINCT FROM 'true' THEN RETURN ctx; END IF;
 IF (jsonb_typeof(p_receipt)='object' AND p_receipt->'enabled'='false'::jsonb
   AND p_receipt->>'operation_id'=ctx->>'operation_id'
   AND p_receipt->>'source_save_operation_id'=ctx->>'source_save_operation_id'
   AND p_receipt->>'card_id'=ctx->>'card_id' AND p_receipt->>'customer_id'=ctx->>'customer_id'
   AND p_receipt->>'merchant_id'=ctx->>'merchant_id' AND p_receipt->>'environment'=ctx->>'environment'
   AND p_receipt->>'last4' ~ '^[0-9]{4}$'
   AND p_receipt->>'brand' IN ('VISA','MASTERCARD','AMERICAN_EXPRESS','DISCOVER','DISCOVER_DINERS',
     'DINERS_CLUB','JCB','UNIONPAY','CHINA_UNIONPAY','EFTPOS','INTERAC','OTHER_BRAND')) IS NOT TRUE THEN
   RETURN jsonb_build_object('ok',false,'code','invalid_recovery_receipt'); END IF;
 opid:=(ctx->>'operation_id')::uuid;
 INSERT INTO public.booking_card_removal_recovery_receipts(operation_id,salon_id,booking_id,
   source_save_operation_id,provider,card_id,customer_id,merchant_id,environment)
 VALUES(opid,(ctx->>'salon_id')::uuid,bid,(ctx->>'source_save_operation_id')::uuid,'square',
   ctx->>'card_id',ctx->>'customer_id',ctx->>'merchant_id',ctx->>'environment');
 UPDATE public.bookings SET noshow_card_id=NULL,noshow_customer_id=NULL,
   noshow_charge_status='removed_by_customer' WHERE id=bid AND salon_id=(ctx->>'salon_id')::uuid;
 RETURN jsonb_build_object('ok',true,'code','removed','idempotent',false);
END; $$;
REVOKE ALL ON FUNCTION public.get_booking_card_removal_recovery_context(uuid,uuid,text),
 public.complete_booking_card_removal_recovery(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_booking_card_removal_recovery_context(uuid,uuid,text),
 public.complete_booking_card_removal_recovery(uuid,uuid,text,jsonb) TO service_role;
